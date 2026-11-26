// Full-resolution MPR on a series that does not fit one WebGL texture.
// ANGLE refuses a single allocation above 1 GiB, so the installed viewer
// uploads the volume as two textures split along Z. This test loads only the
// synthetic fixture from make-large-volume-fixture.py.
//
// Run:
//   OHIF_PLAYWRIGHT_PATH=<playwright> node verification/test-full-resolution-mpr.cjs <zip> [equivalence]
//
// With "equivalence" the same series is rendered twice - once from a single
// texture and once from two textures - and the MPR canvases are compared
// pixel by pixel. Use a fixture that fits 1 GiB (e.g. 460 slices) for that.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {chromium} = require(process.env.OHIF_PLAYWRIGHT_PATH || 'playwright');

const fixture = process.argv[2];
const equivalence = process.argv[3] === 'equivalence';
const reportPath = path.join(__dirname, equivalence
  ? 'full-resolution-mpr-equivalence.json' : 'full-resolution-mpr.json');
const ANGLE_LIMIT_BYTES = 1024 * 1024 * 1024;

const initScript = `(() => {
  window.__texProbe = {textures3: [], lost: []};
  const bytesPer = [[0x8F98,2],[0x8234,2],[0x822A,2],[0x822D,2],[0x822E,4],[0x8229,1],[0x8058,4]];
  const bpp = format => { for (const [f, b] of bytesPer) if (f === format) return b; return 0; };
  const proto = WebGL2RenderingContext.prototype;
  for (const name of ['texImage3D', 'texStorage3D']) {
    const original = proto[name];
    proto[name] = function(...args) {
      const result = original.apply(this, args);
      const [target, level, format, width, height, depth] = args;
      window.__texProbe.textures3.push({call: name, width, height, depth,
        bytes: width * height * depth * bpp(format),
        canvas: this.canvas ? this.canvas.width + 'x' + this.canvas.height : '',
        at: Math.round(performance.now())});
      return result;
    };
  }
  const getContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function(type, ...rest) {
    const context = getContext.call(this, type, ...rest);
    if (context && /webgl/.test(type)) this.addEventListener('webglcontextlost', event => {
      window.__texProbe.lost.push({at: Math.round(performance.now()),
        canvas: this.width + 'x' + this.height});
      event.preventDefault();
    });
    return context;
  };
})();`;

const captureExpression = phase => `(() => {
  const dataFor = canvas => {
    const copy = document.createElement('canvas');
    copy.width = canvas.width;
    copy.height = canvas.height;
    copy.getContext('2d').drawImage(canvas, 0, 0);
    return copy.toDataURL('image/png');
  };
  const profileOf = (canvas, x) => {
    const copy = document.createElement('canvas');
    copy.width = canvas.width;
    copy.height = canvas.height;
    const context = copy.getContext('2d');
    context.drawImage(canvas, 0, 0);
    const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
    const values = [];
    for (let y = 0; y < canvas.height; y += 4) values.push(data[(y * canvas.width + x) * 4]);
    return values;
  };
  const canvases = Array.from(document.querySelectorAll('canvas')).map(canvas => ({
    uid: canvas.closest('[data-viewport-uid]')?.getAttribute('data-viewport-uid') || null,
    width: canvas.width, height: canvas.height, data: dataFor(canvas),
    profile: canvas.width > 200 ? profileOf(canvas, Math.floor(canvas.width * 0.7)) : null
  }));
  const cornerstone = window.__localTestCornerstone;
  return {
    phase: '${phase}',
    canvases,
    volumes: cornerstone ? cornerstone.cache.getVolumes().map(volume => ({
      dimensions: volume.dimensions, spacing: volume.spacing,
      imageIds: volume.imageIds?.length, dataType: volume.dataType
    })) : [],
    probe: {textures3: window.__texProbe.textures3, lost: window.__texProbe.lost}
  };
})()`;

const setupPage = async (browser, flags) => {
  const page = await browser.newPage({viewport: {width: 1400, height: 1000}});
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  // The real configuration needs no flags: the patched viewer always splits a
  // volume that does not fit one GPU texture.
  if (flags) await page.addInitScript(`window.__ohifLocalVolumeTextureSplit = ${JSON.stringify(flags)};`);
  await page.addInitScript(initScript);
  await page.route('**/app-config.js', async route => {
    const response = await route.fetch();
    const body = await response.text() + `
      const cfg = window.config.modesConfiguration['@ohif/mode-longitudinal'].initToolGroups;
      const apply = cfg.$apply;
      cfg.$apply = initialize => {
        const configured = apply(initialize);
        return function(context) {
          window.__localTestCornerstone = context.extensionManager
            .getModuleEntry('@ohif/extension-cornerstone.utilityModule.common').exports
            .getCornerstoneLibraries().cornerstone;
          return configured.call(this, context);
        };
      };
    `;
    await route.fulfill({response, body});
  });
  page.on('dialog', async dialog => { errors.push('dialog: ' + dialog.message()); await dialog.accept(); });
  await page.goto('http://127.0.0.1:3000/localbasic', {waitUntil: 'networkidle'});
  return {page, errors};
};

