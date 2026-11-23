"""Version-checked Measurements panel fix for the pinned OHIF 3.13.12."""
import gzip
import hashlib
import json
from pathlib import Path
from viewer_ui import apply_default_extension

ROOT = Path(__file__).resolve().parent
BUNDLE = ROOT / 'www/3760.bundle.bc58ee8705a94523.js'
PRISTINE_SHA256 = 'af0b258d8a220383b7e55d62a3d4a96777a127935e3c5a71134f8f3d2c0877f8'


def apply():
    patch = ROOT / 'compatibility/delete-measurements.js'
    command_patch = ROOT / 'compatibility/clear-measurements-command.js'
    record = ROOT / 'compatibility/installed-viewer-fixes.json'
    backup = ROOT / 'compatibility/measurement-tracking.original.js.gz'
    installed = BUNDLE.read_bytes()
    installed_hash = hashlib.sha256(installed).hexdigest()
    source_hash = hashlib.sha256(
        Path(__file__).read_bytes() + patch.read_bytes() + command_patch.read_bytes()
    ).hexdigest()
    previous = json.loads(record.read_text()) if record.exists() else {}
    if previous.get('patched_sha256') == installed_hash:
        if previous.get('source_sha256') == source_hash:
            print('Measurements panel fix already applied')
            return
        original = gzip.decompress(backup.read_bytes())
    else:
        original = installed
    if hashlib.sha256(original).hexdigest() != PRISTINE_SHA256:
        raise RuntimeError('Unexpected measurement-tracking bundle; refusing unknown build')
    source = original.decode()
    panel = source.index('function PanelMeasurementTableTracking(props)')
    start = source.index('  const onUntrackConfirm = () => {', panel)
    end = source.index('  const EmptyComponent =', start)
    source = source[:start] + patch.read_text() + source[end:]
    marker = '  return /*#__PURE__*/react.createElement(TrackedMeasurementsContext.Provider'
    if source.count(marker) != 1:
        raise RuntimeError('Unexpected tracking command registration')
    patched = source.replace(marker, command_patch.read_text() + marker).encode()
    if not backup.exists():
        backup.write_bytes(gzip.compress(original, mtime=0))
    temporary = BUNDLE.with_suffix('.js.tmp')
    temporary.write_bytes(patched)
    temporary.replace(BUNDLE)
    BUNDLE.with_suffix('.js.gz').write_bytes(gzip.compress(patched, mtime=0))
    record.write_text(json.dumps({
        'version': '3.13.12', 'source_sha256': source_hash,
        'original_sha256': PRISTINE_SHA256,
        'patched_sha256': hashlib.sha256(patched).hexdigest(),
    }, indent=2) + '\n')
    print('Applied Measurements panel fix; original bundle backed up')


if __name__ == '__main__':
    apply()
    apply_default_extension()
