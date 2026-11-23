#!/usr/bin/env python3
"""Unpack Downloads ZIPs into separate folders, keeping archives and existing data."""
import argparse
import fcntl
import json
import os
from pathlib import Path, PurePosixPath, PureWindowsPath
import shutil
import stat
import subprocess
import tempfile
import zipfile
import zlib

ROOT = Path(__file__).resolve().parent


def notify(message, enabled=True, error=False):
    print(message, flush=True)
    if enabled:
        try:
            subprocess.run(['notify-send', '--app-name=OHIF ZIP',
                            '--urgency=' + ('critical' if error else 'normal'),
                            'Распаковка ZIP в Downloads', message],
                           timeout=5, check=False, stdout=subprocess.DEVNULL,
                           stderr=subprocess.DEVNULL)
        except (OSError, subprocess.TimeoutExpired):
            pass


def signature(path):
    info = path.stat()
    return [info.st_size, info.st_mtime_ns]


def member_path(info):
    name = info.orig_filename.replace('\\', '/')
    path = PurePosixPath(name)
    if '\0' in name or path.is_absolute() or '..' in path.parts or PureWindowsPath(name).drive:
        raise ValueError('недопустимый путь внутри архива')
    kind = stat.S_IFMT(info.external_attr >> 16)
    if kind not in (0, stat.S_IFREG, stat.S_IFDIR):
        raise ValueError('ссылки и специальные файлы внутри ZIP не поддерживаются')
    return path


def unpack(archive, downloads):
    before = signature(archive)
    staging = Path(tempfile.mkdtemp(prefix='.ohif-unpacking-', dir=downloads))
    destination = None
    reserved = False
    published = False
    try:
        with zipfile.ZipFile(archive) as source:
            entries = [(info, member_path(info)) for info in source.infolist()]
            for info, relative in entries:
                if not relative.parts:
                    continue
                target = staging.joinpath(*relative.parts)
                if info.is_dir() or info.filename.endswith('\\'):
                    target.mkdir(parents=True, exist_ok=True)
                else:
                    target.parent.mkdir(parents=True, exist_ok=True)
                    # Opening each member fully also validates its CRC.
                    with source.open(info) as content, target.open('xb') as output:
                        shutil.copyfileobj(content, output, length=1024 * 1024)
        if signature(archive) != before:
            raise ValueError('архив изменился во время распаковки; попробуйте после завершения загрузки')
        stem = archive.stem.encode('utf-8')[:200].decode('utf-8', errors='ignore')
        stem = stem.rstrip(' .') or 'archive'
        index = 1
        while True:
            destination = downloads / (stem if index == 1 else f'{stem} ({index})')
            try:
                destination.mkdir()
                reserved = True
                break
            except FileExistsError:
                index += 1
        # Replace only the empty directory just reserved by this invocation.
        staging.rename(destination)
        published = True
        return {'signature': before, 'folder': destination.name}
    finally:
        if staging.exists():
            shutil.rmtree(staging)
        if reserved and not published:
            try:
                destination.rmdir()
            except OSError:
                pass


def save_state(path, state):
    with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8',
                                     dir=path.parent, prefix='.zip-state-',
                                     delete=False) as output:
        temporary = Path(output.name)
        json.dump(state, output, ensure_ascii=False, indent=2)
        output.write('\n')
    try:
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


def run(downloads, state_path, notifications):
    if not downloads.is_dir():
        raise ValueError(f'папка не найдена: {downloads}')
    state_path.parent.mkdir(parents=True, exist_ok=True)
    with state_path.with_suffix('.lock').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            notify('Распаковка уже выполняется.', notifications)
            return 0
        state = json.loads(state_path.read_text()) if state_path.exists() else {}
        if not isinstance(state, dict):
            raise ValueError('неверный формат журнала распаковки')
        archives = sorted((p for p in downloads.iterdir()
                           if p.suffix.lower() == '.zip' and p.is_file() and not p.is_symlink()),
                          key=lambda p: p.name.casefold())
        if not archives:
            notify('ZIP-архивов в Downloads нет.', notifications)
            return 0
        completed, skipped, errors = 0, 0, []
        pending = []
        for archive in archives:
            key = str(archive.resolve())
            previous = state.get(key, {})
            folder = previous.get('folder', '')
            if (previous.get('signature') == signature(archive)
                    and folder and Path(folder).name == folder
                    and (downloads / folder).is_dir()):
                skipped += 1
            else:
                pending.append((archive, key))
        if pending:
            notify(f'Архивов для распаковки: {len(pending)}. Каждый — в отдельную папку.', notifications)
        for archive, key in pending:
            try:
                record = unpack(archive, downloads)
                state[key] = record
                save_state(state_path, state)
                completed += 1
                print(f'{archive.name} → {record["folder"]}/', flush=True)
            except (OSError, ValueError, RuntimeError, NotImplementedError,
                    zipfile.BadZipFile, zlib.error, EOFError) as error:
                errors.append(f'{archive.name}: {error}')
        message = f'Распаковано: {completed}. Уже обработано: {skipped}. Ошибок: {len(errors)}.'
        if errors:
            message += '\n' + '\n'.join(errors[:3])
            for error in errors:
                print(error, flush=True)
        notify(message, notifications, error=bool(errors))
        return 1 if errors else 0


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--downloads', type=Path, default=Path.home() / 'Downloads')
    parser.add_argument('--state', type=Path, default=ROOT / 'zip-unpack-state.json')
    parser.add_argument('--no-notify', action='store_true')
    args = parser.parse_args()
    os.umask(0o077)
    try:
        return run(args.downloads.resolve(), args.state.resolve(), not args.no_notify)
    except (OSError, ValueError) as error:
        notify(f'Не удалось выполнить распаковку: {error}', not args.no_notify, error=True)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
