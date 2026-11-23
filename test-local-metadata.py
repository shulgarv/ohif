"""Metadata compatibility checks use only synthetic DICOM data."""
from io import BytesIO
import struct
import unittest

from local_metadata import read_metadata
import pydicom
from pydicom.dataset import Dataset, FileDataset, FileMetaDataset
from pydicom.sequence import Sequence


def image_bytes(charsets='ISO_IR 100', instance=1):
    meta = FileMetaDataset()
    meta.MediaStorageSOPClassUID = '1.2.840.10008.5.1.4.1.1.2'
    meta.MediaStorageSOPInstanceUID = f'1.2.826.0.1.3680043.10.543.9.1.{instance}'
    meta.TransferSyntaxUID = '1.2.840.10008.1.2.1'
    ds = FileDataset(None, {}, file_meta=meta, preamble=b'\0' * 128)
    ds.SOPClassUID = meta.MediaStorageSOPClassUID
    ds.SOPInstanceUID = meta.MediaStorageSOPInstanceUID
    ds.StudyInstanceUID = '1.2.826.0.1.3680043.10.543.9'
    ds.SeriesInstanceUID = '1.2.826.0.1.3680043.10.543.9.1'
    ds.FrameOfReferenceUID = '1.2.826.0.1.3680043.10.543.9.2'
    ds.SpecificCharacterSet = charsets
    multi = isinstance(charsets, list)
    ds.PatientName = 'TEST^ПРИМЕР' if multi else 'TEST^LATIN'
    ds.PatientID = 'SYNTHETIC-ONLY'
    ds.StudyDate = '20261009'
    ds.StudyTime = '120000'
    ds.Modality = 'CT'
    ds.SeriesDescription = 'Тестовая серия' if multi else 'Synthetic CT'
    ds.SeriesNumber = 1
    ds.InstanceNumber = instance
    ds.ImageType = ['ORIGINAL', 'PRIMARY', 'AXIAL']
    ds.ImagePositionPatient = [0, 0, instance]
    ds.ImageOrientationPatient = [1, 0, 0, 0, 1, 0]
    ds.PixelSpacing = [1, 1]
    ds.SliceThickness = 1
    ds.Rows = 64
    ds.Columns = 64
    ds.SamplesPerPixel = 1
    ds.PhotometricInterpretation = 'MONOCHROME2'
    ds.BitsAllocated = 16
    ds.BitsStored = 16
    ds.HighBit = 15
    ds.PixelRepresentation = 0
    ds.RescaleIntercept = -1024
    ds.RescaleSlope = 1
    ds.WindowCenter = 40
    ds.WindowWidth = 400
    pixels = [1524 if (x-32)**2+(y-32)**2 < 64 else 1064 if (x-32)**2+(y-32)**2 < 576 else 24
              for y in range(64) for x in range(64)]
    ds.PixelData = struct.pack('<4096H', *pixels)
    if multi:
        item = Dataset()
        item.SpecificCharacterSet = charsets
        item.RequestedProcedureDescription = 'Тест вложенного текста'
        ds.RequestAttributesSequence = Sequence([item])
    stream = BytesIO()
    ds.save_as(stream, enforce_file_format=True)
    return stream.getvalue()


def directory_bytes():
    meta = FileMetaDataset()
    meta.MediaStorageSOPClassUID = '1.2.840.10008.1.3.10'
    meta.MediaStorageSOPInstanceUID = '1.2.826.0.1.3680043.10.543.9.99'
    meta.TransferSyntaxUID = '1.2.840.10008.1.2.1'
    ds = FileDataset(None, {}, file_meta=meta, preamble=b'\0' * 128)
    ds.FileSetID = 'SYNTHETIC'
    ds.OffsetOfTheFirstDirectoryRecordOfTheRootDirectoryEntity = 0
    ds.OffsetOfTheLastDirectoryRecordOfTheRootDirectoryEntity = 0
    ds.FileSetConsistencyFlag = 0
    ds.DirectoryRecordSequence = []
    stream = BytesIO()
    ds.save_as(stream, enforce_file_format=True)
    return stream.getvalue()


