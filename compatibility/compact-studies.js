// Shared by SidePanel and StudyBrowser inside the pinned ui-next module.
const LocalStudiesCompactContext = react.createContext(false);
const localStudiesStyles = `
  [data-local-studies-compact] [data-local-studies-content] > :not(:last-child) { display: none; }
  [data-local-studies-content] { display:flex; flex:1; min-height:0; flex-direction:column; }
  .local-series-tile { width:56px; height:68px; padding:2px; border:1px solid transparent;
    border-radius:4px; background:hsl(var(--background)); color:hsl(var(--foreground)); cursor:grab; outline:none; }
  .local-series-tile:hover, .local-series-tile:focus-visible { border-color:hsl(var(--primary)); }
  .local-series-tile[aria-current=true] { border-color:hsl(var(--highlight)); background:hsl(var(--popover)); }
  .local-series-tile img { width:50px; height:50px; object-fit:contain; pointer-events:none; }
  .local-series-tile:active { cursor:grabbing; }
`;

function LocalCompactSeries({item, active, servicesManager, onDoubleClickThumbnail}) {
  const ds = servicesManager.services.displaySetService.getDisplaySetByUID(item.displaySetInstanceUID);
  // Naturalized DICOM metadata may live on the series or on its instances.
  const thicknesses = [...new Set((ds?.instances || []).map(instance => instance.SliceThickness)
    .concat(ds?.SliceThickness).flat().filter(value => value != null && value !== '')
    .map(Number).filter(value => Number.isFinite(value) && value > 0))].sort((a,b) => a-b);
  const thickness = thicknesses.length ? `${thicknesses[0]}${thicknesses.length > 1 ? '–' + thicknesses.at(-1) : ''} мм` : 'не указана';
  const imageSrc = item.imageSrc || ds?.thumbnailSrc;
  const image = size => imageSrc ? react.createElement('img', {
    src:imageSrc, alt:'', draggable:false, style:{width:size,height:size,objectFit:'contain'},
  }) : react.createElement('div', {style:{width:size,height:size,display:'grid',placeItems:'center'}}, item.modality || 'DICOM');
  const description = item.description || 'Без названия';
  return react.createElement(Tooltip_Tooltip, {delayDuration:300},
    react.createElement(Tooltip_TooltipTrigger, {asChild:true},
      react.createElement('div', {
        className:'local-series-tile text-foreground', role:'button', tabIndex:0,
        'aria-label':`${description}, серия ${item.seriesNumber ?? '—'}, ${item.numInstances ?? '—'} изображений`,
        'aria-current':active ? 'true' : undefined,
        'data-cy':'local-series-thumbnail', 'data-display-set-uid':item.displaySetInstanceUID,
        onDoubleClick:() => onDoubleClickThumbnail(item.displaySetInstanceUID),
        onKeyDown:event => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault(); onDoubleClickThumbnail(item.displaySetInstanceUID);
          }
        },
      }, react.createElement(DraggableThumbnailContent, {dragData:item.dragData}, image(50),
        react.createElement('div', {style:{fontSize:10,lineHeight:'12px',textAlign:'center',whiteSpace:'nowrap',overflow:'hidden'}},
          `${item.modality || ''} ${item.seriesNumber ?? ''}`)))),
    react.createElement(Tooltip_TooltipContent, {
      side:'right', sideOffset:10, collisionPadding:8, 'data-cy':'local-series-preview',
      style:{maxWidth:'min(270px, calc(100vw - 100px))',pointerEvents:'none'},
    }, react.createElement('div', {style:{display:'flex',flexDirection:'column',gap:6,fontSize:12}},
      image(190),
      react.createElement('div', {style:{fontWeight:600,whiteSpace:'normal',overflowWrap:'anywhere'}}, description),
      react.createElement('div', null, `Серия: ${item.seriesNumber ?? '—'} · ${item.modality || 'DICOM'}`),
      react.createElement('div', null, `Изображений: ${item.numInstances ?? '—'}`),
      react.createElement('div', null, `Толщина среза: ${thickness}`))));
}

function LocalCompactStudies({tabs, activeTabName, activeDisplaySetInstanceUIDs = [], servicesManager, onDoubleClickThumbnail}) {
  const studies = (tabs.find(tab => tab.name === activeTabName) || tabs[0])?.studies || [];
  return react.createElement(ScrollArea_ScrollArea, {style:{flex:1,minHeight:0,width:'100%'}},
    react.createElement('div', {'data-cy':'local-studies-rail',style:{display:'flex',flexDirection:'column',alignItems:'center',gap:4,padding:'6px 0'}},
      studies.map(study => react.createElement('div', {key:study.studyInstanceUid,
        role:'group', 'aria-label':study.description || 'Исследование',
        style:{display:'flex',flexDirection:'column',gap:4,paddingBottom:4,borderBottom:'1px solid hsl(var(--border))'},
      }, (study.displaySets || []).map(item => react.createElement(LocalCompactSeries, {
        key:item.displaySetInstanceUID, item, servicesManager, onDoubleClickThumbnail,
        active:activeDisplaySetInstanceUIDs.includes(item.displaySetInstanceUID),
      }))))));
}
