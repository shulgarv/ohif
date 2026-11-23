// Extract the installed parser and pixel-loading path for local, patient-free reports.
// Decoding/rendering is covered separately by test-local-import.cjs in Chromium.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const source = fs.readFileSync(path.join(__dirname, '../www/app.bundle.872442cf365ecf1c.js'), 'utf8');
function cut(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.ok(start >= 0, 'Missing pinned module start: ' + startMarker);
  const end = source.indexOf(endMarker, start);
  assert.ok(end > start, 'Missing pinned module end: ' + endMarker);
  return source.slice(start, end);
}
const body = cut('5842(__unused_rspack_module, __webpack_exports__, __webpack_require__) {',
  '\n},\n45956(module)');
const requireModule = id => {
  assert.equal(id, 81429, 'Unexpected parser dependency');
  return {hp: Buffer};
};
requireModule.d = (exports, definitions) => {
  for (const [key, getter] of Object.entries(definitions)) {
    Object.defineProperty(exports, key, {get: getter});
  }
};
requireModule.g = globalThis;
const dcmjs_es = {};
new Function('__unused_rspack_module', '__webpack_exports__', '__webpack_require__',
  body.slice(body.indexOf('\n') + 1))(null, dcmjs_es, requireModule);
const enums = cut('var MetadataModules_MetadataModules;', '// EXTERNAL MODULE: ../../../node_modules/dcmjs');
const lowerCamel = cut('const toLowerCamelTag = (tag) => {', '\n};') + '\n};';
const listener = cut('const transferSyntax_tags = [',
  ';// CONCATENATED MODULE: ../../../node_modules/@cornerstonejs/metadata/dist/esm/utilities/dicomStream/index.js');
const frames = cut('const PIXEL_DATA_KEYS = [', 'const COMPRESSED_FRAME_DATA_TYPE =');
const {NaturalTagListener, compressedFrameDataFromNatural} = new Function('dcmjs_es',
  enums + lowerCamel + listener + frames + ';return {NaturalTagListener, compressedFrameDataFromNatural};')(dcmjs_es);
const loaderCode = cut('function loadImageFromNaturalizedMetadata(imageId, options = {}) {',
  'const loadImage = (imageId');

async function verify(input) {
  const reader = new dcmjs_es.Ay.async.AsyncDicomReader();
  reader.stream.addBuffer(input);
  reader.stream.setComplete();
  await reader.readFile({listener: NaturalTagListener.createMetadataListener()});
  const natural = reader.dict;
  natural.TransferSyntaxUID = reader.syntax;
  // Metadata comes from the real parser and frame provider. Stub only file I/O
  // (already supplied above) and the decoder boundary after pixel retrieval.
  const esm = {metaData: {
    get: () => natural,
    getTyped: () => compressedFrameDataFromNatural(natural, 0),
  }};
  const load = new Function('esm', 'dist_esm', 'wadouri_parseImageId', 'getLoaderForScheme',
    'NATURALIZED', 'imageLoader_createImage', 'concatPixelData', 'loadImage_ImageQualityStatus',
    loaderCode + ';return loadImageFromNaturalizedMetadata;')(
    esm, {fX: {nb: {COMPRESSED_FRAME_DATA: 'compressedFrameData'}}},
    () => ({scheme: 'dicomfile', url: 'test'}), () => null, 'naturalized',
    async () => ({}), value => value, {FULL_RESOLUTION: 1});
  await load('dicomfile:705').promise;
  return {pixel: !!natural.PixelData, syntax: reader.syntax};
}
module.exports = {verify, dcmjs_es, NaturalTagListener, compressedFrameDataFromNatural};
if (require.main === module) {
  (async () => {
    for (const file of process.argv.slice(2)) {
      const bytes = fs.readFileSync(file);
      const input = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      console.log(path.basename(file), await verify(input));
    }
  })().catch(error => {console.error('FAIL:', error.message); process.exitCode = 1;});
}
