"""MEDIA по владельцу: свой файл отдаётся, всё остальное — один и тот же пустой 404.

Маршрут ``/media/`` подключён без условия ``DEBUG``; правило выбирает режим. MEDIA
временный, файлы и пользователи вымышленные.
"""
import tempfile
import uuid
from pathlib import Path

from django.test import TestCase, override_settings, tag
from rest_framework.test import APIClient

from api.tests.accounts_helpers import TwoUsers, accounts_mode, make_user, signed_in
from config.robots import NOINDEX
from receipts.ownership import local_user
from recognition.models import SourcePhoto
from recognition.tests.test_models import make_photo

CACHE_CONTROL = "private, no-store"
OWN_BYTES = b"\x89PNG synthetic own"
FOREIGN_BYTES = b"\x89PNG synthetic foreign"
DEMO_BYTES = b"\x89PNG synthetic demo"
OUTSIDE_BYTES = b"synthetic file outside MEDIA_ROOT"


def body(response):
    """Тело ответа; файл закрывается, иначе временный каталог на Windows не удалить.

    Свой ``response.close()`` здесь не нужен и вреден: обычный ответ тестовый клиент уже
    закрыл, потоковый закрывает сам, когда тело дочитано до конца (в том числе пустое тело
    HEAD), — и оба раза без ``close_old_connections``. Повторное закрытие послало бы
    ``request_finished`` с этим обработчиком, а он внутри ``TestCase`` (autocommit
    выключен) закрывает соединение теста.
    """
    return b"".join(response.streaming_content) if response.streaming else response.content


def refusal(response):
    """Всё, чем один отказ мог бы отличаться от другого: статус, тело и все заголовки."""
    return response.status_code, body(response), sorted(response.headers.items())


class MediaMixin(TwoUsers):
    def setUp(self):
        super().setUp()
        directory = tempfile.TemporaryDirectory(prefix="checkist-media-access-test-")
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name) / "media"
        self.root.mkdir()
        override = override_settings(MEDIA_ROOT=str(self.root))
        override.enable()
        self.addCleanup(override.disable)

        self.own = self.photo(self.first, OWN_BYTES)
        self.foreign = self.photo(self.second, FOREIGN_BYTES)
        self.write("demo/single.png", DEMO_BYTES)
        (self.root.parent / "outside.txt").write_bytes(OUTSIDE_BYTES)

    def write(self, name, content):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content)
        return name

    def photo(self, owner, content):
        """Фото владельца и по файлу в каждом каталоге, как их раскладывает recognition.storage."""
        storage_uuid = uuid.uuid4()
        original = self.write(f"originals/{storage_uuid}/source.png", content)
        make_photo(owner, storage_uuid=storage_uuid, original_file=original)
        return {
            "uuid": str(storage_uuid),
            "originals": original,
            "prepared": self.write(f"prepared/{storage_uuid}/{uuid.uuid4()}/upright-v1.png", content),
            "crops": self.write(f"crops/{storage_uuid}/1/1-{uuid.uuid4()}/crop.png", content),
        }

    def assert_served(self, response, content):
        self.assertEqual(response.status_code, 200)
        self.assertEqual(body(response), content)
        self.assertEqual(response["Content-Type"], "image/png")
        self.assertEqual(response["Cache-Control"], CACHE_CONTROL)
        self.assertEqual(response["X-Robots-Tag"], NOINDEX)

    def assert_refused(self, response):
        self.assertEqual(response.status_code, 404)
        self.assertEqual(response["Content-Type"], "text/plain")
        self.assertEqual(response["Cache-Control"], CACHE_CONTROL)
        self.assertEqual(response["X-Robots-Tag"], NOINDEX)
        self.assertEqual(body(response), b"")


