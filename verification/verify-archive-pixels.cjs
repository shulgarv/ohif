// Local parser verification only: source DICOM files never enter a browser.
// node verification/verify-archive-pixels.cjs <archive> <result-json> [pydicom-reference-json]
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {dcmjs_es, NaturalTagListener, compressedFrameDataFromNatural} = require('./bundled-pixel-loader.cjs');
const zip = require('../compatibility/vendor/zip-native-2.23.0.min.js');
zip.configure({useWebWorkers:false, useCompressionStream:true});
const sha = buffer => crypto.createHash('sha256').update(buffer).digest('hex');
(async () => {
  const original = fs.readFileSync(process.argv[2]);
  const before = sha(original);
  const reference = process.argv[4] ? JSON.parse(fs.readFileSync(process.argv[4], 'utf8')) : null;
  if (reference) assert.equal(reference.archiveSha256, before, 'Pixel reference belongs to another archive');
  const archive = new zip.ZipReader(new zip.Uint8ArrayReader(original));
  const entries = await archive.getEntries();
  let verified = 0, directories = 0;
  const preserved = {};
  const warnings = new Set();
  // Capture only parser warnings, never patient text or file paths.
  const warn = console.warn;
  console.warn = message => warnings.add(String(message).replace(/[^\x20-\x7e]/g, '?'));
  try {
    for (const entry of entries.filter(e => !e.directory && /\.dcm$/i.test(e.filename))) {
      const bytes = await entry.getData(new zip.Uint8ArrayWriter(), {checkSignature:true});
      const input = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      const reader = new dcmjs_es.Ay.async.AsyncDicomReader();
      reader.stream.addBuffer(input); reader.stream.setComplete();
      await reader.readFile({listener:NaturalTagListener.createMetadataListener()});
      if (reader.meta['00020002']?.Value?.[0] === '1.2.840.10008.1.3.10') {
        directories++;
        continue;
      }
      reader.dict.TransferSyntaxUID = reader.syntax;
      const frame = compressedFrameDataFromNatural(reader.dict, 0);
      assert.ok(frame, 'no pixel data in NATURALIZED at DICOM ordinal ' + verified);
      if (reference) {
        const expected = reference.frames[verified];
        assert.equal(frame.transferSyntaxUid, expected.transferSyntaxUid);
        assert.equal(sha(Buffer.concat(frame.pixelData.map(b => Buffer.from(b)))),
          expected.pixelSha256, 'Pixel mismatch at DICOM ordinal ' + verified);
      } else {
        const primary = dcmjs_es.Ay.data.DicomMessage.readFile(input);
        assert.equal(frame.transferSyntaxUid, primary.meta['00020010'].Value[0]);
        assert.deepEqual(Buffer.concat(frame.pixelData.map(b => Buffer.from(b))),
          Buffer.from(primary.dict['7FE00010'].Value[0]), 'Pixel mismatch at DICOM ordinal ' + verified);
        for (const tag of ['00189318','00189323','00189324']) {
          if (primary.dict[tag]?.vr === 'UN') preserved[tag] = (preserved[tag] || 0) + 1;
        }
      }
      verified++;
    }
  } finally {console.warn = warn; await archive.close();}
  assert.equal(sha(fs.readFileSync(process.argv[2])), before, 'Source archive changed');
  if (reference) assert.equal(verified, reference.frames.length, 'Pixel reference count mismatch');
  const result = {result:'PASS', archive:path.basename(process.argv[2]), sha256:before,
    verified, directories, pixelBytesUnchanged:true, sourceArchiveUnchanged:true, preservedUnknownTags:preserved,
    comparisonReader: reference ? 'pydicom' : 'dcmjs-sync', parserWarnings:[...warnings]};
  fs.writeFileSync(process.argv[3], JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify(result));
})().catch(error => {console.error('FAIL:',error.message); process.exitCode = 1;});
