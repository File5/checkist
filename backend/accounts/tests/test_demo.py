"""Демо двух учётных записей: состав, ответ команды, отказы и то, что видит каждый по HTTP.

MEDIA временный; пользователи, продавец, товары и картинки вымышленные. Пароли тестов
существуют только здесь.
"""
import io
import json
import tempfile
from decimal import Decimal
from pathlib import Path
from unittest.mock import patch

from django.conf import settings
from django.contrib.auth import get_user_model
from django.core.management import CommandError, call_command
from django.test import SimpleTestCase, TestCase, override_settings, tag
from rest_framework.test import APIClient

from accounts import demo
from accounts.tests.test_media import body
from api.tests.accounts_helpers import NOT_FOUND, accounts_mode, with_csrf
from catalog.models import Product
from merges import detection, services
from merges.models import ProductMerge, ProductMergeMember
from receipts.models import ProductAlias, Receipt, ReceiptLine
from receipts.validation import validate_receipt
from recognition.models import ProcessingJob, ReceiptImage, SourcePhoto
from stores.models import Merchant, Store

MODERATOR, USER = demo.MODERATOR, demo.USER
PASSWORDS = {MODERATOR: "Kiefernzapfen-41-blau", USER: "Wacholder-87-gruen"}
COMMAND = "seed_accounts_demo"
ARGUMENTS = ("--moderator-password", PASSWORDS[MODERATOR], "--user-password", PASSWORDS[USER])
MODELS = (
    Merchant, Store, Product, ProductAlias, Receipt, ReceiptLine, SourcePhoto, ProcessingJob, ReceiptImage,
    ProductMerge, ProductMergeMember,
)
User = get_user_model()


def run_command(*arguments):
    out = io.StringIO()
    call_command(COMMAND, *arguments, stdout=out)
    return out.getvalue()


def seed():
    return demo.seed_demo(moderator_password=PASSWORDS[MODERATOR], user_password=PASSWORDS[USER])


def counts():
    return {model.__name__: model.objects.count() for model in MODELS}


def users():
    return list(User.objects.order_by("pk").values())


class PlanTests(SimpleTestCase):
    def test_names_are_fictional(self):
        self.assertEqual(len(set(demo.PRODUCTS)), 5)
        for name in demo.PRODUCTS:
            self.assertRegex(name, r"^Demo ")
        self.assertRegex(demo.MERCHANT["tax_id"], r"^DEMOACCOUNTS\d{4}$")
        self.assertIn("вымышлен", demo.MERCHANT["legal_name"])
        self.assertEqual(demo.USERNAMES, {MODERATOR: "demo_moderator", USER: "demo_user"})

    def test_only_the_two_spellings_look_like_duplicates(self):
        candidates = [
            detection.Candidate(id=index, name=name, merchants=frozenset({1}))
            for index, name in enumerate(demo.PRODUCTS, 1)
        ]
        pair = tuple(sorted(demo.PRODUCTS.index(name) + 1 for name in demo.DUPLICATES.values()))
        self.assertEqual([edge[1:] for edge in detection.find_edges(candidates)], [pair])

    def test_receipts_are_consistent(self):
        for role, (_number, _on, rows) in demo.RECEIPTS.items():
            names = [row[0] for row in rows]
            self.assertEqual(names, [demo.SHARED_PRODUCT, demo.OWN_PRODUCTS[role], demo.DUPLICATES[role]])
            for name, quantity, unit_price, amount in rows:
                self.assertEqual(Decimal(quantity) * Decimal(unit_price), Decimal(amount), name)
        # Статистика двоих различается.
        totals = {role: sum(Decimal(row[3]) for row in rows) for role, (_n, _o, rows) in demo.RECEIPTS.items()}
        self.assertNotEqual(totals[MODERATOR], totals[USER])

    def test_pictures_of_the_two_accounts_differ(self):
        first, second = (demo._png(demo.PHOTO_SIZE, demo.PAPER[role], role) for role in (MODERATOR, USER))
        self.assertTrue(first.startswith(b"\x89PNG"))
        self.assertNotEqual(first, second)
        self.assertEqual(first, demo._png(demo.PHOTO_SIZE, demo.PAPER[MODERATOR], MODERATOR))


