"""Apply reproducible, version-checked local importer fixes to OHIF 3.13.12."""
import gzip
import hashlib
import json
from pathlib import Path
import shutil
import split_volume_texture
from viewer_ui import patch_ui_bundle

ROOT = Path(__file__).resolve().parent
BUNDLE = ROOT / 'www' / 'app.bundle.872442cf365ecf1c.js'
PRISTINE_SHA256 = '5cd20ee551a63e30329c04f30acf136395c745b18033752df412f1becfced993'
PATCH_DIR = ROOT / 'compatibility'


def apply():
    installed = BUNDLE.read_bytes()
    installed_hash = hashlib.sha256(installed).hexdigest()
    patch_sources = [Path(__file__), PATCH_DIR / 'dicom-loader.js',
                     PATCH_DIR / 'files-to-studies.js', PATCH_DIR / 'local-zip.js',
                     PATCH_DIR / 'async-un-sequence.js', ROOT / 'viewer_ui.py',
                     PATCH_DIR / 'compact-studies.js', PATCH_DIR / 'un-numeric-length.js',
                     ROOT / 'split_volume_texture.py']
    patch_sources.extend(sorted((PATCH_DIR / 'vendor').iterdir()))
    source_hash = hashlib.sha256(b''.join(p.read_bytes() for p in patch_sources)).hexdigest()
    record = PATCH_DIR / 'installed-patch.json'
    backup = PATCH_DIR / 'app.bundle.original.js.gz'
    if record.exists() and json.loads(record.read_text())['patched_sha256'] == installed_hash:
        if json.loads(record.read_text()).get('source_sha256') == source_hash:
            print('Local DICOM compatibility fixes already applied')
            return
        original = gzip.decompress(backup.read_bytes())
    else:
        original = installed
    original_hash = hashlib.sha256(original).hexdigest()
    if original_hash != PRISTINE_SHA256:
        raise RuntimeError('Unexpected OHIF bundle; refusing to modify an unknown build')
    source = original.decode('utf-8')
    source = source.replace('var ParsedUnknownValue =',
                            (PATCH_DIR / 'un-numeric-length.js').read_text() + '\nvar ParsedUnknownValue =', 1)
    # Both readers must honor the UN byte boundary before using dictionary VRs.
    sync_start = source.index('    key: "_readTag",')
    sync_end = source.index('    key: "lookupTag",', sync_start)
    sync = source[sync_start:sync_end]
    for old, new in [
        ('        vrType;', '        vrType;\n      var originalVR;'),
        ('        vrType = stream.readVR();', '        vrType = stream.readVR();\n        originalVR = vrType;'),
        ('      var values = [];', '''      if (originalVR === "UN" && localUnHasIncompatibleNumericLength(vrType, length)) {
        vr = ValueRepresentation.createByTypeString("UN");
      }
      var values = [];'''),
    ]:
        if sync.count(old) != 1:
            raise RuntimeError('Unexpected synchronous numeric UN implementation')
        sync = sync.replace(old, new)
    source = source[:sync_start] + sync + source[sync_end:]
    # The primary importer also reads known UN sequences. Parse their item
    # stream directly, preserving all items and the implicit little-endian VR.
    unknown_start = source.index('var ParsedUnknownValue =')
    unknown_end = source.index('var OtherWordString =', unknown_start)
    unknown = source[unknown_start:unknown_end]
    old = '      var arrayBuffer = this.readBytes(stream, length, syntax)[0];'
    new = '''      if (this.type === "SQ") {
        var outerLittleEndian = stream.isLittleEndian;
        stream.setEndian(true);
        try {
          return ValueRepresentation.createByTypeString("SQ").read(
            stream, length, IMPLICIT_LITTLE_ENDIAN, readOptions);
        } finally {
          stream.setEndian(outerLittleEndian);
        }
      }
      var arrayBuffer = this.readBytes(stream, length, syntax)[0];'''
    if unknown.count(old) != 1:
        raise RuntimeError('Unexpected synchronous UN reader implementation')
    unknown = unknown.replace(old, new)
    source = source[:unknown_start] + unknown + source[unknown_end:]
    # Preserve the on-wire VR before dcmjs resolves UN through its dictionary.
    reader_start = source.index('var AsyncDicomReader =')
    reader_end = source.index('_defineProperty(AsyncDicomReader,', reader_start)
    reader = source[reader_start:reader_end]
    header_start = reader.index('    key: "readTagHeader",')
    header = reader[header_start:]
    for old, new in [
        ('      var vrType;', '      var vrType;\n      var originalVR;'),
        ('        vrType = stream.readVR();',
         '        vrType = stream.readVR();\n        originalVR = vrType;'),
        ('        vrObj: vr,', '        vrObj: vr,\n        originalVR: originalVR,'),
        ('      var punctuatedTag =', '''      if (originalVR === "UN" && localUnHasIncompatibleNumericLength(vrType, length)) {
        vr = ValueRepresentation.createByTypeString("UN");
      }
      var punctuatedTag ='''),
    ]:
        if header.count(old) != 1:
            raise RuntimeError('Unexpected async DICOM tag header implementation')
        header = header.replace(old, new)
    reader = reader[:header_start] + header
    sequence_start = reader.index('    key: "readSequence",')
    value_start = reader.index('    value:', sequence_start)
    sequence_end = reader.index('\n  }, {', value_start)
    reader = (reader[:value_start]
              + (PATCH_DIR / 'async-un-sequence.js').read_text().rstrip()
              + reader[sequence_end:])
    source = source[:reader_start] + reader + source[reader_end:]
    start = source.index('  getDataset(image, imageId) {', source.index('const DICOMFileLoader ='))
    end = source.index('\n}();', start)
    source = source[:start] + (PATCH_DIR / 'dicom-loader.js').read_text().rstrip() + source[end:]
    start = source.index('const processFile = async file => {')
    end = source.index(';// CONCATENATED MODULE: ./routes/Local/Local.tsx', start)
    source = source[:start] + (PATCH_DIR / 'files-to-studies.js').read_text() + source[end:]
    old = '    const studies = await filesToStudies(acceptedFiles, dataSource);\n    const query = new URLSearchParams();'
    new = ('    const studies = await filesToStudies(acceptedFiles, dataSource);\n'
           '    if (!studies.length) { setDropInitiated(false); return; }\n'
           '    const query = new URLSearchParams();')
    if source.count(old) != 1:
        raise RuntimeError('Expected exactly one local importer entry point')
    source = source.replace(old, new)
    # Use the existing loading indicator for button imports as well as drops.
    source = source.replace('  const onDrop = async acceptedFiles => {\n    const studies',
                            '  const onDrop = async acceptedFiles => {\n    setDropInitiated(true);\n    const studies')
    start = source.index('const getLoadButton = (onDrop, text, isDir) => {')
    end = source.index('function Local({', start)
    button = source[start:end].replace('(onDrop, text, isDir)', '(onDrop, text, isDir, disabled = false)')
    button = button.replace('noDrag: true', 'noDrag: true,\n    disabled: disabled')
    button = button.replace('disabled: false', 'disabled: disabled')
    source = source[:start] + button + source[end:]
    source = source.replace('    ref: dropzoneRef,\n    onDrop:',
                            '    ref: dropzoneRef,\n    disabled: dropInitiated,\n    onDrop:')
    source = source.replace("getLoadButton(onDrop, 'Load files', false)", "getLoadButton(onDrop, 'Load files / ZIP', false, dropInitiated)")
    source = source.replace("getLoadButton(onDrop, 'Load folders', true)", "getLoadButton(onDrop, 'Load folders', true, dropInitiated)")
    source = source.replace('Drag and drop your DICOM files & folders here ',
                            'Drag and drop your DICOM files, ZIP archives & folders here ')
    if not backup.exists():
        backup.write_bytes(gzip.compress(original, mtime=0))
    source = split_volume_texture.patch_bundle(source)
    patched = patch_ui_bundle(source).encode('utf-8')
    zip_module = (PATCH_DIR / 'local-zip.js').read_bytes()
    (ROOT / 'www' / 'local-zip.js').write_bytes(zip_module)
    (ROOT / 'www' / 'local-zip.js.gz').write_bytes(gzip.compress(zip_module, mtime=0))
    vendor = ROOT / 'www' / 'vendor'
    vendor.mkdir(exist_ok=True)
    for asset in (PATCH_DIR / 'vendor').iterdir():
        shutil.copyfile(asset, vendor / asset.name)
    temporary = BUNDLE.with_suffix('.js.tmp')
    temporary.write_bytes(patched)
    temporary.replace(BUNDLE)
    BUNDLE.with_suffix('.js.gz').write_bytes(gzip.compress(patched, mtime=0))
    record.write_text(json.dumps({'version': '3.13.12', 'source_sha256': source_hash,
                                  'original_sha256': original_hash,
                                  'patched_sha256': hashlib.sha256(patched).hexdigest()}, indent=2) + '\n')
    print('Applied local DICOM compatibility fixes; original bundle backed up')


if __name__ == '__main__':
    apply()
