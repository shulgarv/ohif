"""Synthetic study shaped like 6984280: 5 scouts and 783 1024x1024 CT slices."""
from pathlib import Path
from io import BytesIO
import importlib.util
import random
import struct
import sys
from zipfile import ZipFile, ZIP_DEFLATED
import pydicom

root = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(root))
spec = importlib.util.spec_from_file_location('fixtures', root / 'test-local-metadata.py')
fixtures = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixtures)
# Seeded low-amplitude noise gives a ZIP size similar to a real CT export.
noise = random.Random(6984280).randbytes(1024 * 1024)
pixels = b''.join(struct.pack('<H', 1000 + (value & 63)) for value in noise)
with ZipFile(sys.argv[1], 'w', ZIP_DEFLATED, compresslevel=1) as archive:
    for index in range(1, 789):
        image = pydicom.dcmread(BytesIO(fixtures.image_bytes(instance=index)))
        series = 1 if index < 6 else 2 if index < 397 else 3
        image.SeriesInstanceUID = f'1.2.826.0.1.3680043.10.543.9.{series}'
        image.SeriesNumber = series
        image.SeriesDescription = 'Synthetic large CT'
        if index >= 6:
            image.Rows = image.Columns = 1024
            image.PixelData = pixels
        output = BytesIO()
        pydicom.dcmwrite(output, image, enforce_file_format=True)
        archive.writestr(f'{index:04d}.dcm', output.getvalue())
    archive.writestr('info.famed', 'https://example.invalid/export-sidecar')
print('Created synthetic 788-image ZIP; contains no patient data')
