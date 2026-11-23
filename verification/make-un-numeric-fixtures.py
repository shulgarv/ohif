"""Synthetic UN values whose byte lengths disagree with the numeric dictionary VR."""
from pathlib import Path
import struct
import sys

source = Path(sys.argv[1]).read_bytes()
target = Path(sys.argv[2])
target.mkdir(parents=True, exist_ok=True)
position = source.index(bytes.fromhex('e07f1000'))
for name, tag, value in [
    ('fd-short', (0x0018, 0x9318), b'1234'),
    ('fd-remainder', (0x0018, 0x9318), b'1234567890'),
    ('fd-valid', (0x0018, 0x9318), struct.pack('<3d', 1, 2, 3)),
    ('fd-empty', (0x0018, 0x9318), b''),
    ('ul-short', (0x0020, 0x9057), b'12'),
    ('ul-valid', (0x0020, 0x9057), struct.pack('<I', 7)),
]:
    element = struct.pack('<HH', *tag) + b'UN\0\0' + struct.pack('<I', len(value)) + value
    (target / (name + '.dcm')).write_bytes(source[:position] + element + source[position:])
print('Created 6 synthetic UN numeric fixtures')