class MediaRootMixin:
    def setUp(self):
        super().setUp()
        directory = tempfile.TemporaryDirectory(prefix="checkist-accounts-demo-test-")
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name) / "media"
        override = override_settings(MEDIA_ROOT=str(self.root))
        override.enable()
        self.addCleanup(override.disable)

    def files(self):
        return sorted(path.relative_to(self.root).as_posix() for path in self.root.rglob("*") if path.is_file())


@tag("integration")
class CommandTests(MediaRootMixin, TestCase):
    maxDiff = None

    def test_command_prints_ids_and_no_passwords(self):
        output = run_command(*ARGUMENTS)
        for password in PASSWORDS.values():
            self.assertNotIn(password, output)
        result = json.loads(output)
        moderator, user = (User.objects.get(username=demo.USERNAMES[role]) for role in (MODERATOR, USER))
        products = {product.name: product.pk for product in Product.objects.all()}
        receipts = {receipt.owner_id: receipt.pk for receipt in Receipt.objects.all()}
        group = ProductMerge.objects.get()
        self.assertEqual({key: value for key, value in result.items() if key not in ("merge", "media")}, {
            "created": True,
            "users": {
                MODERATOR: {"id": moderator.pk, "username": "demo_moderator"},
                USER: {"id": user.pk, "username": "demo_user"},
            },
            "store_id": Store.objects.get().pk,
            "shared_product_id": products[demo.SHARED_PRODUCT],
            "own_product_ids": {role: products[name] for role, name in demo.OWN_PRODUCTS.items()},
            "receipt_ids": {MODERATOR: receipts[moderator.pk], USER: receipts[user.pk]},
        })
        self.assertEqual(result["merge"], {
            "group_id": group.pk, "target_product_id": products[demo.DUPLICATES[MODERATOR]],
            "product_ids": sorted(products[name] for name in demo.DUPLICATES.values()),
            "line_ids": {
                role: [ReceiptLine.objects.get(receipt__owner=account, raw_name=demo.DUPLICATES[role]).pk]
                for role, account in ((MODERATOR, moderator), (USER, user))
            },
        })
        for role, account in ((MODERATOR, moderator), (USER, user)):
            photo = SourcePhoto.objects.get(owner=account)
            image = ReceiptImage.objects.get(photo=photo)
            self.assertEqual(result["media"][role], {
                "photo_id": photo.pk, "job_id": image.job_id, "image_id": image.pk,
                "storage_uuid": str(photo.storage_uuid), "original": photo.original_file.name,
                "prepared": photo.upright_file.name, "crop": image.file.name,
            })

    def test_accounts_and_passwords(self):
        seed()
        moderator, user = (User.objects.get(username=demo.USERNAMES[role]) for role in (MODERATOR, USER))
        for role, account in ((MODERATOR, moderator), (USER, user)):
            self.assertTrue(account.check_password(PASSWORDS[role]))
            self.assertNotIn(PASSWORDS[role], account.password)
            self.assertEqual((account.is_active, account.is_staff, account.is_superuser), (True, False, False))
        self.assertTrue(moderator.has_perm("catalog.moderate_catalog"))
        self.assertFalse(user.has_perm("catalog.moderate_catalog"))
        self.assertEqual(list(user.user_permissions.all()), [])
        self.assertEqual(moderator.user_permissions.count(), 1)

    def test_composition(self):
        result = seed()
        self.assertEqual(counts(), {
            "Merchant": 1, "Store": 1, "Product": 5, "ProductAlias": 5, "Receipt": 2, "ReceiptLine": 6,
            "SourcePhoto": 2, "ProcessingJob": 2, "ReceiptImage": 2, "ProductMerge": 1, "ProductMergeMember": 2,
        })
        store = Store.objects.get()
        shared = Product.objects.get(pk=result["shared_product_id"])
        self.assertEqual(shared.name, demo.SHARED_PRODUCT)
        for role in (MODERATOR, USER):
            receipt = Receipt.objects.get(pk=result["receipt_ids"][role])
            self.assertEqual((receipt.owner_id, receipt.store_id), (result["users"][role]["id"], store.pk))
            self.assertEqual(validate_receipt(receipt), [], role)
            self.assertEqual(receipt.lines.filter(product=shared).count(), 1)
            own = Product.objects.get(pk=result["own_product_ids"][role])
            self.assertEqual(own.name, demo.OWN_PRODUCTS[role])
            self.assertEqual(set(own.receipt_lines.values_list("receipt_id", flat=True)), {receipt.pk})
        self.assertEqual(
            set(shared.receipt_lines.values_list("receipt__owner_id", flat=True)),
            {result["users"][role]["id"] for role in (MODERATOR, USER)},
        )

    def test_photos_have_files_in_media(self):
        result = seed()
        expected = []
        for role in (MODERATOR, USER):
            media = result["media"][role]
            photo = SourcePhoto.objects.get(pk=media["photo_id"])
            job = ProcessingJob.objects.get(pk=media["job_id"])
            image = ReceiptImage.objects.get(pk=media["image_id"])
            self.assertEqual(photo.owner_id, result["users"][role]["id"])
            self.assertEqual((job.photo_id, job.status, job.stage), (photo.pk, "succeeded", "finished"))
            self.assertEqual(
                (image.photo_id, image.job_id, image.status, image.receipt_id, image.import_effect),
                (photo.pk, job.pk, "imported", result["receipt_ids"][role], "created"),
            )
            image.full_clean()
            uuid_text = media["storage_uuid"]
            self.assertEqual(media["original"], f"originals/{uuid_text}/source.png")
            self.assertRegex(media["prepared"], rf"^prepared/{uuid_text}/[0-9a-f-]{{36}}/upright-v1\.png$")
            self.assertRegex(media["crop"], rf"^crops/{uuid_text}/{job.pk}/1-[0-9a-f-]{{36}}/crop\.png$")
            self.assertEqual(photo.bytes, (self.root / media["original"]).stat().st_size)
            for key in ("original", "prepared", "crop"):
                self.assertTrue((self.root / media[key]).read_bytes().startswith(b"\x89PNG"), key)
                expected.append(media[key])
        self.assertEqual(self.files(), sorted(expected))
        originals = [(self.root / result["media"][role]["original"]).read_bytes() for role in (MODERATOR, USER)]
        self.assertNotEqual(*originals)

    def test_pending_group_holds_lines_of_both(self):
        result = seed()
        merge = result["merge"]
        group = ProductMerge.objects.get(pk=merge["group_id"])
        self.assertEqual((group.status, group.target_ref), ("pending", merge["target_product_id"]))
        self.assertEqual(
            sorted(group.members.filter(state="active").values_list("product_ref", flat=True)), merge["product_ids"],
        )
        lines = services.group_lines(group)
        self.assertEqual(
            {line.pk: line.receipt.owner_id for line in lines},
            {merge["line_ids"][role][0]: result["users"][role]["id"] for role in (MODERATOR, USER)},
        )
        # Повторный поиск ничего не добавляет: группа одна.
        self.assertEqual(services.detect(dry_run=True).proposals, [])

    def test_passwords_are_required(self):
        for arguments in ((), ARGUMENTS[:2], ARGUMENTS[2:]):
            with self.subTest(arguments=arguments[::2]), self.assertRaises(CommandError):
                run_command(*arguments)
        self.assertFalse(User.objects.filter(username__in=demo.USERNAMES.values()).exists())
        self.assertEqual(self.files() if self.root.exists() else [], [])

    def test_weak_or_empty_password_is_refused(self):
        before, people = counts(), users()
        for weak in ("", "12345678", "demo_user"):
            with self.subTest(password=weak):
                with self.assertRaises(CommandError) as raised:
                    run_command("--moderator-password", PASSWORDS[MODERATOR], "--user-password", weak)
                self.assertIn("demo_user", str(raised.exception))
                self.assertNotIn(PASSWORDS[MODERATOR], str(raised.exception))
                with self.assertRaises(demo.DemoError):
                    demo.seed_demo(moderator_password=PASSWORDS[MODERATOR], user_password=weak)
        self.assertEqual((counts(), users()), (before, people))
        self.assertFalse(self.root.exists())

    def test_refuses_a_non_test_database(self):
        before, people = counts(), users()
        for name in ("checkist_dev", "checkist"):
            with patch.dict(settings.DATABASES["default"], {"NAME": name}), self.assertRaises(CommandError):
                run_command(*ARGUMENTS)
            with patch.dict(settings.DATABASES["default"], {"NAME": name}), self.assertRaises(demo.DemoError):
                seed()
        self.assertEqual((counts(), users()), (before, people))
        self.assertFalse(self.root.exists())

    def test_repeated_call_is_refused_and_changes_nothing(self):
        seed()
        before, people, files = counts(), users(), self.files()
        with self.assertRaises(CommandError) as raised:
            run_command("--moderator-password", "Another-Password-55-x", "--user-password", "Another-Password-66-y")
        self.assertIn("empty", str(raised.exception))
        with self.assertRaises(demo.DemoError):
            seed()
        self.assertEqual((counts(), users(), self.files()), (before, people, files))

    def test_refuses_a_database_with_other_data(self):
        # Чужие демо в той же базе: каталог и чеки уже есть.
        call_command("seed_product_merge_demo", stdout=io.StringIO())
        before, people = counts(), users()
        with self.assertRaises(CommandError):
            run_command(*ARGUMENTS)
        self.assertEqual((counts(), users()), (before, people))
        self.assertFalse(self.root.exists())

    def test_refuses_when_a_demo_username_is_taken(self):
        User.objects.create_user("demo_user")
        people = users()
        with self.assertRaises(demo.DemoError):
            seed()
        self.assertEqual(users(), people)
        self.assertEqual(counts(), dict.fromkeys(counts(), 0))
        self.assertFalse(self.root.exists())

    def test_failure_after_the_files_leaves_nothing(self):
        people = users()
        for error in (services.MergeBusy(services.MergeBusy.code), RuntimeError("synthetic")):
            expected = demo.DemoError if isinstance(error, services.MergeBusy) else RuntimeError
            with self.subTest(error=type(error).__name__):
                with patch.object(services, "detect", side_effect=error), self.assertRaises(expected):
                    seed()
                self.assertEqual(counts(), dict.fromkeys(counts(), 0))
                self.assertEqual(users(), people)
                self.assertEqual([path for path in self.root.rglob("*")], [])
        # После отказа база по-прежнему пуста, и демо создаётся.
        self.assertTrue(seed()["created"])


