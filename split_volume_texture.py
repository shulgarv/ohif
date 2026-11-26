"""Upload an oversized MPR volume as two 3D textures split along Z.

ANGLE rejects a single texture allocation larger than 1 GiB
(``maxTextureBytes``; GL_INVALID_OPERATION, "Texture total allocation size is
too large"), so a 1024x1024x629 16-bit CT volume (1.23 GiB) cannot be uploaded
as one texture. This patch keeps the vtkImageData, geometry, spacing and every
voxel unchanged and only splits the GPU upload into two textures. The volume
mapper samples the second texture above the split plane.

Patches applied to the installed OHIF app bundle:
  * vtkOpenGLTexture.create3DFromRaw: allocate two textures when needed;
  * vtkOpenGLTexture.activate/release: bind and release the second texture;
  * vtkStreamingOpenGLTexture slice uploads: route slices to the right texture;
  * vtkVolumeFS shader: sample either texture from normalized coordinates;
  * vtkOpenGLVolumeMapper uniforms: bind the second texture and split factors.
"""

LIMIT_BYTES = 900 * 1024 * 1024  # below ANGLE's hard 1 GiB per allocation

MARKER = '__ohifLocalVolumeTextureSplit'

HELPERS = '''	publicAPI.localHasSplitTexture = () => !!model.localSplitHandle;
	publicAPI.localGetSplitInfo = () => {
		if (!model.localSplitHandle) return null;
		// The second texture repeats the split slice, so both textures hold the
		// neighbours needed for linear interpolation across the seam.
		const split = model.localSplitDepth;
		const depth = model.depth;
		return {
			offsetZ: split / depth,
			scaleLow: depth / (split + 1),
			scaleHigh: depth / (depth - split),
			boundaryZ: (split + 0.5) / depth,
			unit: typeof model.localSplitUnit === "number" ? model.localSplitUnit : -1
		};
	};
	publicAPI.localUploadSlices = (x, y, z, width, height, depth, pixels) => {
		if (!depth) return;
		const context = model.context;
		const split = model.localSplitDepth;
		const upload = (handle, targetZ, layers, offsetLayers) => {
			if (layers <= 0) return;
			context.bindTexture(model.target, handle);
			const sliceSize = width * height;
			const data = offsetLayers
				? pixels.subarray(offsetLayers * sliceSize, (offsetLayers + layers) * sliceSize)
				: pixels;
			context.texSubImage3D(model.target, 0, x, y, targetZ, width, height, layers,
				model.format, model.openGLDataType, data);
		};
		if (split) {
			// Low texture keeps slices [0..split], high texture [split..depth-1];
			// the shared slice makes the seam interpolation exact.
			const lowLayers = Math.max(0, Math.min(z + depth, split + 1) - z);
			upload(model.handle, z, lowLayers, 0);
			const highStart = Math.max(z, split);
			const highLayers = z + depth - highStart;
			upload(model.localSplitHandle, highStart - split, highLayers, highStart - z);
		} else upload(model.handle, z, depth, 0);
	};
	const localCreateSplitTexture = () => {
		const handle = model.context.createTexture();
		model.context.bindTexture(model.target, handle);
		model.context.texParameteri(model.target, model.context.TEXTURE_MIN_FILTER, publicAPI.getOpenGLFilterMode(model.minificationFilter));
		model.context.texParameteri(model.target, model.context.TEXTURE_MAG_FILTER, publicAPI.getOpenGLFilterMode(model.magnificationFilter));
		model.context.texParameteri(model.target, model.context.TEXTURE_WRAP_S, publicAPI.getOpenGLWrapMode(model.wrapS));
		model.context.texParameteri(model.target, model.context.TEXTURE_WRAP_T, publicAPI.getOpenGLWrapMode(model.wrapT));
		if (model._openGLRenderWindow.getWebgl2()) model.context.texParameteri(model.target, model.context.TEXTURE_WRAP_R, publicAPI.getOpenGLWrapMode(model.wrapR));
		return handle;
	};
	const localSplitFlags = () => {
		try {
			return window.__ohifLocalVolumeTextureSplit || {};
		} catch (error) {
			return {};
		}
	};
	const localSplitDepthFor = (dataType) => {
		// Keep vtk texture sizes untouched unless a single 3D allocation would
		// exceed the WebGL limit. Geometry and voxel values stay original.
		if (model.numberOfDimensions !== 3 || model.depth < 8) return 0;
		const flags = localSplitFlags();
		// Test-only switches used by verification/test-full-resolution-mpr.cjs.
		if (flags.forceSingle) return 0;
		if (flags.forceSplit) return Math.ceil(model.depth / 2);
		const bytes = model.width * model.height * model.depth * Math.max(1, model.components) *
			model._openGLRenderWindow.getDefaultTextureByteSize(dataType, getNorm16Ext(), publicAPI.useHalfFloat());
		if (bytes <= LOCAL_TEXTURE_LIMIT_BYTES) return 0;
		return Math.ceil(model.depth / 2);
	};
	const localReleaseSplit = () => {
		if (!model.localSplitHandle) return;
		if (model.context) model.context.deleteTexture(model.localSplitHandle);
		if (model._openGLRenderWindow && model.localSplitProxy) model._openGLRenderWindow.deactivateTexture(model.localSplitProxy);
		model.localSplitHandle = 0;
		model.localSplitProxy = null;
		model.localSplitUnit = -1;
		model.localSplitDepth = 0;
	};
	const LOCAL_TEXTURE_LIMIT_BYTES = %d;
	try {
		window.%s = Object.assign({enabled: true, limitBytes: LOCAL_TEXTURE_LIMIT_BYTES},
			window.%s || {});
	} catch (error) {}
''' % (LIMIT_BYTES, MARKER, MARKER)

