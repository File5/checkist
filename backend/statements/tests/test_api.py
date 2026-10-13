"""HTTP импорта выписок: загрузка PDF, черновик, сохранение, правила и доступ (семья / чужой).

PDF — вымышленная выписка ``statements.demo``; модель не вызывается.
"""
from datetime import date

from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import TestCase, tag
from rest_framework.test import APIClient

from accounts.models import Household, Membership
from api.tests.accounts_helpers import NOT_AUTHENTICATED, NOT_FOUND, accounts_mode, local_single_mode, make_user, signed_in
from catalog.models import Category
from receipts.models import Receipt
from statements import demo
from statements.models import StatementImport, StatementRow, StatementRule

END = date(2026, 10, 12)
LIST = "/api/statements/"
RULES = "/api/statements/rules/"


def pdf(lines=None, name="statement.pdf"):
    return SimpleUploadedFile(name, demo.pdf_bytes(lines or demo.demo_kaspi_lines(END)), content_type="application/pdf")


class Categories:
    @classmethod
    def setUpTestData(cls):
        super().setUpTestData()
        cls.food = Category.objects.create(name="Еда и напитки")
        cls.transport = Category.objects.create(name="Транспорт")
        cls.cafe = Category.objects.create(name="Кафе и рестораны")
        cls.home = Category.objects.create(name="Жильё")
        cls.rent = Category.objects.create(name="Аренда", parent=cls.home)


@tag("integration")
@local_single_mode()
class StatementApiTests(Categories, TestCase):
    def setUp(self):
        self.client = APIClient()

    def upload(self, file=None):
        return self.client.post(LIST, {"file": file or pdf()}, format="multipart")

    def test_upload_draft_and_reupload(self):
        response = self.upload()
        self.assertEqual(response.status_code, 201, response.content)
        body = response.json()
        self.assertFalse(body["reused"])
        summary = body["statement"]
        self.assertEqual((summary["bank"], summary["bank_name"], summary["rows_count"], summary["saved_count"]),
                         ("kaspi_gold", "Kaspi Gold", 20, 0))
        again = self.upload()
        self.assertEqual((again.status_code, again.json()["reused"], again.json()["statement"]["id"]), (200, True, summary["id"]))
        detail = self.client.get(f"{LIST}{summary['id']}/").json()
        self.assertEqual(set(detail["ai"]), {"waiting", "active", "executor"})
        self.assertTrue(detail["ai"]["active"])
        rows = detail["rows"]
        self.assertEqual(len(rows), 20)
        self.assertEqual(set(rows[0]), {"id", "date", "amount", "currency", "operation", "details", "merchant", "mcc",
                                        "refund", "spend", "kind", "state", "reason", "category", "store_name", "source",
                                        "ai", "duplicate_of", "receipt_id", "goal", "contribution_id"})
        magnum = rows[0]
        self.assertEqual((magnum["kind"], magnum["state"], magnum["amount"], magnum["spend"], magnum["store_name"]),
                         ("spend", "spend", "-18450.00", "18450.00", "MAGNUM"))
        self.assertEqual(magnum["category"], {"id": self.food.pk, "name": "Еда и напитки",
                                              "path": [{"id": self.food.pk, "name": "Еда и напитки"}]})
        incomes = [row for row in rows if row["kind"] == "income"]
        self.assertEqual([row["merchant"] for row in incomes], ["Дмитрий С.", "Kaspi Бонус: кэшбэк"])
        listed = self.client.get(LIST).json()
        self.assertEqual((listed["count"], listed["results"][0]["id"]), (1, summary["id"]))

    def test_save_creates_spends_and_learns(self):
        statement_id = self.upload().json()["statement"]["id"]
        rows = self.client.get(f"{LIST}{statement_id}/").json()["rows"]
        oleg = next(row for row in rows if row["merchant"] == "Олег Б.")
        magnum = rows[0]
        response = self.client.post(f"{LIST}{statement_id}/save/", {"rows": [
            {"id": magnum["id"], "category": self.food.pk, "store_name": "MAGNUM"},
            {"id": oleg["id"], "category": self.rent.pk, "store_name": "Съёмное жильё"},
        ]}, format="json")
        self.assertEqual(response.status_code, 200, response.content)
        body = response.json()
        self.assertEqual((body["created"], body["learned"]), (2, 1))
        self.assertEqual(body["statement"]["saved_count"], 2)
        saved = {row["id"]: row["receipt_id"] for row in body["statement"]["rows"]}
        receipt = Receipt.objects.get(pk=saved[oleg["id"]])
        self.assertEqual((str(receipt.total), receipt.note), ("220000.00", "· Выписка Kaspi Gold"))
        self.assertEqual(StatementRule.objects.get().pattern, "Олег Б.")
        refused = self.client.post(f"{LIST}{statement_id}/save/", {"rows": [{"id": magnum["id"]}]}, format="json")
        self.assertEqual(refused.status_code, 400)
        self.assertEqual(refused.json()["error"]["fields"], {"rows.0.category": ["Обязательное поле."]})

    def test_delete_keeps_saved_spends(self):
        statement_id = self.upload().json()["statement"]["id"]
        row = StatementRow.objects.filter(statement_id=statement_id).order_by("position").first()
        self.client.post(f"{LIST}{statement_id}/save/", {"rows": [{"id": row.pk, "category": self.food.pk}]}, format="json")
        self.assertEqual(self.client.delete(f"{LIST}{statement_id}/").status_code, 204)
        self.assertFalse(StatementImport.objects.exists())
        self.assertEqual(Receipt.objects.count(), 1)
        self.assertEqual(self.client.get(f"{LIST}{statement_id}/").json(), NOT_FOUND)

    def test_upload_refusals(self):
        cases = [
            (SimpleUploadedFile("a.png", b"\x89PNG\r\n\x1a\nxx", content_type="image/png"), 400, "unsupported_format"),
            (SimpleUploadedFile("a.pdf", b"%PDF-1.4 broken", content_type="application/pdf"), 400, "invalid_pdf"),
            (pdf(["АО «Halyk Bank»", "Выписка по карте"]), 400, "statement_unsupported_bank"),
            (pdf(demo.kaspi_header(END, END)), 400, "statement_empty"),
        ]
        for file, status, code in cases:
            with self.subTest(code=code):
                response = self.upload(file)
                self.assertEqual((response.status_code, response.json()["error"]["code"]), (status, code))
        self.assertEqual(self.client.post(LIST, {}, format="multipart").status_code, 400)
        self.assertFalse(StatementImport.objects.exists())

    def test_rules_crud(self):
        created = self.client.post(RULES, {"pattern": " Олег Б. ", "action": "category", "category": self.rent.pk,
                                           "store_name": "Съёмное жильё"}, format="json")
        self.assertEqual(created.status_code, 201, created.content)
        rule = created.json()
        self.assertEqual((rule["pattern"], rule["action"], rule["category"]["id"], rule["store_name"], rule["origin"]),
                         ("Олег Б.", "category", self.rent.pk, "Съёмное жильё", "manual"))
        taken = self.client.post(RULES, {"pattern": "олег б", "action": "skip"}, format="json")
        self.assertEqual(taken.json()["error"]["fields"], {"pattern": ["Правило для этого получателя уже есть."]})
        changed = self.client.patch(f"{RULES}{rule['id']}/", {"action": "own"}, format="json")
        self.assertEqual((changed.json()["action"], changed.json()["category"], changed.json()["store_name"]), ("own", None, None))
        for body, field in (({"pattern": "x", "action": "category"}, "category"), ({"pattern": "!!"}, "pattern"),
                            ({"pattern": "y", "action": "skip", "category": self.food.pk}, "category"),
                            ({"pattern": "z", "action": "nope"}, "action"), ({"pattern": "w", "category": 999999}, "category")):
            with self.subTest(body=body):
                response = self.client.post(RULES, body, format="json")
                self.assertEqual(response.status_code, 400)
                self.assertIn(field, response.json()["error"]["fields"])
        self.assertEqual(len(self.client.get(RULES).json()["results"]), 1)
        self.assertEqual(self.client.delete(f"{RULES}{rule['id']}/").status_code, 204)
        self.assertEqual(self.client.get(RULES).json(), {"results": []})


