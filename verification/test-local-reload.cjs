// Run with OHIF_PLAYWRIGHT_PATH pointing to the installed Playwright package.
const {chromium} = require(process.env.OHIF_PLAYWRIGHT_PATH || 'playwright');
const assert = require('node:assert/strict');
const fixtureRoot = process.argv[2] || '/tmp/ohif-import-fixtures';
(async () => {
  const browser = await chromium.launch({executablePath:'/usr/bin/chromium', args:['--disable-dev-shm-usage','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('http://127.0.0.1:3000/localbasic', {waitUntil:'networkidle'});
    await page.locator('input[webkitdirectory]').setInputFiles(fixtureRoot + '/directory');
    await page.waitForFunction(() => document.querySelector('canvas'), {}, {timeout:30000});
    assert.equal(new URL(page.url()).pathname, '/viewer/dicomlocal');
    await page.reload({waitUntil:'networkidle'});
    assert.equal(new URL(page.url()).pathname, '/localbasic', 'Reload left a stale viewer route');
    assert.equal(await page.getByRole('button', {name:'Load folders', exact:true}).isVisible(), true);
    assert.equal(await page.locator('canvas').count(), 0);
    await page.locator('input[webkitdirectory]').setInputFiles(fixtureRoot + '/charset');
    await page.waitForFunction(() => document.querySelector('canvas'), {}, {timeout:30000});
    await page.waitForFunction(() => document.body.innerText.includes('Тестовая серия'), {}, {timeout:30000});
    assert.equal(await page.getByText('OHIF Viewer is', {exact:false}).count(), 0);
    await page.reload({waitUntil:'networkidle'});
    assert.equal(await page.getByRole('button', {name:'Load folders', exact:true}).isVisible(), true);
    await page.goto('http://127.0.0.1:3000/viewer/dicomlocal?StudyInstanceUIDs=1.2.3&datasources=dicomlocal', {waitUntil:'networkidle'});
    assert.equal(new URL(page.url()).pathname, '/localbasic');
    await page.goto('http://127.0.0.1:3000/microscopy?StudyInstanceUIDs=1.2.3&datasources=dicomlocal', {waitUntil:'networkidle'});
    assert.equal(new URL(page.url()).pathname, '/localbasic');
    await page.reload({waitUntil:'networkidle'});
    assert.equal(await page.getByRole('button', {name:'Load folders', exact:true}).isVisible(), true);
    assert.deepEqual(errors, []);
    console.log('PASS: reload returns to folder chooser; reimport renders another study; stale local URLs recover; dialog stays hidden');
  } finally {await browser.close()}
})().catch(error => {console.error('FAIL:', error.message); process.exitCode=1});