CREATE_3D_ORIGINAL = '''		if (rebuildEntireTexture) {
			if (useTexStorage(dataTypeToUse)) {
				model.context.texStorage3D(model.target, 1, model.internalFormat, model.width, model.height, model.depth);
				if (scaledData[0] != null) model.context.texSubImage3D(model.target, 0, 0, 0, 0, model.width, model.height, model.depth, model.format, model.openGLDataType, scaledData[0]);
			} else model.context.texImage3D(model.target, 0, model.internalFormat, model.width, model.height, model.depth, 0, model.format, model.openGLDataType, scaledData[0]);
			model._prevTexParams = getTexParams();
		} else if (hasUpdatedExtents) {'''

CREATE_3D_PATCHED = '''		if (rebuildEntireTexture) {
			model.localSplitDepth = localSplitDepthFor(dataTypeToUse);
			if (model.localSplitDepth) {
				const lowDepth = model.localSplitDepth + 1;
				const highDepth = model.depth - model.localSplitDepth;
				if (useTexStorage(dataTypeToUse)) {
					model.context.texStorage3D(model.target, 1, model.internalFormat, model.width, model.height, lowDepth);
					model.localSplitHandle = localCreateSplitTexture();
					model.context.texStorage3D(model.target, 1, model.internalFormat, model.width, model.height, highDepth);
				} else {
					model.context.texImage3D(model.target, 0, model.internalFormat, model.width, model.height, lowDepth, 0, model.format, model.openGLDataType, null);
					model.localSplitHandle = localCreateSplitTexture();
					model.context.texImage3D(model.target, 0, model.internalFormat, model.width, model.height, highDepth, 0, model.format, model.openGLDataType, null);
				}
				publicAPI.bind();
				try {
					const splitRecord = window.__ohifLocalVolumeTextureSplit || {};
					splitRecord.lastSplit = {
						handle: model.handle, handleHigh: model.localSplitHandle,
						split: model.localSplitDepth, depthLow: lowDepth, depthHigh: highDepth,
						width: model.width, height: model.height,
						internalFormat: model.internalFormat
					};
					window.__ohifLocalVolumeTextureSplit = splitRecord;
				} catch (error) {}
				if (scaledData[0] != null) publicAPI.localUploadSlices(0, 0, 0, model.width, model.height, model.depth, scaledData[0]);
			} else if (useTexStorage(dataTypeToUse)) {
				model.context.texStorage3D(model.target, 1, model.internalFormat, model.width, model.height, model.depth);
				if (scaledData[0] != null) model.context.texSubImage3D(model.target, 0, 0, 0, 0, model.width, model.height, model.depth, model.format, model.openGLDataType, scaledData[0]);
			} else model.context.texImage3D(model.target, 0, model.internalFormat, model.width, model.height, model.depth, 0, model.format, model.openGLDataType, scaledData[0]);
			model._prevTexParams = getTexParams();
		} else if (hasUpdatedExtents) {'''

EXTENT_ORIGINAL = '''				model.context.texSubImage3D(model.target, 0, extent[0], extent[2], extent[4], extentSize[0], extentSize[1], extentSize[2], model.format, model.openGLDataType, textureData);'''
EXTENT_PATCHED = '''				publicAPI.localUploadSlices(extent[0], extent[2], extent[4], extentSize[0], extentSize[1], extentSize[2], textureData);'''

