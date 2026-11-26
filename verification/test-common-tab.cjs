// Run: OHIF_PLAYWRIGHT_PATH=/path/to/playwright node test-common-tab.cjs <synthetic-folder>
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
            window.__ohifDataReady = new Set();
            const service = context.servicesManager.services.cornerstoneViewportService;
            service.subscribe(service.EVENTS.VIEWPORT_DATA_CHANGED, ({viewportId}) =>
              window.__ohifDataReady.add(viewportId));
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

    const command = (name, options) => page.evaluate(({name, options}) =>
      window.__ohifTestContext.commandsManager.runCommand(name, options), {name, options});
    const snapshot = () => page.evaluate(() => {
      const s = window.__ohifTestContext.servicesManager.services, g = s.viewportGridService.getState();
      return {active: g.activeViewportId, layout: g.layout, isHP: g.isHangingProtocolLayout,
        panes: [...g.viewports.values()].map(entry => {
          const v = s.cornerstoneViewportService.getCornerstoneViewport(entry.viewportId);
          return {id: entry.viewportId, ds: entry.displaySetInstanceUIDs,
            orientation: s.cornerstoneViewportService.getViewportInfo(entry.viewportId)?.getOrientation(),
            type: v?.type, camera: v?.getCamera(), voi: v?.getProperties().voiRange,
            tool: s.toolGroupService.getToolGroupForViewport(entry.viewportId)?.getActivePrimaryMouseButtonTool()};
        })};
    });
    const waitOrientation = async (id, orientation) => {
      await page.waitForFunction(({id, orientation}) => {
        const s = window.__ohifTestContext.servicesManager.services;
        const v = s.cornerstoneViewportService.getCornerstoneViewport(id);
        return s.cornerstoneViewportService.getOrientation(id) === orientation &&
          v?.getNumberOfSlices?.() === 64 && v.element.querySelector('canvas')?.width > 0;
      }, {id, orientation}, {timeout: 10000});
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    };
    const cycle = async label => {
      const start = await snapshot(), active = start.active;
      const source = start.panes.find(v => v.id === active);
      const others = start.panes.filter(v => v.id !== active);
      for (const orientation of ['coronal', 'sagittal', 'axial', 'coronal', 'sagittal', 'axial']) {
        await page.keyboard.press('Tab');
        await waitOrientation(active, orientation);
        const after = await snapshot(), pane = after.panes.find(v => v.id === active);
        assert.deepEqual(after.layout, start.layout, 'Tab must keep Common layout');
        assert.equal(after.active, active, 'Tab must stay in selected pane');
        assert.deepEqual(pane.ds, source.ds, 'Tab must keep selected series');
        assert.equal(pane.tool, source.tool, 'Tab must keep active tool');
        assert.deepEqual(pane.voi, source.voi, 'Tab must preserve window');
        assert.deepEqual(after.panes.filter(v => v.id !== active), others, 'Other panes must stay unchanged');
        checks.push({label, active, orientation});
      }
    };
    // Distinct window settings must survive the stack-to-volume conversion.
    await page.evaluate(() => {
      const s = window.__ohifTestContext.servicesManager.services;
      const v = s.cornerstoneViewportService.getCornerstoneViewport(s.viewportGridService.getState().activeViewportId);
      v.setProperties({voiRange: {lower: -230, upper: 410}}); v.render();
    });
    await cycle('Common 1x1');
    await page.evaluate(() => window.__ohifDataReady.clear());
    await command('setViewportGridLayout', {numRows: 2, numCols: 2});
    await page.waitForFunction(() => window.__ohifTestContext.servicesManager.services.viewportGridService
      .getState().viewports.size === 4);
    // Let the layout resize and its 40ms debounced stack scroll finish before
    // the test replaces all four series, as separate user interactions would.
    await page.waitForTimeout(100);
    // The grid count can settle before the newly populated neighbour finishes
    // mounting. Replacing its series during that mount can destroy the viewport
    // in flight. Wait for real image data before the next user interaction.
    await page.waitForFunction(() => {
      const s = window.__ohifTestContext.servicesManager.services, g = s.viewportGridService.getState();
      return [...g.viewports.values()].every(pane => !pane.displaySetInstanceUIDs.length ||
        !!s.cornerstoneViewportService.getCornerstoneViewport(pane.viewportId)?.getImageData?.());
    });
    // Put another series in each neighbour and select the bottom-right pane.
    const selected = await page.evaluate(() => {
      const c = window.__ohifTestContext, s = c.servicesManager.services, g = s.viewportGridService.getState();
      window.__ohifDataReady.clear();
      const displaySets = s.displaySetService.getActiveDisplaySets();
      const panes = [...g.viewports.values()];
      c.commandsManager.runCommand('setDisplaySetsForViewports', {viewportsToUpdate: panes.map((v, index) => ({
        viewportId: v.viewportId, displaySetInstanceUIDs: [displaySets[index % displaySets.length].displaySetInstanceUID],
        viewportOptions: {viewportType: 'stack', toolGroupId: 'default'}, displaySetOptions: [{}],
      }))});
      s.viewportGridService.setActiveViewportId(panes[3].viewportId);
      return panes[3].viewportId;
    });
    await page.waitForFunction(() => {
      const s = window.__ohifTestContext.servicesManager.services, g = s.viewportGridService.getState();
      return [...g.viewports.keys()].every(id => window.__ohifDataReady.has(id) && s.cornerstoneViewportService.getCornerstoneViewport(id)
        ?.getImageIds?.().length === 64);
    });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await page.keyboard.press('d');
    await cycle('Common 2x2 selected');
    await command('toggleOneUp');
    await page.waitForFunction(() => window.__ohifTestContext.servicesManager.services.viewportGridService
      .getState().viewports.size === 1);
    await cycle('Common expanded');
    await command('toggleOneUp');
    await page.waitForFunction(() => window.__ohifTestContext.servicesManager.services.viewportGridService
      .getState().viewports.size === 4);
    assert.equal((await snapshot()).active, selected);
    await waitOrientation(selected, 'axial');
    // Tab must keep normal focus navigation inside inputs.
    await page.evaluate(() => {
      const holder = document.createElement('div'); holder.id = 'common-tab-inputs';
      holder.innerHTML = '<input id="common-test-input"><button id="common-test-button">Next</button>';
      document.body.append(holder); holder.querySelector('input').focus();
    });
    const beforeInput = await snapshot();
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'common-test-button');
    assert.deepEqual(await snapshot(), beforeInput);
    await page.evaluate(() => document.getElementById('common-tab-inputs').remove());
    // Common chosen from MPR retains protocolId=mpr: Tab must still cycle the active pane.
    await page.keyboard.press('F2');
    await page.waitForFunction(() => window.__ohifTestContext.servicesManager.services.viewportGridService
      .getState().viewports.size === 3);
    await command('setViewportGridLayout', {numRows: 1, numCols: 1});
    await page.waitForFunction(() => {
      const g = window.__ohifTestContext.servicesManager.services.viewportGridService.getState();
      return g.viewports.size === 1 && !g.isHangingProtocolLayout;
    });
    await cycle('Common after MPR');
    await command('setViewportGridLayout', {numRows: 2, numCols: 2});
    await page.waitForFunction(() => window.__ohifTestContext.servicesManager.services.viewportGridService
      .getState().viewports.size === 4);
    await page.waitForTimeout(100);
    await command('toggleOneUp');
    await page.waitForFunction(() => window.__ohifTestContext.servicesManager.services.viewportGridService
      .getState().viewports.size === 1);
    await waitOrientation((await snapshot()).active, 'axial');
    await cycle('Common expanded after MPR');
    await command('toggleOneUp');
    await page.waitForFunction(() => window.__ohifTestContext.servicesManager.services.viewportGridService
      .getState().viewports.size === 4);
    await page.waitForTimeout(100);
    await cycle('Common restored grid after MPR');
    await page.keyboard.press('F2');
    await page.waitForFunction(() => window.__ohifTestContext.servicesManager.services.viewportGridService
      .getState().viewports.size === 3);
    assert.deepEqual(errors, []); assert.deepEqual(external, []);
    const result = {result: 'PASS', checks, selectedOnly: true, seriesPreserved: true,
      windowPreserved: true, toolPreserved: true, normalTabInInput: true,
      javascriptErrors: errors.length, externalRequests: external.length};
    fs.writeFileSync(path.join(__dirname, 'common-tab.json'), JSON.stringify(result, null, 2) + '\n');
    console.log(JSON.stringify(result));
  } finally {await browser.close();}
})().catch(error => {console.error('FAIL:', error.stack); process.exitCode = 1;});