@tag("integration")
@accounts_mode()
class HttpTests(MediaRootMixin, TestCase):
    """То, ради чего демо: в режиме ``accounts`` каждый видит своё, а общее — оба."""

    def setUp(self):
        super().setUp()
        self.ids = seed()
        self.clients = {}
        for role in (MODERATOR, USER):
            self.clients[role] = APIClient()
            # Вход паролем, а не ``force_login``: пароли из аргументов действительно рабочие.
            self.assertTrue(self.clients[role].login(username=demo.USERNAMES[role], password=PASSWORDS[role]))

    def get(self, role, url):
        response = self.clients[role].get(url)
        self.assertEqual(response.status_code, 200, response.content)
        return response.json()

    def other(self, role):
        return USER if role == MODERATOR else MODERATOR

    def test_me_tells_the_moderator_apart(self):
        for role, moderates in ((MODERATOR, True), (USER, False)):
            me = self.get(role, "/api/me/")
            self.assertEqual(me["mode"], "accounts")
            self.assertEqual(me["user"], {**self.ids["users"][role], "is_staff": False})
            self.assertEqual(me["permissions"], {"moderate_catalog": moderates})

    def test_receipts_do_not_overlap(self):
        for role in (MODERATOR, USER):
            page = self.get(role, "/api/receipts/")
            self.assertEqual([row["id"] for row in page["results"]], [self.ids["receipt_ids"][role]])
            foreign = self.clients[role].get(f"/api/receipts/{self.ids['receipt_ids'][self.other(role)]}/")
            self.assertEqual((foreign.status_code, foreign.json()), (404, NOT_FOUND))

    def test_shared_price_history_marks_own_and_foreign(self):
        url = f"/api/products/{self.ids['shared_product_id']}/prices/"
        for role in (MODERATOR, USER):
            points = self.get(role, url)["results"]
            self.assertEqual(len(points), 2)
            self.assertEqual(
                sorted((point["own"], point["receipt_id"]) for point in points),
                [(False, None), (True, self.ids["receipt_ids"][role])],
            )
        for role in (MODERATOR, USER):
            own = self.get(role, f"/api/products/{self.ids['own_product_ids'][role]}/prices/")["results"]
            self.assertEqual([point["own"] for point in own], [True])
            foreign = self.get(role, f"/api/products/{self.ids['own_product_ids'][self.other(role)]}/prices/")
            self.assertEqual([point["own"] for point in foreign["results"]], [False])

    def test_merge_lines_by_reader(self):
        merge = self.ids["merge"]
        url = f"/api/product-merges/{merge['group_id']}/lines/"
        rows = {row["line_id"]: row["receipt_id"] for row in self.get(MODERATOR, url)["results"]}
        self.assertEqual(rows, {
            merge["line_ids"][MODERATOR][0]: self.ids["receipt_ids"][MODERATOR], merge["line_ids"][USER][0]: None,
        })
        rows = {row["line_id"]: row["receipt_id"] for row in self.get(USER, url)["results"]}
        self.assertEqual(rows, {merge["line_ids"][USER][0]: self.ids["receipt_ids"][USER]})

    def test_only_the_moderator_may_change_merges(self):
        client = with_csrf(self.clients[USER])
        response = client.post("/api/product-merges/detect/", {}, format="json")
        self.assertEqual(response.status_code, 403, response.content)
        self.assertEqual(response.json()["error"]["code"], "permission_denied")
        self.assertEqual(ProductMerge.objects.get().status, "pending")

    def test_statistics_differ(self):
        totals = {
            role: [
                (block["currency"], block["totals"]["receipts_count"], block["totals"]["receipts_total"])
                for block in self.get(role, "/api/stats/spending/")["currencies"]
            ]
            for role in (MODERATOR, USER)
        }
        self.assertEqual(totals, {MODERATOR: [("EUR", 1, "6.66")], USER: [("EUR", 1, "7.74")]})

    def test_recognition_lists_are_own(self):
        for role in (MODERATOR, USER):
            media = self.ids["media"][role]
            photos = self.get(role, "/api/recognition/photos/")["results"]
            self.assertEqual([photo["id"] for photo in photos], [media["photo_id"]])
            self.assertEqual(photos[0]["original_url"], f"/media/{media['original']}")
            self.assertEqual(photos[0]["preview_url"], f"/media/{media['prepared']}")
            job = self.get(role, f"/api/recognition/jobs/{media['job_id']}/")
            self.assertEqual((job["status"], job["photo_id"]), ("succeeded", media["photo_id"]))
            image = self.get(role, f"/api/recognition/receipt-images/{media['image_id']}/")
            self.assertEqual(
                (image["status"], image["receipt_id"], image["image_url"]),
                ("imported", self.ids["receipt_ids"][role], f"/media/{media['crop']}"),
            )
            foreign = self.ids["media"][self.other(role)]
            for url in (f"/api/recognition/jobs/{foreign['job_id']}/",
                        f"/api/recognition/receipt-images/{foreign['image_id']}/"):
                self.assertEqual(self.clients[role].get(url).status_code, 404, url)

    def test_media_goes_to_the_owner_only(self):
        for role in (MODERATOR, USER):
            for key in ("original", "prepared", "crop"):
                with self.subTest(role=role, key=key):
                    own = self.clients[role].get(f"/media/{self.ids['media'][role][key]}")
                    self.assertEqual(own.status_code, 200)
                    self.assertEqual(body(own), (self.root / self.ids["media"][role][key]).read_bytes())
                    foreign = self.clients[role].get(f"/media/{self.ids['media'][self.other(role)][key]}")
                    self.assertEqual((foreign.status_code, body(foreign)), (404, b""))
                    anonymous = APIClient().get(f"/media/{self.ids['media'][role][key]}")
                    self.assertEqual((anonymous.status_code, body(anonymous)), (404, b""))
