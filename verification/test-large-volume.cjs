// Exercise the pure MPR volume-size policy; no DICOM files or patient data.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'app-config.js'), 'utf8');
const context = {window: {}};
vm.createContext(context);
vm.runInContext(source, context);
const factor = context.localMprVolumeDecimationFactor;
assert.equal(typeof factor, 'function', 'Missing volume decimation policy');

const metadata = {
  imagePlaneModule: {rows: 1024, columns: 1024},
  imagePixelModule: {bitsAllocated: 16, samplesPerPixel: 1},
};
const get = type => metadata[type];
const ids = count => Array.from({length: count}, (_, index) => `image-${index}`);
const cases = [
  {name: 'large-ct-1024', imageIds: ids(629), caps: {norm16: true}, expected: 2},
  {name: 'large-ct-no-norm16', imageIds: ids(629), caps: {norm16: false}, expected: 3},
  {name: 'small-ct-512', imageIds: ids(64),
    meta: {imagePlaneModule: {rows: 512, columns: 512}}, caps: {norm16: true}, expected: 1},
  {name: 'rgb-8bit', imageIds: ids(64),
    meta: {imagePlaneModule: {rows: 512, columns: 512},
      imagePixelModule: {bitsAllocated: 8, samplesPerPixel: 3}},
    caps: {norm16: true}, expected: 1},
  {name: 'single-image', imageIds: ids(1), caps: {norm16: true}, expected: 1},
  {name: 'missing-geometry', imageIds: ids(629), meta: {}, caps: {norm16: true}, expected: 1},
];
for (const test of cases) {
  const previous = metadata.imagePlaneModule;
  const previousPixel = metadata.imagePixelModule;
  if (test.meta) {
    metadata.imagePlaneModule = test.meta.imagePlaneModule ?? {};
    metadata.imagePixelModule = test.meta.imagePixelModule ?? {};
  }
  const input = [...test.imageIds];
  const actual = factor(input, get, test.caps);
  metadata.imagePlaneModule = previous;
  metadata.imagePixelModule = previousPixel;
  assert.equal(actual, test.expected, `${test.name}: expected ${test.expected}, got ${actual}`);
  assert.deepEqual(input, test.imageIds, `${test.name}: image ids changed`);
}
// With the split-volume patch installed the full resolution is kept whenever
// two textures are enough; the decimation stays as a fallback only.
const splitContext = {window: {__ohifLocalVolumeTextureSplit: {enabled: true, limitBytes: 900 * 1024 * 1024}}};
vm.createContext(splitContext);
vm.runInContext(source, splitContext);
assert.equal(splitContext.localMprVolumeDecimationFactor(ids(629), get, {norm16: true}), 1,
  'split volume upload must keep the full in-plane resolution');
// Without norm16 Cornerstone uses Float32 (2.46 GiB): two textures are not
// enough, so the in-plane fallback still applies.
assert.equal(splitContext.localMprVolumeDecimationFactor(ids(629), get, {norm16: false}), 3,
  'volumes larger than two textures must fall back to decimation');
// 1024x1024x2048 Float32 is 8 GiB: far more than two textures can hold.
assert.equal(splitContext.localMprVolumeDecimationFactor(ids(2048), get, {norm16: false}), 4,
  'volumes larger than two textures still fall back to decimation');
assert.match(source, /registerVolumeLoader\('cornerstoneStreamingImageVolume'/);
assert.match(source, /decimatedVolumeLoader\(volumeId/);
assert.match(source, /ijkDecimation: \[factor, factor, 1\]/);
assert.doesNotMatch(source, /ijkDecimation: \[1, 1, factor\]/);
assert.match(source, /#decimation=/);
console.log(JSON.stringify({result: 'PASS', cases: cases.map(test => test.name),
  inputImageIdsUnchanged: true}));