@tag("integration")
@accounts_mode()
class MediaAccessTests(MediaMixin, TestCase):
    def refused_paths(self):
        own, foreign = self.own["uuid"], self.foreign["uuid"]
        missing = uuid.uuid4()
        self.write(f"other/{own}/source.png", OWN_BYTES)
        return {
            "чужой оригинал": self.foreign["originals"],
            "чужой подготовленный": self.foreign["prepared"],
            "чужая вырезка": self.foreign["crops"],
            "нет файла у своего фото": f"originals/{own}/absent.png",
            "нет такого фото": f"originals/{missing}/source.png",
            "демо": "demo/single.png",
            "нет файла вне каталогов фото": "no-such-file.jpg",
            "другой первый сегмент": f"other/{own}/source.png",
            "каталог своего фото": f"originals/{own}",
            "каталог своего фото со слэшем": f"originals/{own}/",
            "каталог внутри своего фото": str(Path(self.own["crops"]).parent.as_posix()),
            "UUID заглавными": f"originals/{own.upper()}/source.png",
            "UUID без дефисов": f"originals/{own.replace('-', '')}/source.png",
            "UUID в скобках": f"originals/{{{own}}}/source.png",
            "не UUID": "originals/test/source.png",
            "из своего каталога в чужой": f"originals/{own}/../{foreign}/source.png",
            "из своего каталога в демо": f"originals/{own}/../../demo/single.png",
            "из своего каталога наружу": f"originals/{own}/../../../outside.txt",
            "наружу от корня": "../outside.txt",
            "закодированные точки": f"originals/{own}/%2e%2e/{foreign}/source.png",
            "точка в пути": f"originals/{own}/./source.png",
            "пустой сегмент": f"originals//{own}/source.png",
            "обратный слэш": f"originals/{own}/..%5C{foreign}%5Csource.png",
            "обратный слэш вместо прямого": f"originals%5C{own}%5Csource.png",
            "двоеточие": f"originals/{own}/source.png::$DATA",
        }

    def test_owner_gets_own_files_from_every_directory(self):
        for debug in (False, True):
            for directory in ("originals", "prepared", "crops"):
                with self.subTest(debug=debug, directory=directory), override_settings(DEBUG=debug):
                    self.assert_served(
                        self.client_of(self.first).get(f"/media/{self.own[directory]}"), OWN_BYTES)
        self.assert_served(self.client_of(self.second).get(f"/media/{self.foreign['crops']}"), FOREIGN_BYTES)

    def test_head_of_own_file_has_no_body(self):
        response = self.client_of(self.first).head(f"/media/{self.own['originals']}")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(body(response), b"")
        self.assertEqual(response["Cache-Control"], CACHE_CONTROL)
        self.assertEqual(response["X-Robots-Tag"], NOINDEX)

    def test_every_refusal_of_signed_in_user_is_the_same_empty_404(self):
        client = self.client_of(self.first)
        paths = self.refused_paths()
        for debug in (False, True):
            with override_settings(DEBUG=debug):
                expected = refusal(client.get(f"/media/originals/{uuid.uuid4()}/source.png"))
                for name, path in paths.items():
                    with self.subTest(debug=debug, case=name):
                        response = client.get(f"/media/{path}")
                        self.assert_refused(response)
                        self.assertEqual(refusal(response), expected)
                    with self.subTest(debug=debug, case=name, method="HEAD"):
                        self.assert_refused(client.head(f"/media/{path}"))

    def test_anonymous_gets_the_same_empty_404_for_everything(self):
        paths = {
            **self.refused_paths(),
            "оригинал первого": self.own["originals"],
            "подготовленный первого": self.own["prepared"],
            "вырезка первого": self.own["crops"],
        }
        for debug in (False, True):
            with override_settings(DEBUG=debug):
                expected = refusal(APIClient().get(f"/media/originals/{uuid.uuid4()}/source.png"))
                for name, path in paths.items():
                    with self.subTest(debug=debug, case=name):
                        response = APIClient().get(f"/media/{path}")
                        self.assert_refused(response)
                        self.assertEqual(refusal(response), expected)

    def test_anonymous_request_makes_no_queries(self):
        with self.assertNumQueries(0):
            self.assert_refused(APIClient().get(f"/media/{self.own['originals']}"))

    def test_moderator_and_staff_do_not_see_foreign_files(self):
        superuser = make_user("synthetic-superuser", is_staff=True, is_superuser=True)
        for account in (self.moderator, superuser):
            for directory in ("originals", "prepared", "crops"):
                with self.subTest(account=account.username, directory=directory):
                    self.assert_refused(signed_in(account).get(f"/media/{self.own[directory]}"))

    def test_deactivated_user_with_live_session_is_refused(self):
        client = self.client_of(self.first)
        self.assert_served(client.get(f"/media/{self.own['originals']}"), OWN_BYTES)
        self.first.is_active = False
        self.first.save(update_fields=["is_active"])
        self.assert_refused(client.get(f"/media/{self.own['originals']}"))

    def test_file_follows_the_owner_of_the_photo(self):
        """Решает запись фото, а не то, кто просит: после смены владельца файл виден новому."""
        SourcePhoto.objects.filter(storage_uuid=self.own["uuid"]).update(owner=self.second)
        self.assert_refused(self.client_of(self.first).get(f"/media/{self.own['prepared']}"))
        self.assert_served(self.client_of(self.second).get(f"/media/{self.own['prepared']}"), OWN_BYTES)

    def test_other_methods_answer_alike_for_own_and_foreign(self):
        client = self.client_of(self.first)
        for method in ("post", "put", "patch", "delete"):
            with self.subTest(method=method):
                own = getattr(client, method)(f"/media/{self.own['originals']}")
                foreign = getattr(client, method)(f"/media/{self.foreign['originals']}")
                self.assertEqual(own.status_code, 405)
                self.assertEqual(own["Allow"], "GET, HEAD")
                self.assertEqual(own["X-Robots-Tag"], NOINDEX)
                self.assertEqual(refusal(own), refusal(foreign))
        self.assertEqual((self.root / self.own["originals"]).read_bytes(), OWN_BYTES)


