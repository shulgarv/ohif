// Run: OHIF_PLAYWRIGHT_PATH=/path/to/playwright node verification/test-common-drop-orientation.cjs <two-series-folder>
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
    const snapshot = () => page.evaluate(() => {
      const s=window.__ohifTestContext.servicesManager.services,g=s.viewportGridService.getState();
      const pane=g.viewports.get(g.activeViewportId);
      const v=s.cornerstoneViewportService.getCornerstoneViewport(g.activeViewportId);
      return {id:g.activeViewportId,ds:pane.displaySetInstanceUIDs,
        protocol:s.hangingProtocolService.getState().protocolId,isHP:g.isHangingProtocolLayout,
        toolGroup:pane.viewportOptions.toolGroupId || 'default',
        orientation:s.cornerstoneViewportService.getOrientation(g.activeViewportId),
        normal:v.getCamera().viewPlaneNormal,type:v.type};
    });
    const tiles=page.locator('[data-cy="local-series-thumbnail"]');
    const waitPlane = async orientation => {
      await page.waitForFunction(orientation => {
        const s=window.__ohifTestContext.servicesManager.services,g=s.viewportGridService.getState();
        const v=s.cornerstoneViewportService.getCornerstoneViewport(g.activeViewportId);
        return s.cornerstoneViewportService.getOrientation(g.activeViewportId)===orientation && !!v?.getImageData?.();
      },orientation);
      await frames();
    };
    const dragOther = async (label, expected) => {
      const before=await snapshot();
      let target=tiles.first();
      if(await target.getAttribute('data-display-set-uid')===before.ds[0])target=tiles.nth(1);
      const uid=await target.getAttribute('data-display-set-uid');
      const rect=await page.evaluate(() => {
        const s=window.__ohifTestContext.servicesManager.services;
        const r=s.cornerstoneViewportService.getCornerstoneViewport(s.viewportGridService.getState().activeViewportId).element.getBoundingClientRect();
        return {x:r.x+r.width*.5,y:r.y+r.height*.5};
      });
      const a=await target.boundingBox();
      await page.mouse.move(a.x+a.width/2,a.y+a.height/2);
      await page.mouse.down();
      await page.mouse.move(a.x+a.width/2+10,a.y+a.height/2,{steps:5});
      await page.mouse.move(rect.x,rect.y,{steps:20});
      await page.waitForTimeout(100);await page.mouse.up();
      await page.waitForFunction(uid => {
        const s=window.__ohifTestContext.servicesManager.services,g=s.viewportGridService.getState();
        return g.viewports.get(g.activeViewportId).displaySetInstanceUIDs.includes(uid) &&
          s.cornerstoneViewportService.getCornerstoneViewport(g.activeViewportId)?.getImageIds?.().length===64;
      },uid);
      await frames();await page.waitForTimeout(150);
      const after=await snapshot();
      const axis={axial:2,coronal:1,sagittal:0}[expected];
      assert.ok(Math.abs(after.normal[axis])>.99,label+': expected '+expected+', normal='+after.normal);
      assert.equal(after.isHP,before.isHP,'Drop must preserve layout mode');
      const compact = s => ({protocol:s.protocol,isHangingProtocolLayout:s.isHP,
        toolGroup:s.toolGroup,orientation:s.orientation,normal:s.normal,type:s.type});
      checks.push({label,expected,before:compact(before),after:compact(after)});
    };
    await chooseCommon(0);await ready(1);
    await dragOther('Fresh Common 1x1','axial');
    await page.keyboard.press('Tab');await waitPlane('coronal');
    await dragOther('Common 1x1 after Tab to coronal','axial');

    // Start at axial, then use the same Tab interaction as the reported case.
    await page.keyboard.press('F2');await ready(3);
    await page.evaluate(() => {
      const s=window.__ohifTestContext.servicesManager.services,g=s.viewportGridService.getState();
      s.viewportGridService.setActiveViewportId([...g.viewports.values()].find(v=>v.viewportOptions.orientation==='axial').viewportId);
    });
    await doubleClick();await ready(1);
    await page.keyboard.press('Tab');await waitPlane('coronal');
    await dragOther('Expanded MPR after Tab to coronal','coronal');
    // Switch with Tab before the next drop, so the original one-up series
    // snapshots and the last selected plane both participate in the repro.
    await page.keyboard.press('Tab');await waitPlane('sagittal');
    await dragOther('Expanded MPR after Tab to sagittal','sagittal');

    // Change just the layout mode; keep the current projection until the drop.
    const beforeCommon=await snapshot();
    await chooseCommon(0);await ready(1);
    const common=await snapshot();
    assert.equal(common.orientation,beforeCommon.orientation,'Explicit Common keeps current projection');
    assert.equal(common.isHP,false);assert.equal(common.toolGroup,'default');
    await dragOther('Explicit Common after expanded MPR and Tab','axial');
    await page.keyboard.press('Tab');await waitPlane('coronal');
    await dragOther('Common after MPR, then Tab to coronal','axial');
    await dragOther('Common subsequent series','axial');
    assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
    const result={result:'PASS',checks,javascriptErrors:errors,externalRequests:external};
    fs.writeFileSync(path.join(__dirname,'common-drop-orientation.json'),JSON.stringify(result,null,2)+'\n');
    console.log(JSON.stringify(result));
  } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