ACTIVATE_ORIGINAL = '''	publicAPI.activate = () => {
		model._openGLRenderWindow.activateTexture(publicAPI);
		publicAPI.bind();
	};'''
ACTIVATE_PATCHED = '''	publicAPI.activate = () => {
		model._openGLRenderWindow.activateTexture(publicAPI);
		publicAPI.bind();
		if (model.localSplitHandle) {
			// The second half of an oversized volume needs its own texture unit
			// and the same sampling parameters as the primary texture: vtk may
			// switch to linear interpolation after the texture was created.
			model.localSplitProxy = model.localSplitProxy || {};
			model._openGLRenderWindow.activateTexture(model.localSplitProxy);
			model.context.bindTexture(model.target, model.localSplitHandle);
			model.context.texParameteri(model.target, model.context.TEXTURE_WRAP_S, publicAPI.getOpenGLWrapMode(model.wrapS));
			model.context.texParameteri(model.target, model.context.TEXTURE_WRAP_T, publicAPI.getOpenGLWrapMode(model.wrapT));
			if (model._openGLRenderWindow.getWebgl2()) model.context.texParameteri(model.target, model.context.TEXTURE_WRAP_R, publicAPI.getOpenGLWrapMode(model.wrapR));
			model.context.texParameteri(model.target, model.context.TEXTURE_MIN_FILTER, publicAPI.getOpenGLFilterMode(model.minificationFilter));
			model.context.texParameteri(model.target, model.context.TEXTURE_MAG_FILTER, publicAPI.getOpenGLFilterMode(model.magnificationFilter));
			model.localSplitUnit = model._openGLRenderWindow.getTextureUnitForTexture(model.localSplitProxy);
		}
	};'''

RELEASE_ORIGINAL = '''	publicAPI.releaseGraphicsResources = (rwin) => {
		if (rwin && model.handle) {'''
RELEASE_PATCHED = '''	publicAPI.releaseGraphicsResources = (rwin) => {
		localReleaseSplit();
		if (rwin && model.handle) {'''

STREAMING_SLICES = [
    ('''                publicAPI.bind();
                const zOffset = i;
                gl.texSubImage3D(model.target, 0, 0, 0, zOffset, model.width, model.height, 1, model.format, model.openGLDataType, pixData);
                publicAPI.deactivate();
                model.updatedFrames[i] = null;''',
     '''                const zOffset = i;
                publicAPI.localUploadSlices(0, 0, zOffset, model.width, model.height, 1, pixData);
                publicAPI.deactivate();
                model.updatedFrames[i] = null;'''),
    ('''            publicAPI.bind();
            let zOffset = i;
            gl.texSubImage3D(model.target, 0, 0, 0, zOffset, model.width, model.height, 1, model.format, model.openGLDataType, pixData);
            publicAPI.deactivate();''',
     '''            let zOffset = i;
            publicAPI.localUploadSlices(0, 0, zOffset, model.width, model.height, 1, pixData);
            publicAPI.deactivate();'''),
]

SHADER_SAMPLER_ORIGINAL = 'uniform highp sampler3D volumeTexture[vtkNumberOfVolumeTextures];\\nuniform sampler2D colorTexture;'
SHADER_SAMPLER_PATCHED = (
    'uniform highp sampler3D volumeTexture[vtkNumberOfVolumeTextures];\\n'
    'uniform highp sampler3D volumeTextureHigh;\\n'
    'uniform vec4 volumeSplitFactors;\\n'
    'vec4 localSampleVolumeTexture(vec3 pos) {\\n'
    '  if (volumeSplitFactors.y <= 0.0) return texture(volumeTexture[0], pos);\\n'
    '  if (volumeSplitFactors.z < 0.0 || pos.z < volumeSplitFactors.w) return texture(volumeTexture[0], vec3(pos.xy, pos.z * volumeSplitFactors.y));\\n'
    '  return texture(volumeTextureHigh, vec3(pos.xy, (pos.z - volumeSplitFactors.x) * volumeSplitFactors.z));\\n'
    '}\\nuniform sampler2D colorTexture;'
)

SHADER_SAMPLE_ORIGINAL = '\\n    return texture(volumeTexture[0], pos);\\n'
SHADER_SAMPLE_PATCHED = '\\n    return localSampleVolumeTexture(pos);\\n'

