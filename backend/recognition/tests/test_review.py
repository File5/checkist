"""Human confirmation service: body rules, observation assembly, one-transaction import."""
import copy
from unittest.mock import patch

from django.db import IntegrityError, OperationalError
from django.test import SimpleTestCase, TestCase, override_settings, tag
from django.utils import timezone

from catalog.models import Product
from receipts.models import ProductAlias, Receipt, ReceiptDiscount, ReceiptLine, ReceiptTax
from recognition import review
from recognition.models import ProcessingJob, ReceiptImage
from recognition.providers.fake import receipt_payload, tax_evidence_payload
from recognition.schema_validation import validate_observation
from stores.models import Merchant, Store, TaxRate

from .import_fixtures import live_image
from .test_models import make_image, make_photo

BLOCKING = [{"code": "total_mismatch", "field": "/total", "message": "Результат требует проверки."}]


def stored(data=None):
    """The DTO exactly as the importer persists it on a needs_review crop."""
    return validate_observation(receipt_payload() if data is None else data).to_dict()


def wrong_total(position=1):
    """fake ``inconsistent_total``: everything is read, the total is not the sum."""
    data = receipt_payload(position)
    data["total"] = "123.45"
    return data


def missing_quantity(position=1):
    """fake ``partial_missing_quantity``: two unreadable operands of the first line."""
    data = receipt_payload(position)
    for key in ("quantity", "unit_price"):
        data["lines"][0][key] = None
        next(f for f in data["fields"] if f["path"] == "/lines/0/" + key).update(status="unreadable", confidence=None)
    return data


def finished_job(status="partial_succeeded", **fields):
    values = dict(status=status, stage="finished", finished_at=timezone.now(), detected_count=1,
                  completed_count=1, review_count=1)
    values.update(fields)
    return ProcessingJob.objects.create(photo=make_photo(), **values)


def review_image(data=None, *, job=None, **fields):
    """A crop that awaits a person, in a finished job."""
    values = dict(status="needs_review", normalized_result=stored(wrong_total() if data is None else data),
                  issues=copy.deepcopy(BLOCKING))
    values.update(fields)
    return make_image(job or finished_job(), **values)


def body_of(data, **receipt):
    """The request a form sends when nothing was edited: the public projection, as is."""
    body = {
        "receipt": {
            "store_id": None, "store_name": data["merchant"]["brand_name"] or data["store"]["name"],
            "address": data["store"]["address_raw"],
            "country": data["store"]["country_code"] or data["merchant"]["country_code"],
            "currency": data["currency_code"], "operation": data["operation"],
            "purchased_on": data["purchased_on"], "local_time": data["local_time"], "total": data["total"],
            "prices_include_tax": data["prices_include_tax"],
        },
        "lines": [{
            "position": line["position"], "source_position": line["position"], "kind": line["kind"],
            "parent_position": line["parent_position"], "name": line["raw_name"], "quantity": line["quantity"],
            "unit": line["unit"], "unit_price": line["unit_price"], "amount": line["amount"],
            "tax_rate": dict(line["tax_rate"]), "tax_code": line["tax_code"],
        } for line in data["lines"]],
        "discounts": [dict(discount) for discount in data["discounts"]],
        "taxes": [{**tax, "tax_rate": dict(tax["tax_rate"])} for tax in data["taxes"]],
    }
    body["receipt"].update(receipt)
    return body


def fixed_body(position=1, **receipt):
    """The corrected form of ``wrong_total``: the true total of the fake receipt."""
    receipt.setdefault("total", "6.00" if position == 2 else "4.42")
    return body_of(receipt_payload(position), **receipt)


def domain_counts():
    return tuple(model.objects.count() for model in (
        Receipt, ReceiptLine, ReceiptDiscount, ReceiptTax, Store, Merchant, Product, ProductAlias, TaxRate))


def image_state(image):
    image = ReceiptImage.objects.get(pk=image.pk)
    job = ProcessingJob.objects.get(pk=image.job_id)
    return (image.status, image.receipt_id, image.import_effect, image.issues, image.outcome_snapshot,
            image.normalized_result, job.status, job.version,
            tuple(getattr(job, name + "_count") for name in ("completed", "imported", "reused", "review", "failed")))


def evidence(data):
    return {field["path"]: field["status"] for field in data["fields"]}


class StructureTests(SimpleTestCase):
    def test_contract_shape_is_known(self):
        self.assertTrue(review.known_structure(fixed_body()))
        self.assertTrue(review.known_structure(fixed_body(utc_offset="+02:00")))
        # Wrong types and missing keys are value errors of the next step, not structure.
        for body in ({}, {"receipt": None, "lines": "x", "discounts": 5, "taxes": [None, 1, "x"]},
                     {"lines": [{"tax_rate": None}], "taxes": [{"tax_rate": []}]}):
            self.assertTrue(review.known_structure(body), body)

    def test_unknown_key_at_any_level(self):
        cases = []
        for path in ((), ("receipt",), ("lines", 0), ("lines", 0, "tax_rate"), ("discounts", 0), ("taxes", 0),
                     ("taxes", 1, "tax_rate")):
            body = fixed_body()
            target = body
            for key in path:
                target = target[key]
            target["product_id"] = 1
            cases.append(body)
        cases += [None, [], "x", 5]
        for body in cases:
            self.assertFalse(review.known_structure(body), body)
        # Closed facts are not accepted by any name.
        for key in ("receipt_number", "fiscal", "raw_text", "legal_name", "tax_id", "discount_total"):
            body = fixed_body()
            body["receipt"][key] = "PRIVATE"
            self.assertFalse(review.known_structure(body), key)

    def test_request_identity_is_canonical(self):
        first = review.request_sha256(fixed_body())
        reordered = {key: fixed_body()[key] for key in ("taxes", "lines", "receipt", "discounts")}
        self.assertEqual(review.request_sha256(reordered), first)
        self.assertRegex(first, r"\A[0-9a-f]{64}\Z")
        self.assertNotEqual(review.request_sha256(fixed_body(total="4.43")), first)
        self.assertNotEqual(review.request_sha256(fixed_body(utc_offset=None)), first)


