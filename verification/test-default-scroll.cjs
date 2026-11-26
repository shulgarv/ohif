// Run: OHIF_PLAYWRIGHT_PATH=/path/to/playwright node test-default-scroll.cjs <synthetic-fixture-root>
const {chromium} = require(process.env.OHIF_PLAYWRIGHT_PATH || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const fixtureRoot = process.argv[2] || '/tmp/ohif-import-fixtures';
(async () => {
 const browser = await chromium.launch({executablePath: process.env.OHIF_CHROMIUM_PATH || '/usr/bin/chromium',args:['--disable-dev-shm-usage','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
 try {
  const page = await browser.newPage({viewport:{width:1400,height:1000}});
  const errors=[];
  page.on('pageerror', e=>errors.push(e.message));
  await page.route('**/app-config.js', async route=>{
   const response = await route.fetch();
   const body = await response.text();
   await route.fulfill({response,body:body+`
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
  await page.goto('http://127.0.0.1:3000/localbasic',{waitUntil:'networkidle'});
  await page.locator('input[webkitdirectory]').setInputFiles(path.join(fixtureRoot, 'directory'));
  await page.waitForFunction(()=>document.querySelector('canvas')?.width && window.__ohifTestContext,{}, {timeout:30000});
  await page.waitForFunction(()=>{
   const s=window.__ohifTestContext.servicesManager.services;
   const v=s.cornerstoneViewportService.getCornerstoneViewport(s.viewportGridService.getState().activeViewportId);
   return v && (v.getImageIds?.().length || v.getNumberOfSlices?.());
  },{}, {timeout:30000});
  const state=()=>page.evaluate(()=>{
   const s=window.__ohifTestContext.servicesManager.services;
   const group=s.toolGroupService.getToolGroup('default');
   const v=s.cornerstoneViewportService.getCornerstoneViewport(s.viewportGridService.getState().activeViewportId);
   const rect=v.element.getBoundingClientRect();
   return {active:group.getActivePrimaryMouseButtonTool(),scroll:group.getToolOptions('StackScroll'),window:group.getToolOptions('WindowLevel'),voi:v.getProperties().voiRange,slice:v.getCurrentImageIdIndex?.()??v.getSliceIndex?.(),rect:{x:rect.x,y:rect.y,width:rect.width,height:rect.height}};
  });
  await page.waitForFunction(() => { const c=document.querySelector('canvas'); const t=document.createElement('canvas'); t.width=c.width; t.height=c.height; const x=t.getContext('2d'); x.drawImage(c,0,0); return x.getImageData(0,0,t.width,t.height).data.some((v,i)=>i%4!==3 && v>5); }, {}, {timeout:30000});
  const initial=await state();
  console.log('initial',JSON.stringify(initial));
  assert.equal(initial.active,'StackScroll');
  const {x,y,width,height}=initial.rect;
  await page.mouse.move(x+width/2,y+height/2);
  await page.mouse.down();
  await page.mouse.move(x+width/2,y+height/2+400,{steps:15});
  await page.mouse.up();
  await page.waitForFunction(before=>{
   const s=window.__ohifTestContext.servicesManager.services;
   const v=s.cornerstoneViewportService.getCornerstoneViewport(s.viewportGridService.getState().activeViewportId);
   return (v.getCurrentImageIdIndex?.()??v.getSliceIndex?.())!==before;
  },initial.slice,{timeout:5000});
  const dragged=await state();
  assert.deepEqual(dragged.voi,initial.voi);
  for(const [key,tool] of [['d','Length'],['b','StackScroll'],['в','Length'],['и','StackScroll']]) {
   if (/^[a-z]$/.test(key)) await page.keyboard.press(key);
   else await page.evaluate(key => {
    for (const type of ['keydown','keypress','keyup']) document.body.dispatchEvent(new KeyboardEvent(type, {key, keyCode:key.charCodeAt(0), which:key.charCodeAt(0), bubbles:true}));
   }, key);
   assert.equal((await state()).active,tool,key);
  }
  await page.evaluate(() => window.__ohifTestContext.commandsManager.runCommand('setToolActive', {toolName:'WindowLevel',toolGroupId:'default'}));
  assert.equal((await state()).active,'WindowLevel');
  await page.reload({waitUntil:'networkidle'});
  await page.locator('input[webkitdirectory]').setInputFiles(path.join(fixtureRoot, 'charset'));
  await page.waitForFunction(()=>document.querySelector('canvas')?.width && window.__ohifTestContext,{}, {timeout:30000});
  assert.equal((await state()).active,'StackScroll');
  assert.deepEqual(errors,[]);
  const result={result:'PASS',defaultTool:'StackScroll',dragChangedSlice:{before:initial.slice,after:dragged.slice},windowUnchanged:true,hotkeys:['b','и','d','в'],windowLevelSelectable:true,reimportDefault:'StackScroll',javascriptErrors:errors.length};
  fs.writeFileSync(path.join(__dirname, 'default-scroll-tool.json'),JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify(result));
 } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
