"""Hash source pixel bytes independently; output has no patient identifiers."""
import hashlib
from io import BytesIO
import json
from pathlib import Path
import sys
import zipfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import local_metadata  # Makes the application's pydicom installation available.
import pydicom


archive = Path(sys.argv[1])
frames = []
with zipfile.ZipFile(archive) as source:
    for entry in source.infolist():
        if entry.is_dir() or not entry.filename.lower().endswith('.dcm'):
            continue
        dataset = pydicom.dcmread(BytesIO(source.read(entry)))
        if dataset.file_meta.MediaStorageSOPClassUID == '1.2.840.10008.1.3.10':
            continue
        frames.append({
            'transferSyntaxUid': str(dataset.file_meta.TransferSyntaxUID),
            'pixelSha256': hashlib.sha256(dataset.PixelData).hexdigest(),
        })
with archive.open('rb') as source:
    archive_hash = hashlib.file_digest(source, 'sha256').hexdigest()
Path(sys.argv[2]).write_text(json.dumps({
    'archiveSha256': archive_hash, 'frames': frames,
}, indent=2) + '\n')
print(json.dumps({'result': 'PASS', 'referenceFrames': len(frames)}))
