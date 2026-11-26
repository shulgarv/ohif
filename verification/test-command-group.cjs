// Regression: a dataset that starts with a command group (0000,xxxx).
// node verification/test-command-group.cjs <synthetic-fixture-folder>
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {verify, dcmjs_es, NaturalTagListener, compressedFrameDataFromNatural} =
  require('./bundled-pixel-loader.cjs');

(async () => {
  const checks = [];
  const names = fs.readdirSync(process.argv[2]).filter(name => name.endsWith('.dcm')).sort();
  assert.ok(names.length > 0, 'no fixtures');
  for (const name of names) {
    const bytes = fs.readFileSync(path.join(process.argv[2], name));
    const input = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    // The real async parser, naturalization listener, frame provider and loader.
    await verify(input);
    const reader = new dcmjs_es.Ay.async.AsyncDicomReader();
    reader.stream.addBuffer(input);
    reader.stream.setComplete();
    await reader.readFile({listener: NaturalTagListener.createMetadataListener()});
    reader.dict.TransferSyntaxUID = reader.syntax;
    // Elements after the command group must survive, not only the pixel data.
    assert.ok(reader.dict.SOPInstanceUID, name + ': dataset truncated');
    assert.ok(reader.dict.Rows && reader.dict.Columns, name + ': image geometry missing');
    const frame = compressedFrameDataFromNatural(reader.dict, 0);
    assert.ok(frame, name + ': no pixel data in NATURALIZED');
    const sync = dcmjs_es.Ay.data.DicomMessage.readFile(input);
    assert.deepEqual(Buffer.from(frame.pixelData[0]),
      Buffer.from(sync.dict['7FE00010'].Value[0]), name + ': pixels differ from the sync reader');
    // The command group elements are skipped, not merged into the dataset.
    assert.equal(reader.dict.CommandGroupLength, undefined, name + ': command group kept');
    checks.push({name, tags: Object.keys(reader.dict).length, pixelBytes: frame.pixelData[0].byteLength});
  }
  const result = {result: 'PASS', checks};
  fs.writeFileSync(path.join(__dirname, 'command-group.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result));
})().catch(error => { console.error('FAIL:', error.message); process.exitCode = 1; });
