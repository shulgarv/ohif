// Run: OHIF_PLAYWRIGHT_PATH=/path/to/playwright node verification/test-single-measurement.cjs <two-series-folder>
const {chromium} = require(process.env.OHIF_PLAYWRIGHT_PATH || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const fixture = process.argv[2] || '/tmp/ohif-import-fixtures/two-series';

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


    const command = (name, options) => page.evaluate(({name,options}) =>
      window.__ohifTestContext.commandsManager.runCommand(name,options),{name,options});
    const state = () => page.evaluate(() => {
      const s=window.__ohifTestContext.servicesManager.services,g=s.viewportGridService.getState();
      const v=s.cornerstoneViewportService.getCornerstoneViewport(g.activeViewportId);
      const r=v.element.getBoundingClientRect();
      return {tool:s.toolGroupService.getToolGroupForViewport(g.activeViewportId).getActivePrimaryMouseButtonTool(),
        slice:v.getCurrentImageIdIndex?.()??v.getSliceIndex?.(),voi:v.getProperties().voiRange,
        count:s.measurementService.getMeasurements().length,
        rect:{x:r.x,y:r.y,w:r.width,h:r.height}};
    });
    const press = async key => {
      if(/^[a-z]$/.test(key))await page.keyboard.press(key);
      else await page.evaluate(key => {
        for(const type of ['keydown','keypress','keyup'])document.body.dispatchEvent(
          new KeyboardEvent(type,{key,keyCode:key.charCodeAt(0),which:key.charCodeAt(0),bubbles:true}));
      },key);
    };
    const waitTool = tool => page.waitForFunction(tool => {
      const s=window.__ohifTestContext.servicesManager.services,g=s.viewportGridService.getState();
      return s.toolGroupService.getToolGroupForViewport(g.activeViewportId).getActivePrimaryMouseButtonTool()===tool;
    },tool,{timeout:3000});
    const measure = async (label,key,tool) => {
      await command('clearMeasurements');
      await press(key);await waitTool(tool);
      const before=await state(),r=before.rect,cx=r.x+r.w/2,cy=r.y+r.h/2;
      if(tool==='Length'){
        await page.mouse.move(cx-35,cy);await page.mouse.down();
        await page.mouse.move(cx+35,cy,{steps:15});
      }else{
        await page.mouse.move(cx+35,cy);await page.mouse.down();
        for(let i=1;i<=40;i++)await page.mouse.move(
          cx+35*Math.cos(i*2*Math.PI/40),cy+35*Math.sin(i*2*Math.PI/40));
      }
      assert.equal((await state()).tool,tool,'Keep drawing tool while mouse is held');
      await page.mouse.up();
      await waitTool('StackScroll');
      await page.waitForFunction(tool => window.__ohifTestContext.servicesManager.services.measurementService
        .getMeasurements().some(m=>m.toolName===tool),tool);
      const after=await state();
      assert.equal(after.count,1);assert.deepEqual(after.voi,before.voi);
      // The next left-button drag must really scroll, without another hotkey.
      await page.mouse.move(cx+r.w*.3,cy-r.h*.2);await page.mouse.down();
      await page.mouse.move(cx+r.w*.3,cy+r.h*.2,{steps:15});await page.mouse.up();
      await page.waitForFunction(slice => {
        const s=window.__ohifTestContext.servicesManager.services,g=s.viewportGridService.getState();
        const v=s.cornerstoneViewportService.getCornerstoneViewport(g.activeViewportId);
        return (v.getCurrentImageIdIndex?.()??v.getSliceIndex?.())!==slice;
      },after.slice,{timeout:3000});
      const scrolled=await state();
      assert.equal(scrolled.count,1,'Scrolling must not create another measurement');
      assert.deepEqual(scrolled.voi,before.voi);
      checks.push({label,key,measurement:tool,returnedToScroll:true,dragChangedSlice:true});
      // Return to the volume/stack middle so drawings stay within the image.
      await page.evaluate(async () => {
        const c=window.__ohifTestContext,s=c.servicesManager.services;
        const {cornerstone}=c.extensionManager.getModuleEntry(
          '@ohif/extension-cornerstone.utilityModule.common').exports.getCornerstoneLibraries();
        const v=s.cornerstoneViewportService.getCornerstoneViewport(s.viewportGridService.getState().activeViewportId);
        await cornerstone.utilities.jumpToSlice(v.element,{imageIndex:32});
      });
      await page.waitForTimeout(100);
    };
    const ready = count => page.waitForFunction(count => {
      const s=window.__ohifTestContext.servicesManager.services,g=s.viewportGridService.getState();
      return g.viewports.size===count && [...g.viewports.values()].every(p=>
        s.cornerstoneViewportService.getCornerstoneViewport(p.viewportId)?.getImageData?.());
    },count);
    const run = async label => {
      for(const [key,tool] of [['d','Length'],['e','PlanarFreehandROI'],['в','Length'],['у','PlanarFreehandROI']])
        await measure(label,key,tool);
    };
    await run('Common stack');
    await page.keyboard.press('Tab');await page.waitForTimeout(300);
    await run('Common coronal volume');
    await page.keyboard.press('F2');await ready(3);await page.waitForTimeout(250);
    await run('MPR triptych');
    await command('toggleOneUp');await ready(1);await page.waitForTimeout(250);
    await run('Expanded MPR');

    // Direct selection through the normal tool command remains persistent.
    await command('clearMeasurements');
    await press('d');
    await command('setToolActive',{toolName:'WindowLevel'});await waitTool('WindowLevel');
    await command('setToolActiveToolbar',{toolName:'Length'});await waitTool('Length');
    const r=(await state()).rect;
    await page.mouse.move(r.x+r.w*.4,r.y+r.h*.5);await page.mouse.down();
    await page.mouse.move(r.x+r.w*.6,r.y+r.h*.5,{steps:15});await page.mouse.up();
    await page.waitForFunction(() => window.__ohifTestContext.servicesManager.services.measurementService
      .getMeasurements().length===1);
    assert.equal((await state()).tool,'Length','Manual tool selection cancels one-shot hotkey');
    checks.push({label:'Manual tool selection remains persistent'});
    assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
    const result={result:'PASS',checks,javascriptErrors:errors,externalRequests:external};
    fs.writeFileSync(path.join(__dirname,'single-measurement.json'),JSON.stringify(result,null,2)+'\n');
    console.log(JSON.stringify(result));
  }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
