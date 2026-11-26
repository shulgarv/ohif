"""Create a synthetic 629-slice 1024x1024 CT series for MPR GPU-budget checks.

Usage: make-large-volume-fixture.py <output.zip> [plain|ramp|rampflat] [slices]

``plain`` (default) stores the same value 1000 in every slice: a pure GPU
budget fixture. ``ramp`` stores ``4 * instance + row % 64`` and ``rampflat``
stores ``4 * instance``; both give a monotonic gradient along Z so MPR
reformats make a seam between two GPU textures and a wrong slice order visible.
The row pattern additionally exposes the in-plane mapping. ``zsaw`` stores
``500 * (instance % 4)``: sharp value changes between neighbouring slices
expose any Z mapping error of the split texture directly.
"""
import importlib.util
from io import BytesIO
from pathlib import Path
import sys
from zipfile import ZipFile, ZIP_DEFLATED
import array
import pydicom

mode = sys.argv[2] if len(sys.argv) > 2 else 'plain'
ramp = mode in ('ramp', 'rampflat', 'zsaw')
slices = int(sys.argv[3]) if len(sys.argv) > 3 else 629
root = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(root))
spec = importlib.util.spec_from_file_location('fixtures', root / 'test-local-metadata.py')
fixtures = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixtures)

base_row = array.array('H', [1000] * 1024)
def ramp_pixels(instance):
    """Constant per slice with a small per-row offset; no patient data."""
    rows = []
    for row in range(1024):
        if mode == 'zsaw':
            value = 500 * (instance % 4)
        else:
            value = (4 * instance + (row % 64 if mode == 'ramp' else 0)) & 0xFFFF
        rows.append(array.array('H', [value] * 1024))
    data = array.array('H')
    for row in rows:
        data.extend(row)
    return data.tobytes()

with ZipFile(sys.argv[1], 'w', ZIP_DEFLATED, compresslevel=1) as archive:
    for instance in range(1, slices + 1):
        image = pydicom.dcmread(BytesIO(fixtures.image_bytes(instance=instance)))
        image.SOPInstanceUID = f'1.2.826.0.1.3680043.10.543.20.{instance}'
        image.file_meta.MediaStorageSOPInstanceUID = image.SOPInstanceUID
        image.SeriesInstanceUID = '1.2.826.0.1.3680043.10.543.20.1'
        image.SeriesNumber = 1
        image.SeriesDescription = 'Synthetic large MPR ' + mode if ramp else 'Synthetic large MPR'
        image.InstanceNumber = instance
        image.Rows = image.Columns = 1024
        image.PixelSpacing = [0.33007813, 0.33007813]
        image.ImagePositionPatient = [-166.3, -141.0, -1017.2 + instance - 1]
        image.ImageOrientationPatient = [1, 0, 0, 0, 1, 0]
        image.PixelData = ramp_pixels(instance) if ramp else base_row.tobytes() * 1024
        output = BytesIO()
        pydicom.dcmwrite(output, image, enforce_file_format=True)
        archive.writestr(f'{instance:04d}.dcm', output.getvalue())
print('Created synthetic %dx1024x1024 CT series (%s); contains no patient data'
      % (slices, mode))
