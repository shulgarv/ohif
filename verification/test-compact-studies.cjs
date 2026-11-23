// Run: OHIF_PLAYWRIGHT_PATH=/path/to/playwright node verification/test-compact-studies.cjs <two-series-or-series-rail-folder> [20]
const {chromium} = require(process.env.OHIF_PLAYWRIGHT_PATH || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const fixture = process.argv[2];
const expectedCount = Number(process.argv[3] || 2);
const artifact = expectedCount > 2 ? 'compact-studies-many' : 'compact-studies';

(async () => {
  const browser = await chromium.launch({executablePath: '/usr/bin/chromium', args: [
    '--disable-dev-shm-usage', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
  ]});
  try {
    const page = await browser.newPage({viewport: {width: 1400, height: 1000}});
    page.setDefaultTimeout(15000);
    const errors = [], external = [];
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


    const tiles = page.locator('[data-cy="local-series-thumbnail"]');
    await tiles.first().waitFor();
    await page.waitForFunction(count => document.querySelectorAll('[data-cy="local-series-thumbnail"]').length === count, expectedCount);
    assert.equal(await tiles.count(), expectedCount);
    const panel = page.locator('[data-panel-id="viewerLayoutResizableLeftPanel"]');
    assert.ok(Math.abs((await panel.boundingBox()).width-72)<2, 'Rail must reserve 72px');
    assert.equal((await tiles.first().boundingBox()).width, 56);
    assert.equal((await tiles.first().boundingBox()).height, 68);
    await tiles.nth(1).hover();
    const preview = page.locator('[data-cy="local-series-preview"]').first();
    await preview.waitFor();
    const text = await preview.innerText();
    assert.match(text, /Synthetic second series/);
    assert.match(text, /Изображений: 64/);
    assert.match(text, /Толщина среза: 1 мм/);
    assert.ok((await preview.locator('img').first().boundingBox()).width>=180);
    await page.screenshot({path:path.join(__dirname,artifact+'-preview.png')});
    const viewportBox = await page.evaluate(() => {
      const s=window.__ohifTestContext.servicesManager.services;
      const r=s.cornerstoneViewportService.getCornerstoneViewport(s.viewportGridService.getState().activeViewportId).element.getBoundingClientRect();
      return {x:r.x,y:r.y,width:r.width,height:r.height};
    });
    const uid=await tiles.nth(1).getAttribute('data-display-set-uid');
    const drag = async (tile, rect) => {
      const a=await tile.boundingBox();
      await page.mouse.move(a.x+a.width/2,a.y+a.height/2);
      await page.mouse.down();
      await page.mouse.move(a.x+a.width/2+10,a.y+a.height/2,{steps:5});
      await page.mouse.move(rect.x+rect.width*.5,rect.y+rect.height*.5,{steps:20});
      await page.waitForTimeout(100);
      await page.mouse.up();
    };
    await drag(tiles.nth(1),viewportBox);
    await page.waitForFunction(uid => {
      const s=window.__ohifTestContext.servicesManager.services, g=s.viewportGridService.getState();
      return g.viewports.get(g.activeViewportId).displaySetInstanceUIDs.includes(uid) &&
        s.cornerstoneViewportService.getCornerstoneViewport(g.activeViewportId)?.getImageIds?.().length===64;
    }, uid);
    assert.equal(await tiles.nth(1).getAttribute('aria-current'),'true');
    await page.locator('[data-cy="side-panel-header-left"]').click();
    await page.locator('[data-cy="study-browser-thumbnail"]').first().waitFor();
    assert.ok((await panel.boundingBox()).width>200, 'Full Studies must still open');
    await page.locator('[data-cy="side-panel-header-left"]').click();
    await tiles.first().waitFor();
    assert.ok(Math.abs((await panel.boundingBox()).width-72)<2);
    await page.setViewportSize({width:1024,height:768});
    await page.waitForTimeout(200);
    assert.ok(Math.abs((await panel.boundingBox()).width-72)<2, 'Rail must retain pixel width on resize');
    await tiles.first().focus();
    await page.keyboard.press('Enter');
    const firstUID = await tiles.first().getAttribute('data-display-set-uid');
    await page.waitForFunction(uid => {
      const s=window.__ohifTestContext.servicesManager.services,g=s.viewportGridService.getState();
      return g.viewports.get(g.activeViewportId).displaySetInstanceUIDs.includes(uid);
    }, firstUID);
    // Native DnD must still address the chosen Common pane and all MPR panes.
    const command = (name, options) => page.evaluate(({name,options}) =>
      window.__ohifTestContext.commandsManager.runCommand(name,options),{name,options});
    await command('setViewportGridLayout',{numRows:1,numCols:2});
    await page.waitForFunction(() => window.__ohifTestContext.servicesManager.services.viewportGridService.getState().viewports.size===2);
    await page.waitForTimeout(300);
    const gridTarget=await page.evaluate(() => {
      const s=window.__ohifTestContext.servicesManager.services,g=s.viewportGridService.getState();
      const pane=[...g.viewports.values()][1];
      const r=s.cornerstoneViewportService.getCornerstoneViewport(pane.viewportId).element.getBoundingClientRect();
      return {id:pane.viewportId,x:r.x,y:r.y,width:r.width,height:r.height};
    });
    await drag(tiles.nth(1),gridTarget);
    await page.waitForFunction(({uid,id}) => window.__ohifTestContext.servicesManager.services.viewportGridService.getState()
      .viewports.get(id)?.displaySetInstanceUIDs.includes(uid),{uid,id:gridTarget.id});
    await page.keyboard.press('F2');
    await page.waitForFunction(() => window.__ohifTestContext.servicesManager.services.viewportGridService.getState().viewports.size===3);
    await page.waitForTimeout(400);
    const mprTarget=await page.evaluate(() => {
      const s=window.__ohifTestContext.servicesManager.services,g=s.viewportGridService.getState();
      const r=s.cornerstoneViewportService.getCornerstoneViewport(g.activeViewportId).element.getBoundingClientRect();
      return {x:r.x,y:r.y,width:r.width,height:r.height};
    });
    await drag(tiles.first(),mprTarget);
    await page.waitForFunction(uid => [...window.__ohifTestContext.servicesManager.services.viewportGridService.getState()
      .viewports.values()].every(v=>v.displaySetInstanceUIDs.includes(uid)),firstUID);
    await command('setViewportGridLayout',{numRows:1,numCols:1});
    await page.waitForFunction(() => window.__ohifTestContext.servicesManager.services.viewportGridService.getState().viewports.size===1);
    if(expectedCount>2) {
      await tiles.nth(2).hover();
      await page.waitForFunction(() => document.querySelector('[role="tooltip"]')?.textContent.includes('0.5–1.5 мм'));
      assert.match(await page.getByRole('tooltip').innerText(),/Толщина среза: 0.5–1.5 мм/);
      await page.mouse.move(30,600); await page.mouse.wheel(0,1800);
      await page.waitForTimeout(250);
      const lastBox=await tiles.last().boundingBox();
      assert.ok(lastBox.y>50 && lastBox.y+lastBox.height<768,'Wheel must reveal last series within rail');
      await tiles.last().hover();
      await page.waitForFunction(() => document.querySelector('[role="tooltip"]')?.textContent.includes('не указана'));
      assert.match(await page.getByRole('tooltip').innerText(),/Толщина среза: не указана/);
      const box=await page.locator('[data-cy="local-series-preview"]').first().boundingBox();
      assert.ok(box.y>=0 && box.y+box.height<=768,'Preview must fit near bottom of small screen');
      await page.mouse.move(30,600); await page.mouse.wheel(0,-1800);
      await page.waitForTimeout(250);
    }
    await page.mouse.move(500,500);
    await page.screenshot({path:path.join(__dirname,artifact+'.png')});
    assert.deepEqual(errors,[]); assert.deepEqual(external,[]);
    const result={result:'PASS', tiles:expectedCount, width:72, thumbnail:[56,68], preview:text, dragAndDrop:true,
      commonGridDrop:true, mprDrop:true, scrollAndThickness:expectedCount>2,
      fullPanel:true, keyboardSelection:true, smallScreen:true, javascriptErrors:errors,externalRequests:external};
    fs.writeFileSync(path.join(__dirname,artifact+'.json'),JSON.stringify(result,null,2)+'\n');
    console.log(JSON.stringify(result));
  } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