class ObservationTests(SimpleTestCase):
    """build_observation is pure: the stored DTO below, the body on top."""

    def build(self, data, body, store=None):
        built = review.build_observation(stored(data), body, store)
        return built, validate_observation(copy.deepcopy(built))

    def test_unedited_form_keeps_closed_facts_and_their_evidence(self):
        data = wrong_total()
        data["lines"][0].update(store_item_code="M1", barcode="4006381333931", is_marked=True)
        data["fields"] += [{"path": "/lines/0/" + key, "status": "observed", "confidence": 1, "note": "PRIVATE NOTE"}
                           for key in ("store_item_code", "barcode", "is_marked")]
        built, observation = self.build(data, body_of(data, total="4.42"))
        source = stored(data)
        for key in ("receipt_number", "shift_number", "register_code", "raw_text", "fiscal", "warnings",
                    "confidence", "schema_version"):
            self.assertEqual(built[key], source[key], key)
        self.assertEqual(built["merchant"], source["merchant"])
        self.assertEqual(built["store"], source["store"])
        self.assertEqual(observation.total, review_decimal("4.42"))
        self.assertIsNone(built["discount_total"])
        self.assertTrue(all(line["discount_amount"] is None for line in built["lines"]))
        self.assertEqual(built["lines"][0]["store_item_code"], "M1")
        self.assertEqual(built["lines"][0]["barcode"], "4006381333931")
        self.assertIs(built["lines"][0]["is_marked"], True)
        self.assertEqual(built["lines"][0]["product_hint"], source["lines"][0]["product_hint"])
        marks = evidence(built)
        for path in ("/receipt_number", "/shift_number", "/register_code", "/fiscal/tse_transaction",
                     "/fiscal/register_serial", "/merchant/legal_name", "/store/postal_code", "/store/city",
                     "/lines/0/store_item_code", "/lines/0/barcode", "/lines/0/is_marked",
                     "/lines/0/product_hint/name", "/total", "/purchased_on", "/local_time", "/store/name",
                     "/store/address_raw", "/store/country_code", "/lines/3/parent_position",
                     "/lines/0/tax_rate/kind", "/lines/0/tax_rate/rate", "/taxes/1/tax_rate/rate",
                     "/discounts/0/amount"):
            self.assertEqual(marks.get(path), "observed", path)
        self.assertEqual(marks["/taxes/0/gross"], "absent")
        self.assertEqual(marks["/lines/0/parent_position"], "absent")
        self.assertNotIn("/discount_total", marks)
        self.assertNotIn("/lines/0/discount_amount", marks)
        notes = [field["note"] for field in built["fields"] if field["path"] == "/lines/0/barcode"]
        self.assertEqual(notes, ["PRIVATE NOTE"])  # closed evidence is carried whole
        self.assertEqual(built["timestamps"], {
            "header": {"date": "2026-10-04", "time": "14:35:20", "utc_offset": None, "precision": "second"},
            "fiscal": {"date": None, "time": None, "utc_offset": None, "precision": None}})

    def test_public_evidence_is_recreated_from_the_body(self):
        data = missing_quantity()
        next(f for f in data["fields"] if f["path"] == "/operation").update(status="ambiguous")
        data["fields"] = [f for f in data["fields"] if not f["path"].startswith("/taxes/")
                          and "/tax_rate/" not in f["path"]]
        body = body_of(data)
        body["lines"][0].update(quantity="2.000", unit_price="1.2900")
        built, _ = self.build(data, body)
        marks = evidence(built)
        self.assertEqual(marks["/lines/0/quantity"], "observed")
        self.assertEqual(marks["/lines/0/unit_price"], "observed")
        self.assertEqual(marks["/operation"], "observed")
        self.assertEqual(marks["/lines/2/tax_rate/kind"], "observed")
        self.assertEqual(marks["/taxes/0/tax_rate/rate"], "observed")
        body["lines"][0].update(quantity=None, unit_price=None)
        body["receipt"]["operation"] = None
        marks = evidence(self.build(data, body)[0])
        self.assertEqual(marks["/lines/0/quantity"], "absent")
        self.assertEqual(marks["/operation"], "absent")
        self.assertEqual(len(marks), len(self.build(data, body)[0]["fields"]))  # one entry per path

    def test_changed_seller_name_drops_the_recognized_legal_name(self):
        data = wrong_total()
        built, _ = self.build(data, body_of(data, store_name="NEUER LADEN"))
        self.assertEqual(built["merchant"]["brand_name"], "NEUER LADEN")
        self.assertEqual(built["store"]["name"], "NEUER LADEN")
        self.assertIsNone(built["merchant"]["legal_name"])
        self.assertNotIn("/merchant/legal_name", evidence(built))
        self.assertEqual(built["store"]["city"], "Berlin")
        self.assertEqual(built["receipt_number"], "000123")
        cleared, _ = self.build(data, body_of(data, store_name=None))
        self.assertEqual((cleared["merchant"]["brand_name"], cleared["store"]["name"],
                          cleared["merchant"]["legal_name"]), (None, None, None))
        self.assertEqual(evidence(cleared)["/store/name"], "absent")

    def test_changed_address_drops_the_recognized_parts(self):
        data = wrong_total()
        built, _ = self.build(data, body_of(data, address="Neue Strasse 1, 80331 Muenchen"))
        self.assertEqual(built["store"]["address_raw"], "Neue Strasse 1, 80331 Muenchen")
        for key in ("postal_code", "region", "city", "street", "house"):
            self.assertIsNone(built["store"][key], key)
            self.assertNotIn("/store/" + key, evidence(built))
        self.assertEqual(built["merchant"]["legal_name"], "TESTMARKT GmbH")
        self.assertEqual(built["store"]["name"], "TESTMARKT")

    def test_country_of_the_body_or_of_the_chosen_store(self):
        data = wrong_total()
        same, _ = self.build(data, body_of(data, country="DE"))
        self.assertEqual((same["store"]["country_code"], same["merchant"]["country_code"]), ("DE", "DE"))
        other, _ = self.build(data, body_of(data, country="KZ"))
        self.assertEqual((other["store"]["country_code"], other["merchant"]["country_code"]), ("KZ", None))
        self.assertNotIn("/merchant/country_code", evidence(other))
        kept, _ = self.build(data, body_of(data, country=None))
        self.assertEqual(kept["store"]["country_code"], "DE")  # null: as recognized

        class Chosen:
            country_id = "RU"
        chosen, _ = self.build(data, body_of(data, country="KZ", store_id=5), Chosen())
        self.assertEqual((chosen["store"]["country_code"], chosen["merchant"]["country_code"]), ("RU", "DE"))

    def test_lines_inherit_by_source_position_and_renaming_drops_the_hint_name(self):
        data = wrong_total()
        data["lines"][1].update(store_item_code="A7", tax_amount="0.07")
        data["lines"][1]["product_hint"].update(brand="TESTHOF", gtin="4006381333931")
        data["fields"] += [{"path": path, "status": status, "confidence": None, "note": None} for path, status in (
            ("/lines/1/store_item_code", "observed"), ("/lines/1/product_hint/brand", "ambiguous"),
            ("/lines/1/product_hint/gtin", "observed"), ("/lines/1/tax_amount", "observed"))]
        body = body_of(data)
        apple, milk = body["lines"][1], body["lines"][0]
        apple.update(position=1, name="APFEL ROT")
        milk.update(position=2)
        new = {"position": 3, "source_position": None, "kind": "service", "parent_position": None,
               "name": "TUETE", "quantity": "1.000", "unit": "pcs", "unit_price": "0.1000", "amount": "0.10",
               "tax_rate": {"kind": None, "rate": None}, "tax_code": None}
        body["lines"] = [apple, new, milk]
        body["discounts"][0]["line_position"] = 2
        built, _ = self.build(data, body)
        first, second, third = built["lines"]
        self.assertEqual((first["raw_name"], first["store_item_code"], first["tax_amount"]), ("APFEL ROT", "A7", "0.07"))
        self.assertEqual(first["product_hint"], {"name": None, "brand": "TESTHOF", "gtin": "4006381333931",
                                                 "package_quantity": None, "package_unit": None})
        self.assertEqual(third["product_hint"]["name"], "MILCH 1 L")
        self.assertEqual(second["product_hint"], dict.fromkeys(("name", "brand", "gtin", "package_quantity",
                                                                "package_unit")))
        self.assertEqual([second[key] for key in ("store_item_code", "barcode", "tax_amount", "is_excise",
                                                  "is_marked")], [None] * 5)
        marks = evidence(built)
        # Closed evidence follows the line to its new index; the reset hint name has none.
        self.assertEqual(marks["/lines/0/store_item_code"], "observed")
        self.assertEqual(marks["/lines/0/product_hint/brand"], "ambiguous")
        self.assertEqual(marks["/lines/0/product_hint/gtin"], "observed")
        self.assertEqual(marks["/lines/0/tax_amount"], "observed")
        self.assertNotIn("/lines/0/product_hint/name", marks)
        self.assertEqual(marks["/lines/2/product_hint/name"], "observed")
        self.assertFalse([path for path in marks if path.startswith("/lines/1/product_hint")])
        self.assertEqual(marks["/lines/1/tax_rate/kind"], "absent")

    def test_utc_offset_key(self):
        data = wrong_total()
        data["utc_offset_printed"] = "+02:00"
        data["timestamps"]["header"]["utc_offset"] = "+02:00"
        data["fields"].append({"path": "/utc_offset_printed", "status": "observed", "confidence": 1, "note": None})
        self.assertEqual(self.build(data, body_of(data))[0]["utc_offset_printed"], "+02:00")
        self.assertIsNone(self.build(data, body_of(data, local_time="14:36:20"))[0]["utc_offset_printed"])
        self.assertIsNone(self.build(data, body_of(data, purchased_on="2026-10-05"))[0]["utc_offset_printed"])
        self.assertIsNone(self.build(data, body_of(data, utc_offset=None))[0]["utc_offset_printed"])
        moved, _ = self.build(data, body_of(data, local_time="14:36", utc_offset="+01:00"))
        self.assertEqual(moved["utc_offset_printed"], "+01:00")
        self.assertEqual(moved["timestamps"]["header"], {"date": "2026-10-04", "time": "14:36",
                                                         "utc_offset": "+01:00", "precision": "minute"})

    def test_damaged_dto_becomes_an_empty_frame(self):
        partial = {"merchant": {"brand_name": "LADEN", "legal_name": "PRIVATE LEGAL", "tax_id": "PRIVATE TAX"},
                   "receipt_number": "PRIVATE NUMBER", "raw_text": "PRIVATE TEXT",
                   "lines": [{"position": 1, "raw_name": "MILCH", "product_hint": {"secret": "PRIVATE HINT"}}]}
        for damaged in (partial, None, [], "PRIVATE", {"lines": "PRIVATE"}):
            built = review.build_observation(damaged, fixed_body())
            validate_observation(copy.deepcopy(built))
            self.assertNotIn("PRIVATE", str(built))
            self.assertEqual(built["merchant"], {"country_code": None, "legal_name": None, "brand_name": "TESTMARKT",
                                                 "tax_id_type": None, "tax_id": None})
            self.assertIsNone(built["receipt_number"])
            self.assertEqual(set(built["fiscal"].values()), {None})
            self.assertEqual(built["lines"][0]["product_hint"]["name"], None)
        self.assertEqual(review.recognized_positions(partial), {1})
        for damaged in (None, [], {"lines": "x"}, {"lines": [None, {"position": True}, {"position": 0},
                                                             {"position": 40000}, {"position": "1"}]}):
            self.assertEqual(review.recognized_positions(damaged), set())

    def test_evidence_fits_the_schema_limit_for_a_thousand_lines(self):
        data = receipt_payload()
        line = data["lines"][0]
        data["lines"] = [{**copy.deepcopy(line), "position": n, "store_item_code": f"C{n}",
                          "discount_amount": None} for n in range(1, 1001)]
        data["discounts"], data["taxes"] = [], []
        data["fields"] = [{"path": f"/lines/{n}/store_item_code", "status": "observed", "confidence": None,
                           "note": None} for n in range(1000)]
        data["fields"].append({"path": "/lines/7/barcode", "status": "unreadable", "confidence": None, "note": None})
        data["total"] = "2580.00"
        body = body_of(data)
        built, observation = self.build(data, body)
        self.assertLessEqual(len(built["fields"]), 10000)
        marks = evidence(built)
        self.assertEqual(marks["/lines/999/tax_rate/rate"], "observed")
        self.assertEqual(marks["/lines/7/barcode"], "unreadable")
        self.assertEqual(marks["/total"], "observed")
        self.assertEqual(marks["/purchased_on"], "observed")
        self.assertNotIn("/lines/0/quantity", marks)  # a record only: the import reads the value itself
        self.assertEqual(len(observation.lines), 1000)

    def test_request_indexes_of_rows_the_import_policy_kept(self):
        data = receipt_payload()
        body = body_of(data)
        body["taxes"].insert(0, {"tax_rate": {"kind": "vat", "rate": "7.00"}, "tax_code": "A",
                                 "net": "1.00", "tax": "1.00", "gross": "9.00"})  # dropped: does not add up
        body["discounts"].insert(0, {"position": 9, "line_position": None, "name": "X", "amount": "0.00"})
        built = review.build_observation(stored(data), body)
        built["discounts"][0]["amount"] = "-1.00"  # past clean_body: the policy drops it
        observation = validate_observation(built)
        effective, notices, _ = review.effective_observation(observation)
        self.assertEqual((len(effective.taxes), len(effective.discounts)), (2, 1))
        indexes = review._body_indexes(observation, effective)
        self.assertEqual(indexes, {"discounts": {0: 1}, "taxes": {0: 1, 1: 2}})
        issues = [{"code": "x", "field": field} for field in (
            "/taxes/0/tax_rate", "/taxes/1", "/discounts/0/name", "/taxes", "/taxes/5", "/lines/0/amount", "/", None)]
        self.assertEqual([item["field"] for item in review._to_body(issues, indexes)], [
            "/taxes/1/tax_rate", "/taxes/2", "/discounts/1/name", "/taxes", "/taxes/5", "/lines/0/amount", "/", None])
        self.assertIn({"code": "optional_omitted", "field": "/taxes/0", "message": "Необязательное поле пропущено."},
                      notices)