const openMpr = async page => {
  await page.getByRole('button', {name: 'Load files / ZIP', exact: true}).waitFor({timeout: 60000});
  if (fs.statSync(fixture).isDirectory()) {
    await page.locator('input[webkitdirectory]').setInputFiles(fixture);
  } else {
    await page.locator('input[type=file]:not([webkitdirectory])').setInputFiles(fixture);
  }
  await page.waitForFunction(() => window.__ohifLocalImportSummary, {}, {timeout: 300000});
  const summary = await page.evaluate(() => window.__ohifLocalImportSummary);
  assert.equal(summary.failed, 0, 'import failed');
  // Wait for a stack viewport image area. The synthetic fixtures intentionally
  // contain dark slices, so brightness is not a reliable readiness signal.
  await page.waitForFunction(() => Array.from(document.querySelectorAll('canvas'))
    .some(canvas => canvas.width > 100 && canvas.height > 100), {}, {timeout: 240000});
  await page.evaluate(() => {
    const cornerstone = window.__localTestCornerstone;
    for (const engine of cornerstone.getRenderingEngines()) {
      for (const viewport of engine.getViewports()) {
        try { viewport.setProperties({voiRange: {lower: -1020, upper: 1500}}); } catch (error) {}
      }
    }
  });
  await page.waitForTimeout(3000);
  await page.keyboard.press('F2');
  await page.waitForFunction(() => document.querySelectorAll('canvas').length >= 3, {}, {timeout: 120000});
  // A deterministic display window for both runs.
  await page.evaluate(() => {
    const cornerstone = window.__localTestCornerstone;
    for (const engine of cornerstone.getRenderingEngines()) {
      for (const viewport of engine.getViewports()) {
        try { viewport.setProperties({voiRange: {lower: -1020, upper: 1500}}); } catch (error) {}
      }
    }
  });
  // Wait until the MPR canvases stop changing.
  let previous = '';
  for (let attempt = 0; attempt < 40; attempt++) {
    await page.waitForTimeout(500);
    const current = await page.evaluate(() => Array.from(document.querySelectorAll('canvas'))
      .map(canvas => canvas.width + 'x' + canvas.height + ':' + canvas.toDataURL().length).join(','));
    if (current === previous) break;
    previous = current;
  }
  return summary;
};

const compare = (reference, candidate) => {
  const compareExpression = `new Promise(async resolve => {
    const reference = ${JSON.stringify(reference.canvases)};
    const candidate = ${JSON.stringify(candidate.canvases)};
    const output = [];
    for (const [index, expected] of reference.entries()) {
      const actual = candidate[index];
      if (!actual || actual.uid !== expected.uid ||
          actual.width !== expected.width || actual.height !== expected.height) {
        output.push({uid: expected.uid, shapeMismatch: true});
        continue;
      }
      const load = source => new Promise(loaded => {
        const image = new Image();
        image.onload = () => loaded(image);
        image.src = source;
      });
      const pixels = async source => {
        const image = await load(source);
        const canvas = document.createElement('canvas');
        canvas.width = image.width;
        canvas.height = image.height;
        const context = canvas.getContext('2d');
        context.drawImage(image, 0, 0);
        return context.getImageData(0, 0, canvas.width, canvas.height).data;
      };
      const a = await pixels(expected.data);
      const b = await pixels(actual.data);
      let differing = 0;
      let maxDifference = 0;
      const rows = new Map();
      const samples = [];
      for (let i = 0; i < a.length; i += 4) {
        const difference = Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]),
          Math.abs(a[i + 2] - b[i + 2]));
        if (difference > 2) {
          differing++;
          const y = Math.floor((i / 4) / expected.width);
          const x = (i / 4) % expected.width;
          rows.set(y, (rows.get(y) || 0) + 1);
          if (samples.length < 5) samples.push({x, y,
            reference: [a[i], a[i + 1], a[i + 2]], candidate: [b[i], b[i + 1], b[i + 2]]});
        }
        maxDifference = Math.max(maxDifference, difference);
      }
      const rowSummary = [...rows.entries()].sort((left, right) => right[1] - left[1])
        .slice(0, 6).map(([y, count]) => ({y, count}));
      const ranges = [];
      for (const y of [...rows.keys()].sort((left, right) => left - right)) {
        const last = ranges[ranges.length - 1];
        if (last && y === last[1] + 1) last[1] = y;
        else ranges.push([y, y]);
      }
      output.push({uid: expected.uid, width: expected.width, height: expected.height,
        differing, maxDifference, pixels: a.length / 4, rows: rowSummary,
        ranges: ranges.slice(0, 10), samples});
    }
    resolve(output);
  })`;
  return candidate.page.evaluate(compareExpression);
};