class MetadataTests(unittest.TestCase):
    def test_invalid_implementation_uid_does_not_block_images(self):
        payload = image_bytes(['ISO 2022 IR 100', 'ISO 2022 IR 144'])
        valid = b'1.2.826.0.1.3680043.10.999.1'
        # A producer identifier in file meta; image/study identifiers stay valid.
        ds = pydicom.dcmread(BytesIO(payload))
        ds.file_meta.ImplementationClassUID = valid.decode()
        stream = BytesIO()
        ds.save_as(stream, enforce_file_format=True)
        payload = stream.getvalue().replace(valid, valid.replace(b'.10.', b'.00.'), 1)
        original = bytes(payload)
        result = read_metadata(payload)
        self.assertEqual(result['dict']['0008103E']['Value'], ['Тестовая серия'])
        self.assertEqual(result['dict']['0020000D']['Value'], ['1.2.826.0.1.3680043.10.543.9'])
        self.assertEqual(result['meta']['00020010']['Value'], ['1.2.840.10008.1.2.1'])
        self.assertNotIn('00020012', result['meta'])
        self.assertNotIn('7FE00010', result['dict'])
        self.assertEqual(payload, original)

    def test_valid_implementation_uid_is_preserved(self):
        result = read_metadata(image_bytes())
        self.assertIn('00020012', result['meta'])

    def test_invalid_image_uid_still_rejected(self):
        uid = b'1.2.826.0.1.3680043.10.543.9'
        # Target StudyInstanceUID, including its explicit-VR header and padding.
        value = uid + b'\0' * (len(uid) % 2)
        element = struct.pack('<HH2sH', 0x0020, 0x000D, b'UI', len(value)) + value
        payload = image_bytes().replace(element, element.replace(b'.10.', b'.00.'), 1)
        with self.assertRaises(ValueError):
            read_metadata(payload)

    def test_unknown_character_set_still_rejected(self):
        payload = image_bytes().replace(b'ISO_IR 100', b'NO_SUCH_CS', 1)
        with self.assertRaises(LookupError):
            read_metadata(payload)

    def test_invalid_utf8_still_rejected(self):
        payload = image_bytes('ISO_IR 192').replace(b'TEST^LATIN', b'TEST^LATI\xff', 1)
        # pydicom 3.0.2 may wrap this error in TypeError while adding tag context.
        with self.assertRaises((UnicodeDecodeError, TypeError)) as raised:
            read_metadata(payload)
        self.assertIsInstance(raised.exception.__context__ or raised.exception, UnicodeDecodeError)

    def test_multiple_charsets_and_nested_text(self):
        payload = image_bytes(['ISO 2022 IR 100', 'ISO 2022 IR 144'])
        original = bytes(payload)
        result = read_metadata(payload)
        self.assertEqual(result['dict']['00100010']['Value'][0]['Alphabetic'], 'TEST^ПРИМЕР')
        self.assertEqual(result['dict']['0008103E']['Value'], ['Тестовая серия'])
        item = result['dict']['00400275']['Value'][0]
        self.assertEqual(item['00321060']['Value'], ['Тест вложенного текста'])
        self.assertNotIn('7FE00010', result['dict'])
        self.assertEqual(result['meta']['00020010']['Value'], ['1.2.840.10008.1.2.1'])
        self.assertEqual(payload, original)
        ds = pydicom.dcmread(BytesIO(payload))
        self.assertEqual(len(ds.PixelData), 8192)

    def test_dicomdir_is_a_directory_without_study_uid(self):
        result = read_metadata(directory_bytes())
        self.assertEqual(result['meta']['00020002']['Value'], ['1.2.840.10008.1.3.10'])
        self.assertNotIn('0020000D', result['dict'])

    def test_invalid_input_is_rejected(self):
        with self.assertRaises(pydicom.errors.InvalidDicomError):
            read_metadata(b'not a DICOM file')


if __name__ == '__main__':
    unittest.main()
