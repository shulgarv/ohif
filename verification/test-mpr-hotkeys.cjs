// Run: OHIF_PLAYWRIGHT_PATH=/path/to/playwright node test-mpr-hotkeys.cjs <synthetic-folder>
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
    const state = () => page.evaluate(() => {
      const s = window.__ohifTestContext.servicesManager.services;
      const grid = s.viewportGridService.getState();
      const group = s.toolGroupService.getToolGroup('mpr');
      return {active: grid.activeViewportId, layout: grid.layout,
        tool: group.getActivePrimaryMouseButtonTool(), crosshairs: group.getToolOptions('Crosshairs').mode,
        viewports: [...grid.viewports.keys()].map(id => {
          const v = s.cornerstoneViewportService.getCornerstoneViewport(id);
          const r = v.element.getBoundingClientRect();
          return {id, slice: v.getSliceIndex?.(), voi: v.getProperties().voiRange,
            rect: {x: r.x, y: r.y, width: r.width, height: r.height}};
        })};
    });
    const waitLayout = async (count, id) => {
      await page.waitForFunction(({count, id}) => {
        const s = window.__ohifTestContext.servicesManager.services;
        const grid = s.viewportGridService.getState();
        return grid.viewports.size === count && (!id || grid.activeViewportId === id) &&
          [...grid.viewports.keys()].every(key => {
            const v = s.cornerstoneViewportService.getCornerstoneViewport(key);
            return v?.getNumberOfSlices?.() === 64 && v.element.querySelector('canvas')?.width > 0;
          });
      }, {count, id}, {timeout: 30000});
      await page.evaluate(() => new Promise(resolve =>
        requestAnimationFrame(() => requestAnimationFrame(resolve))));
    };
    const nativeTab = async () => {
      await page.evaluate(() => {
        const holder = document.createElement('div');
        holder.id = 'test-tab-focus';
        holder.innerHTML = '<input id="test-input"><button id="test-button">Next</button>';
        document.body.append(holder);
        holder.querySelector('input').focus();
      });
      const before = (await state()).active;
      await page.keyboard.press('Tab');
      assert.equal(await page.evaluate(() => document.activeElement.id), 'test-button');
      assert.equal((await state()).active, before, 'Tab in input must not switch projections');
      await page.evaluate(() => document.getElementById('test-tab-focus').remove());
    };
    await nativeTab();
    await page.keyboard.press('F3');
    assert.equal((await state()).crosshairs, 'Disabled', 'F3 outside MPR must do nothing');
    await page.keyboard.press('F2');
    await waitLayout(3, 'mpr-axial');
    assert.equal((await state()).tool, 'StackScroll', 'F2 must retain current tool');
    await page.keyboard.press('F2');
    await waitLayout(3);
    await page.keyboard.press('F3');
    assert.equal((await state()).crosshairs, 'Active');
    assert.equal((await state()).tool, 'StackScroll', 'Crosshairs must retain primary tool');
    await page.keyboard.press('F3');
    assert.equal((await state()).crosshairs, 'Disabled');
    await nativeTab();
    // Starting from the coronal projection, visit two complete cycles by real Tab presses.
    const coronal = (await state()).viewports.find(v => v.id === 'mpr-coronal');
    await page.mouse.dblclick(coronal.rect.x + coronal.rect.width / 2,
      coronal.rect.y + coronal.rect.height / 2);
    await waitLayout(1, 'mpr-coronal');
    await nativeTab();
    await page.keyboard.press('F2');
    await waitLayout(1, 'mpr-coronal');
    const savedSlices = {};
    let expectedWindow;
    for (const [index, expectedId] of [
      'mpr-sagittal', 'mpr-axial', 'mpr-coronal', 'mpr-sagittal', 'mpr-axial', 'mpr-coronal',
    ].entries()) {
      const before = await state();
      const v = before.viewports[0];
      if (index < 3) {
        const x = v.rect.x + v.rect.width / 2, y = v.rect.y + v.rect.height / 2;
        await page.mouse.move(x, y);
        await page.mouse.down();
        await page.mouse.move(x, y + 65, {steps: 12});
        await page.mouse.up();
        assert.notEqual((await state()).viewports[0].slice, v.slice, 'Scroll must move a slice');
      }
      expectedWindow = {lower: -210 - index * 10, upper: 310 + index * 10};
      await page.evaluate(voiRange => {
        const s = window.__ohifTestContext.servicesManager.services;
        const v = s.cornerstoneViewportService.getCornerstoneViewport(s.viewportGridService.getState().activeViewportId);
        v.setProperties({voiRange}); v.render();
      }, expectedWindow);
      savedSlices[v.id] = (await state()).viewports[0].slice;
      await page.keyboard.press('Tab');
      await waitLayout(1, expectedId);
      const after = await state();
      assert.deepEqual(after.viewports[0].voi, expectedWindow, 'Tab must preserve window');
      assert.equal(after.tool, 'StackScroll');
      if (savedSlices[expectedId] !== undefined) {
        assert.equal(after.viewports[0].slice, savedSlices[expectedId], 'Tab must restore slice position');
      }
      checks.push({from: v.id, to: expectedId, voi: after.viewports[0].voi,
        slice: after.viewports[0].slice});
    }
    await page.keyboard.press('F3');
    assert.equal((await state()).crosshairs, 'Active', 'F3 must work in expanded MPR');
    await page.keyboard.press('F3');
    assert.equal((await state()).crosshairs, 'Disabled');
    const full = (await state()).viewports[0];
    await page.mouse.dblclick(full.rect.x + full.rect.width / 2, full.rect.y + full.rect.height / 2);
    await waitLayout(3);
    for (const viewport of (await state()).viewports) {
      assert.deepEqual(viewport.voi, expectedWindow, 'Return to three panes must preserve window');
      assert.equal(viewport.slice, savedSlices[viewport.id], 'Return must preserve slice');
    }
    // A second expansion must start a fresh cycle from the newly selected projection.
    const axial = (await state()).viewports.find(v => v.id === 'mpr-axial');
    await page.mouse.dblclick(axial.rect.x + axial.rect.width / 2, axial.rect.y + axial.rect.height / 2);
    await waitLayout(1, 'mpr-axial');
    await page.keyboard.press('Tab');
    await waitLayout(1, 'mpr-coronal');
    await page.keyboard.press('F3');
    assert.equal((await state()).crosshairs, 'Active');
    for (const id of ['mpr-sagittal', 'mpr-axial', 'mpr-coronal']) {
      await page.keyboard.press('Tab');
      await waitLayout(1, id);
      assert.equal((await state()).crosshairs, 'Active', 'Tab must preserve enabled crosshairs');
      assert.equal((await state()).tool, 'StackScroll');
    }
    const differentProjection = (await state()).viewports[0];
    await page.mouse.dblclick(differentProjection.rect.x + differentProjection.rect.width / 2,
      differentProjection.rect.y + differentProjection.rect.height / 2);
    await waitLayout(3);
    assert.deepEqual((await state()).viewports.map(v => v.id).sort(),
      ['mpr-axial', 'mpr-coronal', 'mpr-sagittal']);
    for (const v of (await state()).viewports) assert.deepEqual(v.voi, expectedWindow);
    // Reloading and importing again must initialize the same shortcuts.
    await page.goto('http://127.0.0.1:3000/localbasic', {waitUntil: 'networkidle'});
    await page.locator('input[webkitdirectory]').setInputFiles(fixture);
    await page.waitForFunction(() => {
      const s = window.__ohifTestContext?.servicesManager.services;
      const v = s?.cornerstoneViewportService.getCornerstoneViewport(s.viewportGridService.getState().activeViewportId);
      if (v?.getImageIds?.().length !== 64) return false;
      const canvas = v.element.querySelector('canvas');
      if (!canvas?.width || !canvas.height) return false;
      const copy = document.createElement('canvas');
      copy.width = canvas.width; copy.height = canvas.height;
      const context = copy.getContext('2d');
      context.drawImage(canvas, 0, 0);
      return context.getImageData(0, 0, copy.width, copy.height).data.some(
        (value, index) => index % 4 !== 3 && value > 5);
    });
    await page.keyboard.press('F2');
    await waitLayout(3);
    const again = (await state()).viewports.find(v => v.id === 'mpr-coronal');
    await page.mouse.dblclick(again.rect.x + again.rect.width / 2, again.rect.y + again.rect.height / 2);
    await waitLayout(1, 'mpr-coronal');
    await page.keyboard.press('Tab');
    await waitLayout(1, 'mpr-sagittal');
    assert.deepEqual(errors, []);
    assert.deepEqual(external, []);
    const result = {result: 'PASS', openMpr: 'F2', crosshairs: 'F3', cycle: checks,
      f2KeepsExpandedView: true, nativeTabInInputs: true, primaryToolPreserved: true,
      windowAndSlicesPreserved: true, cycleWithCrosshairs: true, restoreDifferentProjection: true,
      reimportHotkeys: true, javascriptErrors: errors.length, externalRequests: external.length};
    fs.writeFileSync(path.join(__dirname, 'mpr-hotkeys.json'), JSON.stringify(result, null, 2) + '\n');
    console.log(JSON.stringify(result));
  } finally {await browser.close();}
})().catch(error => {console.error('FAIL:', error.message); process.exitCode = 1;});
