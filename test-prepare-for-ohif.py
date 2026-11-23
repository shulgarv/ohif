"""Verify UTF-8 conversion without patient data."""
import hashlib
import importlib.util
from pathlib import Path
import tempfile
import unittest

import pydicom
from pydicom.dataset import Dataset, FileDataset, FileMetaDataset
from pydicom.sequence import Sequence

spec = importlib.util.spec_from_file_location('prepare', Path(__file__).with_name('prepare-for-ohif.py'))
prepare = importlib.util.module_from_spec(spec)
spec.loader.exec_module(prepare)


class ConversionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / 'study'
        self.source.mkdir()
        self.output = self.root / 'study-utf8'
        meta = FileMetaDataset()
        meta.MediaStorageSOPClassUID = '1.2.840.10008.5.1.4.1.1.2'
        meta.MediaStorageSOPInstanceUID = '1.2.826.0.1.3680043.10.543.1'
        meta.TransferSyntaxUID = '1.2.840.10008.1.2.1'
        ds = FileDataset(None, {}, file_meta=meta, preamble=b'\0' * 128)
        ds.SOPClassUID = meta.MediaStorageSOPClassUID
        ds.SOPInstanceUID = meta.MediaStorageSOPInstanceUID
        ds.StudyInstanceUID = '1.2.826.0.1.3680043.10.543.2'
        ds.SeriesInstanceUID = '1.2.826.0.1.3680043.10.543.3'
        ds.SpecificCharacterSet = ['ISO 2022 IR 100', 'ISO 2022 IR 144']
        ds.PatientName = 'TEST^ПРИМЕР'
        ds.SeriesDescription = 'Тестовая серия'
        item = Dataset()
        item.SpecificCharacterSet = ds.SpecificCharacterSet
        item.RequestedProcedureDescription = 'Тест вложенного текста'
        ds.RequestAttributesSequence = Sequence([item])
        ds.Rows = 2
        ds.Columns = 2
        ds.SamplesPerPixel = 1
        ds.PhotometricInterpretation = 'MONOCHROME2'
        ds.BitsAllocated = 16
        ds.BitsStored = 16
        ds.HighBit = 15
        ds.PixelRepresentation = 0
        ds.PixelData = b'\x00\x00\x01\x00\x02\x00\x03\x00'
        self.input = self.source / 'image.dcm'
        ds.save_as(self.input)

    def test_text_pixels_uids_and_source_preserved(self):
        original_hash = hashlib.sha256(self.input.read_bytes()).digest()
        output, report = prepare.prepare(self.source, self.output)
        result = pydicom.dcmread(output / 'image.dcm')
        result.decode()
        self.assertEqual(str(result.SpecificCharacterSet), 'ISO_IR 192')
        self.assertEqual(str(result.PatientName), 'TEST^ПРИМЕР')
        self.assertEqual(result.SeriesDescription, 'Тестовая серия')
        self.assertEqual(result.RequestAttributesSequence[0].RequestedProcedureDescription,
                         'Тест вложенного текста')
        self.assertEqual(str(result.RequestAttributesSequence[0].SpecificCharacterSet), 'ISO_IR 192')
        original = pydicom.dcmread(self.input)
        self.assertEqual(result.PixelData, original.PixelData)
        self.assertEqual(result.StudyInstanceUID, original.StudyInstanceUID)
        self.assertEqual(hashlib.sha256(self.input.read_bytes()).digest(), original_hash)
        self.assertEqual(report['metadata_verified'], 1)
        self.assertEqual(report['pixel_payloads_verified'], 1)

    def test_existing_output_is_preserved(self):
        self.output.mkdir()
        keep = self.output / 'keep'
        keep.write_text('keep')
        with self.assertRaises(FileExistsError):
            prepare.prepare(self.source, self.output)
        self.assertEqual(keep.read_text(), 'keep')

    def test_output_inside_source_is_refused(self):
        with self.assertRaises(ValueError):
            prepare.prepare(self.source, self.source / 'output')

    def test_directory_record_is_omitted(self):
        directory = pydicom.dcmread(self.input)
        directory.file_meta.MediaStorageSOPClassUID = prepare.DIRECTORY_SOP
        directory.save_as(self.source / 'DICOMDIR')
        output, report = prepare.prepare(self.source, self.output)
        self.assertFalse((output / 'DICOMDIR').exists())
        self.assertTrue((self.source / 'DICOMDIR').exists())
        self.assertEqual(report['directory_files_omitted'], 1)


if __name__ == '__main__':
    unittest.main()
