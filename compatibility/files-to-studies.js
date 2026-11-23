async function filesToStudies(files) {
  const summary = { imported: 0, directories: 0, failed: 0 };
  const zipSummary = { archives: 0, ignored: 0 };
  const archiveErrors = [];
  const inputs = [];
  for (const file of files) {
    // Known export sidecar, not an image. Keep unknown filenames on the parser path.
    if (/(^|[\\/])info\.famed$/i.test(file.name)) continue;
    if (/\.zip$/i.test(file.name) || /^(application\/zip|application\/x-zip-compressed)$/.test(file.type)) {
      zipSummary.archives++;
      try {
        const {openLocalZip} = await import('/local-zip.js');
        const archive = await openLocalZip(file);
        inputs.push(...archive.entries);
        zipSummary.ignored += archive.ignored;
      } catch (error) {
        summary.failed++;
        archiveErrors.push(error.message);
      }
    } else {
      inputs.push({read: async () => file});
    }
  }
  let cursor = 0;
  const processNext = async () => {
    while (cursor < inputs.length) {
      const input = inputs[cursor++];
      try {
        const file = await input.read();
        const fileLoaderService = new Local_fileLoaderService(file);
        const imageId = fileLoaderService.addFile(file);
        const image = await fileLoaderService.loadFile(file, imageId);
        const dataset = await fileLoaderService.getDataset(image, imageId);
        const sopClass = dataset.SOPClassUID || dataset._meta?.MediaStorageSOPClassUID?.Value?.[0];
        if (sopClass === '1.2.840.10008.1.3.10') {
          summary.directories++;
          continue;
        }
        if (!dataset.StudyInstanceUID || !dataset.SeriesInstanceUID || !dataset.SOPInstanceUID) {
          throw new Error('Отсутствуют обязательные идентификаторы DICOM.');
        }
        core_src/* .DicomMetadataStore.addInstance */.H8.addInstance(dataset);
        summary.imported++;
      } catch (error) {
        summary.failed++;
        console.warn('Local DICOM import: one file could not be read.');
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(8, inputs.length) }, processNext));
  const studies = core_src/* .DicomMetadataStore.getStudyInstanceUIDs */.H8.getStudyInstanceUIDs().filter(id => typeof id === 'string' && id.length > 0);
  window.__ohifLocalImportSummary = summary;
  window.__ohifLocalZipSummary = zipSummary;
  if (summary.failed || !studies.length) {
    const details = archiveErrors.length ? '\n' + [...new Set(archiveErrors)].join('\n') : '';
    window.alert((studies.length
      ? `Загружено DICOM-файлов: ${summary.imported}. Не удалось прочитать файлов: ${summary.failed}. Исследование может быть неполным.`
      : 'В выбранных файлах нет доступных для просмотра исследований DICOM.') + details);
  }
  return studies;
}
