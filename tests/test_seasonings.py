import sqlite3
import tempfile
import unittest
from decimal import Decimal
from pathlib import Path

from nutrition.seasonings import SeasoningStore


class SeasoningTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name) / 'test.db'
        self.store = SeasoningStore(self.path)
        self.data = dict(name='ตัวอย่าง', brand='สมมติ', basis_quantity=Decimal('15'),
                         basis_unit='ml', nutrients={'sodium_mg': Decimal('0')}, reviewed=True,
                         retrieved_on='2026-01-01', source_reference='synthetic label')

    def test_reviewed_source_is_saved_with_unknown_and_zero(self):
        ids = self.store.create_reviewed(**self.data)
        item, = self.store.list()
        self.assertEqual(item['version_id'], ids['version_id'])
        self.assertEqual(item['nutrients']['sodium_mg'], '0')
        self.assertIsNone(item['nutrients']['potassium_mg'])
        self.assertEqual(item['basis_quantity'], '15')

    def test_rejects_unreviewed_or_invalid_data_without_partial_record(self):
        for change in ({'reviewed': False}, {'basis_quantity': Decimal('0')}, {'basis_unit': 'piece'}):
            with self.assertRaises(ValueError):
                self.store.create_reviewed(**{**self.data, **change})
        self.assertEqual(self.store.list(), [])

    def test_brand_cannot_be_replaced(self):
        ids = self.store.create_reviewed(**self.data)
        with sqlite3.connect(self.path) as db:
            with self.assertRaises(sqlite3.IntegrityError):
                db.execute('INSERT OR REPLACE INTO seasoning_brands VALUES (?, ?)', (ids['ingredient_id'], 'other'))
        self.assertEqual(self.store.list()[0]['brand'], 'สมมติ')

    def test_unreviewed_version_is_identified(self):
        ids = self.store.create_reviewed(**self.data)
        self.store.ingredients.add_version(ids['ingredient_id'], version='2', provider='example',
            source_version='2', retrieved_on='2026-01-02', source_reference='synthetic',
            provenance='test', basis_quantity=Decimal('15'), basis_unit='ml',
            food_state='as_sold', reviewed=False, nutrients={})
        versions = self.store.list()
        self.assertTrue(versions[0]['reviewed'])
        self.assertFalse(versions[1]['reviewed'])
        self.assertEqual(versions[1]['provenance'], 'test')

    def test_failure_after_identity_insert_rolls_back(self):
        with sqlite3.connect(self.path) as db:
            db.execute("CREATE TRIGGER fail_brand BEFORE INSERT ON seasoning_brands BEGIN SELECT RAISE(ABORT, 'test'); END")
        with self.assertRaises(sqlite3.IntegrityError):
            self.store.create_reviewed(**self.data)
        with sqlite3.connect(self.path) as db:
            self.assertEqual(db.execute('SELECT count(*) FROM ingredients').fetchone()[0], 0)
