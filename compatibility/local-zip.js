// zip.js is vendored locally; archives and extracted files never leave the browser.
let library;
async function getLibrary() {
  library ||= import('/vendor/zip-native-2.23.0.min.js').then(() => {
    globalThis.zip.configure({useWebWorkers: false, useCompressionStream: true});
    return globalThis.zip;
  });
  return library;
}

export async function openLocalZip(file) {
  const zip = await getLibrary();
  const reader = new zip.ZipReader(new zip.BlobReader(file));
  try {
    const entries = await reader.getEntries();
    const candidates = entries.filter(entry => !entry.directory &&
      !/(^|\/)__MACOSX\/|(^|\/)\.DS_Store$|(^|\/)\._/.test(entry.filename) &&
      !/(^|[\\/])info\.famed$/i.test(entry.filename) &&
      !/\.(txt|md|pdf|xml|json|html?|exe|dll|bat|cmd|sh|ini|inf|jpg|jpeg|png|gif|bmp|zip)$/i.test(entry.filename));
    if (candidates.some(entry => entry.encrypted)) {
      throw new Error('ZIP защищён паролем. Для открытия такого архива сначала распакуй его вручную.');
    }
    if (candidates.length > 100000 || candidates.some(entry => entry.uncompressedSize > 512 * 1024 * 1024) ||
        candidates.reduce((sum, entry) => sum + entry.uncompressedSize, 0) > 8 * 1024 * 1024 * 1024) {
      throw new Error('Этот ZIP слишком большой для распаковки в браузере. Распакуй его вручную и выбери папку.');
    }
    // BlobReader owns the file handle; entries remain readable after close().
    return {
      ignored: entries.length - candidates.length,
      entries: candidates.map(entry => ({
        read: async () => {
          const blob = await entry.getData(new zip.BlobWriter('application/dicom'), {checkSignature: true});
          return new File([blob], entry.filename.split(/[\\/]/).pop(), {type:'application/dicom'});
        },
      })),
    };
  } catch (error) {
    if (/^ZIP |^Этот ZIP /.test(error.message)) throw error;
    throw new Error('Не удалось открыть ZIP. Возможно, архив повреждён или имеет неподдерживаемый формат.');
  } finally {
    await reader.close();
  }
}
