// Exercise installed ZIP/importer/parser code locally, without a patient-data browser.
// node verification/verify-local-import.cjs <zip-or-folder> <report-json>
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {spawn} = require('node:child_process');
const {dcmjs_es} = require('./bundled-pixel-loader.cjs');
const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'www/app.bundle.872442cf365ecf1c.js'), 'utf8');
const zip = require('../compatibility/vendor/zip-native-2.23.0.min.js');
zip.configure({useWebWorkers: false, useCompressionStream: true});
const zipSource = fs.readFileSync(path.join(root, 'www/local-zip.js'), 'utf8');
const openLocalZip = new Function('getLibrary',
  zipSource.slice(zipSource.indexOf('export async function')).replace('export async function', 'async function') +
  '\nreturn openLocalZip;')(async () => zip);
const start = source.indexOf('  async getDataset(image, imageId) {', source.indexOf('const DICOMFileLoader ='));
assert.ok(start > 0);
const end = source.indexOf('\n}();', start);
const importerStart = source.indexOf('async function filesToStudies(files) {');
const importerEnd = source.indexOf(';// CONCATENATED MODULE: ./routes/Local/Local.tsx', importerStart);
assert.ok(importerStart > 0 && importerEnd > importerStart);
const python = spawn(path.join(root, '.venv/bin/python'), ['-u', '-c', `
import base64, json, sys
from local_metadata import read_metadata
for line in sys.stdin:
    request = json.loads(line)
    try:
        result = {'id': request['id'], 'ok': True, 'body': read_metadata(base64.b64decode(request['data']))}
    except Exception:
        result = {'id': request['id'], 'ok': False}
    print(json.dumps(result, ensure_ascii=False, allow_nan=False), flush=True)
`], {cwd: root, stdio: ['pipe', 'pipe', 'pipe']});
let sequence = 0, responses = '', fallbackRequests = 0, parserWarnings = 0;
const pending = new Map();
python.stdout.setEncoding('utf8');
python.stdout.on('data', chunk => {
  responses += chunk;
  let newline;
  while ((newline = responses.indexOf('\n')) >= 0) {
    const result = JSON.parse(responses.slice(0, newline));
    responses = responses.slice(newline + 1);
    const resolve = pending.get(result.id);
    pending.delete(result.id);
    resolve({ok: result.ok, json: async () => result.body});
  }
});
python.on('exit', code => {
  for (const resolve of pending.values()) resolve({ok: false});
  pending.clear();
});
// Never echo worker diagnostics: malformed DICOM warnings can contain patient text.
let workerDiagnostics = false;
python.stderr.on('data', () => {workerDiagnostics = true;});
const fetchMetadata = (url, options) => {
  assert.equal(url, '/api/local-dicom-metadata');
  fallbackRequests++;
  const id = sequence++;
  return new Promise(resolve => {
    pending.set(id, resolve);
    python.stdin.write(JSON.stringify({id, data: Buffer.from(options.body).toString('base64')}) + '\n');
  });
};
const getDataset = new Function('dcmjs_es', 'fetch',
  'return ({' + source.slice(start, end) + '}).getDataset;')(dcmjs_es, fetchMetadata);
const studies = new Set(), series = new Set(), instances = new Set();
let metadataPixelBuffers = 0;
const core = {H8: {
  addInstance: dataset => {
    studies.add(dataset.StudyInstanceUID);
    series.add(dataset.SeriesInstanceUID);
    instances.add(dataset.SOPInstanceUID);
    for (const tag of ['PixelData', 'FloatPixelData', 'DoubleFloatPixelData']) {
      if (dataset[tag]) metadataPixelBuffers++;
    }
  },
  getStudyInstanceUIDs: () => [...studies],
}};
class FileLoader {
  addFile() { return 'dicomfile:local-verification'; }
  async loadFile(file) { return file.arrayBuffer(); }
  getDataset(image, imageId) { return getDataset(image, imageId); }
}
const dialogs = [];
const windowStub = {alert: message => dialogs.push(message)};
const filesToStudies = new Function('Local_fileLoaderService', 'core_src', 'window', 'loadZipModule',
  source.slice(importerStart, importerEnd).replace("import('/local-zip.js')", 'loadZipModule()') +
  '\nreturn filesToStudies;')(FileLoader, core, windowStub, async () => ({openLocalZip}));
function walk(folder) {
  return fs.readdirSync(folder, {withFileTypes: true}).flatMap(entry => {
    const file = path.join(folder, entry.name);
    return entry.isDirectory() ? walk(file) : [file];
  });
}
async function fingerprint(files) {
  const hash = crypto.createHash('sha256');
  for (const file of files) {
    hash.update(path.relative(process.argv[2], file));
    for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  }
  return hash.digest('hex');
}
(async () => {
  const isZip = fs.statSync(process.argv[2]).isFile();
  const paths = isZip ? [process.argv[2]] : walk(process.argv[2]).sort();
  const before = await fingerprint(paths);
  const files = await Promise.all(paths.map(async file =>
    new File([await fs.openAsBlob(file)], path.basename(file))));
  const warn = console.warn;
  console.warn = () => {parserWarnings++;};
  try { await filesToStudies(files); }
  finally {console.warn = warn; python.stdin.end();}
  const summary = windowStub.__ohifLocalImportSummary;
  assert.equal(summary.failed, 0, 'DICOM files rejected by the installed importer');
  assert.ok(summary.imported > 0 && studies.size > 0, 'No available DICOM studies');
  assert.equal(dialogs.length, 0, 'Import displayed an error dialog');
  assert.equal(metadataPixelBuffers, 0, 'Pixel buffers retained by metadata store');
  assert.equal(await fingerprint(paths), before, 'Source files changed');
  const result = {result: 'PASS', input: path.basename(process.argv[2]), inputType: isZip ? 'ZIP' : 'folder',
    sourceSha256: before, summary, zipSummary: windowStub.__ohifLocalZipSummary,
    studies: studies.size, series: series.size, instances: instances.size,
    repeatedInstances: summary.imported - instances.size, fallbackRequests,
    parserWarnings, workerDiagnostics, errorDialogs: dialogs.length, metadataPixelBuffers,
    sourcesUnchanged: true, browserUsed: false};
  fs.writeFileSync(process.argv[3], JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result));
})().catch(error => {python.kill(); console.error('FAIL:', error.message); process.exitCode = 1;});
