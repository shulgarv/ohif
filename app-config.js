window.config = {
  name: 'Local DICOM',
  routerBasename: '/',
  // Keep one-off measurements temporary without asking to track each series.
  measurementTrackingMode: 'none',
  extensions: [],
  modes: [],
  modesConfiguration: {
    '@ohif/mode-longitudinal': {
      onModeEnter: {
        $apply: enter => function (context) {
          enter.call(this, context);
          const {commandsManager, servicesManager} = context;
          const {viewportGridService, cornerstoneViewportService, toolGroupService,
            hangingProtocolService} = servicesManager.services;
          let mprOneUpViewports = null;
          let switchingMprProjection = false;
          let commonLayout = false;
          const pendingCommonProjections = new Map();
          this._unsubscriptions.push(() => {
            for (const unsubscribe of pendingCommonProjections.values()) unsubscribe();
            pendingCommonProjections.clear();
          });
          const getCommonProjectionTarget = () => {
            const state = viewportGridService.getState();
            if (!commonLayout && state.isHangingProtocolLayout &&
                hangingProtocolService.getState().protocolId !== 'default') return;
            const entry = state.viewports.get(state.activeViewportId);
            const viewport = cornerstoneViewportService.getCornerstoneViewport(state.activeViewportId);
            const displaySets = entry?.displaySetInstanceUIDs.map(uid =>
              servicesManager.services.displaySetService.getDisplaySetByUID(uid));
            if (!viewport || !displaySets?.some(ds => ds?.isReconstructable) ||
                ['volume3d', 'volume3D'].includes(viewport.type)) return;
            return {state, entry, viewport, displaySets};
          };
          const isMprViewport = viewport => viewport?.viewportOptions.toolGroupId === 'mpr';
          const isMprOneUp = state => state.layout.numRows === 1 && state.layout.numCols === 1 &&
            isMprViewport(state.viewports.get(state.activeViewportId));
          // D/E arm one measurement. Completion is distinct from annotation
          // creation (mouse down), updates, and restoring measurements with Undo.
          const {cornerstone, cornerstoneTools} = context.extensionManager.getModuleEntry(
            '@ohif/extension-cornerstone.utilityModule.common').exports.getCornerstoneLibraries();
          let singleMeasurement = null;
          let measurementMouseDown = false;
          const onMeasurementToolActivated = event => {
            const {toolGroupId, toolBindingsOptions} = event.detail;
            if (singleMeasurement?.group.id === toolGroupId &&
                toolBindingsOptions.bindings?.some(binding => binding.mouseButton === 1)) {
              singleMeasurement = null;
            }
          };
          commandsManager.registerCommand('DEFAULT', 'localMeasureOnce', {
            commandFn: ({toolName}) => {
              singleMeasurement = null;
              commandsManager.runCommand('setToolActive', {toolName});
              const group = toolGroupService.getToolGroupForViewport(
                viewportGridService.getState().activeViewportId);
              if (group?.getActivePrimaryMouseButtonTool() === toolName) {
                singleMeasurement = {group, toolName};
              }
            },
          });
          const finishSingleMeasurement = () => {
            const pending = singleMeasurement;
            if (!pending?.completed || measurementMouseDown) return;
            // Finish the tool's mouse-up callback before making it passive.
            queueMicrotask(() => {
              if (singleMeasurement !== pending || measurementMouseDown || toolGroupService.getToolGroupForViewport(
                  viewportGridService.getState().activeViewportId) !== pending.group ||
                  pending.group.getActivePrimaryMouseButtonTool() !== pending.toolName) return;
              commandsManager.runCommand('setToolActive', {
                toolName: 'StackScroll', toolGroupId: pending.group.id,
              });
            });
          };
          const onMeasurementCompleted = event => {
            if (!singleMeasurement || event.detail?.annotation?.metadata?.toolName !== singleMeasurement.toolName) return;
            singleMeasurement.completed = true;
            finishSingleMeasurement();
          };
          // Freehand can complete when the contour closes before mouse up.
          const onMeasurementMouseDown = event => {
            if (event.button === 0) measurementMouseDown = true;
          };
          const onMeasurementMouseUp = event => {
            if (event.button !== 0) return;
            measurementMouseDown = false;
            finishSingleMeasurement();
          };
          document.addEventListener('mousedown', onMeasurementMouseDown, true);
          document.addEventListener('mouseup', onMeasurementMouseUp, true);
          cornerstone.eventTarget.addEventListener(
            cornerstoneTools.Enums.Events.ANNOTATION_COMPLETED, onMeasurementCompleted);
          cornerstone.eventTarget.addEventListener(
            cornerstoneTools.Enums.Events.TOOL_ACTIVATED, onMeasurementToolActivated);
          this._unsubscriptions.push(() => {
            singleMeasurement = null;
            cornerstone.eventTarget.removeEventListener(
              cornerstoneTools.Enums.Events.ANNOTATION_COMPLETED, onMeasurementCompleted);
            cornerstone.eventTarget.removeEventListener(
              cornerstoneTools.Enums.Events.TOOL_ACTIVATED, onMeasurementToolActivated);
            document.removeEventListener('mousedown', onMeasurementMouseDown, true);
            document.removeEventListener('mouseup', onMeasurementMouseUp, true);
            delete commandsManager.getContext('DEFAULT').localMeasureOnce;
          });
          // Momentary slab control, using the physical J key for both layouts.
          // Capture before Cornerstone so the existing primary tool stays intact.
          let slabPointer = null;
          let slabGesture = null;
          let slabMouseDown = false;
          const thinSlab = 0.05; // Cornerstone MINIMUM_SLAB_THICKNESS in this pinned build.
          // Slab/blend belong to each projection. OHIF's shared LUT snapshot
          // keeps thickness but omits blend, so carry both with pane position.
          const getPositionPresentation = cornerstoneViewportService._getPositionPresentation;
          const setPositionPresentation = cornerstoneViewportService._setPositionPresentation;
          cornerstoneViewportService._getPositionPresentation = function (viewportId) {
            const presentation = getPositionPresentation.call(this, viewportId);
            const viewport = this.getCornerstoneViewport(viewportId);
            if (presentation && viewport?.type === 'orthographic' &&
                isMprViewport(viewportGridService.getState().viewports.get(viewportId))) {
              return {...presentation, localMprSlab: {
                thickness: viewport.getSlabThickness(), blend: viewport.getBlendMode(),
              }};
            }
            return presentation;
          };
          cornerstoneViewportService._setPositionPresentation = function (viewport, presentation) {
            const result = setPositionPresentation.call(this, viewport, presentation);
            const slab = presentation?.localMprSlab;
            if (slab && viewport.type === 'orthographic' &&
                isMprViewport(viewportGridService.getState().viewports.get(viewport.id))) {
              const blendChanged = viewport.getBlendMode() !== slab.blend;
              const thicknessChanged = viewport.getSlabThickness() !== slab.thickness;
              if (blendChanged) viewport.setBlendMode(slab.blend);
              if (thicknessChanged) {
                if (slab.thickness <= thinSlab) viewport.resetSlabThickness();
                else viewport.setSlabThickness(slab.thickness);
              }
              if (blendChanged || thicknessChanged) viewport.render();
            }
            return result;
          };
          this._unsubscriptions.push(() => {
            cornerstoneViewportService._getPositionPresentation = getPositionPresentation;
            cornerstoneViewportService._setPositionPresentation = setPositionPresentation;
          });
          const editableTarget = event => event.target?.closest?.(
            'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="dialog"]');
          const slabKey = event => event.code === 'KeyJ' || ['j', 'о'].includes(event.key?.toLowerCase());
          const slabViewportAt = point => {
            if (!point || commonLayout) return;
            for (const [id, entry] of viewportGridService.getState().viewports) {
              if (!isMprViewport(entry)) continue;
              const viewport = cornerstoneViewportService.getCornerstoneViewport(id);
              const rect = viewport?.element.getBoundingClientRect();
              if (viewport?.type === 'orthographic' && viewport.getImageData() &&
                  point.x >= rect.left && point.x < rect.right &&
                  point.y >= rect.top && point.y < rect.bottom) return viewport;
            }
          };
          const finishSlabGesture = () => {
            const viewport = slabGesture?.viewport;
            slabGesture = null;
            if (viewport && cornerstoneViewportService.getCornerstoneViewport(viewport.id) === viewport) {
              cornerstoneViewportService.storePresentation({viewportId: viewport.id});
            }
          };
          const onSlabKeyDown = event => {
            if (!slabKey(event) || event.ctrlKey || event.altKey || event.metaKey || event.shiftKey ||
                event.isComposing || editableTarget(event) ||
                document.querySelector('[role="dialog"]')) return;
            const viewport = slabViewportAt(slabPointer);
            if (!slabGesture && (!viewport || slabPointer.buttons)) return;
            event.preventDefault();
            event.stopImmediatePropagation();
            if (slabGesture || event.repeat) return;
            const {dimensions, spacing} = viewport.getImageData();
            slabGesture = {viewport, y: slabPointer.y,
              max: Math.hypot(...dimensions.map((size, i) => size * spacing[i]))};
            viewportGridService.setActiveViewportId(viewport.id);
          };
          const onSlabKeyUp = event => {
            if (!slabKey(event) || !slabGesture) return;
            event.preventDefault();
            event.stopImmediatePropagation();
            finishSlabGesture();
          };
          const onSlabMove = event => {
            slabPointer = {x: event.clientX, y: event.clientY, buttons: event.buttons};
            if (!slabGesture) return;
            const {viewport, max, y} = slabGesture;
            const state = viewportGridService.getState();
            if (commonLayout || !isMprViewport(state.viewports.get(viewport.id)) ||
                cornerstoneViewportService.getCornerstoneViewport(viewport.id) !== viewport ||
                document.querySelector('[role="dialog"]')) {
              finishSlabGesture();
              return;
            }
            event.preventDefault();
            event.stopImmediatePropagation();
            slabGesture.y = event.clientY;
            const thickness = Math.max(thinSlab, Math.min(max,
              viewport.getSlabThickness() + (y - event.clientY) * 0.25));
            // BlendModes: COMPOSITE = 0, MAXIMUM_INTENSITY_BLEND = 1.
            viewport.setBlendMode(thickness <= thinSlab ? 0 : 1);
            if (thickness <= thinSlab) viewport.resetSlabThickness();
            else viewport.setSlabThickness(thickness);
            viewport.render();
          };
          const onSlabMouseDown = event => {
            slabPointer = {x: event.clientX, y: event.clientY, buttons: event.buttons};
            if (!slabGesture || event.button !== 0) return;
            slabMouseDown = true;
            event.preventDefault();
            event.stopImmediatePropagation();
          };
          const onSlabMouseUp = event => {
            slabPointer = {x: event.clientX, y: event.clientY, buttons: event.buttons};
            if (!slabMouseDown || event.button !== 0) return;
            slabMouseDown = false;
            event.preventDefault();
            event.stopImmediatePropagation();
          };
          const cancelSlabGesture = () => {
            finishSlabGesture();
            slabMouseDown = false;
            slabPointer = null;
          };
          const onSlabVisibility = () => {if (document.hidden) cancelSlabGesture();};
          const slabListeners = [['keydown', onSlabKeyDown], ['keyup', onSlabKeyUp],
            ['mousemove', onSlabMove], ['mousedown', onSlabMouseDown], ['mouseup', onSlabMouseUp]];
          for (const [name, listener] of slabListeners) document.addEventListener(name, listener, true);
          window.addEventListener('blur', cancelSlabGesture);
          document.addEventListener('visibilitychange', onSlabVisibility);
          this._unsubscriptions.push(() => {
            cancelSlabGesture();
            for (const [name, listener] of slabListeners) document.removeEventListener(name, listener, true);
            window.removeEventListener('blur', cancelSlabGesture);
            document.removeEventListener('visibilitychange', onSlabVisibility);
          });
          // The pinned SidePanel has no action slot. Place a real button beside
          // its panel selectors, and reattach when React switches open/closed UI.
          const {measurementService} = servicesManager.services;
          const clearMeasurementsButton = document.createElement('button');
          clearMeasurementsButton.type = 'button';
          clearMeasurementsButton.dataset.cy = 'local-clear-measurements-btn';
          clearMeasurementsButton.setAttribute('aria-label', 'Удалить все измерения');
          clearMeasurementsButton.title = 'Удалить все измерения (можно отменить через Undo)';
          clearMeasurementsButton.className = 'text-primary hover:bg-primary/20 rounded flex items-center justify-center';
          clearMeasurementsButton.style.cssText = 'width:24px;height:28px;flex-shrink:0';
          clearMeasurementsButton.innerHTML = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" ' +
            'stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
            '<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7"/></svg>';
          clearMeasurementsButton.onclick = () => commandsManager.runCommand('localClearAllMeasurements');
          const refreshClearMeasurements = () => {
            const disabled = measurementService.getMeasurements().length === 0;
            clearMeasurementsButton.disabled = disabled;
            clearMeasurementsButton.style.opacity = disabled ? '0.35' : '1';
            clearMeasurementsButton.style.cursor = disabled ? 'default' : 'pointer';
          };
          const placeClearMeasurements = () => {
            const selector = document.querySelector('[data-cy="trackedMeasurements-btn"]');
            const holder = selector?.closest('button')?.parentElement;
            if (holder && clearMeasurementsButton.parentElement !== holder) holder.append(clearMeasurementsButton);
          };
          const clearObserver = new MutationObserver(placeClearMeasurements);
          clearObserver.observe(document.body, {childList: true, subtree: true});
          placeClearMeasurements();
          refreshClearMeasurements();
          const clearSubscriptions = ['MEASUREMENT_ADDED', 'MEASUREMENT_REMOVED', 'MEASUREMENTS_CLEARED',
            'RAW_MEASUREMENT_ADDED', 'MEASUREMENT_UPDATED'].map(name =>
            measurementService.subscribe(measurementService.EVENTS[name], refreshClearMeasurements));
          this._unsubscriptions.push(() => {
            clearObserver.disconnect();
            clearMeasurementsButton.remove();
            for (const {unsubscribe} of clearSubscriptions) unsubscribe();
          });
          // Native Crosshairs requires multiple mounted viewports. Keep its
          // world-space center while OHIF replaces panes, and draw reference
          // lines from the saved plane normals when only one pane is mounted.
          let crosshairTransition = null;
          let crosshairFrame = null;
          let crosshairDrag = null;
          const crosshairPlanes = new Map();
          const crosshairRestores = [];
          const crosshairEnabled = () => ['Active', 'Enabled', 'Passive'].includes(
            toolGroupService.getToolGroup('mpr')?.getToolOptions('Crosshairs')?.mode);
          const singleMpr = () => {
            const state = viewportGridService.getState();
            return !commonLayout && isMprOneUp(state) && mprOneUpViewports ?
              cornerstoneViewportService.getCornerstoneViewport(state.activeViewportId) : null;
          };
          const dot = (a, b) => a.reduce((sum, value, i) => sum + value * b[i], 0);
          const cross = (a, b) => [a[1] * b[2] - a[2] * b[1],
            a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
          const projectCenter = (center, viewport) => {
            const {focalPoint, viewPlaneNormal} = viewport.getCamera();
            const distance = dot(focalPoint.map((value, i) => value - center[i]), viewPlaneNormal);
            return center.map((value, i) => value + distance * viewPlaneNormal[i]);
          };
          let configuredCrosshair = null;
          const configureCrosshair = () => {
            const tool = toolGroupService.getToolGroup('mpr')?.getToolInstance('Crosshairs');
            if (!tool || configuredCrosshair === tool) return tool;
            configuredCrosshair = tool;
            const replace = (name, fn) => {
              const originalFn = tool[name];
              tool[name] = fn(originalFn);
              crosshairRestores.push(() => {tool[name] = originalFn;});
            };
            replace('_recomputeToolCenterFromAbsoluteCameras', originalFn => function (options) {
              if (crosshairTransition) return [...crosshairTransition.center];
              const viewport = singleMpr();
              if (viewport) {
                this.toolCenter = projectCenter(this.toolCenter, viewport);
                return this.toolCenter;
              }
              return originalFn.call(this, options);
            });
            replace('renderAnnotation', originalFn => function (enabledElement, helper) {
              const viewport = singleMpr();
              if (!viewport || viewport !== enabledElement.viewport) {
                return originalFn.call(this, enabledElement, helper);
              }
              if (crosshairTransition) return false;
              this.toolCenter = projectCenter(this.toolCenter, viewport);
              const center = viewport.worldToCanvas(this.toolCenter);
              const normal = viewport.getCamera().viewPlaneNormal;
              const length = Math.hypot(viewport.element.clientWidth, viewport.element.clientHeight);
              const gap = this.configuration.referenceLinesCenterGapRadius || 0;
              let rendered = false;
              for (const [id, planeNormal] of crosshairPlanes) {
                const direction = cross(normal, planeNormal);
                if (Math.hypot(...direction) < 1e-3) continue;
                const point = viewport.worldToCanvas(this.toolCenter.map((v, i) => v + direction[i]));
                const delta = point.map((v, i) => v - center[i]);
                const magnitude = Math.hypot(...delta);
                if (magnitude < 1e-3) continue;
                for (const sign of [-1, 1]) {
                  const key = `local-mpr-crosshair:${id}:${sign}`;
                  let line = helper.getSvgNode(key);
                  if (!line) {
                    line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
                    line.setAttribute('data-local-mpr-crosshair', id);
                    helper.appendNode(line, key);
                  } else helper.setNodeTouched(key);
                  const unit = delta.map(v => v / magnitude * sign);
                  const values = {x1: center[0] + unit[0] * gap, y1: center[1] + unit[1] * gap,
                    x2: center[0] + unit[0] * length, y2: center[1] + unit[1] * length,
                    stroke: this._getReferenceLineColor(id), 'stroke-width': 1};
                  for (const [name, value] of Object.entries(values)) line.setAttribute(name, value);
                }
                rendered = true;
              }
              return rendered;
            });
            return tool;
          };
          const beginCrosshairTransition = ids => {
            const tool = configureCrosshair();
            if (!tool) return;
            for (const [id, entry] of viewportGridService.getState().viewports) {
              const viewport = cornerstoneViewportService.getCornerstoneViewport(id);
              if (isMprViewport(entry) && viewport) {
                crosshairPlanes.set(id, [...viewport.getCamera().viewPlaneNormal]);
              }
            }
            if (!crosshairEnabled()) {
              const center = tool._calculateToolCenterFromAbsoluteCameras();
              if (center) tool.toolCenter = [...center];
              return;
            }
            crosshairTransition = {center: [...tool.toolCenter], pending: new Set(ids)};
            if (crosshairFrame !== null) cancelAnimationFrame(crosshairFrame);
            crosshairFrame = requestAnimationFrame(restoreCrosshairWhenReady);
          };
          const restoreCrosshairWhenReady = () => {
            crosshairFrame = null;
            const transition = crosshairTransition;
            if (!transition) return;
            const state = viewportGridService.getState();
            const ready = state.viewports.size === transition.pending.size &&
              [...transition.pending].every(id => {
                const viewport = cornerstoneViewportService.getCornerstoneViewport(id);
                return state.viewports.has(id) && viewport?.getNumberOfSlices?.() > 0 &&
                  viewport.element.querySelector('canvas')?.width > 0;
              });
            if (!ready) {
              crosshairFrame = requestAnimationFrame(restoreCrosshairWhenReady);
              return;
            }
            // The active pane can remain mounted when neighbours are restored,
            // so it will not emit VIEWPORT_DATA_CHANGED. Wait for the actual
            // target layout, then let mounting/presentation restoration finish.
            crosshairFrame = requestAnimationFrame(() => {
              crosshairFrame = requestAnimationFrame(() => {
                crosshairFrame = null;
                if (crosshairTransition !== transition) return;
                crosshairTransition = null;
                if (crosshairEnabled()) configureCrosshair().setToolCenter([...transition.center]);
              });
            });
          };
          const resetCrosshairLayout = () => {
            crosshairTransition = null;
            crosshairDrag = null;
            crosshairPlanes.clear();
            if (crosshairFrame !== null) cancelAnimationFrame(crosshairFrame);
            crosshairFrame = null;
          };
          const moveCrosshair = event => {
            const viewport = singleMpr();
            if (!viewport || !crosshairEnabled()) return;
            const rect = viewport.element.getBoundingClientRect();
            const point = viewport.canvasToWorld([event.clientX - rect.left, event.clientY - rect.top]);
            const tool = configureCrosshair();
            tool.setToolCenter(point);
            viewport.render();
          };
          const onCrosshairDown = event => {
            if (event.button !== 0 || event.ctrlKey || event.altKey || event.metaKey || crosshairTransition) return;
            const viewport = singleMpr();
            if (!viewport || !crosshairEnabled() || !viewport.element.contains(event.target)) return;
            const tool = configureCrosshair();
            const rect = viewport.element.getBoundingClientRect();
            const center = viewport.worldToCanvas(tool.toolCenter);
            const delta = [event.clientX - rect.left - center[0], event.clientY - rect.top - center[1]];
            const nearCenter = Math.hypot(...delta) <= 12;
            const normal = viewport.getCamera().viewPlaneNormal;
            const nearLine = [...crosshairPlanes.values()].some(planeNormal => {
              const direction = cross(normal, planeNormal);
              if (Math.hypot(...direction) < 1e-3) return false;
              const point = viewport.worldToCanvas(tool.toolCenter.map((v, i) => v + direction[i]));
              const vector = point.map((v, i) => v - center[i]);
              return Math.abs(delta[0] * vector[1] - delta[1] * vector[0]) / Math.hypot(...vector) <= 6;
            });
            if (!event.shiftKey && !nearCenter && !nearLine) return;
            event.preventDefault();
            event.stopImmediatePropagation();
            crosshairDrag = viewport.id;
            moveCrosshair(event);
          };
          const onCrosshairMove = event => {
            if (!crosshairDrag) return;
            event.preventDefault();
            event.stopImmediatePropagation();
            moveCrosshair(event);
          };
          const onCrosshairUp = event => {
            if (!crosshairDrag) return;
            crosshairDrag = null;
            event.preventDefault();
            event.stopImmediatePropagation();
          };
          const cancelCrosshairDrag = () => {crosshairDrag = null;};
          document.addEventListener('mousedown', onCrosshairDown, true);
          document.addEventListener('mousemove', onCrosshairMove, true);
          document.addEventListener('mouseup', onCrosshairUp, true);
          window.addEventListener('blur', cancelCrosshairDrag);
          this._unsubscriptions.push(() => {
            resetCrosshairLayout();
            for (const restore of crosshairRestores) restore();
            document.removeEventListener('mousedown', onCrosshairDown, true);
            document.removeEventListener('mousemove', onCrosshairMove, true);
            document.removeEventListener('mouseup', onCrosshairUp, true);
            window.removeEventListener('blur', cancelCrosshairDrag);
          });
          const preserveMprTool = () => {
            const {activeViewportId, viewports} = viewportGridService.getState();
            const sourceId = viewports.get(activeViewportId)?.viewportOptions.toolGroupId ||
              toolGroupService.getToolGroupForViewport(activeViewportId)?.id;
            const source = sourceId && toolGroupService.getToolGroup(sourceId);
            const target = toolGroupService.getToolGroup('mpr');
            const toolName = source?.getActivePrimaryMouseButtonTool();
            if (sourceId !== 'mpr' && toolName && target?.hasTool(toolName)) {
              commandsManager.runCommand('setToolActive', {toolName, toolGroupId: 'mpr'});
            }
          };
          commandsManager.registerCommand('DEFAULT', 'localOpenMpr', {
            commandFn: () => {
              const state = viewportGridService.getState();
              // Common layouts leave protocolId unchanged. Only a real MPR
              // layout (including double-click one-up) should make this a no-op.
              if (!commonLayout && hangingProtocolService.getState().protocolId === 'mpr' &&
                  state.isHangingProtocolLayout &&
                  isMprViewport(state.viewports.get(state.activeViewportId))) return;
              const displaySetInstanceUIDs = state.viewports.get(state.activeViewportId)?.displaySetInstanceUIDs;
              if (!displaySetInstanceUIDs?.length) return;
              preserveMprTool();
              resetCrosshairLayout();
              commonLayout = false;
              mprOneUpViewports = null;
              // Apply a fresh triptych to the selected series, without restoring
              // a cached Common/one-up layout or rematching the first series.
              const {activeStudyUID} = hangingProtocolService.getState();
              return hangingProtocolService.setProtocol('mpr', {
                stageIndex: 0,
                displaySetSelectorMap: {
                  [`${activeStudyUID}:activeDisplaySet:0`]: [...displaySetInstanceUIDs],
                },
              });
            },
          });
          commandsManager.registerCommand('DEFAULT', 'localToggleMprCrosshairs', {
            commandFn: () => {
              const state = viewportGridService.getState();
              if (isMprViewport(state.viewports.get(state.activeViewportId))) {
                configureCrosshair();
                const result = commandsManager.runCommand('toggleActiveDisabledToolbar', {
                  itemId: 'Crosshairs', toolGroupIds: ['mpr'],
                });
                singleMpr()?.render();
                return result;
              }
            },
          });
          commandsManager.registerCommand('DEFAULT', 'localNextMprProjection', {
            commandFn: async () => {
              const state = viewportGridService.getState();
              if (!isMprOneUp(state) || !mprOneUpViewports || switchingMprProjection ||
                  !cornerstoneViewportService.getCornerstoneViewport(state.activeViewportId)) return;
              const order = ['coronal', 'sagittal', 'axial'];
              const projections = order.map(orientation => mprOneUpViewports.find(viewport =>
                viewport.viewportOptions.orientation?.replace('_reformat', '') === orientation))
                .filter(Boolean);
              const index = projections.findIndex(viewport => viewport.viewportId === state.activeViewportId);
              if (index < 0 || projections.length < 2) return;
              const next = projections[(index + 1) % projections.length];
              beginCrosshairTransition([next.viewportId]);
              switchingMprProjection = true;
              try {
                cornerstoneViewportService.storePresentation({viewportId: state.activeViewportId});
                await viewportGridService.setLayout({
                  numRows: 1, numCols: 1, activeViewportId: next.viewportId,
                  isHangingProtocolLayout: true,
                  findOrCreateViewport: () => ({
                    displaySetInstanceUIDs: [...next.displaySetInstanceUIDs],
                    displaySetOptions: next.displaySetOptions,
                    viewportOptions: {...next.viewportOptions},
                  }),
                });
              } finally {
                switchingMprProjection = false;
              }
            },
          });
          commandsManager.registerCommand('DEFAULT', 'localNextCommonProjection', {
            commandFn: () => {
              const target = getCommonProjectionTarget();
              if (!target) return;
              const {state, entry, viewport, displaySets} = target;
              if (pendingCommonProjections.has(state.activeViewportId)) return;
              const order = ['axial', 'coronal', 'sagittal'];
              let current = cornerstoneViewportService.getOrientation(state.activeViewportId);
              if (!order.includes(current)) {
                // Acquisition plane may be sagittal/coronal as well as axial.
                const normal = viewport.getCamera?.().viewPlaneNormal;
                if (normal) {
                  const axis = normal.map(Math.abs).indexOf(Math.max(...normal.map(Math.abs)));
                  current = ['sagittal', 'coronal', 'axial'][axis];
                }
              }
              const orientation = order[(Math.max(0, order.indexOf(current)) + 1) % order.length];
              const volumeMode = viewport.type === 'orthographic' || viewport.getCurrentMode?.() === 'volume';
              if (volumeMode) {
                return commandsManager.runCommand('setViewportOrientation', {
                  viewportId: state.activeViewportId, orientation,
                });
              }
              // A queued stack scroll must not run against the destroyed
              // stack instance after replacing it with a volume viewport.
              if (viewport.debouncedTimeout) clearTimeout(viewport.debouncedTimeout);
              cornerstoneViewportService.storePresentation({viewportId: state.activeViewportId});
              const voiRange = viewport.getProperties().voiRange;
              const {unsubscribe} = cornerstoneViewportService.subscribe(
                cornerstoneViewportService.EVENTS.VIEWPORT_DATA_CHANGED, ({viewportId}) => {
                  if (viewportId !== state.activeViewportId) return;
                  unsubscribe();
                  pendingCommonProjections.delete(viewportId);
                  const live = cornerstoneViewportService.getCornerstoneViewport(viewportId);
                  const currentUIDs = viewportGridService.getDisplaySetsUIDsForViewport(viewportId);
                  if (!live || !entry.displaySetInstanceUIDs.every(uid => currentUIDs?.includes(uid))) return;
                  commandsManager.runCommand('setViewportOrientation', {viewportId, orientation});
                  if (voiRange) live.setProperties({voiRange: {...voiRange}});
                  live.render();
                });
              pendingCommonProjections.set(state.activeViewportId, unsubscribe);
              try {
                return commandsManager.runCommand('setDisplaySetsForViewports', {
                  viewportsToUpdate: [{
                    viewportId: state.activeViewportId,
                    displaySetInstanceUIDs: [...entry.displaySetInstanceUIDs],
                    displaySetOptions: entry.displaySetOptions || displaySets.map(() => ({})),
                    viewportOptions: {
                      ...entry.viewportOptions, viewportType: 'volume', orientation,
                      toolGroupId: entry.viewportOptions.toolGroupId || 'default',
                    },
                  }],
                });
              } catch (error) {
                unsubscribe();
                pendingCommonProjections.delete(state.activeViewportId);
                throw error;
              }
            },
          });
          // Scope Tab to image projections; the standard hotkey manager always
          // prevents the browser's default action, even when a command does nothing.
          const onMprTab = event => {
            if (event.key !== 'Tab' || event.shiftKey || event.ctrlKey || event.altKey || event.metaKey ||
                event.target?.closest?.('input, textarea, select, [contenteditable="true"], [role="dialog"]')) return;
            const state = viewportGridService.getState();
            const commandName = !commonLayout && state.isHangingProtocolLayout && isMprOneUp(state) && mprOneUpViewports ?
              'localNextMprProjection' : getCommonProjectionTarget() ? 'localNextCommonProjection' : null;
            if (!commandName) return;
            event.preventDefault();
            event.stopImmediatePropagation();
            if (!event.repeat) commandsManager.runCommand(commandName);
          };
          document.addEventListener('keydown', onMprTab, true);
          this._unsubscriptions.push(() => document.removeEventListener('keydown', onMprTab, true));
          this._unsubscriptions.push(() => {
            for (const name of ['localOpenMpr', 'localToggleMprCrosshairs', 'localNextMprProjection',
              'localNextCommonProjection']) {
              delete commandsManager.getContext('DEFAULT')[name];
            }
          });
          // MPR has a separate tool group: carry the current primary tool into it
          // on every entry, including when a previously used MPR layout is restored.
          for (const commandName of ['toggleHangingProtocol', 'setHangingProtocol']) {
            const command = commandsManager.getCommand(commandName, 'DEFAULT');
            commandsManager.registerCommand('DEFAULT', commandName, {
              ...command,
              commandFn: options => {
                if (options?.protocolId || options?.reset) resetCrosshairLayout();
                if (options?.protocolId) commonLayout = false;
                if (options?.reset || (options?.protocolId &&
                    options.protocolId !== hangingProtocolService.getState().protocolId)) {
                  mprOneUpViewports = null;
                }
                if (options?.protocolId === 'mpr') {
                  preserveMprTool();
                }
                return command.commandFn(options);
              },
            });
            this._unsubscriptions.push(() =>
              commandsManager.registerCommand('DEFAULT', commandName, command));
          }
          const commonLayoutCommand = commandsManager.getCommand('setViewportGridLayout', 'DEFAULT');
          commandsManager.registerCommand('DEFAULT', 'setViewportGridLayout', {
            ...commonLayoutCommand,
            commandFn: options => {
              resetCrosshairLayout();
              commonLayout = true;
              mprOneUpViewports = null;
              return commonLayoutCommand.commandFn(options);
            },
          });
          this._unsubscriptions.push(() =>
            commandsManager.registerCommand('DEFAULT', 'setViewportGridLayout', commonLayoutCommand));
          const original = commandsManager.getCommand('toggleOneUp', 'DEFAULT');
          // Save the edited MPR presentation before restoring the multi-pane layout.
          commandsManager.registerCommand('DEFAULT', 'toggleOneUp', {
            ...original,
            commandFn: options => {
              const state = viewportGridService.getState();
              const {activeViewportId, viewports, layout} = state;
              if (layout.numRows !== 1 || layout.numCols !== 1) {
                mprOneUpViewports = !getCommonProjectionTarget() && isMprViewport(viewports.get(activeViewportId)) ?
                  [...viewports.values()].filter(isMprViewport) : null;
              }
              if (layout.numRows === 1 && layout.numCols === 1 &&
                  viewports.get(activeViewportId)?.viewportOptions.toolGroupId === 'mpr' &&
                  cornerstoneViewportService.getCornerstoneViewport(activeViewportId)) {
                cornerstoneViewportService.storePresentation({viewportId: activeViewportId});
              }
              if (!commonLayout && mprOneUpViewports && isMprViewport(viewports.get(activeViewportId))) {
                beginCrosshairTransition(layout.numRows === 1 && layout.numCols === 1 ?
                  mprOneUpViewports.map(v => v.viewportId) : [activeViewportId]);
              }
              return original.commandFn(options);
            },
          });
          this._unsubscriptions.push(() =>
            commandsManager.registerCommand('DEFAULT', 'toggleOneUp', original));
        },
      },
      initToolGroups: {
        $apply: initialize => function (context) {
          initialize.call(this, context);
          const toolGroup = context.toolGroupService.getToolGroup('default');
          toolGroup.setToolPassive('WindowLevel');
          // Primary mouse button; StackScroll keeps its wheel/touch bindings.
          toolGroup.setToolActive('StackScroll', {bindings: [{mouseButton: 1}]});
        },
      },
    },
  },
  customizationService: {
    global: {
      'ohif.hotkeyBindings': {
        $apply: bindings => [
          ...bindings.filter(binding => !((binding.commandName === 'setToolActive' &&
            binding.commandOptions?.toolName === 'CircularBrush') ||
            binding.commandOptions?.toolName === 'Crosshairs' ||
            binding.commandOptions?.itemId === 'Crosshairs' ||
            binding.commandOptions?.value === 'Crosshairs' ||
            binding.keys?.some(key => ['f2', 'f3', 'j', 'о', 'd', 'в', 'e', 'у'].includes(key.toLowerCase())))),
          {commandName: 'localOpenMpr', label: 'Open MPR (F2)', keys: ['f2'], isEditable: true},
          {commandName: 'localToggleMprCrosshairs', label: 'Toggle MPR Crosshairs (F3)',
            keys: ['f3'], isEditable: true},
          {commandName: 'setToolActive', commandOptions: {toolName: 'StackScroll'},
            label: 'Stack Scroll (B)', keys: ['b'], isEditable: true},
          // Explicit null preserves the default tool group while giving the alias
          // a distinct command hash; this manager joins keys as chords, not aliases.
          {commandName: 'setToolActive', commandOptions: {toolName: 'StackScroll', toolGroupId: null},
            label: 'Stack Scroll (И)', keys: ['и'], isEditable: true},
          {commandName: 'localMeasureOnce', commandOptions: {toolName: 'Length'},
            label: 'Length (D)', keys: ['d'], isEditable: true},
          {commandName: 'localMeasureOnce', commandOptions: {toolName: 'Length', toolGroupId: null},
            label: 'Length (В)', keys: ['в'], isEditable: true},
          {commandName: 'localMeasureOnce', commandOptions: {toolName: 'PlanarFreehandROI'},
            label: 'Freehand ROI (E)', keys: ['e'], isEditable: true},
          {commandName: 'localMeasureOnce', commandOptions: {toolName: 'PlanarFreehandROI', toolGroupId: null},
            label: 'Freehand ROI (У)', keys: ['у'], isEditable: true},
        ],
      },
    },
  },
  showStudyList: false,
  // Activate another viewport and use the tool with the same mouse press.
  activateViewportBeforeInteraction: false,
  investigationalUseDialog: { option: 'never' },
  maxNumberOfWebWorkers: 3,
  showWarningMessageForCrossOrigin: true,
  showCPUFallbackMessage: true,
  showLoadingIndicator: true,
  strictZSpacingForVolumeViewport: true,
  groupEnabledModesFirst: true,
  maxNumRequests: { interaction: 100, thumbnail: 5, prefetch: 25 },
  showErrorDetails: 'always',
  defaultDataSourceName: 'dicomlocal',
  dataSources: [
    {
      namespace: '@ohif/extension-default.dataSourcesModule.dicomlocal',
      sourceName: 'dicomlocal',
      configuration: { friendlyName: 'Local DICOM files' },
    },
  ],
};
