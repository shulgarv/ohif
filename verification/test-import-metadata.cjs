// node verification/test-import-metadata.cjs <synthetic-dicom-folder>
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {dcmjs_es} = require('./bundled-pixel-loader.cjs');
const getDataset = new Function('dcmjs_es', 'return ({' +
  fs.readFileSync(path.join(__dirname, '../compatibility/dicom-loader.js'), 'utf8') + '}).getDataset;')(dcmjs_es);
(async () => {
  const cases = [];
  for (const name of fs.readdirSync(process.argv[2]).filter(name => name.endsWith('.dcm'))) {
    const original = fs.readFileSync(path.join(process.argv[2], name));
    const input = original.buffer.slice(original.byteOffset, original.byteOffset + original.byteLength);
    const full = dcmjs_es.Ay.data.DicomMessage.readFile(input);
    const expected = dcmjs_es.Ay.data.DicomMetaDictionary.naturalizeDataset(full.dict);
    const actual = await getDataset(input, 'dicomfile:metadata-test');
    for (const key of ['PixelData', 'FloatPixelData', 'DoubleFloatPixelData']) {
      assert.ok(actual[key] === undefined, name + ': pixel buffer retained in metadata');
      delete expected[key];
      if (expected._vrMap) delete expected._vrMap[key];
    }
    delete actual.url;
    delete actual._meta;
    delete actual.AvailableTransferSyntaxUID;
    assert.deepEqual(actual, expected, name + ': other metadata preserved');
    assert.deepEqual(Buffer.from(input), original, 'Source bytes changed');
    cases.push(name);
  }
  console.log(JSON.stringify({result:'PASS', cases, metadataPixelBytes:0}));
})().catch(error => {console.error('FAIL:', error.message); process.exitCode = 1;});
