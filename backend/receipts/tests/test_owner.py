from datetime import timedelta
from decimal import Decimal

from django.contrib.auth import get_user_model
from django.db import IntegrityError, transaction
from django.db.models import ProtectedError
from django.test import TestCase, tag

from receipts.models import Receipt
from receipts.ownership import LOCAL_USERNAME, local_user

from .test_models import PURCHASED_AT, PURCHASED_ON, ReceiptTestCase

# Все имена и номера вымышленные.

User = get_user_model()

NEW_UNIQUES = {
    "receipts_receipt_owner_fiscal_key_uniq",
    "receipts_receipt_owner_store_number_uniq",
    "receipts_receipt_owner_store_time_total_uniq",
}
OLD_UNIQUES = {
    "receipts_receipt_fiscal_key_uniq",
    "receipts_receipt_store_number_uniq",
    "receipts_receipt_store_time_total_uniq",
}


@tag("integration")
class LocalUserTests(TestCase):
    def setUp(self):
        # Тестовая база может уже содержать запись из миграции — каждый тест начинает без неё.
        User.objects.filter(username=LOCAL_USERNAME).delete()

    def test_name_is_fixed(self):
        self.assertEqual(LOCAL_USERNAME, "local")

    def test_creates_an_active_user_without_rights_and_usable_password(self):
        user = local_user()
        user.refresh_from_db()
        self.assertEqual(user.username, "local")
        self.assertTrue(user.is_active)
        self.assertFalse(user.is_staff)
        self.assertFalse(user.is_superuser)
        self.assertFalse(user.has_usable_password())
        self.assertFalse(user.user_permissions.exists())
        self.assertFalse(user.groups.exists())

    def test_repeated_call_returns_the_same_row(self):
        first = local_user()
        second = local_user()
        self.assertEqual(first.pk, second.pk)
        self.assertEqual(User.objects.filter(username="local").count(), 1)

    def test_existing_user_is_not_changed(self):
        existing = User.objects.create_user("local", password="vymyshlennyi-parol-17", is_staff=True, is_active=False)
        before = User.objects.filter(pk=existing.pk).values().get()
        user = local_user()
        self.assertEqual(user.pk, existing.pk)
        self.assertEqual(User.objects.filter(pk=existing.pk).values().get(), before)
        self.assertTrue(user.check_password("vymyshlennyi-parol-17"))

    def test_password_set_later_is_kept(self):
        user = local_user()
        user.set_password("vymyshlennyi-parol-17")
        user.save()
        again = local_user()
        self.assertTrue(again.has_usable_password())
        self.assertTrue(again.check_password("vymyshlennyi-parol-17"))

    def test_row_is_looked_up_on_every_call(self):
        """Кэша на уровне модуля нет: TransactionTestCase очищает таблицу между тестами."""
        first = local_user()
        first.delete()
        second = local_user()
        self.assertTrue(User.objects.filter(pk=second.pk, username="local").exists())


