"""Значок категории (2026-10-13): наследование, значки миграции по словам названия, смена — только модератор.

Категории вымышленные; модель не вызывается.
"""
import importlib
from types import SimpleNamespace

from django.apps import apps
from django.test import SimpleTestCase, TestCase, tag
from rest_framework.test import APIClient

from api.common import CategoryTree
from api.tests.accounts_helpers import (
    NOT_AUTHENTICATED, NOT_FOUND, PERMISSION_DENIED, TwoUsers, accounts_mode, local_single_mode,
)
from catalog.models import Category, CategoryIcon

migration = importlib.import_module("catalog.migrations.0005_category_icon")


def url(pk):
    return f"/api/categories/{pk}/icon/"


class TreeIconTests(SimpleTestCase):
    def test_own_icon_or_of_the_nearest_ancestor(self):
        tree = CategoryTree([(1, "Еда", None, "cart"), (2, "Молочное", 1, ""), (3, "Сыры", 2, ""),
                             (4, "Здоровье", 1, "heart"), (5, "Аптека", 4, ""), (6, "Прочее", None, "")])
        self.assertEqual([tree.icon(pk) for pk in range(1, 7)], ["cart", "cart", "cart", "heart", "heart", None])
        self.assertEqual([tree.own_icon(pk) for pk in (1, 2, 6)], ["cart", None, None])

    def test_rows_without_icons_and_a_cycle(self):
        self.assertIsNone(CategoryTree([(1, "Еда", None)]).icon(1))
        tree = CategoryTree([(1, "А", 2, "bus"), (2, "Б", 1, "")])
        self.assertEqual((tree.icon(1), tree.icon(2)), ("bus", None))


class MigrationRulesTests(SimpleTestCase):
    def test_names_of_the_server_and_other_spellings(self):
        names = {
            "Еда и напитки": "cart", "Продукты питания": "cart", "Транспорт": "bus", "Такси": "bus",
            "Кафе и рестораны": "dining", "Жильё": "home", "Коммунальные платежи": "home", "Связь и подписки": "phone",
            "Интернет": "phone", "Здоровье": "heart", "Одежда": "shirt", "Развлечения": "ticket", "Подарки": "gift",
            "Дети": "baby", "Покупки онлайн": "box", "Банк и комиссии": "bank", "Красота и уход": "beauty",
            "Домашние животные": "paw", "Автомобиль": "car", "Путешествия": "plane", "Образование": "book",
            "Прочее": "", "Электроника": "",
        }
        self.assertEqual({name: migration.icon_for(name) for name in names}, names)
        self.assertEqual(migration.icon_for("ЕДА"), "cart")
        self.assertTrue({icon for icon, _ in migration.RULES} <= set(CategoryIcon.values))


@tag("integration")
class MigrationDataTests(TestCase):
    def test_only_empty_roots_get_an_icon(self):
        food = Category.objects.create(name="Демо-продукты")
        dairy = Category.objects.create(name="Демо-продукты молочные", parent=food)
        chosen = Category.objects.create(name="Демо-такси", icon="car")
        other = Category.objects.create(name="Демо-разное")
        migration.seed(apps, SimpleNamespace(connection=SimpleNamespace(alias="default")))
        icons = dict(Category.objects.filter(pk__in=[food.pk, dairy.pk, chosen.pk, other.pk]).values_list("pk", "icon"))
        self.assertEqual(icons, {food.pk: "cart", dairy.pk: "", chosen.pk: "car", other.pk: ""})


class IconMixin:
    @classmethod
    def setUpTestData(cls):
        super().setUpTestData()
        cls.food = Category.objects.create(name="Демо-еда", icon="cart")
        cls.dairy = Category.objects.create(name="Демо-молочное", parent=cls.food)


@tag("integration")
@local_single_mode()
class IconApiTests(IconMixin, TestCase):
    def post(self, pk, body, status=200):
        response = APIClient().post(url(pk), body, format="json")
        self.assertEqual(response.status_code, status, response.content)
        return response.json()

    def test_read_set_and_inherit(self):
        self.assertEqual(APIClient().get(url(self.dairy.pk)).json(), {"id": self.dairy.pk, "icon": "cart", "own_icon": None})
        self.assertEqual(self.post(self.dairy.pk, {"icon": "heart"}), {"id": self.dairy.pk, "icon": "heart", "own_icon": "heart"})
        self.assertEqual(APIClient().get(url(self.dairy.pk)).json(), {"id": self.dairy.pk, "icon": "heart", "own_icon": "heart"})
        self.assertEqual(self.post(self.dairy.pk, {"icon": None}), {"id": self.dairy.pk, "icon": "cart", "own_icon": None})
        self.assertEqual(self.post(self.food.pk, {"icon": ""}), {"id": self.food.pk, "icon": None, "own_icon": None})
        self.assertEqual(Category.objects.get(pk=self.food.pk).icon, "")

    def test_refusals(self):
        cases = [
            ({"icon": "rocket"}, {"icon": ["Неизвестный значок."]}),
            ({"icon": False}, {"icon": ["Неизвестный значок."]}),
            ({}, {"icon": ["Обязательное поле."]}),
            ({"icon": "cart", "name": "x"}, {"name": ["Неизвестное поле."]}),
        ]
        for body, fields in cases:
            with self.subTest(body=body):
                self.assertEqual(self.post(self.dairy.pk, body, 400)["error"]["fields"], fields)
        self.assertEqual(self.post(999999999, {"icon": "cart"}, 404), NOT_FOUND)
        self.assertEqual(APIClient().get(url(999999999)).json(), NOT_FOUND)
        self.assertEqual(Category.objects.get(pk=self.dairy.pk).icon, "")


@tag("integration")
@accounts_mode()
class IconAccountsTests(IconMixin, TwoUsers, TestCase):
    def test_only_a_moderator_changes_the_icon(self):
        self.assertEqual(APIClient().get(url(self.food.pk)).json(), NOT_AUTHENTICATED)
        self.assertEqual(APIClient().post(url(self.food.pk), {"icon": "bus"}, format="json").json(), NOT_AUTHENTICATED)
        self.assertEqual(self.client_of(self.first).get(url(self.food.pk)).json()["icon"], "cart")
        refused = self.client_of(self.first, csrf=True).post(url(self.food.pk), {"icon": "bus"}, format="json")
        self.assertEqual((refused.status_code, refused.json()), (403, PERMISSION_DENIED))
        self.assertEqual(Category.objects.get(pk=self.food.pk).icon, "cart")
        done = self.client_of(self.moderator, csrf=True).post(url(self.food.pk), {"icon": "bus"}, format="json")
        self.assertEqual((done.status_code, done.json()["icon"]), (200, "bus"))

    def test_csrf_is_required(self):
        client = APIClient(enforce_csrf_checks=True)
        client.force_login(self.moderator)
        self.assertEqual(client.post(url(self.food.pk), {"icon": "bus"}, format="json").json()["error"]["code"], "csrf_failed")