@tag("integration")
@accounts_mode()
class StatementAccessTests(Categories, TestCase):
    @classmethod
    def setUpTestData(cls):
        super().setUpTestData()
        cls.andrey, cls.liza, cls.stranger = make_user("andrey"), make_user("liza"), make_user("stranger")
        family = Household.objects.create(name="Вымышленная семья")
        Membership.objects.create(household=family, user=cls.andrey, role="head")
        Membership.objects.create(household=family, user=cls.liza, role="member")
        cls.family = family

    def test_draft_is_personal_and_rules_are_shared_by_the_family(self):
        andrey, liza, stranger = signed_in(self.andrey), signed_in(self.liza), signed_in(self.stranger)
        statement_id = andrey.post(LIST, {"file": pdf()}, format="multipart").json()["statement"]["id"]
        row = StatementRow.objects.filter(statement_id=statement_id).order_by("position").first()
        for client in (liza, stranger):
            self.assertEqual(client.get(f"{LIST}{statement_id}/").json(), NOT_FOUND)
            self.assertEqual(client.get(LIST).json()["count"], 0)
            response = client.post(f"{LIST}{statement_id}/save/", {"rows": [{"id": row.pk, "category": self.food.pk}]},
                                   format="json")
            self.assertEqual(response.json(), NOT_FOUND)
            self.assertEqual(client.delete(f"{LIST}{statement_id}/").json(), NOT_FOUND)
        # Liza's own upload of the same file is her own draft; spends go to the uploader.
        own = liza.post(LIST, {"file": pdf()}, format="multipart")
        self.assertEqual((own.status_code, own.json()["reused"]), (201, False))
        andrey.post(f"{LIST}{statement_id}/save/", {"rows": [{"id": row.pk, "category": self.cafe.pk}]}, format="json")
        self.assertEqual(Receipt.objects.get().owner, self.andrey)
        # The learned rule belongs to the family: Liza sees and edits it, the stranger does not.
        rule = StatementRule.objects.get()
        self.assertEqual((rule.household_id, rule.user_id, rule.created_by_id), (self.family.pk, None, self.andrey.pk))
        self.assertEqual([item["id"] for item in liza.get(RULES).json()["results"]], [rule.pk])
        self.assertEqual(stranger.get(RULES).json(), {"results": []})
        self.assertEqual(stranger.patch(f"{RULES}{rule.pk}/", {"action": "skip"}, format="json").json(), NOT_FOUND)
        self.assertEqual(stranger.delete(f"{RULES}{rule.pk}/").json(), NOT_FOUND)
        self.assertEqual(liza.patch(f"{RULES}{rule.pk}/", {"action": "skip"}, format="json").status_code, 200)
        mine = stranger.post(RULES, {"pattern": "Олег Б.", "action": "skip"}, format="json").json()
        self.assertEqual(StatementRule.objects.get(pk=mine["id"]).user_id, self.stranger.pk)

    def test_sign_in_is_required(self):
        client = APIClient()
        for response in (client.get(LIST), client.get(RULES), client.post(LIST, {"file": pdf()}, format="multipart")):
            self.assertEqual((response.status_code, response.json()), (401, NOT_AUTHENTICATED))
