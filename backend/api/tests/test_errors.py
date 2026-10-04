from unittest.mock import patch

from django.core.exceptions import PermissionDenied as DjangoPermissionDenied
from django.core import exceptions as django_exceptions
from django.http import Http404, UnreadablePostError
from django.http.multipartparser import MultiPartParserError
from django.test import SimpleTestCase, override_settings
from django.urls import path
from rest_framework import exceptions
from rest_framework.authentication import BasicAuthentication
from rest_framework.response import Response
from rest_framework.test import APIClient
from rest_framework.views import APIView

from api.views.base import ReadOnlyAPIView
from config.exceptions import InvalidParameter, ObjectNotFound, PageOutOfRange, RangeTooLarge

SECRET = "postgres://internal-host:5432/password-secret traceback"
INVALID = {"code": "invalid_parameter", "message": "Некорректные параметры запроса."}
NOT_FOUND = {"code": "not_found", "message": "Не найдено."}
FORBIDDEN = {"code": "permission_denied", "message": "Доступ запрещён."}


def raising(exception, base=ReadOnlyAPIView, **attributes):
    def get(self, request):
        raise exception

    return type("RaisingView", (base,), {"get": get, **attributes}).as_view()


class OkView(ReadOnlyAPIView):
    def get(self, request):
        return Response({"ok": True})


class ProtectedView(APIView):
    """Без явных классов доступа: действует глобальная ``IsAuthenticated``."""

    def get(self, request):
        return Response({"ok": True})


urlpatterns = [
    path("ok/", OkView.as_view()),
    path("invalid/", raising(InvalidParameter({"date_from": ["Ожидается дата ГГГГ-ММ-ДД."]}))),
    path("range/", raising(RangeTooLarge())),
    path("missing/", raising(ObjectNotFound())),
    path("page/", raising(PageOutOfRange())),
    path("http404/", raising(Http404(SECRET))),
    path("drf-not-found/", raising(exceptions.NotFound(SECRET))),
    path("drf-validation/", raising(exceptions.ValidationError({"name": ["Обязательное поле."], "size": "Мало."}))),
    path("drf-validation-list/", raising(exceptions.ValidationError([SECRET]))),
    path("drf-parse/", raising(exceptions.ParseError(SECRET))),
    path("drf-media-type/", raising(exceptions.UnsupportedMediaType(SECRET))),
    path("drf-denied/", raising(exceptions.PermissionDenied(SECRET))),
    path("django-denied/", raising(DjangoPermissionDenied(SECRET))),
    path("protected/", ProtectedView.as_view()),
    path("protected-basic/", type("BasicView", (ProtectedView,), {"authentication_classes": [BasicAuthentication]}).as_view()),
    path("throttled/", raising(exceptions.Throttled(wait=7))),
    path("crash/", raising(RuntimeError(SECRET))),
    path("api-crash/", raising(exceptions.APIException(SECRET))),
    path("value-crash/", raising(ValueError(SECRET))),
    path("lookup-crash/", raising(LookupError(SECRET))),
    path("unicode-crash/", raising(UnicodeDecodeError("utf-8", b"\xff", 0, 1, SECRET))),
]


REQUEST_ERRORS = tuple(
    cls for cls in vars(django_exceptions).values()
    if isinstance(cls, type) and issubclass(cls, (django_exceptions.SuspiciousOperation, django_exceptions.BadRequest))
) + (UnreadablePostError, MultiPartParserError)
urlpatterns += [path(f"request-error-{index}/", raising(cls(SECRET))) for index, cls in enumerate(REQUEST_ERRORS)]


