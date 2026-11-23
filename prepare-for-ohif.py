#!/usr/bin/env python3
"""Create a UTF-8 DICOM copy for OHIF; preserve source files and pixel bytes."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import tempfile

import pydicom
from pydicom import config
from pydicom.multival import MultiValue

DIRECTORY_SOP = '1.2.840.10008.1.3.10'
CHARSET_TAG = 0x00080005


def digest(path):
    with path.open('rb') as source:
        return hashlib.file_digest(source, 'sha256').hexdigest()


def snapshot(dataset):
    """Compare all decoded values, except charset declarations and group lengths."""
    def value(v):
        if isinstance(v, pydicom.dataset.Dataset):
            return snapshot(v)
        if isinstance(v, (list, tuple, MultiValue, pydicom.sequence.Sequence)):
            return tuple(value(x) for x in v)
        if isinstance(v, bytes):
            return ('bytes', len(v), hashlib.sha256(v).hexdigest())
        return str(v)
    return tuple((int(e.tag), e.VR, value(e.value)) for e in dataset
                 if int(e.tag) != CHARSET_TAG and e.tag.element != 0)


def set_utf8(dataset):
    # Decode before changing the charset, including each sequence's own encoding.
    dataset.decode()
    def update(ds, element):
        if int(element.tag) == CHARSET_TAG:
            element.value = 'ISO_IR 192'
    dataset.walk(update)
    dataset.SpecificCharacterSet = 'ISO_IR 192'


def prepare(source, output=None):
    source = source.resolve()
    if not source.is_dir():
        raise ValueError('Source must be a folder')
    if output is not None:
        output = output.resolve()
        if output == source or source in output.parents:
            raise ValueError('Output must be outside the source folder')
        if output.exists():
            raise FileExistsError('Output already exists; refusing to overwrite')
        parent = output.parent
    else:
        parent = source.parent
    staging = Path(tempfile.mkdtemp(prefix='.ohif-utf8-', dir=parent))
    reserved = False
    published = False
    report = {'pydicom_version': pydicom.__version__, 'converted': 0,
              'directory_files_omitted': 0, 'other_files_copied': 0,
              'source_hashes_verified': 0, 'metadata_verified': 0,
              'pixel_payloads_verified': 0}
    try:
        for path in sorted(source.rglob('*')):
            if path.is_symlink():
                raise ValueError('Symbolic links are not supported')
            if not path.is_file():
                continue
            with path.open('rb') as stream:
                header = stream.read(132)
            target = staging / path.relative_to(source)
            before_hash = digest(path)
            if header[128:132] != b'DICM':
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(path, target)
                report['other_files_copied'] += 1
            else:
                dataset = pydicom.dcmread(path)
                if str(dataset.file_meta.get('MediaStorageSOPClassUID', '')) == DIRECTORY_SOP:
                    # Directory records contain byte offsets into DICOMDIR; do not rewrite
                    # them. OHIF imports image instances directly and needs no DICOMDIR.
                    report['directory_files_omitted'] += 1
                else:
                    dataset.decode()
                    before_metadata = snapshot(dataset)
                    before_meta = snapshot(dataset.file_meta)
                    before_pixel = dataset.get('PixelData')
                    set_utf8(dataset)
                    target.parent.mkdir(parents=True, exist_ok=True)
                    dataset.save_as(target, overwrite=False)
                    checked = pydicom.dcmread(target)
                    checked.decode()
                    if (snapshot(checked) != before_metadata or
                            snapshot(checked.file_meta) != before_meta):
                        raise ValueError('Metadata verification failed')
                    if checked.get('PixelData') != before_pixel:
                        raise ValueError('Pixel data verification failed')
                    report['converted'] += 1
                    report['metadata_verified'] += 1
                    if before_pixel is not None:
                        report['pixel_payloads_verified'] += 1
                    if report['converted'] % 100 == 0:
                        print('Verified DICOM instances:', report['converted'], flush=True)
            if digest(path) != before_hash:
                raise ValueError('Source file changed during preparation')
            report['source_hashes_verified'] += 1
        if report['converted'] == 0:
            raise ValueError('No DICOM instances found')
        if output is None:
            stem = source.name.encode()[:180].decode(errors='ignore')
            index = 1
            while True:
                output = parent / (stem + (' (OHIF)' if index == 1 else f' (OHIF {index})'))
                try:
                    output.mkdir()
                    reserved = True
                    break
                except FileExistsError:
                    index += 1
        else:
            output.mkdir()
            reserved = True
        staging.rename(output)
        published = True
        return output, report
    finally:
        if staging.exists():
            shutil.rmtree(staging)
        if reserved and not published:
            output.rmdir()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', type=Path)
    parser.add_argument('--output', type=Path)
    parser.add_argument('--report', type=Path)
    args = parser.parse_args()
    os.umask(0o077)
    config.settings.reading_validation_mode = config.RAISE
    config.settings.writing_validation_mode = config.RAISE
    output, report = prepare(args.source, args.output)
    if args.report:
        args.report.write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report, indent=2), flush=True)
    print('Prepared folder:', output, flush=True)


if __name__ == '__main__':
    main()
