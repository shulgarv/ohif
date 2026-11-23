#!/usr/bin/env python3
"""Extract the static viewer from the pinned, official OHIF Docker image."""
import hashlib
import gzip
import json
from pathlib import Path, PurePosixPath
import runpy
import shutil
import tarfile
import urllib.request

VERSION = 'v3.13.12'
IMAGE_DIGEST = 'sha256:2710da0c2893692f43bae6a70992623065a0edd849ae20412fc862e0f2b30aa5'
ROOT = Path(__file__).resolve().parent
SITE = ROOT / 'www'
CACHE = ROOT / '.image-cache'
REGISTRY = 'https://registry-1.docker.io/v2/ohif/app/'


def get_json(url, headers=None):
    with urllib.request.urlopen(urllib.request.Request(url, headers=headers or {}), timeout=60) as response:
        return json.load(response)


def restore_compressed_assets():
    # The nginx image uses gzip_static and leaves empty uncompressed placeholders.
    # Restore those assets so a regular static HTTP server can serve them.
    restored = 0
    for compressed in SITE.rglob('*.gz'):
        target = compressed.with_suffix('')
        if target.exists() and target.stat().st_size:
            continue
        with gzip.open(compressed, 'rb') as source, target.open('wb') as destination:
            shutil.copyfileobj(source, destination)
        restored += 1
    return restored


def main():
    SITE.mkdir(exist_ok=True)
    CACHE.mkdir(exist_ok=True)
    token = get_json('https://auth.docker.io/token?service=registry.docker.io&scope=repository:ohif/app:pull')['token']
    headers = {'Authorization': 'Bearer ' + token,
               'Accept': 'application/vnd.docker.distribution.manifest.v2+json'}
    with urllib.request.urlopen(urllib.request.Request(REGISTRY + 'manifests/' + IMAGE_DIGEST, headers=headers), timeout=60) as response:
        raw = response.read()
    assert hashlib.sha256(raw).hexdigest() == IMAGE_DIGEST.split(':')[1], 'Manifest digest mismatch'
    manifest = json.loads(raw)
    extracted = 0
    for index, layer in enumerate(manifest['layers'], 1):
        digest = layer['digest'].split(':')[1]
        archive = CACHE / (digest + '.tar.gz')
        print(f'Layer {index}/{len(manifest["layers"])} ({layer["size"] / 1024 / 1024:.1f} MiB)', flush=True)
        if not archive.exists():
            temporary = archive.with_suffix('.partial')
            request = urllib.request.Request(REGISTRY + 'blobs/' + layer['digest'], headers=headers)
            with urllib.request.urlopen(request, timeout=120) as response, temporary.open('wb') as target:
                shutil.copyfileobj(response, target)
            temporary.rename(archive)
        with archive.open('rb') as source:
            actual = hashlib.file_digest(source, 'sha256').hexdigest()
        if actual != digest:
            archive.unlink()
            raise RuntimeError('Layer digest mismatch')
        with tarfile.open(archive, 'r:gz') as tar:
            for member in tar:
                parts = PurePosixPath(member.name).parts
                if parts[:4] != ('usr', 'share', 'nginx', 'html') or len(parts) <= 4:
                    continue
                relative = PurePosixPath(*parts[4:])
                if '..' in relative.parts:
                    raise RuntimeError('Unsafe archive path')
                destination = SITE.joinpath(*relative.parts)
                if member.isdir():
                    destination.mkdir(parents=True, exist_ok=True)
                elif member.isfile():
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    with tar.extractfile(member) as source, destination.open('wb') as target:
                        shutil.copyfileobj(source, target)
                    extracted += 1
        archive.unlink()
    if not (SITE / 'index.html').is_file():
        raise RuntimeError('Viewer index.html missing')
    restored = restore_compressed_assets()
    if (ROOT / 'app-config.js').is_file():
        shutil.copyfile(ROOT / 'app-config.js', SITE / 'app-config.js')
    (ROOT / 'installed-version.json').write_text(json.dumps({
        'version': VERSION, 'image': 'ohif/app', 'digest': IMAGE_DIGEST,
        'extracted_files': extracted, 'restored_compressed_assets': restored,
    }, indent=2) + '\n')
    CACHE.rmdir()
    runpy.run_path(str(ROOT / 'apply-local-compatibility.py'), run_name='__main__')
    runpy.run_path(str(ROOT / 'apply-viewer-fixes.py'), run_name='__main__')
    print(f'Installed {VERSION}: {extracted} static files', flush=True)


if __name__ == '__main__':
    main()
