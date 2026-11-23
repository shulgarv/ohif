// Run: OHIF_PLAYWRIGHT_PATH=/path/to/playwright node test-local-import.cjs <folder> <expected-images> <expected-directories> <expected-failed>
const {chromium} = require(process.env.OHIF_PLAYWRIGHT_PATH || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const [folder, images, directories, failed] = process.argv.slice(2);
const expected = {imported: Number(images), directories: Number(directories), failed: Number(failed)};
const fingerprints = root => {
  if (fs.statSync(root).isFile()) return {[root]: crypto.createHash('sha256').update(fs.readFileSync(root)).digest('hex')};
  const result = {};
  for (const entry of fs.readdirSync(root, {withFileTypes: true})) {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) Object.assign(result, fingerprints(file));
    else if (entry.isFile()) result[file] = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  }
  return result;
};
(async () => {
  const before = fingerprints(folder);
  const browser = await chromium.launch({executablePath:'/usr/bin/chromium', args:['--disable-dev-shm-usage','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
  try {
    const page = await browser.newPage({viewport: {width: 1400, height: 1000}});
    const errors = [], dialogs = [], external = [];
    let fallbackRequests = 0;
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => {
      if (message.type() === 'error' && /StudyInstanceUID|reading 'series'/.test(message.text())) errors.push('invalid study metadata');
    });
    page.on('dialog', async dialog => {dialogs.push(dialog.message()); await dialog.accept()});
    page.on('request', request => {
      const url = request.url();
      if (url.includes('/api/local-dicom-metadata')) fallbackRequests++;
      if (/^https?:/.test(url) && !url.startsWith('http://127.0.0.1:3000/')) external.push(url);
    });
    await page.goto('http://127.0.0.1:3000/localbasic', {waitUntil: 'networkidle'});
    await page.getByRole('button', {name:'Load folders', exact:true}).waitFor();
    if (process.env.OHIF_EXPECT_LOADING === '1') {
      await page.route('**/local-zip.js', async route => {
        await new Promise(resolve => setTimeout(resolve, 750));
        await route.continue();
      });
    }
    if (process.env.OHIF_TEST_DROP === '1') {
      const base64 = fs.readFileSync(folder).toString('base64');
      await page.evaluate(({base64, name}) => {
        const bytes = Uint8Array.from(atob(base64), char => char.charCodeAt(0));
        const transfer = new DataTransfer();
        transfer.items.add(new File([bytes], name, {type:'application/zip'}));
        document.querySelector('input[webkitdirectory]').dispatchEvent(new DragEvent('drop', {bubbles:true, dataTransfer:transfer}));
      }, {base64, name:path.basename(folder)});
    } else if (fs.statSync(folder).isFile()) {
      await page.getByRole('button', {name:'Load files / ZIP', exact:true}).waitFor();
      await page.locator('input[type=file]:not([webkitdirectory])').setInputFiles(folder);
    } else {
      await page.locator('input[webkitdirectory]').setInputFiles(folder);
    }
    if (process.env.OHIF_EXPECT_LOADING === '1') {
      assert.equal(await page.getByRole('button', {name:'Load files / ZIP', exact:true}).isDisabled(), true);
    }
    if (expected.imported > 0) {
      await page.waitForFunction(() => document.querySelector('canvas') || new URLSearchParams(location.search).getAll('StudyInstanceUIDs').includes('undefined'), {}, {timeout: Number(process.env.OHIF_IMPORT_TIMEOUT || 60000)});
      const invalidUID = await page.evaluate(() => new URLSearchParams(location.search).getAll('StudyInstanceUIDs').includes('undefined'));
      assert.equal(invalidUID, false, 'DICOMDIR produced an undefined study identifier');
      await page.waitForFunction(() => {
        const canvas = document.querySelector('canvas');
        if (!canvas || !canvas.width || !canvas.height) return false;
        const copy = document.createElement('canvas'); copy.width = canvas.width; copy.height = canvas.height;
        const context = copy.getContext('2d'); context.drawImage(canvas, 0, 0);
        const data = context.getImageData(0, 0, copy.width, copy.height).data;
        let bright = 0;
        for (let i = 0; i < data.length; i += 4) if (Math.max(data[i], data[i+1], data[i+2]) > 5) bright++;
        return bright / (copy.width * copy.height) > 0.01;
      }, {}, {timeout: 45000});
    } else {
      await page.waitForFunction(() => window.__ohifLocalImportSummary, {}, {timeout: 30000});
      assert.equal(new URL(page.url()).pathname, '/localbasic');
      assert.equal(await page.getByRole('button', {name:'Load folders', exact:true}).isVisible(), true);
      assert.equal(await page.getByRole('button', {name:'Load folders', exact:true}).isEnabled(), true);
    }
    const summary = await page.evaluate(() => window.__ohifLocalImportSummary);
    assert.deepEqual(summary, expected);
    if (process.env.OHIF_EXPECT_ZIPS) {
      const zipSummary = await page.evaluate(() => window.__ohifLocalZipSummary);
      assert.equal(zipSummary.archives, Number(process.env.OHIF_EXPECT_ZIPS));
    }
    assert.equal(dialogs.length, expected.failed > 0 || expected.imported === 0 ? 1 : 0);
    assert.deepEqual(errors, []);
    assert.deepEqual(external, []);
    assert.deepEqual(fingerprints(folder), before, 'Source files changed');
    if (process.env.OHIF_EXPECT_CYRILLIC === '1') {
      assert.equal(fallbackRequests, expected.imported);
      assert.match(await page.locator('body').innerText(), /Тестовая серия/);
    }
    console.log(JSON.stringify({result: 'PASS', summary, fallbackRequests, rendered: expected.imported > 0, sourceHashesUnchanged: true, externalRequests: external.length}));
  } finally {await browser.close()}
})().catch(error => {console.error('FAIL:', error.message); process.exitCode = 1});