def review_decimal(value):
    from decimal import Decimal
    return Decimal(value)


@tag("integration")
class BodyRulesTests(TestCase):
    """Every row of the field table: one bad value -> its path and reason."""

    def refused(self, body, source=...):
        with self.assertRaises(review.ReviewInvalidParameter) as caught:
            review.clean_body(body, stored() if source is ... else source)
        return caught.exception.fields

    def one(self, path, value, reason, *, field=None):
        body = fixed_body()
        target = body
        *parents, key = path
        for part in parents:
            target = target[part]
        if value is KeyError:
            del target[key]
        else:
            target[key] = value
        name = field or ".".join(str(part) for part in path)
        with self.subTest(path=name, value=value):
            self.assertEqual(self.refused(body), {name: reason})

    def test_valid_body_is_normalized(self):
        body = fixed_body(country="de", currency="eur", store_name="  TESTMARKT\n", address="Teststrasse 12\n10115 Berlin")
        body["lines"][0]["name"] = " MILCH\t1 L "
        cleaned, store = review.clean_body(body, stored())
        self.assertIsNone(store)
        self.assertEqual(cleaned["receipt"]["country"], "DE")
        self.assertEqual(cleaned["receipt"]["currency"], "EUR")
        self.assertEqual(cleaned["receipt"]["store_name"], "TESTMARKT")
        self.assertEqual(cleaned["receipt"]["address"], "Teststrasse 12, 10115 Berlin")
        self.assertEqual(cleaned["lines"][0]["name"], "MILCH 1 L")
        self.assertNotIn("utc_offset", cleaned["receipt"])
        self.assertEqual(review.clean_body(fixed_body(), stored())[0], fixed_body())
        nullable = fixed_body(store_name=None, address=None, country=None, currency=None, operation=None,
                              prices_include_tax=None, utc_offset=None)
        self.assertEqual(review.clean_body(nullable, stored())[0], nullable)
        for offset in ("+02:00", "-11:30", "+14:00"):
            review.clean_body(fixed_body(utc_offset=offset), stored())
        review.clean_body(fixed_body(local_time="14:35", total="-4.42"), stored())

    def test_missing_keys(self):
        self.assertEqual(self.refused({}), dict.fromkeys(("receipt", "lines", "discounts", "taxes"), "required"))
        for key in review.RECEIPT_KEYS:
            self.one(("receipt", key), KeyError, "required")
        for key in review.LINE_KEYS:
            self.one(("lines", 1, key), KeyError, "required")
        for key in review.RATE_KEYS:
            self.one(("lines", 0, "tax_rate", key), KeyError, "required")
            self.one(("taxes", 1, "tax_rate", key), KeyError, "required")
        for key in review.DISCOUNT_KEYS:
            self.one(("discounts", 0, key), KeyError, "required")
        for key in review.TAX_KEYS:
            self.one(("taxes", 0, key), KeyError, "required")

    def test_receipt_values(self):
        for value, reason in ((0, "range"), (-1, "range"), (2**63, "range"), ("1", "type"), (1.0, "type"),
                              (True, "type"), (999999, "unknown")):
            self.one(("receipt", "store_id"), value, reason)
        for key, limit in (("store_name", 100), ("address", 4096)):
            for value, reason in ((5, "type"), ("", "blank"), (" \n ", "blank"), ("x" * (limit + 1), "too_long"),
                                  ("a\x00b", "format"), ("a\x7fb", "format")):
                self.one(("receipt", key), value, reason)
        for key, good in (("country", "XXX"), ("currency", "XX")):
            for value, reason in ((good, "format"), (5, "type"), ("1" * (2 if key == "country" else 3), "format"),
                                  ("ZZ" if key == "country" else "ZZZ", "unknown")):
                self.one(("receipt", key), value, reason)
        for value, reason in (("return", "choice"), (1, "type"), ("", "choice")):
            self.one(("receipt", "operation"), value, reason)
        for value, reason in ((None, "null"), ("2026-13-01", "format"), ("04.10.2026", "format"),
                              ("2026-02-30", "format"), (20261004, "type"), ("", "format")):
            self.one(("receipt", "purchased_on"), value, reason)
        for value, reason in ((None, "null"), ("25:00", "format"), ("14:35:61", "format"), ("14.35", "format"),
                              ("1435", "format"), (1435, "type"), ("14:35:20.5", "format")):
            self.one(("receipt", "local_time"), value, reason)
        for value, reason in (("Z", "format"), ("+15:00", "format"), ("+14:30", "format"), ("02:00", "format"),
                              ("+02:60", "format"), (2, "type")):
            body = fixed_body(utc_offset=value)
            with self.subTest(offset=value):
                self.assertEqual(self.refused(body), {"receipt.utc_offset": reason})
        for value, reason in ((None, "null"), (4.42, "type"), (442, "type"), ("4.4", "format"), ("4,42", "format"),
                              ("4.420", "format"), ("1" * 13 + ".00", "format"), ("+4.42", "format"), ("", "format"),
                              ("NaN", "format"), (True, "type")):
            self.one(("receipt", "total"), value, reason)
        for value in (1, 0, "true", "", []):
            self.one(("receipt", "prices_include_tax"), value, "type")
        self.assertEqual(self.refused({**fixed_body(), "receipt": []}), {"receipt": "type"})

    def test_line_values(self):
        for value, reason in ((None, "null"), (0, "range"), (32768, "range"), ("1", "type"), (1.5, "type"),
                              (True, "type")):
            self.one(("lines", 0, "position"), value, reason)
        for value, reason in ((0, "range"), ("1", "type"), (9, "reference")):
            self.one(("lines", 0, "source_position"), value, reason)
        # A repeated value is reported at its later row.
        self.one(("lines", 0, "position"), 2, "duplicate", field="lines.1.position")
        self.one(("lines", 0, "source_position"), 2, "duplicate", field="lines.1.source_position")
        for value, reason in ((None, "null"), ("goods", "choice"), (1, "type")):
            self.one(("lines", 0, "kind"), value, reason)
        for value, reason in ((None, "null"), ("", "blank"), ("x" * 4097, "too_long"), (5, "type"), ("a\x1bb", "format")):
            self.one(("lines", 0, "name"), value, reason)
        for value, reason in ((2, "type"), (2.0, "type"), ("2", "format"), ("2.00", "format"), ("2,000", "format"),
                              ("0.000", "range"), ("-0.000", "range"), ("1" * 10 + ".000", "format")):
            self.one(("lines", 0, "quantity"), value, reason)
        for value, reason in (("шт", "choice"), ("PCS", "choice"), (1, "type")):
            self.one(("lines", 0, "unit"), value, reason)
        for value, reason in ((1.29, "type"), ("1.29", "format"), ("-1.2900", "format"), ("1" * 11 + ".0000", "format")):
            self.one(("lines", 0, "unit_price"), value, reason)
        for value, reason in ((2.58, "type"), ("2.5", "format"), ("2.580", "format")):
            self.one(("lines", 0, "amount"), value, reason)
        for value, reason in (("x" * 9, "too_long"), ("", "blank"), (7, "type")):
            self.one(("lines", 0, "tax_code"), value, reason)
        self.one(("lines", 0, "tax_rate"), None, "type")
        self.one(("lines", 0, "tax_rate"), "vat", "type")
        for rate, path, reason in (({"kind": "vat", "rate": None}, "rate", "null"),
                                   ({"kind": "exempt", "rate": "0.00"}, "rate", "choice"),
                                   ({"kind": None, "rate": "7.00"}, "rate", "choice"),
                                   ({"kind": "sales", "rate": "7.00"}, "kind", "choice"),
                                   ({"kind": "vat", "rate": 7}, "rate", "type"),
                                   ({"kind": "vat", "rate": "7"}, "rate", "format"),
                                   ({"kind": "vat", "rate": "-7.00"}, "rate", "format"),
                                   ({"kind": "vat", "rate": "1000.00"}, "rate", "format")):
            self.one(("lines", 0, "tax_rate"), rate, reason, field="lines.0.tax_rate." + path)
        review.clean_body(fixed_body() | {"lines": [
            {**fixed_body()["lines"][0], "tax_rate": {"kind": "exempt", "rate": None}},
            *fixed_body()["lines"][1:]]}, stored())
        # A parent is a product line of this body, for a deposit only.
        for value in (9, 4, 2 + 2):
            self.one(("lines", 3, "parent_position"), value, "reference")
        self.one(("lines", 0, "parent_position"), 2, "reference")
        self.one(("lines", 3, "parent_position"), "3", "type")
        body = fixed_body()
        body["lines"][2]["kind"] = "service"
        self.assertEqual(self.refused(body), {"lines.3.parent_position": "reference"})
        for value, reason in (({}, "type"), (None, "type"), ([], "size"), ([fixed_body()["lines"][0]] * 1001, "size")):
            self.one(("lines",), value, reason)
        self.assertEqual(self.refused({**fixed_body(), "lines": [None, 5, []]}),
                         {"lines.0": "type", "lines.1": "type", "lines.2": "type"})

    def test_source_positions_come_from_the_stored_dto(self):
        body = fixed_body()
        self.assertEqual(self.refused(body, source={"lines": [{"position": 2}]}),
                         {f"lines.{index}.source_position": "reference" for index in (0, 2, 3)})
        self.assertEqual(set(self.refused(body, source=None)),
                         {f"lines.{index}.source_position" for index in range(4)})
        for line in body["lines"]:
            line["source_position"] = None
        review.clean_body(body, None)

    def test_discount_and_tax_values(self):
        for value, reason in ((None, "null"), (0, "range"), (40000, "range"), ("1", "type")):
            self.one(("discounts", 0, "position"), value, reason)
        for value, reason in ((9, "reference"), (0, "range"), ("1", "type")):
            self.one(("discounts", 0, "line_position"), value, reason)
        for value, reason in ((None, "null"), ("", "blank"), ("x" * 256, "too_long"), (1, "type")):
            self.one(("discounts", 0, "name"), value, reason)
        for value, reason in ((None, "null"), ("0.00", "range"), ("-0.20", "range"), (0.2, "type"), ("0.2", "format")):
            self.one(("discounts", 0, "amount"), value, reason)
        body = fixed_body()
        body["discounts"].append(dict(body["discounts"][0], line_position=None))
        self.assertEqual(self.refused(body), {"discounts.1.position": "duplicate"})
        for value, reason in (({}, "type"), ([body["discounts"][0]] * 1001, "size")):
            self.one(("discounts",), value, reason)
        self.one(("taxes", 0, "tax_rate"), {"kind": None, "rate": None}, "null", field="taxes.0.tax_rate.kind")
        self.one(("taxes", 1, "tax_rate"), {"kind": "vat", "rate": "19"}, "format", field="taxes.1.tax_rate.rate")
        self.one(("taxes", 0, "tax_code"), "x" * 9, "too_long")
        for key in ("net", "tax", "gross"):
            for value, reason in ((1.5, "type"), ("1.5", "format")):
                self.one(("taxes", 1, key), value, reason)
        self.one(("taxes", 0, "net"), None, "too_many_null", field="taxes.0")
        for value, reason in ((None, "type"), ([fixed_body()["taxes"][0]] * 101, "size")):
            self.one(("taxes",), value, reason)
        empty = fixed_body()
        empty["discounts"], empty["taxes"] = [], []
        review.clean_body(empty, stored())

    def test_every_error_is_reported_at_once(self):
        body = fixed_body(total=4.42, currency="EURO")
        body["lines"][1]["quantity"] = 0.5
        body["taxes"][1]["tax_rate"]["rate"] = None
        del body["discounts"]
        self.assertEqual(self.refused(body), {
            "discounts": "required", "receipt.total": "type", "receipt.currency": "format",
            "lines.1.quantity": "type", "taxes.1.tax_rate.rate": "null"})


