"""Decode local DICOM metadata without rewriting files or decoding pixel data."""
from io import BytesIO
from pathlib import Path
import sys

# The desktop service uses system Python; pydicom remains in this app's venv.
SITE_PACKAGES = (Path(__file__).parent / '.venv' / 'lib' /
                 f'python{sys.version_info.major}.{sys.version_info.minor}' / 'site-packages')
if SITE_PACKAGES.is_dir():
    sys.path.insert(0, str(SITE_PACKAGES))


def read_metadata(payload):
    import pydicom
    from pydicom import config

    # Reject invalid text instead of silently displaying replacement characters.
    config.settings.reading_validation_mode = config.RAISE
    ds = pydicom.dcmread(BytesIO(payload))
    ds.decode()
    # Cornerstone reads the original file for pixels, including compressed frames.
    for tag in (0x7FE00010, 0x7FE00008, 0x7FE00009):
        if tag in ds:
            del ds[tag]
    # Some exporters use a malformed producer UID (e.g. leading zeroes).
    # It identifies the writing software, not the image or its transfer syntax.
    # Keep strict validation for image identifiers and text; omit only this
    # provenance field when it cannot be converted for the metadata response.
    if 0x00020012 in ds.file_meta:
        try:
            ds.file_meta[0x00020012]
        except ValueError:
            del ds.file_meta[0x00020012]
    return {'dict': ds.to_json_dict(), 'meta': ds.file_meta.to_json_dict()}
