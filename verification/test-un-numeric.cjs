// node verification/test-un-numeric.cjs <synthetic-fixture-folder>
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {verify, dcmjs_es, NaturalTagListener, compressedFrameDataFromNatural} = require('./bundled-pixel-loader.cjs');
(async () => {
  const checks = [];
  for (const name of fs.readdirSync(process.argv[2]).filter(n => n.endsWith('.dcm')).sort()) {
    const bytes = fs.readFileSync(path.join(process.argv[2], name));
    const input = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    // The real async parser, naturalization listener, frame provider and image loader.
    await verify(input);
    const reader = new dcmjs_es.Ay.async.AsyncDicomReader();
    reader.stream.addBuffer(input); reader.stream.setComplete();
    await reader.readFile({listener: NaturalTagListener.createMetadataListener()});
    reader.dict.TransferSyntaxUID = reader.syntax;
    const frame = compressedFrameDataFromNatural(reader.dict, 0);
    const sync = dcmjs_es.Ay.data.DicomMessage.readFile(input);
    const pixel = sync.dict['7FE00010'].Value[0];
    assert.deepEqual(Buffer.from(frame.pixelData[0]), Buffer.from(pixel), name + ': pixels unchanged');
    const tag = name.startsWith('fd') ? '00189318' : '00209057';
    if (/short|remainder/.test(name)) {
      assert.equal(sync.dict[tag].vr, 'UN', name + ': retain unknown VR');
      const key = name.startsWith('fd') ? 'ReconstructionTargetCenterPatient' : 'InStackPositionNumber';
      const raw = reader.dict[key];
      const buffer = Array.isArray(raw) ? raw.flat()[0] : raw;
      assert.equal(Buffer.from(buffer).toString(), name === 'fd-short.dcm' ? '1234' : name === 'ul-short.dcm' ? '12' : '1234567890');
    } else if (name === 'fd-valid.dcm') {
      assert.deepEqual(reader.dict.ReconstructionTargetCenterPatient, [1,2,3]);
    } else if (name === 'ul-valid.dcm') {
      assert.equal(reader.dict.InStackPositionNumber, 7);
    }
    checks.push(name);
  }
  const result = {result:'PASS', checks, pixelBytesUnchanged:true};
  fs.writeFileSync(path.join(__dirname, 'un-numeric.json'), JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify(result));
})().catch(error => {console.error('FAIL:', error.message); process.exitCode = 1;});
