"""ZIP test archives contain synthetic DICOM only."""
from io import BytesIO
from pathlib import Path
import struct
import sys
from zipfile import ZIP_DEFLATED, ZIP_STORED, ZipFile

root = Path(sys.argv[1])
for name, method, folder in [('deflate.ZIP', ZIP_DEFLATED, 'directory'),
                             ('stored.zip', ZIP_STORED, 'directory'),
                             ('charset.zip', ZIP_DEFLATED, 'charset')]:
    with ZipFile(root / name, 'w', compression=method) as archive:
        for index, file in enumerate(sorted((root / folder).iterdir())):
            # Nested paths must work, and identical basenames must not collide.
            archive.write(file, f'nested/{index}/{file.name}')
        archive.writestr('README.txt', 'Synthetic DICOM only')
        archive.writestr('nested/empty/', '')
with ZipFile(root / 'zip64.zip', 'w') as archive:
    with archive.open('nested/ct.dcm', 'w', force_zip64=True) as file:
        file.write((root / 'directory' / 'ct-1.dcm').read_bytes())
with ZipFile(root / 'empty.zip', 'w') as archive:
    archive.writestr('README.txt', 'No images')
(root / 'invalid.zip').write_bytes(b'not ZIP')
# Damage one stored image's bytes while leaving both directory records intact.
damaged = bytearray((root / 'stored.zip').read_bytes())
with ZipFile(BytesIO(damaged)) as archive:
    image = next(info for info in archive.infolist() if info.filename.endswith('ct-1.dcm'))
    offset = image.header_offset
    name_len, extra_len = struct.unpack_from('<HH', damaged, offset + 26)
    damaged[offset + 30 + name_len + extra_len + 132] ^= 1
(root / 'crc-error.zip').write_bytes(damaged)
# An encrypted flag is enough to test the preflight rejection without a password.
encrypted = bytearray((root / 'stored.zip').read_bytes())
with ZipFile(BytesIO(encrypted)) as archive:
    for info in archive.infolist():
        if info.filename.endswith('.dcm'):
            offset = info.header_offset
            struct.pack_into('<H', encrypted, offset + 6, info.flag_bits | 1)
pos = 0
while True:
    pos = encrypted.find(b'PK\x01\x02', pos)
    if pos < 0:
        break
    struct.pack_into('<H', encrypted, pos + 8, struct.unpack_from('<H', encrypted, pos + 8)[0] | 1)
    pos += 46
(root / 'encrypted.zip').write_bytes(encrypted)
for name in ('companion', 'companion-damaged', 'companion-unknown'):
    with ZipFile(root / (name + '.zip'), 'w', ZIP_DEFLATED) as archive:
        for file in sorted((root / name).iterdir()):
            archive.write(file, 'nested/' + file.name)
print('Synthetic ZIP fixtures created')
