// Run: OHIF_PLAYWRIGHT_PATH=/path/to/playwright node test-mpr-crosshairs.cjs <synthetic-folder>
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
    const snapshot = () => page.evaluate(() => {
      const s = window.__ohifTestContext.servicesManager.services;
      const grid = s.viewportGridService.getState();
      const tool = s.toolGroupService.getToolGroup('mpr').getToolInstance('Crosshairs');
      return {center: [...tool.toolCenter], mode: tool.mode,
        views: [...grid.viewports.keys()].map(id => {
          const v = s.cornerstoneViewportService.getCornerstoneViewport(id);
          return {id, camera: v.getCamera(), center: v.worldToCanvas(tool.toolCenter),
            lines: [...v.element.querySelectorAll('svg line')].map(l => ({
              x1: +l.getAttribute('x1'), y1: +l.getAttribute('y1'),
              x2: +l.getAttribute('x2'), y2: +l.getAttribute('y2')}))};
        })};
    });
    const near = (a, b, label) => {
      assert.equal(a.length, b.length);
      for (let i = 0; i < a.length; i++) assert.ok(Math.abs(a[i] - b[i]) < 0.01,
        `${label}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`);
    };
    const assertCenter = async expected => {
      await page.waitForTimeout(100);
      const actual = await snapshot();
      near(actual.center, expected, 'World point must be retained');
      for (const view of actual.views) {
        const n = view.camera.viewPlaneNormal;
        const distance = expected.reduce((sum, value, i) => sum + (value - view.camera.focalPoint[i]) * n[i], 0);
        assert.ok(Math.abs(distance) < 0.01, `Slice in ${view.id} must pass through shared point: distance ${distance}, snapshot ${JSON.stringify(actual)}`);
        assert.ok(view.lines.length >= 4, `Crosshair lines must be visible in ${view.id}`);
        for (const line of view.lines) {
          const d = [line.x2 - line.x1, line.y2 - line.y1];
          const offset = [view.center[0] - line.x1, view.center[1] - line.y1];
          const error = Math.abs(d[0] * offset[1] - d[1] * offset[0]) / Math.hypot(...d);
          assert.ok(error < 0.1, `Visible line in ${view.id} must cross shared point`);
        }
      }
      return actual;
    };
    const expand = async id => {
      const view = (await state()).viewports.find(v => v.id === id);
      await page.mouse.dblclick(view.rect.x + view.rect.width / 2, view.rect.y + view.rect.height / 2);
      await waitLayout(1, id);
    };
    const restore = async () => {
      const view = (await state()).viewports[0];
      await page.mouse.dblclick(view.rect.x + view.rect.width / 2, view.rect.y + view.rect.height / 2);
      await waitLayout(3);
    };
    const shiftDrag = async (id, fractionX, fractionY) => {
      const result = await page.evaluate(({id, fractionX, fractionY}) => {
        const s = window.__ohifTestContext.servicesManager.services;
        const v = s.cornerstoneViewportService.getCornerstoneViewport(id);
        const rect = v.element.getBoundingClientRect();
        const canvas = [rect.width * fractionX, rect.height * fractionY];
        const x = Math.round(rect.x + canvas[0]), y = Math.round(rect.y + canvas[1]);
        return {x, y, world: v.canvasToWorld([x - rect.x, y - rect.y])};
      }, {id, fractionX, fractionY});
      await page.keyboard.down('Shift');
      await page.mouse.move(result.x - 15, result.y - 10);
      await page.mouse.down();
      await page.mouse.move(result.x, result.y, {steps: 5});
      await page.mouse.up();
      await page.keyboard.up('Shift');
      await page.waitForTimeout(100);
      const actual = await snapshot();
      near(actual.center, result.world, 'Dragging must select the requested world point');
      await assertCenter(actual.center);
      return actual.center;
    };
    await page.keyboard.press('F2');
    await waitLayout(3, 'mpr-axial');
    // First-ever F3 in one-up must initialize a valid point and actual SVG lines.
    await expand('mpr-coronal');
    await page.keyboard.press('F3');
    await page.waitForTimeout(100);
    let center = (await snapshot()).center;
    await assertCenter(center);
    center = await shiftDrag('mpr-coronal', 0.53, 0.47);
    checks.push({scenario: 'first F3 in expanded MPR and Shift drag', center});
    for (const id of ['mpr-sagittal', 'mpr-axial', 'mpr-coronal']) {
      await page.keyboard.press('Tab');
      await waitLayout(1, id);
      await assertCenter(center);
    }
    await restore();
    await assertCenter(center);
    checks.push({scenario: 'Tab cycle and restore shared point to three panes', center});
    // Native three-pane crosshair interaction must carry back into one-up.
    center = await shiftDrag('mpr-axial', 0.54, 0.46);
    await expand('mpr-axial');
    await assertCenter(center);
    checks.push({scenario: 'native three-pane move then expand', center});
    // Drag the crossing with the ordinary left button while preserving StackScroll.
    const beforeDrag = await snapshot();
    const rect = (await state()).viewports[0].rect;
    const point = beforeDrag.views[0].center;
    const expected = await page.evaluate(({point}) => {
      const s = window.__ohifTestContext.servicesManager.services;
      const v = s.cornerstoneViewportService.getCornerstoneViewport('mpr-axial');
      const rect = v.element.getBoundingClientRect();
      const x = Math.round(rect.x + point[0] + 18), y = Math.round(rect.y + point[1] + 12);
      return {x, y, world: v.canvasToWorld([x - rect.x, y - rect.y])};
    }, {point});
    await page.mouse.move(rect.x + point[0], rect.y + point[1]);
    await page.mouse.down();
    await page.mouse.move(expected.x, expected.y, {steps: 5});
    await page.mouse.up();
    center = expected.world;
    await assertCenter(center);
    assert.equal((await state()).tool, 'StackScroll');
    checks.push({scenario: 'left drag in expanded MPR', center});
    // Scrolling changes the selected coordinate; the other coordinates persist.
    await page.mouse.move(rect.x + rect.width * 0.7, rect.y + rect.height * 0.7);
    await page.mouse.wheel(0, 120);
    await page.waitForTimeout(150);
    const scrolled = await snapshot();
    assert.notDeepEqual(scrolled.center, center, 'Scroll must update shared point along slice normal');
    near(scrolled.center.slice(0, 2), center.slice(0, 2), 'Scroll must retain in-plane coordinates');
    center = scrolled.center;
    await assertCenter(center);
    await restore();
    await assertCenter(center);
    checks.push({scenario: 'expanded scroll then restore', center});
    // F3 hides all lines; re-enabling retains the selected point in both layouts.
    await page.keyboard.press('F3');
    await page.waitForTimeout(100);
    assert.ok((await snapshot()).views.every(v => v.lines.length === 0));
    await page.keyboard.press('F3');
    await assertCenter(center);
    await expand('mpr-sagittal');
    await assertCenter(center);
    await page.keyboard.press('F3');
    await page.waitForTimeout(100);
    assert.equal((await snapshot()).views[0].lines.length, 0);
    await page.keyboard.press('F3');
    await assertCenter(center);
    await restore();
    await assertCenter(center);
    assert.deepEqual(errors, []);
    assert.deepEqual(external, []);
    const result = {result: 'PASS', checks, firstF3InExpandedView: true,
      realLinesAndWorldPointVerified: true, leftAndShiftDragging: true,
      scrollAndTabPreserveSharedPoint: true, toggleVisibilityPreservesPoint: true,
      primaryToolPreserved: true, javascriptErrors: errors.length, externalRequests: external.length};
    fs.writeFileSync(path.join(__dirname, 'mpr-crosshairs.json'), JSON.stringify(result, null, 2) + '\n');
    console.log(JSON.stringify(result));
  } finally {await browser.close();}
})().catch(error => {console.error('FAIL:', error.stack); process.exitCode = 1;});
