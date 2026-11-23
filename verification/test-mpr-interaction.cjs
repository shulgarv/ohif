// Run: OHIF_PLAYWRIGHT_PATH=/path/to/playwright node test-mpr-interaction.cjs <synthetic-folder>
const {chromium} = require(process.env.OHIF_PLAYWRIGHT_PATH || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const fixture = process.argv[2];

(async () => {
  const browser = await chromium.launch({executablePath: '/usr/bin/chromium', args: [
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
    await page.keyboard.press('b');
    const state = () => page.evaluate(() => {
      const services = window.__ohifTestContext.servicesManager.services;
      const {activeViewportId, viewports} = services.viewportGridService.getState();
      return {
        activeViewportId,
        tool: services.toolGroupService.getToolGroup('mpr').getActivePrimaryMouseButtonTool(),
        viewports: [...viewports.keys()].map(id => {
          const viewport = services.cornerstoneViewportService.getCornerstoneViewport(id);
          const rect = viewport.element.getBoundingClientRect();
          return {id, slice: viewport.getSliceIndex(), voi: viewport.getProperties().voiRange,
            rect: {x: rect.x, y: rect.y, width: rect.width, height: rect.height}};
        }),
      };
    });
    const initial = await state();
    assert.equal(initial.tool, 'StackScroll');
    console.log('Initial MPR:', JSON.stringify(initial));
    for (const index of [1, 2, 0]) {
      const before = await state();
      const target = before.viewports[index];
      assert.notEqual(before.activeViewportId, target.id, 'Target must start inactive');
      const {x, y, width, height} = target.rect;
      await page.mouse.move(x + width / 2, y + height / 2);
      await page.mouse.down();
      await page.mouse.move(x + width / 2, y + height / 2 + 70, {steps: 12});
      await page.mouse.up();
      try {
        await page.waitForFunction(({id, slice}) => {
          const services = window.__ohifTestContext.servicesManager.services;
          return services.cornerstoneViewportService.getCornerstoneViewport(id).getSliceIndex() !== slice;
        }, target, {timeout: 3000});
      } catch {
        console.log('After first drag:', JSON.stringify(await state()));
        throw new Error(`First drag in inactive viewport ${target.id} did not scroll`);
      }
      const after = await state();
      assert.equal(after.activeViewportId, target.id, 'Viewport did not activate automatically');
      for (const viewport of before.viewports) {
        const changed = after.viewports.find(item => item.id === viewport.id);
        assert.deepEqual(changed.voi, viewport.voi, 'Window parameters changed during scroll');
        if (viewport.id !== target.id) assert.equal(changed.slice, viewport.slice, 'Another plane scrolled');
      }
      checks.push({viewport: target.id, before: target.slice, after: after.viewports[index].slice});
    }
    assert.deepEqual(errors, []);
    assert.deepEqual(external, []);
    const result = {result: 'PASS', firstDragScrolls: checks, automaticActivation: true,
      windowUnchanged: true, otherPlanesUnchanged: true, javascriptErrors: errors.length,
      externalRequests: external.length};
    fs.writeFileSync(path.join(__dirname, 'mpr-interaction.json'), JSON.stringify(result, null, 2) + '\n');
    console.log(JSON.stringify(result));
  } finally {
    await browser.close();
  }
})().catch(error => {console.error('FAIL:', error.message); process.exitCode = 1;});
