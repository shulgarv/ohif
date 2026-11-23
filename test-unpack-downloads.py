"""Integration checks using artificial archives, without touching Downloads."""
import fcntl
import json
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import unittest
import zipfile

SCRIPT = Path(__file__).with_name('unpack-downloads.py')


class UnpackTests(unittest.TestCase):
    def setUp(self):
        self.sandbox = tempfile.TemporaryDirectory()
        self.addCleanup(self.sandbox.cleanup)
        self.root = Path(self.sandbox.name)
        self.downloads = self.root / 'Downloads'
        self.downloads.mkdir()
        self.state = self.root / 'state.json'

    def make_zip(self, name, files):
        archive = self.downloads / name
        with zipfile.ZipFile(archive, 'w', zipfile.ZIP_DEFLATED) as output:
            for path, contents in files.items():
                output.writestr(path, contents)
        return archive

    def run_script(self, code=0):
        result = subprocess.run([sys.executable, str(SCRIPT), '--downloads', str(self.downloads),
                                 '--state', str(self.state), '--no-notify'],
                                capture_output=True, text=True)
        self.assertEqual(result.returncode, code, result.stdout + result.stderr)
        return result

    def test_flat_nested_uppercase_spaces_and_repeat(self):
        archive = self.make_zip('Исследование КТ.ZIP', {'001.dcm': b'first', 'series/002.dcm': b'second'})
        before = archive.read_bytes()
        self.run_script()
        folder = self.downloads / 'Исследование КТ'
        self.assertEqual((folder / '001.dcm').read_bytes(), b'first')
        self.assertEqual((folder / 'series/002.dcm').read_bytes(), b'second')
        self.assertEqual(archive.read_bytes(), before)
        self.assertFalse((self.downloads / '001.dcm').exists())
        self.run_script()
        self.assertEqual(len(list(self.downloads.iterdir())), 2)
        self.assertEqual(len(json.loads(self.state.read_text())), 1)

    def test_existing_folder_is_kept_and_changed_archive_gets_new_folder(self):
        existing = self.downloads / 'study'
        existing.mkdir()
        (existing / 'keep.txt').write_text('keep')
        self.make_zip('study.zip', {'scan.dcm': b'original'})
        self.run_script()
        self.assertEqual((existing / 'keep.txt').read_text(), 'keep')
        self.assertEqual((self.downloads / 'study (2)/scan.dcm').read_bytes(), b'original')
        self.make_zip('study.zip', {'scan.dcm': b'changed contents'})
        self.run_script()
        self.assertEqual((self.downloads / 'study (3)/scan.dcm').read_bytes(), b'changed contents')
        self.assertEqual((self.downloads / 'study (2)/scan.dcm').read_bytes(), b'original')

    def test_deleted_output_can_be_extracted_again(self):
        self.make_zip('study.zip', {'scan.dcm': b'data'})
        self.run_script()
        (self.downloads / 'study/scan.dcm').unlink()
        (self.downloads / 'study').rmdir()
        self.run_script()
        self.assertEqual((self.downloads / 'study/scan.dcm').read_bytes(), b'data')

    def test_invalid_paths_leave_no_partial_output_and_other_archive_continues(self):
        for index, path in enumerate(['../escape.dcm', '/escape.dcm', '..\\escape.dcm', 'C:\\escape.dcm']):
            self.make_zip(f'bad-{index}.zip', {'first.dcm': b'first', path: b'bad'})
        self.make_zip('good.zip', {'scan.dcm': b'good'})
        self.run_script(code=1)
        self.assertEqual((self.downloads / 'good/scan.dcm').read_bytes(), b'good')
        self.assertEqual({p.name for p in self.downloads.iterdir() if p.is_dir()}, {'good'})
        self.assertFalse((self.root / 'escape.dcm').exists())

    def test_corrupted_archive_does_not_publish_partial_folder(self):
        archive = self.make_zip('broken.zip', {'scan.dcm': b'corrupt me'})
        with zipfile.ZipFile(archive) as source:
            entry = source.infolist()[0]
            offset = entry.header_offset + 30 + len(entry.filename.encode()) + len(entry.extra)
        damaged = bytearray(archive.read_bytes())
        damaged[offset] ^= 255
        archive.write_bytes(damaged)
        self.make_zip('good.zip', {'scan.dcm': b'good'})
        self.run_script(code=1)
        self.assertEqual({p.name for p in self.downloads.iterdir() if p.is_dir()}, {'good'})

    def test_symlink_member_is_rejected(self):
        with zipfile.ZipFile(self.downloads / 'link.zip', 'w') as archive:
            entry = zipfile.ZipInfo('link')
            entry.create_system = 3
            entry.external_attr = (stat.S_IFLNK | 0o777) << 16
            archive.writestr(entry, '../outside')
        self.run_script(code=1)
        self.assertFalse(any(p.is_dir() for p in self.downloads.iterdir()))

    def test_second_invocation_while_locked_does_not_extract(self):
        self.make_zip('study.zip', {'scan.dcm': b'data'})
        with self.state.with_suffix('.lock').open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            result = self.run_script()
            self.assertIn('уже выполняется', result.stdout)
        self.assertFalse((self.downloads / 'study').exists())


if __name__ == '__main__':
    unittest.main()
