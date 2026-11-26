// Run: OHIF_PLAYWRIGHT_PATH=/path/to/playwright node verification/test-layout-transition.cjs <two-series-folder>
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
    const state = () => page.evaluate(() => {
      const s = window.__ohifTestContext.servicesManager.services, g = s.viewportGridService.getState();
      return {layout: g.layout, panes: [...g.viewports.values()].map(v => ({
        id: v.viewportId, ds: v.displaySetInstanceUIDs, options: v.viewportOptions})), isHP: g.isHangingProtocolLayout};
    });
    const doubleClick = async () => {
      const rect = await page.evaluate(() => {
        const s = window.__ohifTestContext.servicesManager.services;
        const v = s.cornerstoneViewportService.getCornerstoneViewport(s.viewportGridService.getState().activeViewportId);
        const r = v.element.getBoundingClientRect(); return {x:r.x+r.width*.6,y:r.y+r.height*.6};
      });
      await page.mouse.dblclick(rect.x, rect.y);
      await page.waitForTimeout(400);
    };

    page.setDefaultTimeout(15000);
    const frames = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const chooseCommon = async index => {
      await page.getByRole('button',{name:'Change layout',exact:true}).click();
      const section=page.getByText('Common',{exact:true}).locator('..');
      await section.locator('div.cursor-pointer').nth(index).click();
      await frames();
      await page.waitForTimeout(250);
    };
    const ready = async count => {
      await page.waitForFunction(count => {
        const s=window.__ohifTestContext.servicesManager.services,g=s.viewportGridService.getState();
        return g.viewports.size===count && [...g.viewports.values()].every(v =>
          !v.displaySetInstanceUIDs.length || s.cornerstoneViewportService.getCornerstoneViewport(v.viewportId)?.getImageData?.());
      }, count);
      await frames();
    };
    await chooseCommon(0);
    await doubleClick();
    assert.equal((await state()).panes.length,1,'Fresh Common 1x1 stays single');
    checks.push('Fresh Common 1x1 double-click');
    // Exercise every MPR projection and both entry points (F2 and the menu).
    for (let plane=0;plane<3;plane++) {
      if (plane === 2) {
        await page.getByRole('button',{name:'Change layout',exact:true}).click();
        await page.getByText('MPR',{exact:true}).click();
      } else await page.keyboard.press('F2');
      await ready(3);
      await page.evaluate(orientation => {
        const s=window.__ohifTestContext.servicesManager.services,g=s.viewportGridService.getState();
        const pane=[...g.viewports.values()].find(v=>v.viewportOptions.orientation===orientation);
        s.viewportGridService.setActiveViewportId(pane.viewportId);
      }, ['axial','coronal','sagittal'][plane]);
      await doubleClick(); await ready(1);
      const expanded=await state();
      await chooseCommon(0); await ready(1);
      const common=await state();
      assert.equal(common.panes[0].options.orientation,expanded.panes[0].options.orientation,'Keep projection');
      assert.deepEqual(common.panes[0].ds,expanded.panes[0].ds,'Keep selected series');
      assert.equal(common.panes[0].options.toolGroupId,'default');
      assert.equal(await page.evaluate(() => {
        const s=window.__ohifTestContext.servicesManager.services;
        return s.toolGroupService.getToolGroupForViewport(s.viewportGridService.getState().activeViewportId)?.id;
      }),'default','Mounted viewport must actually leave MPR tool group');
      for(let repeat=0;repeat<3;repeat++) {
        await doubleClick(); const after=await state();
        assert.equal(after.panes.length,1,'Explicit Common 1x1 must not resurrect cached MPR');
        assert.equal(after.isHP,false); assert.deepEqual(after.panes,common.panes);
      }
      checks.push({label:'Expanded MPR -> Common 1x1',orientation:expanded.panes[0].options.orientation,doubleClicks:3});
      // A new Common grid gets its own independent expand/restore history.
      await chooseCommon(2); await ready(4);
      await doubleClick(); await ready(1);
      await doubleClick(); await ready(4);
      assert.ok((await state()).panes.every(v=>v.options.toolGroupId!=='mpr'));
      await doubleClick(); await ready(1);
      await chooseCommon(0); await ready(1);
      await doubleClick(); assert.equal((await state()).panes.length,1,'Common 1x1 clears Common grid history too');
      checks.push('Common 2x2 expand/restore and explicit 1x1');
    }
    // Choosing Common directly from an unexpanded MPR must behave identically.
    await page.keyboard.press('F2'); await ready(3);
    await chooseCommon(0); await ready(1);
    await doubleClick(); assert.equal((await state()).panes.length,1);
    await page.keyboard.press('F2'); await ready(3);
    await doubleClick(); await ready(1);
    await doubleClick(); await ready(3);
    checks.push('Direct MPR -> Common and subsequent F2 MPR expand/restore');
    assert.deepEqual(errors,[]); assert.deepEqual(external,[]);
    const result={result:'PASS',checks,javascriptErrors:errors.length,externalRequests:external.length};
    fs.writeFileSync(path.join(__dirname,'layout-transition.json'),JSON.stringify(result,null,2)+'\n');
    console.log(JSON.stringify(result));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
