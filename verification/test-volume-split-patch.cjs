// Static checks for the split-volume GPU upload patch and the fallback policy.
// Run: node verification/test-volume-split-patch.cjs
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '..');
const bundlePath = path.join(root, 'www', 'app.bundle.872442cf365ecf1c.js');
const source = fs.readFileSync(bundlePath, 'utf8');
const sha256 = data => crypto.createHash('sha256').update(data).digest('hex');
const checks = [];
const check = (name, condition) => {
  assert.ok(condition, name);
  checks.push(name);
};

// The volume is split only above ANGLE's per-allocation limit, so ordinary
// series keep exactly one texture and the original code path.
check('module advertises the split upload early', source.includes(
  'window.__ohifLocalVolumeTextureSplit = Object.assign({enabled: true, limitBytes:'));
check('split decision keeps small volumes intact', source.includes(
  'if (bytes <= LOCAL_TEXTURE_LIMIT_BYTES) return 0;'));
check('split decision honours the test switches', source.includes('if (flags.forceSingle) return 0;')
  && source.includes('if (flags.forceSplit) return Math.ceil(model.depth / 2);'));
check('second texture reuses the boundary slice',
  source.includes('const lowDepth = model.localSplitDepth + 1;'));
check('second texture is allocated with texStorage3D',
  source.includes('texStorage3D(model.target, 1, model.internalFormat, model.width, model.height, highDepth)'));
check('streaming uploads are routed per slice',
  source.includes('publicAPI.localUploadSlices(0, 0, zOffset, model.width, model.height, 1, pixData)'));
check('partial 3D uploads are routed', source.includes(
  'publicAPI.localUploadSlices(extent[0], extent[2], extent[4], extentSize[0], extentSize[1], extentSize[2], textureData)'));
check('second texture gets its own unit and sampling parameters',
  source.includes('model.localSplitUnit = model._openGLRenderWindow.getTextureUnitForTexture(model.localSplitProxy);')
  && source.includes('TEXTURE_MIN_FILTER, publicAPI.getOpenGLFilterMode(model.minificationFilter)'));
check('volume shader samples both textures',
  source.includes('vec4 localSampleVolumeTexture(vec3 pos)')
  && source.includes('if (volumeSplitFactors.y <= 0.0) return texture(volumeTexture[0], pos);')
  && source.includes('volumeSplitFactors.z < 0.0 || pos.z < volumeSplitFactors.w')
  && source.includes('texture(volumeTextureHigh, vec3(pos.xy, (pos.z - volumeSplitFactors.x)'));
check('shader samples through the split helper',
  source.includes('return localSampleVolumeTexture(pos);'));
check('mapper binds the second texture and split factors',
  source.includes('program.setUniformi("volumeTextureHigh", bound && bound.unit >= 0 ? bound.unit : splitTexture.getTextureUnit());')
  && source.includes('program.setUniform4f("volumeSplitFactors", bound.offsetZ, bound.scaleLow, bound.scaleHigh, bound.boundaryZ);'));
check('unsplit volumes use the original single texture path',
  source.includes('program.setUniform4f("volumeSplitFactors", 0, 1, -1, 2);'));

// Plain and compressed copies must stay identical for the local server.
const gzip = fs.readFileSync(bundlePath + '.gz');
check('gzip bundle matches plain bundle', zlib.gunzipSync(gzip).equals(Buffer.from(source)));
const record = JSON.parse(fs.readFileSync(path.join(root, 'compatibility', 'installed-patch.json'), 'utf8'));
check('recorded patched hash matches the installed bundle',
  record.patched_sha256 === sha256(Buffer.from(source)));
check('pristine hash is still the pinned OHIF 3.13.12 build',
  record.original_sha256 === '5cd20ee551a63e30329c04f30acf136395c745b18033752df412f1becfced993');

// The app configuration must not down-sample when two textures are enough.
const config = fs.readFileSync(path.join(root, 'app-config.js'), 'utf8');
check('configuration keeps full resolution for two textures',
  config.includes('if (split?.enabled && textureBytes <= 2 * split.limitBytes) return 1;'));
const wwwConfig = fs.readFileSync(path.join(root, 'www', 'app-config.js'));
check('www configuration is synchronised',
  wwwConfig.equals(Buffer.from(config))
  && zlib.gunzipSync(fs.readFileSync(path.join(root, 'www', 'app-config.js.gz'))).equals(wwwConfig));

// Applying the patch twice must be refused instead of duplicating code.
const {execFileSync} = require('node:child_process');
const patchedAgain = execFileSync('python3', ['-c', `
import split_volume_texture
source = open('www/app.bundle.872442cf365ecf1c.js').read()
try:
    split_volume_texture.patch_bundle(source)
except RuntimeError as error:
    print('refused')
`, ], {cwd: root, encoding: 'utf8'});
check('patch refuses to apply twice', patchedAgain.trim() === 'refused');

console.log(JSON.stringify({result: 'PASS', checks}));
