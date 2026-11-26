"""Create a synthetic 629-slice 1024x1024 CT series for MPR GPU-budget checks."""
import importlib.util
from io import BytesIO
from pathlib import Path
import struct
import sys
from zipfile import ZipFile, ZIP_DEFLATED
import pydicom

root = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(root))
spec = importlib.util.spec_from_file_location('fixtures', root / 'test-local-metadata.py')
fixtures = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixtures)
pixels = struct.pack('<H', 1000) * (1024 * 1024)
with ZipFile(sys.argv[1], 'w', ZIP_DEFLATED, compresslevel=1) as archive:
    for instance in range(1, 630):
        image = pydicom.dcmread(BytesIO(fixtures.image_bytes(instance=instance)))
        image.SOPInstanceUID = f'1.2.826.0.1.3680043.10.543.20.{instance}'
        image.file_meta.MediaStorageSOPInstanceUID = image.SOPInstanceUID
        image.SeriesInstanceUID = '1.2.826.0.1.3680043.10.543.20.1'
        image.SeriesNumber = 1
        image.SeriesDescription = 'Synthetic large MPR'
        image.InstanceNumber = instance
        image.Rows = image.Columns = 1024
        image.PixelSpacing = [0.33007813, 0.33007813]
        image.ImagePositionPatient = [-166.3, -141.0, -1017.2 + instance - 1]
        image.ImageOrientationPatient = [1, 0, 0, 0, 1, 0]
        image.PixelData = pixels
        output = BytesIO()
        pydicom.dcmwrite(output, image, enforce_file_format=True)
        archive.writestr(f'{instance:04d}.dcm', output.getvalue())
print('Created synthetic 629x1024x1024 CT series; contains no patient data')
