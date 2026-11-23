// OHIF_PLAYWRIGHT_PATH=/path/to/playwright node verification/test-un-sequences-browser.cjs <fixtures>
const {chromium} = require(process.env.OHIF_PLAYWRIGHT_PATH || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
(async () => {
  const browser = await chromium.launch({executablePath: '/usr/bin/chromium',
    args: ['--disable-dev-shm-usage', '--use-angle=swiftshader', '--enable-unsafe-swiftshader']});
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/app.bundle.872442cf365ecf1c.js', async route => {
      const response = await route.fetch();
      const body = await response.text();
      const marker = 'var async = {\n  AsyncDicomReader: AsyncDicomReader\n};';
      assert.ok(body.includes(marker));
      await route.fulfill({response,
        body: body.replace(marker, marker + '\nglobalThis.__ohifUnSequenceReader = AsyncDicomReader;')});
    });
    await page.goto('http://127.0.0.1:3000/localbasic', {waitUntil: 'networkidle'});
    const results = [];
    for (const name of fs.readdirSync(process.argv[2]).filter(name => name.endsWith('.dcm')).sort()) {
      const payload = Array.from(fs.readFileSync(path.join(process.argv[2], name)));
      const parsed = await page.evaluate(async payload => {
        const buffer = new Uint8Array(payload).buffer;
        const reader = new globalThis.__ohifUnSequenceReader();
        reader.stream.addBuffer(buffer);
        reader.stream.setComplete();
        const getBuffer = reader.stream.getBuffer;
        let largestRequest = 0;
        reader.stream.getBuffer = function(start, end) {
          if (end > buffer.byteLength) throw new Error('Parser requested data beyond DICOM');
          largestRequest = Math.max(largestRequest, end - start);
          return getBuffer.call(this, start, end);
        };
        await reader.readFile();
        const items = reader.dict['0040030E'].Value;
        return {names: items.map(item => item['0008103E'].Value[0]),
          nested: items.map(item => item['00400275']?.Value[0]?.['00401001'].Value[0]),
          after: reader.dict['00401001'].Value[0],
          syntaxRestored: reader.syntax === reader.meta['00020010'].Value[0], largestRequest};
      }, payload);
      assert.deepEqual(parsed.names, ['servTEST', 'second'], name);
      assert.equal(parsed.after, 'AFTER', name);
      assert.equal(parsed.syntaxRestored, true, name);
      if (name.includes('nested') || name.includes('big-endian') || name.includes('explicit') || name.includes('implicit')) {
        assert.deepEqual(parsed.nested, ['CHILD', 'CHILD'], name);
      }
      results.push({name, largestRequest: parsed.largestRequest});
    }
    assert.deepEqual(errors, []);
    const result = {result: 'PASS', cases: results, javascriptErrors: errors.length};
    fs.writeFileSync(path.join(__dirname, 'un-sequences.json'), JSON.stringify(result, null, 2) + '\n');
    console.log(JSON.stringify(result));
  } finally {await browser.close();}
})().catch(error => {console.error('FAIL:', error.message); process.exitCode = 1;});
