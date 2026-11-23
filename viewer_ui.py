"""Reproducible UI patches for the pinned OHIF build; no patient data access."""
import gzip
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent
PATCH = ROOT / 'compatibility/compact-studies.js'
DEFAULT_BUNDLE = ROOT / 'www/89.bundle.195151dd43a14c57.js'
DEFAULT_SHA256 = '50f4d1938ac24da3191fe26a51821fb06d94c20ee17ad2a4cf4af0b1cd1d8fed'


def replace_once(source, old, new):
    if source.count(old) != 1:
        raise RuntimeError(f'Unexpected pinned UI implementation: {old[:100]!r}')
    return source.replace(old, new)


def patch_ui_bundle(source):
    source = replace_once(source, 'const SidePanel = ({', PATCH.read_text() + '\nconst SidePanel = ({')
    # All hooks above this branch run in both modes. Keep the same native panel
    # content mounted while expanding/collapsing so thumbnails retain their state.
    # Match the tail by component boundaries rather than unrelated JSX.
    start = source.index('const SidePanel = ({')
    end = source.index(';// CONCATENATED MODULE: ../../ui-next/src/components/SidePanel/index.ts', start)
    component = source[start:end]
    index = component.rindex('  return /*#__PURE__*/react.createElement("div", {')
    branch = '''  if (side === 'left') {
    return react.createElement(LocalStudiesCompactContext.Provider, {value:!panelOpen},
      react.createElement('div', {
        className:classnames_default()(className, 'flex flex-col bg-muted'),
        'data-local-studies-compact':panelOpen ? undefined : '',
        style:panelOpen ? style : {...createBaseStyle(64), marginLeft:0, marginRight:4},
      }, react.createElement('style', null, localStudiesStyles),
        panelOpen ? getOpenStateComponent() : react.createElement('button', {
          type:'button', 'data-cy':'side-panel-header-left',
          'aria-label':'Развернуть Studies', title:'Развернуть Studies',
          onClick:() => updatePanelOpen(true),
          className:'text-primary bg-popover rounded',
          style:{height:32,width:64,flexShrink:0,fontSize:10,display:'flex',alignItems:'center',justifyContent:'center',gap:2},
        }, 'Studies', react.createElement(Icons.NavigationPanelReveal, {style:{width:14,height:14,transform:'rotate(180deg)'}})),
        react.createElement('div', {'data-local-studies-content':''}, tabs.map((tab,index) =>
          index === activeTabIndex ? react.createElement(tab.content, {key:index}) : null))));
  }
'''
    component = component[:index] + branch + component[index:]
    source = source[:start] + component + source[end:]
    marker = '  const getTabContent = () => {'
    # The StudyBrowser implementation is the sole owner of this marker.
    source = replace_once(source, marker, '''  const localCompact = react.useContext(LocalStudiesCompactContext);
  if (localCompact) return react.createElement(LocalCompactStudies, {
    tabs, activeTabName, activeDisplaySetInstanceUIDs, servicesManager, onDoubleClickThumbnail,
  });
''' + marker)
    return source


def patch_default_bundle(source):
    # Secondary Capture series can mix scouts with report pages without patient
    # coordinates. Report the missing geometry before any positional validation.
    marker = '''    messages.addMessage(src/* .DisplaySetMessage.CODES.NO_POSITION_INFORMATION */.Ob.CODES.NO_POSITION_INFORMATION);
  }
  const sortedInstances ='''
    source = replace_once(source, marker, '''    messages.addMessage(src/* .DisplaySetMessage.CODES.NO_POSITION_INFORMATION */.Ob.CODES.NO_POSITION_INFORMATION);
    if (!isReconstructable) {
      messages.addMessage(src/* .DisplaySetMessage.CODES.NOT_RECONSTRUCTABLE */.Ob.CODES.NOT_RECONSTRUCTABLE);
    }
    return messages;
  }
  const sortedInstances =''')
    source = replace_once(source, '  leftPanelClosed = false,', '  leftPanelClosed = true,')
    # Loading/dragging a series should not expand the left rail automatically.
    # An explicit forceActive request (or the user's header click) can expand it.
    source = replace_once(source, '          if (!closedManually) {',
                          "          if (!closedManually && (side !== 'left' || activatePanelEvent.forceActive)) {")
    # The outer left panel reserves 72px; the inner content is 64px plus its
    # existing 4px inside/outside borders. Right panel dimensions stay native.
    marker = '      collapsedOffsetWidth: collapsedWidth + collapsedInsideBorderSize + collapsedOutsideBorderSize'
    left = source.index(marker, source.index('const getPanelGroupDefinition ='))
    source = source[:left] + source[left:].replace(marker, '      collapsedOffsetWidth: 72', 1)
    marker = '    collapsedWidth: panelGroupDefinition.shared.collapsedWidth,'
    left = source.index(marker, source.index('const useResizablePanels ='))
    source = source[:left] + source[left:].replace(marker, '    collapsedWidth: 64,', 1)
    # Reset one-up history only after the protocol accepts the explicit layout.
    marker = '      const completeLayout = () => {\n        const state = viewportGridService.getState();'
    source = replace_once(source, marker, '''      useToggleOneUpViewportGridStore.getState().clearToggleOneUpViewportGridStore();
''' + marker)
    marker = '''        viewportGridService.setLayout({
          numRows,
          numCols,
          findOrCreateViewport,
          isHangingProtocolLayout
        });'''
    source = replace_once(source, marker, '''        const commonViewport = (...args) => {
          const viewport = findOrCreateViewport(...args);
          if (isHangingProtocolLayout || viewport?.viewportOptions?.toolGroupId !== 'mpr') return viewport;
          // Common keeps the series and projection, but no MPR tools or VOI sync.
          return {...viewport, viewportOptions:{...viewport.viewportOptions,
            toolGroupId:'default', syncGroups:[],
          }};
        };
        viewportGridService.setLayout({
          numRows,
          numCols,
          findOrCreateViewport:commonViewport,
          isHangingProtocolLayout
        });''')
    return source


def apply_default_extension():
    backup = ROOT / 'compatibility/default-extension.original.js.gz'
    record = ROOT / 'compatibility/installed-layout-studies.json'
    installed = DEFAULT_BUNDLE.read_bytes()
    source_hash = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
    previous = json.loads(record.read_text()) if record.exists() else {}
    if previous.get('patched_sha256') == hashlib.sha256(installed).hexdigest():
        if previous.get('source_sha256') == source_hash:
            print('Layout and Studies extension fix already applied')
            return
        original = gzip.decompress(backup.read_bytes())
    else:
        original = installed
    if hashlib.sha256(original).hexdigest() != DEFAULT_SHA256:
        raise RuntimeError('Unexpected default extension bundle; refusing unknown build')
    patched = patch_default_bundle(original.decode()).encode()
    if not backup.exists():
        backup.write_bytes(gzip.compress(original, mtime=0))
    temporary = DEFAULT_BUNDLE.with_suffix('.js.tmp')
    temporary.write_bytes(patched)
    temporary.replace(DEFAULT_BUNDLE)
    DEFAULT_BUNDLE.with_suffix('.js.gz').write_bytes(gzip.compress(patched, mtime=0))
    record.write_text(json.dumps({'version':'3.13.12', 'source_sha256':source_hash,
        'original_sha256':DEFAULT_SHA256, 'patched_sha256':hashlib.sha256(patched).hexdigest()}, indent=2) + '\n')
    print('Applied layout and Studies extension fix; original bundle backed up')


if __name__ == '__main__':
    apply_default_extension()
