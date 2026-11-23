// Run actual installed message validation and vector math; synthetic metadata only.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'www/app.bundle.872442cf365ecf1c.js'), 'utf8');
const extension = fs.readFileSync(process.argv[2] || path.join(root, 'www/89.bundle.195151dd43a14c57.js'), 'utf8');
const cache = new Map();
function req(id) {
  if (cache.has(id)) return cache.get(id).exports;
  const marker = new RegExp('^' + id + '\\([^\\n]+\\) \\{', 'm');
  const match = marker.exec(app);
  assert.ok(match, 'Missing core module ' + id);
  const start = match.index + match[0].length;
  const tail = app.slice(start);
  const end = /\n},\n\d+\(/.exec(tail);
  assert.ok(end, 'Missing module end ' + id);
  const module = {exports: {}};
  cache.set(id, module);
  new Function('module', '__webpack_exports__', '__webpack_require__', tail.slice(0, end.index))(module, module.exports, req);
  return module.exports;
}
req.d = (exports, definitions) => Object.entries(definitions).forEach(([key, get]) => Object.defineProperty(exports, key, {get}));
req.r = exports => Object.defineProperty(exports, '__esModule', {value: true});
const codes = new Proxy({}, {get: (_, key) => key});
const src = {WZ: class {
  constructor() {this.codes = [];}
  addMessage(code) {this.codes.push(code);}
}, Ob: {CODES: codes}, Wp: {
  toNumber: req(71914).A,
  calculateScanAxisNormal: req(13533).A,
  areAllImageOrientationsEqual: req(13191).A,
}};
const start = extension.indexOf('function checkMultiFrame(');
const end = extension.indexOf('// EXTERNAL MODULE: ../../core/src/classes/ImageSet.ts', start);
assert.ok(start > 0 && end > start);
const validate = new Function('src', 'isDisplaySetReconstructable', 'sortInstancesByPosition', '__webpack_require__',
  extension.slice(start, end) + '\nreturn getDisplaySetMessages;')(src, req(93208), req(4044), req);
const image = (n, positioned = true) => ({Modality:'CT', Rows:64, Columns:64, SamplesPerPixel:1,
  ImageType:['DERIVED','SECONDARY'], InstanceNumber:n,
  ...(positioned ? {ImagePositionPatient:[0,0,n], ImageOrientationPatient:[1,0,0,0,1,0], PixelSpacing:[1,1]} : {})});
const cases = [
  {name:'mixed-position', images:[image(1), image(2,false), image(3), image(4,false), image(5,false)], positioned:false},
  {name:'mixed-orientation-only', images:[image(1), {...image(2),ImageOrientationPatient:[0,1,0,0,0,-1]},image(3)], positioned:true},
  {name:'mixed-position-and-orientation', images:[image(1), image(2,false), {...image(3),ImageOrientationPatient:[0,1,0,0,0,-1]},image(4,false),image(5,false)], positioned:false},
  {name:'no-positions', images:[image(1,false),image(2,false),image(3,false)], positioned:false},
  {name:'normal-axial', images:[image(1),image(2),image(3)], positioned:true},
  {name:'localizer', images:[{...image(1),ImageType:['LOCALIZER']},image(2,false)], localizer:true},
  {name:'multiframe-no-position', images:[{...image(1,false),NumberOfFrames:3}], multiframe:true},
];
if (process.env.OHIF_GEOMETRY_JSON) {
  const series = JSON.parse(fs.readFileSync(process.env.OHIF_GEOMETRY_JSON, 'utf8'));
  series.forEach((images, index) => cases.push({name:'archive-series-' + index, images,
    positioned:images.every(item => item.ImagePositionPatient)}));
}
const selected = process.env.OHIF_CASE ? cases.filter(test => test.name.includes(process.env.OHIF_CASE)) : cases;
assert.ok(selected.length, 'No selected validation cases');
for (const test of selected) {
  const before = JSON.stringify(test.images);
  const messages = validate(test.images, test.name === 'normal-axial', false);
  assert.equal(JSON.stringify(test.images), before, 'Metadata changed');
  if (test.positioned === false) {
    assert.ok(messages.codes.includes('NO_POSITION_INFORMATION'));
    assert.ok(messages.codes.includes('NOT_RECONSTRUCTABLE'));
  }
  if (test.name === 'normal-axial' || test.localizer) assert.deepEqual(messages.codes, []);
  if (test.multiframe) assert.ok(messages.codes.includes('MULTIFRAME_NO_POSITION_INFORMATION'));
}
console.log(JSON.stringify({result:'PASS', cases:selected.map(test=>test.name), metadataUnchanged:true}));
