// Use only the synthetic ZIP from make-large-import-fixture.py.
// OHIF_PLAYWRIGHT_PATH=<path> OHIF_CHROMIUM_PATH=<optional limit wrapper> node verification/test-large-import.cjs <zip>
const {chromium} = require(process.env.OHIF_PLAYWRIGHT_PATH || 'playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
(async () => {
  const browser = await chromium.launch({
    executablePath: process.env.OHIF_CHROMIUM_PATH || '/usr/bin/chromium',
    args: ['--disable-dev-shm-usage', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  });
  const result = {crashed:false, imported:0, retainedPixelBytes:0};
  let timer;
  try {
    const page = await browser.newPage({viewport:{width:1400,height:1000}});
    const errors = [], external = [];
    page.on('crash', () => {result.crashed = true;});
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => {
      if (/^https?:/.test(request.url()) && !request.url().startsWith('http://127.0.0.1:3000/')) external.push(request.url());
    });
    // Count bytes at the actual metadata-store call; do not change importer behavior.
    await page.route('**/app.bundle.872442cf365ecf1c.js', async route => {
      const response = await route.fetch();
      const source = await response.text();
      const marker = 'core_src/* .DicomMetadataStore.addInstance */.H8.addInstance(dataset);';
      assert.ok(source.includes(marker));
      await route.fulfill({response,body:source.replace(marker, marker + `
        window.__memoryProbe ||= {imported:0,retainedPixelBytes:0};
        window.__memoryProbe.imported++;
        for (const key of ['PixelData','FloatPixelData','DoubleFloatPixelData']) {
          window.__memoryProbe.retainedPixelBytes += (dataset[key]||[]).reduce((n,b)=>n+(b.byteLength||0),0);
        }
      `)});
    });
    await page.route('**/app-config.js', async route => {
      const response = await route.fetch();
      await route.fulfill({response,body:await response.text() + `
        const cfg = window.config.modesConfiguration['@ohif/mode-longitudinal'].initToolGroups;
        const apply = cfg.$apply;
        cfg.$apply = initialize => {
          const configured = apply(initialize);
          return function(context) {window.__ohifTestContext=context;return configured.call(this,context);};
        };
      `});
    });
    await page.goto('http://127.0.0.1:3000/localbasic', {waitUntil:'networkidle'});
    const cdp = await page.context().newCDPSession(page);
    let polling = false;
    timer = setInterval(async () => {
      if (polling) return;
      polling = true;
      try {
        Object.assign(result, await page.evaluate(() => window.__memoryProbe || {}));
        const heap = await cdp.send('Runtime.getHeapUsage');
        result.peakSampledBackingStorage = Math.max(result.peakSampledBackingStorage || 0, heap.backingStorageSize || 0);
      } catch {} finally {polling = false;}
    }, 5000);
    await page.locator('input[type=file]:not([webkitdirectory])').setInputFiles(process.argv[2]);
    await page.waitForFunction(() => window.__ohifLocalImportSummary, {}, {timeout:120000});
    result.summary = await page.evaluate(() => window.__ohifLocalImportSummary);
    Object.assign(result, await page.evaluate(() => window.__memoryProbe));
    assert.deepEqual(result.summary, {imported:788,directories:0,failed:0});
    assert.equal(result.retainedPixelBytes, 0, 'Importer retains pixel buffers in metadata');
    const rendered = async () => page.waitForFunction(() => {
      const canvas = document.querySelector('canvas');
      if (!canvas?.width || !canvas.height) return false;
      const copy = document.createElement('canvas'); copy.width=canvas.width; copy.height=canvas.height;
      const context = copy.getContext('2d'); context.drawImage(canvas,0,0);
      return context.getImageData(0,0,copy.width,copy.height).data.some((v,i)=>i%4!==3&&v>5);
    }, {}, {timeout:45000});
    await rendered();
    result.series = [];
    const tiles = page.locator('[data-cy="local-series-thumbnail"]');
    await page.waitForFunction(() => document.querySelectorAll('[data-cy="local-series-thumbnail"]').length===3);
    for (let index=0; index<3; index++) {
      const tile = tiles.nth(index);
      const uid = await tile.getAttribute('data-display-set-uid');
      await tile.focus(); await page.keyboard.press('Enter');
      await page.waitForFunction(uid => {
        const s=window.__ohifTestContext.servicesManager.services, g=s.viewportGridService.getState();
        const v=s.cornerstoneViewportService.getCornerstoneViewport(g.activeViewportId);
        return g.viewports.get(g.activeViewportId).displaySetInstanceUIDs.includes(uid) && v?.getImageData?.();
      }, uid);
      const count = await page.evaluate(async () => {
        const s=window.__ohifTestContext.servicesManager.services;
        const v=s.cornerstoneViewportService.getCornerstoneViewport(s.viewportGridService.getState().activeViewportId);
        const count=v.getImageIds().length;
        await v.setImageIdIndex(count-1);
        return count;
      });
      await rendered();
      result.series.push(count);
    }
    assert.deepEqual(result.series.sort((a,b)=>a-b), [5,391,392]);
    await page.waitForTimeout(1000);
    result.heap = await cdp.send('Runtime.getHeapUsage');
    result.peakSampledBackingStorage = Math.max(result.peakSampledBackingStorage || 0, result.heap.backingStorageSize || 0);
    assert.equal(result.crashed,false); assert.deepEqual(errors,[]); assert.deepEqual(external,[]);
    result.result = 'PASS'; result.rendered = true;
    result.javascriptErrors=errors.length; result.externalRequests=external.length;
    console.log(JSON.stringify(result));
  } catch(error) {
    result.result='FAIL';result.failure=error.message;
    console.error('FAIL:',error.message);process.exitCode=1;
  } finally {
    clearInterval(timer);
    fs.writeFileSync(path.join(__dirname,'large-import.json'),JSON.stringify(result,null,2)+'\n');
    await browser.close();
  }
})();