UNIFORM_ORIGINAL = '''		const volumeShadowSampleDistance = sampleDistance * model.renderable.getVolumeShadowSamplingDistFactor();
		program.setUniformf("volumeShadowSampleDistance", volumeShadowSampleDistance);
		model.scalarTextures.forEach((scalarTexture, component) => {
			program.setUniformi(`volumeTexture[${component}]`, scalarTexture.getTextureUnit());
		});'''
UNIFORM_PATCHED = '''		const volumeShadowSampleDistance = sampleDistance * model.renderable.getVolumeShadowSamplingDistFactor();
		program.setUniformf("volumeShadowSampleDistance", volumeShadowSampleDistance);
		model.scalarTextures.forEach((scalarTexture, component) => {
			program.setUniformi(`volumeTexture[${component}]`, scalarTexture.getTextureUnit());
		});
		if (program.isUniformUsed("volumeSplitFactors")) {
			// Bind the second half of an oversized volume texture. When the
			// volume fits in one texture the low texture is used for everything.
			const splitTexture = model.scalarTextures[0];
			const splitInfo = typeof splitTexture?.localGetSplitInfo === "function" ? splitTexture.localGetSplitInfo() : null;
			if (splitInfo && splitInfo.unit < 0) splitTexture.activate();
			const bound = splitInfo && typeof splitTexture?.localGetSplitInfo === "function" ? splitTexture.localGetSplitInfo() : null;
			if (bound) program.setUniform4f("volumeSplitFactors", bound.offsetZ, bound.scaleLow, bound.scaleHigh, bound.boundaryZ);
			else program.setUniform4f("volumeSplitFactors", 0, 1, -1, 2);
			if (program.isUniformUsed("volumeTextureHigh")) program.setUniformi("volumeTextureHigh", bound && bound.unit >= 0 ? bound.unit : splitTexture.getTextureUnit());
		}'''


MODULE_FLAG_ORIGINAL = 'function vtkOpenGLTexture(publicAPI, model) {'
MODULE_FLAG_PATCHED = """// Local: advertise the split volume upload before any volume is created, so
// app-config.js can keep the full in-plane resolution instead of downsampling.
try {
	window.%s = Object.assign({enabled: true, limitBytes: %d},
		window.%s || {});
} catch (error) {}
function vtkOpenGLTexture(publicAPI, model) {""" % (MARKER, LIMIT_BYTES, MARKER)


def _replace_once(source, old, new, description):
    if source.count(old) != 1:
        raise RuntimeError(f'Unexpected {description} implementation ({source.count(old)} matches)')
    return source.replace(old, new, 1)


def patch_bundle(source):
    """Return the bundle source with the split-volume texture patch applied."""
    if MARKER in source:
        raise RuntimeError('Volume texture split patch already applied to this source')
    anchor = '	publicAPI.create3DFromRaw = ({'
    if source.count(anchor) != 1:
        raise RuntimeError('Unexpected vtkOpenGLTexture.create3DFromRaw anchor')
    source = _replace_once(source, MODULE_FLAG_ORIGINAL, MODULE_FLAG_PATCHED,
                           'vtkOpenGLTexture module entry')
    source = _replace_once(source, anchor, HELPERS + anchor,
                           'vtkOpenGLTexture.create3DFromRaw anchor')
    source = _replace_once(source, CREATE_3D_ORIGINAL, CREATE_3D_PATCHED,
                           'vtkOpenGLTexture.create3DFromRaw')
    source = _replace_once(source, EXTENT_ORIGINAL, EXTENT_PATCHED,
                           'vtkOpenGLTexture partial 3D upload')
    source = _replace_once(source, ACTIVATE_ORIGINAL, ACTIVATE_PATCHED,
                           'vtkOpenGLTexture.activate')
    source = _replace_once(source, RELEASE_ORIGINAL, RELEASE_PATCHED,
                           'vtkOpenGLTexture.releaseGraphicsResources')
    for original, patched in STREAMING_SLICES:
        source = _replace_once(source, original, patched,
                               'vtkStreamingOpenGLTexture slice upload')
    source = _replace_once(source, SHADER_SAMPLER_ORIGINAL, SHADER_SAMPLER_PATCHED,
                           'vtkVolumeFS sampler declaration')
    source = _replace_once(source, SHADER_SAMPLE_ORIGINAL, SHADER_SAMPLE_PATCHED,
                           'vtkVolumeFS volume sampling')
    source = _replace_once(source, UNIFORM_ORIGINAL, UNIFORM_PATCHED,
                           'vtkOpenGLVolumeMapper volume texture uniforms')
    return source
