// Run: OHIF_PLAYWRIGHT_PATH=/path/to/playwright node test-mpr-window.cjs <synthetic-folder>
const {chromium} = require(process.env.OHIF_PLAYWRIGHT_PATH || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const fixture = process.argv[2];

(async () => {
  const browser = await chromium.launch({executablePath: process.env.OHIF_CHROMIUM_PATH || '/usr/bin/chromium', args: [
    '--disable-dev-shm-usage', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
  ]});
  try {
    const page = await browser.newPage({viewport: {width: 1400, height: 1000}});
    const errors = [], external = [], checks = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => {
      if (/^https?:/.test(request.url()) && !request.url().startsWith('http://127.0.0.1:3000/')) {
        external.push(request.url());
      }
    });
    // Expose services in this isolated test page, while retaining real mode initialization.
    await page.route('**/app-config.js', async route => {
      const response = await route.fetch();
      const source = await response.text();
      await route.fulfill({response, body: source + `
        const config = window.config.modesConfiguration['@ohif/mode-longitudinal'].initToolGroups;
        const apply = config.$apply;
        config.$apply = initialize => {
          const configured = apply(initialize);
          return function (context) {
            window.__ohifTestContext = context;
            return configured.call(this, context);
          };
        };
      `});
    });
    await page.goto('http://127.0.0.1:3000/localbasic', {waitUntil: 'networkidle'});
    await page.locator('input[webkitdirectory]').setInputFiles(fixture);
    await page.waitForFunction(() => {
      const services = window.__ohifTestContext?.servicesManager.services;
      const viewport = services?.cornerstoneViewportService.getCornerstoneViewport(
        services.viewportGridService.getState().activeViewportId);
      if (viewport?.getImageIds?.().length !== 64) return false;
      const canvas = viewport.element.querySelector('canvas');
      if (!canvas?.width || !canvas.height) return false;
      const copy = document.createElement('canvas');
      copy.width = canvas.width; copy.height = canvas.height;
      const context = copy.getContext('2d');
      context.drawImage(canvas, 0, 0);
      return context.getImageData(0, 0, copy.width, copy.height).data.some(
        (value, index) => index % 4 !== 3 && value > 5);
    }, {}, {timeout: 30000});
    await page.evaluate(() => window.__ohifTestContext.commandsManager.runCommand(
      'toggleHangingProtocol', {protocolId: 'mpr'}));
    await page.waitForFunction(() => {
      const services = window.__ohifTestContext.servicesManager.services;
      const {viewports} = services.viewportGridService.getState();
      return viewports.size === 3 && [...viewports.keys()].every(id => {
        const viewport = services.cornerstoneViewportService.getCornerstoneViewport(id);
        if (viewport?.getNumberOfSlices?.() !== 64) return false;
        const canvas = viewport.element.querySelector('canvas');
        if (!canvas?.width || !canvas.height) return false;
        const copy = document.createElement('canvas');
        copy.width = canvas.width; copy.height = canvas.height;
        const context = copy.getContext('2d');
        context.drawImage(canvas, 0, 0);
        return context.getImageData(0, 0, copy.width, copy.height).data.some(
          (value, index) => index % 4 !== 3 && value > 5);
      });
    }, {}, {timeout: 30000});

    const state = () => page.evaluate(() => {
      const services = window.__ohifTestContext.servicesManager.services;
      const {activeViewportId, viewports} = services.viewportGridService.getState();
      return {activeViewportId, viewports: [...viewports.keys()].map(id => {
        const viewport = services.cornerstoneViewportService.getCornerstoneViewport(id);
        const rect = viewport.element.getBoundingClientRect();
        return {id, voi: viewport.getProperties().voiRange, slice: viewport.getSliceIndex(),
          rect: {x: rect.x, y: rect.y, width: rect.width, height: rect.height}};
      })};
    });
    const waitLayout = async count => {
      await page.waitForFunction(count => {
        const s = window.__ohifTestContext.servicesManager.services;
        const {viewports} = s.viewportGridService.getState();
        return viewports.size === count && [...viewports.keys()].every(id => {
          const v = s.cornerstoneViewportService.getCornerstoneViewport(id);
          return v?.getNumberOfSlices?.() === 64 && v.element.querySelector('canvas')?.width > 0;
        });
      }, count, {timeout: 30000});
    };
    const center = v => ({x: v.rect.x + v.rect.width / 2, y: v.rect.y + v.rect.height / 2});
    for (const {id, dx, dy} of [
      {id: 'mpr-sagittal', dx: 80, dy: 0},
      {id: 'mpr-axial', dx: 0, dy: 40},
      {id: 'mpr-coronal', dx: 40, dy: -30},
      {id: 'mpr-sagittal', dx: 80, dy: 40},
    ]) {
      const start = await state();
      const target = start.viewports.find(v => v.id === id);
      let point = center(target);
      await page.mouse.dblclick(point.x, point.y);
      await waitLayout(1);
      const maximized = await state();
      assert.equal(maximized.viewports[0].id, target.id);
      assert.deepEqual(maximized.viewports[0].voi, target.voi, 'Window changed on expansion');
      await page.evaluate(() => window.__ohifTestContext.commandsManager.runCommand(
        'setToolActive', {toolName: 'WindowLevel', toolGroupId: 'mpr'}));
      point = center(maximized.viewports[0]);
      await page.mouse.move(point.x, point.y);
      await page.mouse.down();
      await page.mouse.move(point.x + dx, point.y + dy, {steps: 12});
      await page.mouse.up();
      const edited = await state();
      assert.notDeepEqual(edited.viewports[0].voi, maximized.viewports[0].voi, 'Mouse drag did not change window');
      await page.mouse.dblclick(point.x, point.y);
      await waitLayout(3);
      await page.evaluate(() => new Promise(resolve =>
        requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const restored = await state();
      for (const viewport of restored.viewports) {
        assert.deepEqual(viewport.voi, edited.viewports[0].voi,
          `Window reset in ${viewport.id} when returning from expanded ${target.id}`);
      }
      checks.push({projection: id, editedWindow: edited.viewports[0].voi,
        restoredWindows: restored.viewports.map(({id, voi}) => ({id, voi}))});
      console.log('Window preserved:', JSON.stringify(checks.at(-1)));
    }
    assert.deepEqual(errors, []);
    assert.deepEqual(external, []);
    const result = {result: 'PASS', cycles: checks,
      javascriptErrors: errors.length, externalRequests: external.length};
    fs.writeFileSync(path.join(__dirname, 'mpr-window.json'), JSON.stringify(result, null, 2) + '\n');
    console.log(JSON.stringify(result));
  } finally {await browser.close();}
})().catch(error => {console.error('FAIL:', error.message); process.exitCode = 1;});
