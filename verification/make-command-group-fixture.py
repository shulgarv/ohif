"""Create a DICOM file whose dataset starts with a command group (0000,xxxx).

Some exporters write the DICOM command set in front of the dataset. Its group
length elements are absent from the tag dictionary, which used to make the
async dcmjs reader lose every element of such a file. The fixture keeps the
original dataset and pixel data untouched and only inserts the command group.

Usage: make-command-group-fixture.py <output-directory>
"""
import importlib.util
from io import BytesIO
from pathlib import Path
import struct
import sys
import pydicom

root = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(root))
spec = importlib.util.spec_from_file_location('fixtures', root / 'test-local-metadata.py')
fixtures = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixtures)


def text(value, pad=b' '):
    data = value.encode('ascii')
    return data + pad * ((len(data) + 1) % 2)


def explicit(tag, vr, value):
    """Explicit VR little endian element with a long or short value length."""
    group, element = tag
    head = struct.pack('<HH', group, element) + vr.encode('ascii')
    if vr in ('OB', 'OW', 'OF', 'SQ', 'UT', 'UN'):
        return head + b'\0\0' + struct.pack('<I', len(value)) + value
    return head + struct.pack('<H', len(value)) + value


def command_group():
    """Command set elements: one fixed and two variable length elements."""
    return b''.join([
        explicit((0x0000, 0x0000), 'UL', struct.pack('<I', 0)),
        explicit((0x0000, 0x0002), 'UI', text('1.2.840.10008.5.1.4.1.1.2')),
        explicit((0x0000, 0x0100), 'US', struct.pack('<H', 0x0001)),
        explicit((0x0000, 0x0900), 'US', struct.pack('<H', 0x0000)),
    ])


output = Path(sys.argv[1])
output.mkdir(parents=True, exist_ok=True)
source = fixtures.image_bytes(instance=1)
dataset = pydicom.dcmread(BytesIO(source), force=True)
meta_length = dataset.file_meta[(0x0002, 0x0000)].value
# (0002,0000) UL 4 <length> is 12 bytes long; then the meta elements follow.
meta_end = 132 + 12 + meta_length
meta = source[132:meta_end]
assert meta[:4] == b'\x02\x00\x00\x00'
body = source[meta_end:]
(output / 'ct-command-group.dcm').write_bytes(source[:132] + meta + command_group() + body)
print('Created synthetic DICOM with a leading command group; contains no patient data')
