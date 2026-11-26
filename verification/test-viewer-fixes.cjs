// Run: OHIF_PLAYWRIGHT_PATH=/path/to/playwright node verification/test-viewer-fixes.cjs <two-series-folder>
const {chromium} = require(process.env.OHIF_PLAYWRIGHT_PATH || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const fixture = process.argv[2] || '/tmp/ohif-import-fixtures/two-series';

(async () => {
  const browser = await chromium.launch({
    executablePath: process.env.OHIF_CHROMIUM_PATH || '/usr/bin/chromium',
    args: process.env.OHIF_BROWSER_GL === '1'
      ? ['--disable-dev-shm-usage', '--use-gl=angle', '--use-angle=gl']
      : ['--disable-dev-shm-usage', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  });
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
    await page.route('**/89.bundle.195151dd43a14c57.js', async route => {
      const response = await route.fetch();
      const body = await response.text();
      const marker = 'const connectMeasurementServiceToTools = ({';
      assert.ok(body.includes(marker));
      await route.fulfill({response, body: body.replace(marker,
        'window.__ohifAnnotations = dist_esm.annotation;\n' + marker)});
    });
    await page.route('**/3760.bundle.bc58ee8705a94523.js', async route => {
      const response = await route.fetch();
      const body = await response.text();
      const marker = '  return /*#__PURE__*/react.createElement(TrackedMeasurementsContext.Provider';
      assert.ok(body.includes(marker));
      await route.fulfill({response, body: body.replace(marker,
        '  window.__ohifTracking = trackedMeasurements;\n' + marker)});
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


    const snapshot = () => page.evaluate(() => {
      const s = window.__ohifTestContext.servicesManager.services;
      const g = s.viewportGridService.getState();
      return {hp: s.hangingProtocolService.getState().protocolId, layout: g.layout,
        isHP: g.isHangingProtocolLayout,
        viewports: [...g.viewports.values()].map(v => ({id: v.viewportId,
          group: v.viewportOptions.toolGroupId, ds: v.displaySetInstanceUIDs})),
        measurements: s.measurementService.getMeasurements().length};
    });
    const command = (name, options) => page.evaluate(({name, options}) =>
      window.__ohifTestContext.commandsManager.runCommand(name, options), {name, options});
    const checkFreehandKeys = async () => {
      for (const key of ['e', 'у']) {
        await page.keyboard.press('b');
        if (key === 'e') await page.keyboard.press(key);
        else await page.evaluate(key => {
          for (const type of ['keydown', 'keypress', 'keyup']) document.body.dispatchEvent(
            new KeyboardEvent(type, {key, code: 'KeyE', keyCode: key.charCodeAt(0),
              which: key.charCodeAt(0), bubbles: true}));
        }, key);
        assert.equal(await page.evaluate(() => {
          const s = window.__ohifTestContext.servicesManager.services;
          return s.toolGroupService.getToolGroupForViewport(s.viewportGridService.getState().activeViewportId)
            .getActivePrimaryMouseButtonTool();
        }), 'PlanarFreehandROI', key);
      }
    };
    await checkFreehandKeys();
    const rect = await page.evaluate(() => {
      const s = window.__ohifTestContext.servicesManager.services;
      const r = s.cornerstoneViewportService.getCornerstoneViewport(s.viewportGridService.getState().activeViewportId)
        .element.getBoundingClientRect();
      return {x: r.x, y: r.y, w: r.width, h: r.height};
    });
    const cx = rect.x + rect.w / 2, cy = rect.y + rect.h / 2;
    await page.mouse.move(cx + 55, cy); await page.mouse.down();
    for (let i = 1; i <= 40; i++) await page.mouse.move(
      cx + 55 * Math.cos(i * 2 * Math.PI / 40), cy + 55 * Math.sin(i * 2 * Math.PI / 40));
    await page.mouse.up();
    await page.waitForFunction(() => window.__ohifTestContext.servicesManager.services.measurementService
      .getMeasurements().some(m => m.toolName === 'PlanarFreehandROI'));
    await page.keyboard.press('d');
    await page.mouse.move(cx - 45, cy + 90); await page.mouse.down();
    await page.mouse.move(cx + 45, cy + 90, {steps: 10}); await page.mouse.up();
    await page.waitForFunction(() => window.__ohifTestContext.servicesManager.services.measurementService
      .getMeasurements().length === 2);
    await page.locator('[data-cy=trackedMeasurements-btn]').click();
    // 'none' intentionally makes the tracking machine refuse restoreTrackedSeries.
    const trackingEnabled = await page.evaluate(() => window.config.measurementTrackingMode !== 'none');
    for (const tracked of trackingEnabled ? [false, true] : [false]) {
      if (tracked) {
        await page.evaluate(() => {
          const c = window.__ohifTestContext;
          const m = c.servicesManager.services.measurementService.getMeasurements()[0];
          c.commandsManager.runCommand('restoreTrackedSeries', {
            StudyInstanceUID: m.referenceStudyUID, SeriesInstanceUIDs: [m.referenceSeriesUID],
          });
        });
        await page.waitForFunction(() => !!window.__ohifTracking.context.trackedStudy);
      }
      const ids = await page.evaluate(() => window.__ohifTestContext.servicesManager.services.measurementService
        .getMeasurements().map(m => m.uid));
      assert.equal(ids.length, 2);
      await page.getByRole('button', {name: 'Delete', exact: true}).click();
      assert.equal(await page.getByRole('dialog').count(), 0, 'Delete must not show Untrack modal');
      await page.waitForFunction(() => window.__ohifTestContext.servicesManager.services.measurementService
        .getMeasurements().length === 0, {}, {timeout: 3000});
      assert.equal(await page.evaluate(ids => ids.some(id => window.__ohifAnnotations.state.getAnnotation(id)), ids),
        false, 'Delete must remove annotations from images');
      assert.equal(await page.evaluate(() => window.__ohifTracking.context.trackedStudy), '');
      await command('undo');
      await page.waitForFunction(() => window.__ohifTestContext.servicesManager.services.measurementService
        .getMeasurements().length === 2);
      if (tracked) assert.ok(await page.evaluate(() => window.__ohifTracking.context.trackedStudy));
      await command('redo');
      await page.waitForFunction(() => window.__ohifTestContext.servicesManager.services.measurementService
        .getMeasurements().length === 0);
      assert.equal(await page.evaluate(() => window.__ohifTracking.context.trackedStudy), '');
      await command('undo');
      await page.waitForFunction(() => window.__ohifTestContext.servicesManager.services.measurementService
        .getMeasurements().length === 2);
      checks.push({delete: tracked ? 'tracked' : 'untracked', noModal: true,
        removedAnnotations: true, undoRedo: true});
    }
    // Close the panel before exercising MPR.
    await page.locator('[data-cy=trackedMeasurements-btn]').click();
    await page.keyboard.press('F2');
    const renderedFrames = () => page.evaluate(() => new Promise(resolve =>
      requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const waitMpr = async expected => {
      await page.waitForFunction(expected => {
      const s = window.__ohifTestContext.servicesManager.services;
      const g = s.viewportGridService.getState();
      return g.viewports.size === 3 && [...g.viewports.values()].every(v =>
        v.viewportOptions.toolGroupId === 'mpr' && (!expected || v.displaySetInstanceUIDs.includes(expected)) &&
        s.cornerstoneViewportService.getCornerstoneViewport(v.viewportId)?.getNumberOfSlices?.() === 64);
      }, expected, {timeout: 5000});
      await renderedFrames();
    };
    await waitMpr();
    await checkFreehandKeys();
    await page.keyboard.press('b');
    for (let i = 0; i < 6; i++) {
      await command('setViewportGridLayout', {numRows: 1, numCols: i % 2 ? 2 : 1});
      await page.waitForFunction(cols => {
        const g = window.__ohifTestContext.servicesManager.services.viewportGridService.getState();
        return g.layout.numCols === cols && !g.isHangingProtocolLayout;
      }, i % 2 ? 2 : 1);
      const expected = await page.evaluate(swap => {
        const c = window.__ohifTestContext, s = c.servicesManager.services;
        const g = s.viewportGridService.getState();
        const current = g.viewports.get(g.activeViewportId).displaySetInstanceUIDs[0];
        const ds = s.displaySetService.getActiveDisplaySets().find(d => swap ? d.displaySetInstanceUID !== current :
          d.displaySetInstanceUID === current);
        // Same command/service path used by dragging a thumbnail onto a viewport.
        c.commandsManager.runCommand('setDisplaySetsForViewports', {viewportsToUpdate:
          s.hangingProtocolService.getViewportsRequireUpdate(g.activeViewportId, ds.displaySetInstanceUID,
            g.isHangingProtocolLayout)});
        return ds.displaySetInstanceUID;
      }, i !== 2);
      await page.waitForFunction(expected => {
        const s = window.__ohifTestContext.servicesManager.services, g = s.viewportGridService.getState();
        const v = s.cornerstoneViewportService.getCornerstoneViewport(g.activeViewportId);
        return g.viewports.get(g.activeViewportId).displaySetInstanceUIDs.includes(expected) &&
          (v?.getImageIds?.().length === 64 || v?.getNumberOfSlices?.() === 64);
      }, expected);
      await renderedFrames();
      await page.keyboard.press('b');
      await page.keyboard.press('F2');
      await waitMpr(expected);
      assert.equal(await page.evaluate(() => window.__ohifTestContext.servicesManager.services.toolGroupService
        .getToolGroup('mpr').getActivePrimaryMouseButtonTool()), 'StackScroll');
      const before = await snapshot();
      await page.keyboard.press('F2');
      assert.deepEqual(await snapshot(), before, 'F2 in MPR must keep its layout');
      await page.keyboard.press('F3');
      assert.equal(await page.evaluate(() => window.__ohifTestContext.servicesManager.services.toolGroupService
        .getToolGroup('mpr').getToolOptions('Crosshairs').mode), 'Active');
      await page.keyboard.press('F3');
      checks.push({mprReentry: i + 1, selectedSeries: expected, correctSeriesInAllPanes: true});
    }
    assert.deepEqual(errors, []); assert.deepEqual(external, []);
    const result = {result: 'PASS', freehandKeys: ['e', 'у'], freehandDrawing: true,
      checks, javascriptErrors: errors.length, externalRequests: external.length};
    fs.writeFileSync(path.join(__dirname, 'viewer-fixes.json'), JSON.stringify(result, null, 2) + '\n');
    console.log(JSON.stringify(result));
  } finally {await browser.close();}
})().catch(error => {console.error('FAIL:', error.stack); process.exitCode = 1;});
