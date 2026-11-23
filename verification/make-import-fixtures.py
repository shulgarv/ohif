"""Create synthetic browser regression inputs, without copying patient data."""
import importlib.util
import io
import struct
import shutil
import pydicom
from pathlib import Path
import sys

root = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(root))
spec = importlib.util.spec_from_file_location('fixtures', root / 'test-local-metadata.py')
fixtures = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixtures)
target = Path(sys.argv[1])
for name in ('directory', 'charset', 'mixed', 'invalid', 'directory-only', 'mpr', 'mpr-slab', 'two-series'):
    (target / name).mkdir(parents=True, exist_ok=True)
for instance in range(1, 4):
    (target / 'directory' / f'ct-{instance}.dcm').write_bytes(fixtures.image_bytes(instance=instance))
    (target / 'charset' / f'ct-{instance}.dcm').write_bytes(fixtures.image_bytes(['ISO 2022 IR 100', 'ISO 2022 IR 144'], instance))
for instance in range(1, 65):
    (target / 'mpr' / f'ct-{instance:03d}.dcm').write_bytes(fixtures.image_bytes(instance=instance))
    slab = pydicom.dcmread(io.BytesIO(fixtures.image_bytes(instance=instance)))
    # Off-plane bright sphere: a thick MIP reveals pixels absent from each
    # central thin slice, allowing the browser test to verify real rendering.
    slab.PixelData = struct.pack('<4096H', *[
        1524 if (x - 38)**2 + (y - 38)**2 + (instance - 38)**2 < 9 else
        1064 if (x - 32)**2 + (y - 32)**2 < 576 else 24
        for y in range(64) for x in range(64)])
    slab.save_as(target / 'mpr-slab' / f'ct-{instance:03d}.dcm')
    (target / 'two-series' / f'ct-{instance:03d}.dcm').write_bytes(fixtures.image_bytes(instance=instance))
    second = pydicom.dcmread(io.BytesIO(fixtures.image_bytes(instance=instance)))
    second.SeriesInstanceUID += '.2'
    second.SOPInstanceUID += '.2'
    second.file_meta.MediaStorageSOPInstanceUID = second.SOPInstanceUID
    second.SeriesNumber = 2
    second.SeriesDescription = 'Synthetic second series'
    second.save_as(target / 'two-series' / f'second-{instance:03d}.dcm')
(target / 'directory' / 'DICOMDIR').write_bytes(fixtures.directory_bytes())
(target / 'directory-only' / 'DICOMDIR').write_bytes(fixtures.directory_bytes())
(target / 'invalid' / 'invalid.dcm').write_bytes(b'not DICOM')
(target / 'mixed' / 'ct.dcm').write_bytes(fixtures.image_bytes())
(target / 'mixed' / 'invalid.dcm').write_bytes(b'not DICOM')
# Export sidecars must not produce incomplete-study alerts. Damaged images must.
for name, extra in [('companion', {}), ('companion-damaged', {'damaged.dcm': bytes(256)}),
                    ('companion-unknown', {'other.famed': b'not DICOM'})]:
    folder = target / name
    folder.mkdir(exist_ok=True)
    (folder / 'ct.dcm').write_bytes(fixtures.image_bytes())
    (folder / 'info.famed').write_bytes(b'https://example.invalid/export-sidecar')
    for filename, content in extra.items():
        (folder / filename).write_bytes(content)
# A crowded rail, variable/missing thickness and long descriptions; synthetic only.
rail = target / 'series-rail'
rail.mkdir(exist_ok=True)
for file in (target / 'two-series').glob('*.dcm'):
    shutil.copyfile(file, rail / file.name)
for series in range(3, 21):
    for instance in range(1, 4):
        image = pydicom.dcmread(io.BytesIO(fixtures.image_bytes(instance=instance)))
        image.SeriesInstanceUID += f'.{series}'
        image.SOPInstanceUID += f'.{series}'
        image.file_meta.MediaStorageSOPInstanceUID = image.SOPInstanceUID
        image.SeriesNumber = series
        image.SeriesDescription = f'Synthetic rail series {series} with a long descriptive name'
        if series == 3:
            image.SliceThickness = 0.5 if instance % 2 else 1.5
        elif series == 20:
            del image.SliceThickness
        image.save_as(rail / f'rail-{series:02d}-{instance}.dcm')
print('Synthetic fixtures created')