@tag("integration")
class OwnerConstraintTests(ReceiptTestCase):
    @classmethod
    def setUpTestData(cls):
        super().setUpTestData()
        cls.owner = User.objects.create_user("vladelec-odin")
        cls.other_owner = User.objects.create_user("vladelec-dva")

    def receipt(self, owner, **fields):
        values = dict(
            owner=owner, store=self.store, currency=self.currency, operation=Receipt.Operation.SALE,
            purchased_at=PURCHASED_AT, purchased_on=PURCHASED_ON, total=Decimal("10.00"),
        )
        values.update(fields)
        return Receipt.objects.create(**values)

    def test_owner_is_required(self):
        with self.assertRaises(IntegrityError) as caught, transaction.atomic():
            Receipt.objects.create(
                store=self.store, currency=self.currency, operation=Receipt.Operation.SALE,
                purchased_at=PURCHASED_AT, purchased_on=PURCHASED_ON, total=Decimal("10.00"),
            )
        self.assertIn("owner_id", str(caught.exception))
        self.assertFalse(Receipt.objects.exists())

    def test_owner_field_has_no_default_and_no_null(self):
        field = Receipt._meta.get_field("owner")
        self.assertFalse(field.null)
        self.assertFalse(field.blank)
        self.assertFalse(field.has_default())
        self.assertIs(field.related_model, User)

    def test_owner_with_receipts_is_protected(self):
        receipt = self.receipt(self.owner)
        with self.assertRaises(ProtectedError), transaction.atomic():
            self.owner.delete()
        self.assertTrue(Receipt.objects.filter(pk=receipt.pk).exists())

    def test_related_name(self):
        receipt = self.receipt(self.owner)
        self.assertEqual(list(self.owner.receipts.all()), [receipt])
        self.assertEqual(list(self.other_owner.receipts.all()), [])

    def test_constraint_and_index_names(self):
        names = {constraint.name for constraint in Receipt._meta.constraints}
        self.assertEqual(names, NEW_UNIQUES)
        self.assertFalse(names & OLD_UNIQUES)
        self.assertEqual(
            {index.name: index.fields for index in Receipt._meta.indexes},
            {
                "receipts_rcpt_store_at_idx": ["store", "purchased_at"],
                "receipts_rcpt_owner_on_idx": ["owner", "purchased_on"],
            },
        )

    # Уровень 1: фискальный ключ.

    def fiscal(self, owner, **fields):
        fields.setdefault("fiscal_key", "xa:0000000000000001:101")
        return self.receipt(owner, **fields)

    def test_fiscal_key_repeated_by_one_owner_is_rejected(self):
        self.fiscal(self.owner)
        # Остальные поля другие: магазин, время, номер, сумма.
        self.assertRejected(
            "receipts_receipt_owner_fiscal_key_uniq",
            lambda: self.fiscal(
                self.owner, store=self.other_store, receipt_number="77",
                purchased_at=PURCHASED_AT + timedelta(days=1), purchased_on=PURCHASED_ON + timedelta(days=1),
                total=Decimal("99.00"),
            ),
        )
        self.assertEqual(Receipt.objects.count(), 1)

    def test_fiscal_key_of_two_owners_is_allowed(self):
        first = self.fiscal(self.owner)
        second = self.fiscal(self.other_owner)
        self.assertNotEqual(first.pk, second.pk)
        self.assertEqual(Receipt.objects.filter(fiscal_key=first.fiscal_key).count(), 2)

    # Уровень 2: магазин, дата, смена, касса, номер.

    def numbered(self, owner, **fields):
        fields.setdefault("receipt_number", "5")
        fields.setdefault("shift_number", "139")
        fields.setdefault("register_code", "1")
        return self.receipt(owner, **fields)

    def test_number_repeated_by_one_owner_is_rejected(self):
        self.numbered(self.owner)
        # Время, сумма и фискальный ключ другие — номер всё равно занят.
        self.assertRejected(
            "receipts_receipt_owner_store_number_uniq",
            lambda: self.numbered(
                self.owner, purchased_at=PURCHASED_AT + timedelta(hours=2), total=Decimal("99.00"),
                fiscal_key="xa:000000000001:1",
            ),
        )
        self.assertEqual(Receipt.objects.count(), 1)

    def test_number_of_two_owners_is_allowed(self):
        self.numbered(self.owner)
        self.numbered(self.other_owner)
        self.assertEqual(Receipt.objects.filter(receipt_number="5").count(), 2)

    # Уровень 3: магазин, время, сумма — только без номера и фискального ключа.

    def test_time_and_total_repeated_by_one_owner_is_rejected(self):
        self.receipt(self.owner)
        self.assertRejected("receipts_receipt_owner_store_time_total_uniq", lambda: self.receipt(self.owner))
        self.assertEqual(Receipt.objects.count(), 1)

    def test_time_and_total_of_two_owners_is_allowed(self):
        self.receipt(self.owner)
        self.receipt(self.other_owner)
        self.assertEqual(Receipt.objects.count(), 2)

    def test_two_owners_keep_all_three_levels_at_once(self):
        for owner in (self.owner, self.other_owner):
            self.fiscal(owner)
            self.numbered(owner, total=Decimal("11.00"))
            self.receipt(owner, total=Decimal("12.00"))
        self.assertEqual(self.owner.receipts.count(), 3)
        self.assertEqual(self.other_owner.receipts.count(), 3)
        # Чужой такой же чек не снимает запрет на свой дубль.
        self.assertRejected("receipts_receipt_owner_fiscal_key_uniq", lambda: self.fiscal(self.other_owner))
        self.assertRejected(
            "receipts_receipt_owner_store_number_uniq",
            lambda: self.numbered(self.other_owner, total=Decimal("11.00")),
        )
        self.assertRejected(
            "receipts_receipt_owner_store_time_total_uniq",
            lambda: self.receipt(self.other_owner, total=Decimal("12.00")),
        )
        self.assertEqual(Receipt.objects.count(), 6)
