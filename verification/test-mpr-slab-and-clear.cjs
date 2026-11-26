// Run: OHIF_PLAYWRIGHT_PATH=/path/to/playwright node verification/test-viewer-fixes.cjs <two-series-folder>
const {chromium} = require(process.env.OHIF_PLAYWRIGHT_PATH || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const fixture = process.argv[2] || '/tmp/ohif-import-fixtures/mpr-slab';

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



    const command = (name, options) => page.evaluate(({name, options}) =>
      window.__ohifTestContext.commandsManager.runCommand(name, options), {name, options});
    const frames = () => page.evaluate(() => new Promise(resolve =>
      requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const pixels = id => page.evaluate(id => {
      const v = window.__ohifTestContext.servicesManager.services.cornerstoneViewportService.getCornerstoneViewport(id);
      const canvas = v.element.querySelector('canvas'), copy = document.createElement('canvas');
      copy.width = canvas.width; copy.height = canvas.height;
      const ctx = copy.getContext('2d'); ctx.drawImage(canvas, 0, 0);
      const bytes = ctx.getImageData(0, 0, copy.width, copy.height).data;
      let hash = 2166136261;
      for (const byte of bytes) hash = Math.imul(hash ^ byte, 16777619);
      return hash >>> 0;
    }, id);
    const state = () => page.evaluate(() => {
      const s = window.__ohifTestContext.servicesManager.services;
      const g = s.viewportGridService.getState();
      return {tool: s.toolGroupService.getToolGroupForViewport(g.activeViewportId).getActivePrimaryMouseButtonTool(),
        panes: [...g.viewports.keys()].map(id => {
          const v = s.cornerstoneViewportService.getCornerstoneViewport(id), r = v.element.getBoundingClientRect();
          return {id, slab: v.getSlabThickness?.(), blend: v.getBlendMode?.(),
            slice: v.getSliceIndex?.(), voi: v.getProperties().voiRange,
            x: r.x + r.width / 2, y: r.y + r.height / 2};
        })};
    });
    const hold = async (key, down) => {
      if (key === 'j') await page.keyboard[down ? 'down' : 'up']('j');
      else await page.evaluate(down => document.body.dispatchEvent(new KeyboardEvent(
        down ? 'keydown' : 'keyup', {key: 'о', code: 'KeyJ', bubbles: true})), down);
    };
    const drawLength = async () => {
      const v = (await state()).panes[0];
      await page.keyboard.press('d');
      await page.mouse.move(v.x - 40, v.y + 50); await page.mouse.down();
      await page.mouse.move(v.x + 40, v.y + 50, {steps: 8}); await page.mouse.up();
      await page.waitForFunction(() => window.__ohifTestContext.servicesManager.services.measurementService
        .getMeasurements().length > 0);
    };
    await page.keyboard.press('F2');
    await page.waitForFunction(() => {
      const s = window.__ohifTestContext.servicesManager.services;
      const g = s.viewportGridService.getState();
      return g.viewports.size === 3 && [...g.viewports.keys()].every(id =>
        s.cornerstoneViewportService.getCornerstoneViewport(id)?.getNumberOfSlices?.() === 64);
    });
    await frames();
    for (const [index, key] of ['j', 'о', 'j'].entries()) {
      const before = await state(), v = before.panes[index];
      const thinPixels = await pixels(v.id);
      await page.mouse.move(v.x, v.y);
      await hold(key, true);
      if (index === 2) await page.mouse.down();
      await page.mouse.move(v.x, v.y - 40, {steps: 8});
      await frames();
      const up = await state(), changed = up.panes.find(p => p.id === v.id);
      assert.ok(changed.slab > v.slab + 5, `${key}: upward movement must increase slab`);
      assert.equal(changed.blend, 1, 'Thicker slabs must use MIP');
      await page.mouse.move(v.x, v.y - 70, {steps: 6});
      await frames();
      assert.ok((await state()).panes[index].slab > changed.slab, 'Thickness must grow gradually');
      assert.notEqual(await pixels(v.id), thinPixels, 'MIP must change actual rendered pixels');
      await page.mouse.move(v.x, v.y + 50, {steps: 15});
      if (index === 2) await page.mouse.up();
      await hold(key, false);
      const after = await state();
      await frames();
      assert.equal(await pixels(v.id), thinPixels, 'Thin-slice rendering must be restored exactly');
      assert.equal(after.panes[index].slab, v.slab, 'Downward movement must restore thin slice');
      assert.equal(after.panes[index].blend, v.blend);
      assert.equal(after.tool, before.tool);
      after.panes.forEach((p, i) => {
        assert.equal(p.slice, before.panes[i].slice);
        assert.deepEqual(p.voi, before.panes[i].voi);
        if (i !== index) assert.equal(p.slab, before.panes[i].slab, 'Neighbours must retain thickness');
      });
      await page.mouse.move(v.x, v.y + 60);
      assert.equal((await state()).panes[index].slab, v.slab, 'Release must end adjustment');
      checks.push({key, viewport: v.id, gradualMIP: true, renderedPixelsChanged: true,
        thinSliceRestored: true, mouseButton: index === 2});
    }
    // A lost focus must release the momentary gesture even without keyup.
    const blurPane = (await state()).panes[0];
    await page.mouse.move(blurPane.x, blurPane.y); await hold('j', true);
    await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    await page.mouse.move(blurPane.x, blurPane.y - 30);
    assert.equal((await state()).panes[0].slab, 0.05);
    await hold('j', false);
    // Two gestures can decrease previously increased thickness; keyup is not a new minimum.
    let v = (await state()).panes[0];
    await page.mouse.move(v.x, v.y); await hold('j', true);
    await page.mouse.move(v.x, v.y - 50, {steps: 10}); await hold('j', false);
    await page.mouse.dblclick(v.x + 70, v.y + 70);
    await page.waitForFunction(() => window.__ohifTestContext.servicesManager.services.viewportGridService.getState().viewports.size === 1);
    await frames();
    v = (await state()).panes[0];
    assert.ok(v.slab > 5, 'Expanded pane must preserve thickness');
    assert.equal(v.blend, 1, 'Expanded pane must preserve MIP blend mode');
    await page.mouse.move(v.x, v.y); await hold('j', true);
    await page.mouse.move(v.x, v.y - 25, {steps: 5}); await hold('j', false);
    const expandedThickness = (await state()).panes[0].slab;
    for (const index of [1, 2, 0]) {
      await page.keyboard.press('Tab');
      await page.waitForFunction(id => window.__ohifTestContext.servicesManager.services.viewportGridService
        .getState().activeViewportId === id, ['mpr-axial', 'mpr-coronal', 'mpr-sagittal'][index]);
      await frames();
      assert.equal((await state()).panes[0].slab, index === 0 ? expandedThickness : 0.05,
        'Each projection must retain its own slab thickness');
    }
    assert.equal((await state()).panes[0].slab, expandedThickness, 'Tab cycle must preserve slab');
    assert.equal((await state()).panes[0].blend, 1, 'Tab cycle must preserve MIP blend mode');
    v = (await state()).panes[0];
    await page.mouse.move(v.x, v.y); await hold('о', true);
    await page.mouse.move(v.x, v.y + 150, {steps: 20}); await hold('о', false);
    assert.equal((await state()).panes[0].slab, 0.05);
    // Back in three panes, give each one a different slab, then expand/restore.
    await page.mouse.dblclick(v.x + 80, v.y + 80);
    await page.waitForFunction(() => window.__ohifTestContext.servicesManager.services.viewportGridService.getState().viewports.size === 3);
    await frames();
    for (const [index, pane] of (await state()).panes.entries()) {
      await page.mouse.move(pane.x, pane.y); await hold('j', true);
      await page.mouse.move(pane.x, pane.y - 20 * (index + 1), {steps: 6}); await hold('j', false);
    }
    const distinctSlabs = (await state()).panes.map(p => ({id: p.id, slab: p.slab, blend: p.blend}));
    v = (await state()).panes[1];
    await page.mouse.dblclick(v.x + 80, v.y + 80);
    await page.waitForFunction(() => window.__ohifTestContext.servicesManager.services.viewportGridService.getState().viewports.size === 1);
    await frames();
    v = (await state()).panes[0];
    await page.mouse.dblclick(v.x + 80, v.y + 80);
    await page.waitForFunction(() => window.__ohifTestContext.servicesManager.services.viewportGridService.getState().viewports.size === 3);
    await frames();
    assert.deepEqual((await state()).panes.map(p => ({id: p.id, slab: p.slab, blend: p.blend})), distinctSlabs,
      'Return to three panes must restore three independent slabs and blend modes');
    v = (await state()).panes[0];
    // Crosshairs and the primary tool coexist with the held gesture.
    await page.keyboard.press('F3');
    const crosshairCenter = await page.evaluate(() => [...window.__ohifTestContext.servicesManager.services
      .toolGroupService.getToolGroup('mpr').getToolInstance('Crosshairs').toolCenter]);
    await page.mouse.move(v.x, v.y); await hold('j', true); await page.mouse.down();
    await page.mouse.move(v.x, v.y + 100, {steps: 10}); await page.mouse.up(); await hold('j', false);
    assert.deepEqual(await page.evaluate(() => [...window.__ohifTestContext.servicesManager.services
      .toolGroupService.getToolGroup('mpr').getToolInstance('Crosshairs').toolCenter]), crosshairCenter);
    await page.keyboard.press('F3');
    // Text fields keep their usual J input.
    await page.evaluate(() => {
      const input = document.createElement('input'); input.id = 'slab-test-input';
      document.body.append(input); input.focus();
    });
    await page.keyboard.type('j');
    assert.equal(await page.locator('#slab-test-input').inputValue(), 'j');
    await page.mouse.move(v.x, v.y - 50);
    assert.equal((await state()).panes[0].slab, 0.05);
    await page.locator('#slab-test-input').evaluate(e => e.remove());
    const clear = page.getByRole('button', {name: 'Удалить все измерения', exact: true});
    assert.equal(await clear.count(), 1, 'Right rail must have a clear button');
    assert.equal(await clear.isDisabled(), true);
    await drawLength();
    // The configured 'none' mode deliberately disables starting/restoring tracking.
    const trackingEnabled = await page.evaluate(() => window.config.measurementTrackingMode !== 'none');
    for (const tracked of trackingEnabled ? [false, true] : [false]) {
      if (tracked) await page.evaluate(() => {
        const c = window.__ohifTestContext, m = c.servicesManager.services.measurementService.getMeasurements()[0];
        c.commandsManager.runCommand('restoreTrackedSeries', {StudyInstanceUID: m.referenceStudyUID,
          SeriesInstanceUIDs: [m.referenceSeriesUID]});
      });
      await page.waitForFunction(() => window.__ohifTracking.context.trackedStudy !== undefined);
      const ids = await page.evaluate(() => window.__ohifTestContext.servicesManager.services.measurementService
        .getMeasurements().map(m => m.uid));
      assert.equal(await clear.isEnabled(), true);
      await clear.click();
      assert.equal(await page.getByRole('dialog').count(), 0);
      assert.equal(await page.evaluate(() => window.__ohifTestContext.servicesManager.services.measurementService
        .getMeasurements().length), 0);
      assert.equal(await page.evaluate(ids => ids.some(id => window.__ohifAnnotations.state.getAnnotation(id)), ids), false);
      assert.equal(await page.evaluate(() => window.__ohifTracking.context.trackedStudy), '');
      await command('undo');
      await page.waitForFunction(() => window.__ohifTestContext.servicesManager.services.measurementService.getMeasurements().length > 0);
      if (tracked) assert.ok(await page.evaluate(() => window.__ohifTracking.context.trackedStudy));
      await command('redo');
      await page.waitForFunction(() => window.__ohifTestContext.servicesManager.services.measurementService.getMeasurements().length === 0);
      await command('undo');
      await page.waitForFunction(() => window.__ohifTestContext.servicesManager.services.measurementService.getMeasurements().length > 0);
      checks.push({clear: tracked ? 'tracked' : 'untracked', annotationsRemoved: true, undoRedo: true});
    }
    await page.locator('[data-cy=trackedMeasurements-btn]').click();
    await clear.click();
    assert.equal(await clear.isDisabled(), true, 'Clear must work with expanded sidebar too');
    await page.screenshot({path: path.join(__dirname, 'mpr-slab-and-clear.png')});
    assert.deepEqual(errors, []); assert.deepEqual(external, []);
    const result = {result: 'PASS', checks, expandedMpr: true, tabPreservesThickness: true,
      inputTyping: true, blurEndsGesture: true, crosshairsCompatible: true, independentSlabsAfterRestore: true,
      oneClickClearCollapsedAndExpanded: true, javascriptErrors: errors.length, externalRequests: external.length};
    fs.writeFileSync(path.join(__dirname, 'mpr-slab-and-clear.json'), JSON.stringify(result, null, 2) + '\n');
    console.log(JSON.stringify(result));
  } finally {await browser.close();}
})().catch(error => {console.error('FAIL:', error.stack); process.exitCode = 1;});