@tag("integration")
@override_settings(CHECKIST_AUTH_MODE="local_single")
class MediaLocalSingleTests(MediaMixin, TestCase):
    """``local_single``: как при ``static()`` — любой файл под MEDIA_ROOT, пока включён DEBUG."""

    def test_debug_serves_any_file_without_sign_in(self):
        self.write("originals/test/source.png", OWN_BYTES)
        local = self.photo(local_user(), OWN_BYTES)
        paths = {
            self.foreign["originals"]: FOREIGN_BYTES, self.own["crops"]: OWN_BYTES,
            local["prepared"]: OWN_BYTES, "demo/single.png": DEMO_BYTES,
            "originals/test/source.png": OWN_BYTES,
        }
        with override_settings(DEBUG=True):
            for path, content in paths.items():
                with self.subTest(path=path), self.assertNumQueries(0):
                    self.assert_served(APIClient().get(f"/media/{path}"), content)

    def test_without_debug_nothing_is_served(self):
        local = self.photo(local_user(), OWN_BYTES)
        with override_settings(DEBUG=False):
            for path in (local["originals"], self.own["originals"], "demo/single.png", "no-such-file.jpg"):
                with self.subTest(path=path), self.assertNumQueries(0):
                    self.assert_refused(APIClient().get(f"/media/{path}"))
                with self.subTest(path=path, signed_in=True):
                    self.assert_refused(self.client_of(self.first).get(f"/media/{path}"))

    def test_debug_refuses_missing_files_and_paths_out_of_the_root(self):
        own, foreign = self.own["uuid"], self.foreign["uuid"]
        paths = (
            "no-such-file.jpg", f"originals/{own}/absent.png", f"originals/{own}", "demo/",
            "../outside.txt", f"originals/{own}/../../../outside.txt", "demo/%2e%2e/%2e%2e/outside.txt",
            f"originals/{own}/../{foreign}/source.png", "demo//single.png", "demo%5Csingle.png",
            "..%5Coutside.txt", "demo/single.png::$DATA",
        )
        with override_settings(DEBUG=True):
            expected = refusal(APIClient().get("/media/no-such-file.png"))
            for path in paths:
                with self.subTest(path=path):
                    response = APIClient().get(f"/media/{path}")
                    self.assert_refused(response)
                    self.assertEqual(refusal(response), expected)