(async () => {
  const browser = await chromium.launch({
    executablePath: process.env.OHIF_CHROMIUM_PATH || '/run/current-system/sw/bin/brave',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-gl=angle', '--use-angle=gl'],
  });
  const report = {fixture: path.basename(fixture), equivalence};
  const problems = [];
  try {
    // OHIF_TEST_REFERENCE_SPLIT renders both runs from two textures; it shows
    // whether remaining pixel differences are run-to-run noise.
    const referenceFlags = process.env.OHIF_TEST_REFERENCE_SPLIT === '1'
      ? {enabled: true, limitBytes: 900 * 1024 * 1024, forceSplit: true}
      : {enabled: true, limitBytes: 900 * 1024 * 1024, forceSingle: true};
    // A single texture above the ANGLE limit cannot be allocated, so the
    // reference run only exists for series that fit one texture.
    let referenceCapture = {canvases: [], probe: {textures3: []}};
    let referenceErrors = [];
    if (equivalence) {
      const reference = await setupPage(browser, referenceFlags);
      await openMpr(reference.page);
      referenceCapture = await reference.page.evaluate(captureExpression('single'));
      referenceErrors = reference.errors;
      await reference.page.close();
    }

    const split = await setupPage(browser, equivalence
      ? {enabled: true, limitBytes: 900 * 1024 * 1024, forceSplit: true} : null);
    const splitSummary = await openMpr(split.page);
    const splitCapture = await split.page.evaluate(captureExpression('split'));
    report.imported = splitSummary.imported;
    report.volume = splitCapture.volumes[0];
    report.textures3 = splitCapture.probe.textures3.map(texture => ({
      width: texture.width, height: texture.height, depth: texture.depth, bytes: texture.bytes}));
    report.referenceTextures3 = referenceCapture.probe.textures3.map(texture => ({
      width: texture.width, height: texture.height, depth: texture.depth, bytes: texture.bytes}));

    report.contextLost = splitCapture.probe.lost;
    report.pageErrors = [...referenceErrors, ...split.errors];
    if (equivalence) {
      const comparison = await compare(referenceCapture, {page: split.page, canvases: splitCapture.canvases});
      report.comparison = comparison;
      await split.page.close();
    }

    // Geometry must stay original: full in-plane resolution and 1 mm Z step.
    assert.ok(report.volume, 'volume missing');
    const zStep = Math.abs(report.volume.spacing[2]);
    assert.equal(zStep, 1, 'Z spacing changed');
    assert.equal(report.volume.dimensions[0], 1024, 'in-plane columns changed');
    assert.equal(report.volume.dimensions[1], 1024, 'in-plane rows changed');
    assert.equal(report.volume.imageIds, report.imported, 'slice count changed');
    // Two textures, each within ANGLE's per-allocation limit, covering all slices.
    const textures = report.textures3.filter(texture => texture.width === report.volume.dimensions[0]);
    assert.equal(textures.length, 2, 'volume must be uploaded as two textures');
    // Both textures share the split slice for exact interpolation at the seam.
    assert.equal(textures[0].depth + textures[1].depth, report.volume.dimensions[2] + 1,
      'textures must cover every slice and share one boundary slice');
    for (const texture of textures) {
      assert.ok(texture.bytes <= ANGLE_LIMIT_BYTES, 'texture exceeds the ANGLE allocation limit');
    }
    if (equivalence) {
      assert.equal(report.referenceTextures3.filter(texture =>
        texture.width === report.volume.dimensions[0]).length,
        process.env.OHIF_TEST_REFERENCE_SPLIT === '1' ? 2 : 1,
        'reference run used an unexpected number of volume textures');
    }
    // No context loss and no exceptions in the MPR viewport canvases.
    assert.deepEqual(report.pageErrors, [], 'unexpected page errors');
    assert.equal(Array.isArray(report.contextLost) ? report.contextLost.filter(entry =>
      entry.canvas !== '4x4' && entry.canvas !== '300x150').length : 0, 0,
      'WebGL context lost in a viewport');
    const empty = splitCapture.canvases.filter(canvas => canvas.width > 200 && canvas.data.length < 2000);
    assert.equal(empty.length, 0, 'MPR canvas rendered empty');
    if (equivalence) {
      for (const entry of report.comparison) {
        assert.ok(!entry.shapeMismatch, 'MPR canvas geometry changed between runs');
        const ratio = entry.differing / entry.pixels;
        assert.ok(ratio < 0.001, `split render differs on ${entry.differing} pixels`);
        assert.ok(entry.maxDifference <= 8, `split render differs by ${entry.maxDifference} levels`);
      }
    }
    report.result = 'PASS';
  } catch (error) {
    report.result = 'FAIL';
    report.error = String(error && error.message || error);
    problems.push(report.error);
  } finally {
    await browser.close();
  }
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 1) + '\n');
  console.log(JSON.stringify({result: report.result, report: path.relative(process.cwd(), reportPath),
    error: report.error, textures3: report.textures3, volume: report.volume,
    comparison: report.comparison}));
  if (report.result !== 'PASS') process.exitCode = 1;
})();