@override_settings(ROOT_URLCONF=__name__)
class ErrorFormatTests(SimpleTestCase):
    def setUp(self):
        self.client = APIClient()

    def assert_error(self, response, status_code, error):
        self.assertEqual(response.status_code, status_code)
        self.assertEqual(response["Content-Type"], "application/json")
        self.assertEqual(response.json(), {"error": error})
        self.assertNotIn("secret", response.content.decode())

    def test_invalid_parameter_has_fields(self):
        self.assert_error(self.client.get("/invalid/"), 400, {
            **INVALID, "fields": {"date_from": ["Ожидается дата ГГГГ-ММ-ДД."]},
        })

    def test_range_too_large(self):
        self.assert_error(self.client.get("/range/"), 400, {
            "code": "range_too_large",
            "message": "Слишком большой диапазон: сузьте даты или укрупните интервал.",
        })

    def test_not_found_from_api_django_and_drf(self):
        for url in ("/missing/", "/http404/", "/drf-not-found/"):
            with self.subTest(url=url):
                self.assert_error(self.client.get(url), 404, NOT_FOUND)

    def test_page_out_of_range(self):
        self.assert_error(self.client.get("/page/"), 404, {
            "code": "page_out_of_range", "message": "Страница за пределами диапазона.",
        })

    def test_drf_validation_error_keeps_field_messages(self):
        self.assert_error(self.client.get("/drf-validation/"), 400, {
            **INVALID, "fields": {"name": ["Обязательное поле."], "size": ["Мало."]},
        })

    def test_drf_400_without_fields_does_not_leak_detail(self):
        for url in ("/drf-validation-list/", "/drf-parse/"):
            with self.subTest(url=url):
                self.assert_error(self.client.get(url), 400, INVALID)

    def test_415_without_media_type_detail(self):
        self.assert_error(self.client.get("/drf-media-type/"), 415, {
            "code": "unsupported_media_type", "message": "Тип содержимого не поддерживается.",
        })

    def test_permission_denied_from_drf_and_django(self):
        for url in ("/drf-denied/", "/django-denied/"):
            with self.subTest(url=url):
                self.assert_error(self.client.get(url), 403, FORBIDDEN)

    def test_global_permission_still_requires_authentication(self):
        # Умолчания DRF: первой идёт SessionAuthentication без WWW-Authenticate, поэтому 403.
        self.assert_error(self.client.get("/protected/"), 403, FORBIDDEN)

    def test_unauthenticated_is_401_with_challenge(self):
        response = self.client.get("/protected-basic/")
        self.assert_error(response, 401, {"code": "not_authenticated", "message": "Требуется вход."})
        self.assertEqual(response["WWW-Authenticate"], 'Basic realm="api"')

    def test_invalid_credentials_are_401_without_detail(self):
        response = self.client.get("/protected-basic/", HTTP_AUTHORIZATION="Basic !!!")
        self.assert_error(response, 401, {"code": "not_authenticated", "message": "Требуется вход."})

    def test_write_methods_are_405(self):
        for method in ("post", "put", "patch", "delete"):
            with self.subTest(method=method):
                response = getattr(self.client, method)("/ok/")
                self.assert_error(response, 405, {
                    "code": "method_not_allowed", "message": "Метод не поддерживается.",
                })
                self.assertEqual(response["Allow"], "GET, HEAD, OPTIONS")

    def test_incompatible_accept_is_406(self):
        self.assert_error(self.client.get("/ok/", HTTP_ACCEPT="text/html"), 406, {
            "code": "not_acceptable", "message": "Доступен только JSON.",
        })

    def test_other_statuses_below_500_keep_drf_format(self):
        response = self.client.get("/throttled/")
        self.assertEqual(response.status_code, 429)
        self.assertEqual(set(response.json()), {"detail"})
        self.assertEqual(response["Retry-After"], "7")

    def test_500_has_no_exception_text_even_in_debug(self):
        for debug in (True, False):
            for url in ("/crash/", "/api-crash/", "/value-crash/", "/lookup-crash/", "/unicode-crash/"):
                with self.subTest(debug=debug, url=url), override_settings(DEBUG=debug):
                    self.assert_error(self.client.get(url), 500, {
                        "code": "internal_error", "message": "Внутренняя ошибка сервера.",
                    })

    def test_django_request_errors_are_safe_400_even_in_debug(self):
        for debug in (False, True):
            for index, cls in enumerate(REQUEST_ERRORS):
                with self.subTest(debug=debug, exception=cls.__name__), override_settings(DEBUG=debug):
                    self.assert_error(self.client.get(f"/request-error-{index}/"), 400, {
                        "code": "invalid_request", "message": "Некорректный запрос.",
                    })

    def test_read_only_view_is_anonymous_and_ignores_authorization(self):
        for headers in ({}, {"HTTP_AUTHORIZATION": "Bearer invalid-token"}):
            with self.subTest(headers=headers):
                response = self.client.get("/ok/?unknown=1", **headers)
                self.assertEqual((response.status_code, response.json()), (200, {"ok": True}))


class FallbackRouteTests(SimpleTestCase):
    """Настоящий ``config.urls``: запасной маршрут и health рядом с ним."""

    def setUp(self):
        self.client = APIClient()

    def assert_not_found(self, response):
        self.assertEqual(response.status_code, 404)
        self.assertEqual(response["Content-Type"], "application/json")
        self.assertEqual(response.json(), {"error": NOT_FOUND})

    def test_unknown_path_is_json_404(self):
        for url in ("/api/unknown/", "/api/", "/api/products/1/unknown/", "/api/health/extra/"):
            with self.subTest(url=url):
                self.assert_not_found(self.client.get(url))

    def test_unknown_path_is_404_for_every_method(self):
        for method in ("head", "options", "post", "put", "patch", "delete"):
            with self.subTest(method=method):
                response = getattr(self.client, method)("/api/unknown/")
                self.assertEqual(response.status_code, 404)
                if method != "head":
                    self.assertEqual(response.json(), {"error": NOT_FOUND})

    def test_unknown_path_ignores_query_and_authorization(self):
        self.assert_not_found(self.client.get("/api/unknown/?page=1", HTTP_AUTHORIZATION="Bearer invalid-token"))

    def test_unknown_path_with_html_accept_is_406(self):
        response = self.client.get("/api/unknown/", HTTP_ACCEPT="text/html")
        self.assertEqual(response.status_code, 406)
        self.assertEqual(response.json()["error"]["code"], "not_acceptable")

    def test_health_without_slash_still_redirects(self):
        response = self.client.get("/api/health")
        self.assertEqual(response.status_code, 301)
        self.assertEqual(response["Location"], "/api/health/")

    def test_unknown_path_without_slash_redirects_to_json_404(self):
        response = self.client.get("/api/unknown")
        self.assertEqual((response.status_code, response["Location"]), (301, "/api/unknown/"))
        self.assert_not_found(self.client.get(response["Location"]))

    def test_path_outside_api_is_not_handled_by_fallback(self):
        response = self.client.get("/other/")
        self.assertEqual(response.status_code, 404)
        self.assertNotEqual(response["Content-Type"], "application/json")

    def test_health_route_still_wins(self):
        with (
            patch("health.probes.probe_database", return_value={"status": "ok"}),
            patch("health.probes.probe_redis", return_value={"status": "ok"}),
            patch("health.probes.probe_celery", return_value={"status": "ok"}),
        ):
            response = self.client.get("/api/health/")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["status"], "ok")
        self.assertEqual(response["Cache-Control"], "no-store")
