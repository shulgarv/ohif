"""Synthetic CP-246 sequences: no patient data or source studies."""
from io import BytesIO
from pathlib import Path
import importlib.util
import struct
import sys
from zipfile import ZipFile, ZIP_DEFLATED

import pydicom

root = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('fixtures', root / 'test-local-metadata.py')
fixtures = importlib.util.module_from_spec(spec)
sys.path.insert(0, str(root))
spec.loader.exec_module(fixtures)
target = Path(sys.argv[1])
target.mkdir(parents=True, exist_ok=True)


def element(tag, vr, value, syntax='explicit-le', undefined=False):
    endian = '>' if syntax == 'explicit-be' else '<'
    length = 0xffffffff if undefined else len(value)
    header = struct.pack(endian + 'HH', *tag)
    if syntax == 'implicit-le':
        return header + struct.pack('<I', length) + value
    if vr in ('UN', 'SQ', 'OB', 'OW'):
        return header + vr.encode() + b'\0\0' + struct.pack(endian + 'I', length) + value
    return header + vr.encode() + struct.pack(endian + 'H', length) + value


def item(value, syntax='implicit-le', undefined=False):
    endian = '>' if syntax == 'explicit-be' else '<'
    header = struct.pack(endian + 'HHI', 0xfffe, 0xe000,
                         0xffffffff if undefined else len(value))
    delimiter = struct.pack(endian + 'HHI', 0xfffe, 0xe00d, 0) if undefined else b''
    return header + value + delimiter


def sequence(vr='UN', outer='explicit-le', undefined=False, nested=False):
    inner = 'implicit-le' if vr == 'UN' else outer
    values = b''
    for name in (b'servTEST', b'second  '):
        content = element((8, 0x103e), 'LO', name, inner)
        if nested:
            child = element((0x0040, 0x1001), 'SH', b'CHILD ', inner)
            content += element((0x0040, 0x0275), 'SQ', item(child, inner), inner)
        values += item(content, inner, undefined)
    if undefined:
        endian = '>' if inner == 'explicit-be' else '<'
        values += struct.pack(endian + 'HHI', 0xfffe, 0xe0dd, 0)
    return element((0x0040, 0x030e), vr, values, outer, undefined)


cases = [
    ('un-defined', 'UN', 'explicit-le', False, False),
    ('un-undefined', 'UN', 'explicit-le', True, False),
    ('un-nested', 'UN', 'explicit-le', False, True),
    ('un-big-endian', 'UN', 'explicit-be', False, True),
    ('sq-explicit', 'SQ', 'explicit-le', False, True),
    ('sq-undefined', 'SQ', 'explicit-le', True, False),
    ('sq-big-endian', 'SQ', 'explicit-be', False, True),
    ('sq-implicit', 'SQ', 'implicit-le', False, True),
]
for index, (name, vr, syntax, undefined, nested) in enumerate(cases, 1):
    ds = pydicom.dcmread(BytesIO(fixtures.image_bytes(instance=index)))
    ds.file_meta.TransferSyntaxUID = {
        'explicit-le': '1.2.840.10008.1.2.1',
        'explicit-be': '1.2.840.10008.1.2.2',
        'implicit-le': '1.2.840.10008.1.2',
    }[syntax]
    output = BytesIO()
    pydicom.dcmwrite(output, ds, enforce_file_format=True)
    base = output.getvalue()
    pixel_tag = struct.pack('>HH' if syntax == 'explicit-be' else '<HH', 0x7fe0, 0x0010)
    position = base.index(pixel_tag)
    extra = sequence(vr, syntax, undefined, nested)
    extra += element((0x0040, 0x1001), 'SH', b'AFTER ', syntax)
    (target / (name + '.dcm')).write_bytes(base[:position] + extra + base[position:])

with ZipFile(target.with_suffix('.zip'), 'w', ZIP_DEFLATED) as archive:
    for file in sorted(target.glob('*.dcm')):
        archive.write(file, 'nested/' + file.name)
print(f'Created {len(cases)} synthetic sequence fixtures and ZIP')
