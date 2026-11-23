  async getDataset(image, imageId) {
    let dicomData;
    try {
      dicomData = dcmjs_es/* ["default"].data.DicomMessage.readFile */.Ay.data.DicomMessage.readFile(image);
    } catch (error) {
      if (!/character set/i.test(String(error.message))) throw error;
      const response = await fetch('/api/local-dicom-metadata', {
        method: 'POST',
        headers: { 'Content-Type': 'application/dicom' },
        body: image,
      });
      if (!response.ok) throw new Error('Не удалось прочитать кодировку DICOM локальным обработчиком.');
      dicomData = await response.json();
    }
    // This store needs metadata only. Cornerstone reads pixels from the original
    // file on demand; retaining them here duplicates entire high-resolution studies.
    for (const tag of ['7FE00010', '7FE00008', '7FE00009']) {
      delete dicomData.dict[tag];
    }
    const dataset = dcmjs_es/* ["default"].data.DicomMetaDictionary.naturalizeDataset */.Ay.data.DicomMetaDictionary.naturalizeDataset(dicomData.dict);
    dataset.url = imageId;
    dataset._meta = dcmjs_es/* ["default"].data.DicomMetaDictionary.namifyDataset */.Ay.data.DicomMetaDictionary.namifyDataset(dicomData.meta);
    dataset.AvailableTransferSyntaxUID = dataset.AvailableTransferSyntaxUID || dataset._meta.TransferSyntaxUID?.Value?.[0];
    return dataset;
  }