@tag("integration")
class ConfirmServiceTests(TestCase):
    def test_corrected_total_creates_the_whole_receipt(self):
        image = review_image()
        job_before = ProcessingJob.objects.get(pk=image.job_id)
        before_dto = copy.deepcopy(image.normalized_result)
        result = review.confirm(image.pk, fixed_body())
        self.assertEqual(result, review.ConfirmResult(image.pk, image.job_id, False))
        image.refresh_from_db()
        receipt = Receipt.objects.get()
        self.assertEqual((image.status, image.receipt_id, image.import_effect), ("imported", receipt.pk, "created"))
        self.assertEqual(image.normalized_result, before_dto)  # the provider DTO is never rewritten
        self.assertEqual(image.issues, [])
        self.assertEqual(domain_counts(), (1, 4, 1, 2, 1, 1, 3, 3, TaxRate.objects.count()))
        self.assertEqual(str(receipt.total), "4.42")
        self.assertEqual(str(receipt.discount_total), "0.20")
        # Closed facts came from the stored DTO, not from the request.
        self.assertEqual((receipt.receipt_number, receipt.shift_number, receipt.register_code), ("000123", "7", "02"))
        self.assertEqual(receipt.fiscal, {"register_serial": "TEST-KASSE-02", "tse_transaction": "98765"})
        self.assertEqual(receipt.fiscal_key, "de:TEST-KASSE-02:98765")
        self.assertEqual(receipt.raw_text, "SYNTHETIC RECEIPT - TEST ONLY\n")
        self.assertEqual(receipt.store.merchant.legal_name, "TESTMARKT GmbH")
        self.assertEqual(receipt.store.postal_code, "10115")
        lines = list(receipt.lines.order_by("position"))
        self.assertEqual([str(line.discount_amount) for line in lines], ["0.20", "0.00", "0.00", "0.00"])
        self.assertEqual(lines[3].parent_id, lines[2].pk)
        self.assertEqual([line.tax_rate.rate for line in lines], [review_decimal(v) for v in ("7.00", "7.00", "19.00", "19.00")])
        self.assertEqual(sorted(str(tax.gross) for tax in receipt.taxes.all()), ["1.04", "3.38"])

        confirmed = image.outcome_snapshot["confirmed"]
        self.assertEqual(set(image.outcome_snapshot), {"receipt_id", "confirmed"})
        self.assertEqual(image.outcome_snapshot["receipt_id"], receipt.pk)
        self.assertEqual(set(confirmed), {"at", "request_sha256", "previous_issues", "result"})
        self.assertRegex(confirmed["at"], r"\A2[0-9]{3}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z\Z")
        self.assertEqual(confirmed["request_sha256"], review.request_sha256(fixed_body()))
        self.assertEqual(confirmed["previous_issues"], BLOCKING)
        self.assertEqual(confirmed["result"]["total"], "4.42")
        validate_observation(copy.deepcopy(confirmed["result"]))
        self.assertEqual(receipt.extra["recognition"]["confirmed"], {"image_id": image.pk, "at": confirmed["at"]})
        self.assertIn("derived", receipt.extra["recognition"])

        job = ProcessingJob.objects.get(pk=image.job_id)
        self.assertEqual((job.status, job.version), ("succeeded", job_before.version + 1))
        self.assertEqual((job.completed_count, job.imported_count, job.reused_count, job.review_count), (1, 1, 0, 0))
        self.assertEqual((job.finished_at, job.error_code, job.stage), (job_before.finished_at, "", "finished"))

    def test_job_is_promoted_only_when_every_crop_succeeded(self):
        job = finished_job(detected_count=3, completed_count=3, imported_count=0, review_count=3)
        first = review_image(job=job)
        second = review_image(wrong_total(2), job=job, position=2)
        third = make_image(job, position=3, status="failed", issues=[{"code": "provider_error", "field": "/"}])
        review.confirm(first.pk, fixed_body())
        job.refresh_from_db()
        self.assertEqual((job.status, job.version, job.imported_count, job.review_count, job.failed_count),
                         ("partial_succeeded", 2, 1, 2 - 1, 1))
        review.confirm(second.pk, fixed_body(2))
        job.refresh_from_db()
        self.assertEqual((job.status, job.version, job.imported_count, job.review_count), ("partial_succeeded", 3, 2, 0))
        self.assertEqual(ReceiptImage.objects.get(pk=third.pk).status, "failed")
        # A failed or cancelled job keeps its verdict; only its counters follow the crops.
        for status in ("failed", "cancelled"):
            other = finished_job(status=status, error_code="timeout" if status == "failed" else "",
                                 cancel_requested_at=timezone.now() if status == "cancelled" else None)
            image = review_image(another(status), job=other)
            review.confirm(image.pk, body_of(another(status)))
            other.refresh_from_db()
            self.assertEqual((other.status, other.review_count, other.imported_count), (status, 0, 1))
        self.assertEqual(Receipt.objects.count(), 4)

    def test_import_rules_refuse_and_nothing_is_saved(self):
        Merchant.objects.all().delete()
        image = review_image()
        before, counts = image_state(image), domain_counts()
        cases = (
            (body_of(wrong_total()), {("total_mismatch", "/total")}),
            (fixed_body(total="4.40"), {("total_mismatch", "/total")}),
            (self.edited(lambda body: body["lines"][0].update(amount="9.99")),
             {("total_mismatch", "/lines/0/amount"), ("total_mismatch", "/total")}),
            (self.edited(lambda body: body["lines"][0].update(quantity=None, unit_price=None, amount=None)),
             {("missing_required", "/lines/0/quantity"), ("missing_required", "/lines/0/unit_price"),
              ("missing_required", "/lines/0/amount")}),
            (fixed_body(currency=None), {("missing_required", "/currency_code")}),
            (fixed_body(address=None), {("missing_required", "/store/address_raw")}),
            (self.edited(lambda body: body["lines"][3].update(kind="deposit_return", parent_position=None)),
             {("invalid_value", "/lines/3/amount")}),
        )
        for body, expected in cases:
            with self.subTest(expected=expected), self.assertRaises(review.ReviewInvalid) as caught:
                review.confirm(image.pk, body)
            found = {(item["code"], item["field"]) for item in caught.exception.issues}
            self.assertLessEqual(expected, found)
            self.assertEqual(caught.exception.normalized["receipt_number"], "000123")
            self.assertEqual((image_state(image), domain_counts()), (before, counts))

    def edited(self, change):
        body = fixed_body()
        change(body)
        return body

    def test_refusal_inside_the_graph_rolls_back_the_new_store_and_products(self):
        image = review_image()
        before, counts = image_state(image), domain_counts()
        from recognition import importer
        from recognition.resolution import ResolutionError, issue
        original = importer._create_graph

        def refuse(*args, **kwargs):
            original(*args, **kwargs)  # the store, products, lines and taxes are written first
            self.assertEqual(Receipt.objects.count(), 1)
            raise ResolutionError(issue("missing_required", "/taxes/1/tax_rate"))

        with patch.object(importer, "_create_graph", side_effect=refuse), self.assertRaises(review.ReviewInvalid) as caught:
            review.confirm(image.pk, fixed_body())
        self.assertEqual(caught.exception.issues, [issue("missing_required", "/taxes/1/tax_rate")])
        self.assertEqual((image_state(image), domain_counts()), (before, counts))
        from django.core.exceptions import ValidationError
        with patch.object(importer, "_create_graph", side_effect=ValidationError("PRIVATE")), \
                self.assertRaises(review.ReviewInvalid) as caught:
            review.confirm(image.pk, fixed_body())
        self.assertEqual([(item["code"], item["field"]) for item in caught.exception.issues], [("invalid_value", "/")])
        self.assertNotIn("PRIVATE", str(caught.exception.issues))
        self.assertEqual((image_state(image), domain_counts()), (before, counts))

    def test_same_body_replays_and_another_body_is_resolved(self):
        image = review_image()
        review.confirm(image.pk, fixed_body())
        after, counts = image_state(image), domain_counts()
        reordered = {key: fixed_body(country="de")[key] for key in ("taxes", "discounts", "lines", "receipt")}
        result = review.confirm(image.pk, fixed_body())
        self.assertEqual(result, review.ConfirmResult(image.pk, image.job_id, True))
        self.assertTrue(review.confirm(image.pk, reordered).replayed)
        self.assertEqual((image_state(image), domain_counts()), (after, counts))
        for body in (fixed_body(operation=None), fixed_body(utc_offset=None), body_of(wrong_total())):
            with self.assertRaises(review.ReviewResolved):
                review.confirm(image.pk, body)
        self.assertEqual((image_state(image), domain_counts()), (after, counts))
        # A confirmed receipt removed in the admin: the crop cannot be confirmed again.
        Receipt.objects.all().delete()
        for body in (fixed_body(), fixed_body(operation=None)):
            with self.assertRaises(review.ReviewUnavailable):
                review.confirm(image.pk, body)

    def test_unavailable_states_and_active_job(self):
        from recognition.importer import import_receipt
        from .import_fixtures import observation
        automatic, job = live_image()
        import_receipt(automatic, observation(), run_token=job.run_token, version=job.version)
        ProcessingJob.objects.filter(pk=job.pk).update(
            status="succeeded", stage="finished", finished_at=timezone.now(), run_token=None, heartbeat_at=None,
            lease_expires_at=None)
        images = [automatic]
        for status in ("pending", "running", "failed", "cancelled", "reused", "updated"):
            images.append(review_image(another(status), status=status, job=finished_job(status="failed")))
        counts = domain_counts()
        for image in images:
            before = image_state(image)
            with self.subTest(status=image.status), self.assertRaises(review.ReviewUnavailable):
                review.confirm(image.pk, fixed_body())
            self.assertEqual((image_state(image), domain_counts()), (before, counts))
        with self.assertRaises(review.ReviewNotFound):
            review.confirm(999999, fixed_body())
        for status in ("queued", "running", "cancel_requested"):
            active, job = live_image(status="needs_review", normalized_result=stored(wrong_total()))
            if status == "queued":
                ProcessingJob.objects.filter(pk=job.pk).update(status="queued", stage="waiting", run_token=None,
                                                               heartbeat_at=None, lease_expires_at=None)
            elif status == "cancel_requested":
                ProcessingJob.objects.filter(pk=job.pk).update(status=status, cancel_requested_at=timezone.now())
            before = image_state(active)
            with self.subTest(job=status), self.assertRaises(review.ReviewJobActive):
                review.confirm(active.pk, body_of(wrong_total()))  # state is checked before the import rules
            self.assertEqual((image_state(active), domain_counts()), (before, counts))

    def test_chosen_store_replaces_store_resolution(self):
        merchant = Merchant.objects.create(country_id="DE", legal_name="ANDERER MARKT AG", brand_name="ANDERER")
        store = Store.objects.create(merchant=merchant, country_id="DE", address_raw="Hauptweg 5, 01067 Dresden",
                                     timezone="Europe/Berlin")
        twin = Store.objects.create(merchant=merchant, country_id="DE", address_raw="Hauptweg 6, 01067 Dresden",
                                    timezone="Europe/Berlin")
        image = review_image()
        review.confirm(image.pk, fixed_body(store_id=store.pk, store_name=None, address=None, country="KZ",
                                            currency=None))
        receipt = Receipt.objects.get()
        self.assertEqual((receipt.store_id, receipt.currency_id), (store.pk, "EUR"))
        self.assertEqual((Store.objects.count(), Merchant.objects.count()), (2, 1))
        merchant.refresh_from_db()
        self.assertEqual((merchant.legal_name, merchant.tax_id), ("ANDERER MARKT AG", ""))
        image.refresh_from_db()
        self.assertEqual([(item["code"], item["field"]) for item in image.issues],
                         [("currency_inferred", "/currency_code")])
        self.assertEqual(ProductAlias.objects.filter(merchant=merchant).count(), 3)
        # The same printed receipt in the other chosen shop is another receipt.
        second = review_image()
        review.confirm(second.pk, fixed_body(store_id=twin.pk))
        self.assertEqual(Receipt.objects.filter(store=twin).count(), 0)  # the fiscal key is global: linked
        second.refresh_from_db()
        self.assertEqual((second.status, second.receipt_id), ("reused", receipt.pk))
        self.assertIn(("receipt_conflict", "/store"), [(item["code"], item["field"]) for item in second.issues])

    def test_ambiguous_store_is_refused_until_a_store_is_chosen(self):
        first = Merchant.objects.create(country_id="DE", legal_name="TESTMARKT GmbH")
        second = Merchant.objects.create(country_id="DE", legal_name="Testmarkt  GmbH")
        Store.objects.create(merchant=first, country_id="DE", address_raw="Teststrasse 12, 10115 Berlin",
                             timezone="Europe/Berlin")
        target = Store.objects.create(merchant=second, country_id="DE", address_raw="Teststrasse 12, 10115 Berlin",
                                      timezone="Europe/Berlin")
        image = review_image()
        with self.assertRaises(review.ReviewInvalid) as caught:
            review.confirm(image.pk, fixed_body())
        self.assertEqual([(item["code"], item["field"]) for item in caught.exception.issues],
                         [("store_ambiguous", "/store")])
        review.confirm(image.pk, fixed_body(store_id=target.pk))
        self.assertEqual(Receipt.objects.get().store_id, target.pk)

    def test_existing_receipt_is_linked_and_never_rewritten(self):
        review.confirm(review_image().pk, fixed_body())
        receipt = Receipt.objects.get()
        Receipt.objects.filter(pk=receipt.pk).update(raw_text="")
        snapshot = self.receipt_values(receipt)
        counts = domain_counts()

        same = review_image()
        review.confirm(same.pk, fixed_body())
        same.refresh_from_db()
        self.assertEqual((same.status, same.import_effect, same.receipt_id), ("updated", "updated", receipt.pk))
        self.assertEqual(same.issues, [])
        self.assertEqual(Receipt.objects.get().raw_text, "SYNTHETIC RECEIPT - TEST ONLY\n")  # an empty field is completed
        Receipt.objects.filter(pk=receipt.pk).update(raw_text="")

        edited = review_image()
        body = fixed_body(operation="refund")
        body["lines"][1].update(name="BIRNE")
        body["lines"].pop()
        body["receipt"]["total"] = "4.17"
        body["discounts"][0]["name"] = "Aktion"
        body["taxes"] = []
        Receipt.objects.filter(pk=receipt.pk).update(raw_text="KEPT")
        snapshot = self.receipt_values(receipt)
        review.confirm(edited.pk, body)
        edited.refresh_from_db()
        self.assertEqual((edited.status, edited.import_effect, edited.receipt_id), ("reused", "linked", receipt.pk))
        found = {(item["code"], item["field"]) for item in edited.issues}
        self.assertEqual(found, {
            ("receipt_conflict", "/operation"), ("receipt_conflict", "/total"),
            ("receipt_structure_conflict", "/lines"), ("receipt_line_conflict", "/lines/1"),
            ("receipt_line_conflict", "/lines"), ("receipt_structure_conflict", "/discounts"),
            ("receipt_structure_conflict", "/taxes")})
        self.assertEqual(self.receipt_values(receipt), snapshot)
        self.assertEqual(domain_counts(), counts)  # no duplicate lines, products, discounts or taxes
        self.assertEqual(Receipt.objects.get().extra["recognition"]["confirmed"]["image_id"],
                         ReceiptImage.objects.order_by("pk").first().pk)  # the mark of the creating crop stays
        self.assertEqual(edited.outcome_snapshot["confirmed"]["result"]["total"], "4.17")

    def receipt_values(self, receipt):
        receipt = Receipt.objects.get(pk=receipt.pk)
        return (receipt.total, receipt.operation, receipt.raw_text, receipt.extra, receipt.store_id,
                list(receipt.lines.order_by("position").values_list("position", "raw_name", "amount", "product_id")),
                list(receipt.discounts.values_list("position", "name", "amount")),
                list(receipt.taxes.order_by("pk").values_list("net", "tax", "gross")))

    def test_conflicting_closed_identity_stays_a_refusal(self):
        review.confirm(review_image().pk, fixed_body())
        data = wrong_total()
        data["fiscal"]["tse_transaction"] = "11111"  # another strong key at the same store, time and total
        image = review_image(data)
        before, counts = image_state(image), domain_counts()
        with self.assertRaises(review.ReviewInvalid) as caught:
            review.confirm(image.pk, fixed_body())
        self.assertEqual([(item["code"], item["field"]) for item in caught.exception.issues],
                         [("identity_conflict", "/fiscal")])
        self.assertEqual((image_state(image), domain_counts()), (before, counts))

    def test_unreadable_operands_are_typed_or_derived(self):
        typed = review_image(missing_quantity())
        body = body_of(missing_quantity())
        with self.assertRaises(review.ReviewInvalid) as caught:
            review.confirm(typed.pk, self.without_amount(body))
        self.assertLessEqual({("missing_required", "/lines/0/quantity")},
                             {(item["code"], item["field"]) for item in caught.exception.issues})
        body["lines"][0].update(quantity="2.000", unit_price="1.2900")
        review.confirm(typed.pk, body)
        line = ReceiptLine.objects.get(receipt__recognition_images=typed, position=1)
        self.assertEqual((str(line.quantity), str(line.unit_price), str(line.amount)), ("2.000", "1.2900", "2.58"))

        # A person leaves both empty: one piece at the printed amount, as the import derives it.
        derived = review_image(missing_quantity(2))
        review.confirm(derived.pk, body_of(missing_quantity(2)))
        line = ReceiptLine.objects.get(receipt__recognition_images=derived, position=1)
        self.assertEqual((str(line.quantity), line.unit, str(line.unit_price)), ("1.000", "pcs", "1.5000"))
        receipt = Receipt.objects.get(recognition_images=derived)
        self.assertEqual(receipt.extra["recognition"]["derived"][:2], ["/lines/0/quantity", "/lines/0/unit_price"])

        # One empty operand is arithmetic of the two typed ones.
        data = another("derive")
        body = body_of(data)
        body["lines"][1].update(amount=None)
        body["lines"][2].update(unit_price=None, unit=None)
        image = review_image(data)
        review.confirm(image.pk, body)
        lines = {line.position: line for line in ReceiptLine.objects.filter(receipt__recognition_images=image)}
        self.assertEqual((str(lines[2].amount), str(lines[3].unit_price), lines[3].unit), ("1.00", "0.7900", "pcs"))

    def without_amount(self, body):
        body = copy.deepcopy(body)
        body["lines"][0]["amount"] = None
        return body

    def test_confirmed_tax_rates_are_imported_without_provider_evidence(self):
        data = tax_evidence_payload(tax_evidence=False)
        data["total"] = "99.99"
        image = review_image(data)
        review.confirm(image.pk, body_of(data, total="23.95"))
        receipt = Receipt.objects.get()
        self.assertEqual(receipt.lines.filter(tax_rate__isnull=False).count(), 25)
        self.assertEqual(sorted(str(tax.gross) for tax in receipt.taxes.all()), ["18.19", "5.76"])
        image.refresh_from_db()
        # Closed doubts of the provider stay doubts: the ambiguous number is still omitted.
        self.assertEqual({(item["code"], item["field"]) for item in image.issues},
                         {("optional_omitted", "/receipt_number"), ("optional_omitted", "/fiscal/signature")})
        self.assertEqual(receipt.receipt_number, "")
        # A person who doubts a rate clears it; a wrong table is dropped with a notice, the receipt is kept.
        other = tax_evidence_payload(tax_evidence=True)
        body = body_of(other)
        body["lines"][0]["tax_rate"] = {"kind": None, "rate": None}
        body["taxes"][0]["net"] = "1.00"
        body["taxes"][0]["gross"] = "18.19"
        second = review_image(other)
        review.confirm(second.pk, body)
        second.refresh_from_db()
        receipt = Receipt.objects.get(recognition_images=second)
        self.assertEqual(receipt.lines.filter(tax_rate__isnull=True).count(), 1)
        self.assertEqual(receipt.taxes.count(), 0)
        self.assertLessEqual({("optional_omitted", "/taxes/0"), ("optional_omitted", "/taxes")},
                             {(item["code"], item["field"]) for item in second.issues})

    def test_added_removed_and_renamed_rows(self):
        image = review_image(clipped=True)
        body = fixed_body(store_name="NEUER LADEN", address="Neue Strasse 1, 80331 Muenchen", total="3.37")
        body["lines"] = [
            {**body["lines"][0], "name": "VOLLMILCH 1 L"},
            {"position": 7, "source_position": None, "kind": "product", "parent_position": None, "name": "BROT",
             "quantity": "1.000", "unit": "pcs", "unit_price": "0.9900", "amount": "0.99",
             "tax_rate": {"kind": "exempt", "rate": None}, "tax_code": None},
        ]
        body["discounts"] = [{"position": 3, "line_position": None, "name": "Coupon", "amount": "0.20"}]
        body["taxes"] = []
        review.confirm(image.pk, body)
        receipt = Receipt.objects.get()
        self.assertEqual(list(receipt.lines.order_by("position").values_list("position", "raw_name")),
                         [(1, "VOLLMILCH 1 L"), (7, "BROT")])
        self.assertEqual(list(receipt.lines.order_by("position").values_list("product__name", flat=True)),
                         ["VOLLMILCH 1 L", "BROT"])  # the old hint name was not kept for the renamed line
        self.assertEqual(receipt.lines.get(position=7).tax_rate.kind, "exempt")
        self.assertEqual(list(receipt.discounts.values_list("position", "line_id", "name")), [(3, None, "Coupon")])
        self.assertEqual((str(receipt.discount_total), receipt.taxes.count()), ("0.20", 0))
        merchant = receipt.store.merchant
        self.assertEqual((merchant.legal_name, merchant.brand_name, receipt.store.name), ("NEUER LADEN",) * 3)
        self.assertEqual((receipt.store.address_raw, receipt.store.city, receipt.store.postal_code),
                         ("Neue Strasse 1, 80331 Muenchen", "", ""))
        image.refresh_from_db()
        self.assertEqual(image.issues, [{"code": "clipped", "field": "/clipped", "message": "Результат требует проверки."}])

    def test_skeleton_of_a_partial_dto_is_confirmable(self):
        partial = {"merchant": {"brand_name": "LADEN"}, "lines": [{"position": 1, "raw_name": "MILCH"}]}
        image = make_image(finished_job(), status="needs_review", normalized_result=partial, issues=BLOCKING)
        body = fixed_body(operation=None, prices_include_tax=None)
        with self.assertRaises(review.ReviewInvalidParameter) as caught:
            review.confirm(image.pk, body)  # only the line the projection shows can be a source
        self.assertEqual(caught.exception.fields, {f"lines.{n}.source_position": "reference" for n in (1, 2, 3)})
        for line in body["lines"][1:]:
            line["source_position"] = None
        review.confirm(image.pk, body)
        receipt = Receipt.objects.get()
        self.assertEqual((receipt.receipt_number, receipt.fiscal, receipt.fiscal_key, receipt.raw_text), ("", {}, "", ""))
        self.assertEqual(receipt.store.merchant.legal_name, "TESTMARKT")
        image.refresh_from_db()
        self.assertEqual(image.normalized_result, partial)
        self.assertEqual([(item["code"], item["field"]) for item in image.issues],
                         [("operation_defaulted", "/operation"), ("optional_omitted", "/prices_include_tax")])

    def test_duplicate_search_follows_the_setting(self):
        with patch("recognition.review._detect_product_merges") as detect:
            review.confirm(review_image().pk, fixed_body())
            detect.assert_not_called()
            with override_settings(PRODUCT_MERGE_AUTO_DETECT=True):
                with self.assertRaises(review.ReviewInvalid):
                    review.confirm(review_image(wrong_total(2)).pk, body_of(wrong_total(2)))
                detect.assert_not_called()
                review.confirm(review_image(wrong_total(2)).pk, fixed_body(2))
            detect.assert_called_once_with(Receipt.objects.order_by("pk").last())

    @override_settings(PRODUCT_MERGE_AUTO_DETECT=True)
    def test_failed_duplicate_search_keeps_the_confirmed_receipt(self):
        with patch("merges.services.detect", side_effect=RuntimeError("PRIVATE")), self.assertLogs(
                "recognition.importer", "ERROR") as logs:
            image = review_image()
            review.confirm(image.pk, fixed_body())
        self.assertNotIn("PRIVATE", "".join(logs.output))
        image.refresh_from_db()
        self.assertEqual((image.status, Receipt.objects.count()), ("imported", 1))

    def test_busy_database_and_unique_race_are_review_busy(self):
        image = review_image()
        before, counts = image_state(image), domain_counts()

        def database_error(kind, **cause):
            error = kind("PRIVATE")
            error.__cause__ = type("Cause", (Exception,), {})()
            for key, value in cause.items():
                setattr(error.__cause__, key, value)
            return error

        diag = type("Diag", (), {"constraint_name": "receipts_receipt_owner_store_time_total_uniq"})()
        errors = [database_error(OperationalError, sqlstate=state) for state in ("55P03", "57014", "40P01")]
        errors.append(database_error(IntegrityError, sqlstate="23505", diag=diag))
        for error in errors:
            with self.subTest(error=error), patch("recognition.review._import_domain", side_effect=error), \
                    self.assertRaises(review.ReviewBusy):
                review.confirm(image.pk, fixed_body())
            self.assertEqual((image_state(image), domain_counts()), (before, counts))
        # Anything else is not disguised as "busy".
        other = type("Diag", (), {"constraint_name": "receipts_line_position_uniq"})()
        for error, kind in ((database_error(OperationalError, sqlstate="08006"), OperationalError),
                            (database_error(IntegrityError, sqlstate="23505", diag=other), IntegrityError),
                            (RuntimeError("PRIVATE"), RuntimeError)):
            with patch("recognition.review._import_domain", side_effect=error), self.assertRaises(kind):
                review.confirm(image.pk, fixed_body())
            self.assertEqual((image_state(image), domain_counts()), (before, counts))

    def test_import_receipt_behaviour_is_unchanged_by_the_shared_domain_part(self):
        from recognition.importer import import_receipt
        from .import_fixtures import observation
        image, job = live_image()
        result = import_receipt(image, observation(), run_token=job.run_token, version=job.version)
        self.assertEqual(result.outcome, "created")
        self.assertNotIn("confirmed", result.receipt.extra["recognition"])
        self.assertEqual(result.image.outcome_snapshot, {"receipt_id": result.receipt.pk})


def another(seed):
    """A valid fake receipt of the same shop at another minute: a distinct identity per seed."""
    data = receipt_payload()
    minute = sum(seed.encode()) % 50 + 10
    data["local_time"] = f"09:{minute}:00"
    data["timestamps"]["header"]["time"] = data["local_time"]
    data["receipt_number"] = f"9{minute}"
    data["fiscal"]["tse_transaction"] = f"7{minute}"
    return data
