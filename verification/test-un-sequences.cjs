// Exercise the actual bundled dcmjs parser without allocating bogus gigabyte buffers.
// node verification/test-un-sequences.cjs <fixture-folder> [bundle]
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const fixtureRoot = process.argv[2];
const bundle = process.argv[3] || path.join(__dirname, '../www/app.bundle.872442cf365ecf1c.js');
const source = fs.readFileSync(bundle, 'utf8');
const start = source.indexOf('5842(__unused_rspack_module, __webpack_exports__, __webpack_require__) {');
assert.notEqual(start, -1, 'Pinned dcmjs module missing');
const bodyStart = source.indexOf('\n', start) + 1;
const end = source.indexOf('\n},\n45956(module)', bodyStart);
assert.notEqual(end, -1, 'Pinned dcmjs module boundary missing');
const requireModule = id => {
  assert.equal(id, 81429, 'Unexpected external dependency');
  return {hp: Buffer};
};
requireModule.d = (exports, definitions) => {
  for (const [key, getter] of Object.entries(definitions)) {
    Object.defineProperty(exports, key, {get: getter});
  }
};
requireModule.g = globalThis;
const exportsObject = {};
new Function('__unused_rspack_module', '__webpack_exports__', '__webpack_require__',
  source.slice(bodyStart, end))(null, exportsObject, requireModule);
const Reader = exportsObject.Ay.async.AsyncDicomReader;
const read = async buffer => {
  const reader = new Reader();
  const input = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  reader.stream.addBuffer(input);
  reader.stream.setComplete();
  const getBuffer = reader.stream.getBuffer;
  reader.stream.getBuffer = function(start, end) {
    assert.ok(end <= input.byteLength,
      `Parser requested ${end - start} bytes beyond a ${input.byteLength}-byte DICOM`);
    return getBuffer.call(this, start, end);
  };
  await reader.readFile();
  return reader;
};
(async () => {
  const results = [];
  for (const name of fs.readdirSync(fixtureRoot).filter(name => name.endsWith('.dcm')).sort()) {
    const input = fs.readFileSync(path.join(fixtureRoot, name));
    const reader = await read(input);
    const items = reader.dict['0040030E'].Value;
    assert.equal(items.length, 2, name + ': keep sequence items separate');
    assert.deepEqual(items.map(item => item['0008103E'].Value[0]), ['servTEST', 'second']);
    assert.equal(reader.dict['00401001'].Value[0], 'AFTER', name + ': restore outer syntax');
    assert.equal(reader.dict['00280010'].Value[0], 64);
    if (name.includes('nested') || name.includes('big-endian') || name.includes('explicit') || name.includes('implicit')) {
      for (const item of items) {
        assert.equal(item['00400275'].Value[0]['00401001'].Value[0], 'CHILD');
      }
    }
    const transferSyntax = reader.meta['00020010'].Value[0];
    assert.equal(reader.syntax, transferSyntax, name + ': restore transfer syntax');
    const synchronous = exportsObject.Ay.data.DicomMessage.readFile(
      input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength));
    assert.deepEqual(synchronous.dict['0040030E'].Value.map(item => item['0008103E'].Value[0]),
      ['servTEST', 'second'], name + ': primary importer reads both items');
    assert.equal(synchronous.dict['00401001'].Value[0], 'AFTER');
    results.push(name);
  }
  // Restore the outer syntax even if parsing an inner sequence throws.
  const ReaderClass = Reader;
  const failureReader = new ReaderClass();
  failureReader.syntax = '1.2.840.10008.1.2.2';
  failureReader.stream.setEndian(false);
  failureReader.stream.ensureAvailable = () => { throw new Error('synthetic read failure'); };
  await assert.rejects(failureReader.readSequence({}, {vr: 'SQ', originalVR: 'UN', length: 8}, {}),
    /synthetic read failure/);
  assert.equal(failureReader.syntax, '1.2.840.10008.1.2.2');
  assert.equal(failureReader.stream.isLittleEndian, false);
  console.log(JSON.stringify({result: 'PASS', cases: results, restoresSyntaxOnFailure: true}));
})().catch(error => {console.error('FAIL:', error.message); process.exitCode = 1;});
