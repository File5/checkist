"""Ошибки запроса до Params: реальный Django/DRF pipeline, без подмены QueryDict."""
import json
import asyncio
import logging
from io import BytesIO
from types import SimpleNamespace
from unittest.mock import patch

from asgiref.sync import async_to_sync
from django.core.exceptions import RequestDataTooBig
from django.http import UnreadablePostError
from django.core.servers.basehttp import WSGIRequestHandler
from django.core.handlers.wsgi import WSGIRequest

from django.conf import settings
from django.test import RequestFactory, SimpleTestCase, TestCase, TransactionTestCase, override_settings, tag

from api.tests.factories import save_samples
from api.tests.test_query_controls import SEARCH_URLS
from api.params import Params
from config.exceptions import InvalidParameter
from config.requests import ApiCommonMiddleware, SafeApiTargetFilter

INVALID_REQUEST = {"error": {"code": "invalid_request", "message": "Некорректный запрос."}}


class RequestSyntaxTests(SimpleTestCase):
    def test_surrogate_values_are_rejected_before_parameter_parsing(self):
        for name in ("q", "country", "page", "rates"):
            for value in ("\ud800ab", "a\udfffb", "ab\ud800"):
                params = Params({name: value})
                self.assertIsNone(params.raw(name))
                with self.assertRaises(InvalidParameter) as raised:
                    params.check()
                self.assertEqual(raised.exception.fields, {name: ["Недопустимый Unicode."]})

    def test_content_type_constructor_error_is_safe_wsgi_400(self):
        from config.wsgi import application

        for debug in (False, True):
            with self.subTest(debug=debug), override_settings(DEBUG=debug, ALLOWED_HOSTS=["testserver"]):
                environ = RequestFactory().get("/api/unknown/").environ
                environ["CONTENT_TYPE"] = "application/json; x*=private-codec''%ff"
                started = []
                body = b"".join(application(environ, lambda *args: started.append(args)))
                self.assertEqual(started[0][0], "400 Bad Request")
                self.assertEqual(json.loads(body), INVALID_REQUEST)

    def test_charset_cannot_trigger_query_limit_in_wsgi_constructor(self):
        from config.wsgi import application

        for content_type in ("application/json; charset=utf-8", "application/json; charset=base64", "text/plain; charset=latin1"):
            environ = RequestFactory().get("/api/products/").environ
            environ["QUERY_STRING"] = "&".join(["unknown=private-value"] * 1001)
            environ["CONTENT_TYPE"] = content_type
            started = []
            body = b"".join(application(environ, lambda *args: started.append(args)))
            self.assertEqual(started[0][0], "400 Bad Request")
            self.assertEqual(json.loads(body), INVALID_REQUEST)

    def test_invalid_request_asgi_boundary(self):
        from config.asgi import application

        async def send_request(query, path, headers):
            received = asyncio.Queue()
            await received.put({"type": "http.request", "body": b"", "more_body": False})
            sent = []

            async def send(message):
                sent.append(message)

            await application({
                "type": "http", "asgi": {"version": "3.0"}, "http_version": "1.1",
                "method": "GET", "path": path, "query_string": query, "scheme": "http",
                "headers": [(b"host", b"testserver"), *headers], "server": ("testserver", 80),
            }, received.get, send)
            return sent

        for debug in (False, True):
            for query, path, headers in (
                (b"q=\xff", "/api/unknown/", []),
                (b"q=%ed%a0%80", "/api/unknown/", []),
                (b"", "/api/\ud800/", []),
                (b"", "/api/unknown/", [(b"content-type", b"application/json; x*=private-codec''%ff")]),
            ):
                with self.subTest(debug=debug, query=query, path=repr(path)), override_settings(DEBUG=debug, ALLOWED_HOSTS=["testserver"]):
                    sent = async_to_sync(send_request)(query, path, headers)
                    self.assertEqual(sent[0]["status"], 400)
                    self.assertEqual(json.loads(sent[1]["body"]), INVALID_REQUEST)

    def test_accept_parser_codec_errors_are_400(self):
        for value in ("application/json; x*=private-codec''%ff", "application/json; x*=base64''%ff"):
            response = self.client.get("/api/products/", HTTP_ACCEPT=value)
            self.assertEqual((response.status_code, response.json()), (400, INVALID_REQUEST))

    def test_percent_and_invalid_utf8_path_identifiers_are_json_404(self):
        for pk in ("%ff", "%", "%0", "%gg", "%ed%a0%80", "%00", "9" * 5000):
            for path in ("products/{pk}/", "categories/{pk}/", "generic-products/{pk}/"):
                with self.subTest(pk=pk[:30], path=path):
                    response = self.client.get("/api/" + path.format(pk=pk))
                    self.assertEqual(response.status_code, 404)
                    self.assertEqual(response.json(), {"error": {"code": "not_found", "message": "Не найдено."}})

    def test_body_stream_is_not_read_on_get_or_405(self):
        from config.wsgi import application

        for method, expected in (("get", 404), ("post", 405), ("put", 405), ("patch", 405), ("delete", 405)):
            environ = getattr(RequestFactory(), method)("/api/unknown/" if method == "get" else "/api/products/").environ
            stream = environ["wsgi.input"]
            environ["CONTENT_TYPE"] = "multipart/form-data; boundary=broken"
            environ["CONTENT_LENGTH"] = str(settings.DATA_UPLOAD_MAX_MEMORY_SIZE + 1)
            with patch.object(stream, "read", side_effect=UnreadablePostError("private-value")) as read:
                started = []
                b"".join(application(environ, lambda *args: started.append(args)))
            read.assert_not_called()
            self.assertEqual(int(started[0][0].split()[0]), expected)

    def test_request_errors_outside_drf_are_safe_but_internal_errors_propagate(self):
        middleware = ApiCommonMiddleware(lambda request: None)
        request = RequestFactory().get("/api/products/")
        response = middleware.process_exception(request, RequestDataTooBig("private-value"))
        self.assertEqual((response.status_code, json.loads(response.content)), (400, INVALID_REQUEST))
        self.assertIsNone(middleware.process_exception(request, RuntimeError("private-value")))
        request = RequestFactory().get("/other/")
        self.assertIsNone(middleware.process_exception(request, RequestDataTooBig("private-value")))

    def test_api_access_log_redacts_target(self):
        record = logging.LogRecord("django.server", logging.INFO, "", 0, '"%s" %s %s', (
            "GET /api/products/123/?unknown=private-value HTTP/1.1", "400", "99",
        ), None)
        SafeApiTargetFilter().filter(record)
        self.assertEqual(record.getMessage(), '"GET /api/[redacted] HTTP/1.1" 400 99')

    def test_api_access_log_decodes_path_once_like_runserver(self):
        for path in ("/api", "/api/products/", "/%61pi/products/", "/api%2Fproducts/", "/api%2fproducts/", "//api/products/", "///%61pi/products/"):
            for query in ("", "?", "?unknown=review-private-marker", "?q=%00review-private-marker"):
                with self.subTest(path=path, query=query):
                    record = self.access_record(f"GET {path}{query} HTTP/1.1")
                    self.assertTrue(SafeApiTargetFilter().filter(record))
                    self.assertEqual(record.getMessage(), '"GET /api/[redacted] HTTP/1.1" 400 99')
                    self.assertNotIn("review-private-marker", record.getMessage())

    def test_api_access_log_preserves_known_non_api_paths(self):
        for path in ("/other/", "/apiculture/", "/API/products/", "/%2561pi/products/", "/api%252Fproducts/", "/./api/products/", "/%2Fapi/products/"):
            for query in ("", "?unknown=review-private-marker"):
                with self.subTest(path=path, query=query):
                    line = f"GET {path}{query} HTTP/1.1"
                    record = self.access_record(line)
                    self.assertTrue(SafeApiTargetFilter().filter(record))
                    self.assertEqual(record.getMessage(), f'"{line}" 400 99')

    def test_api_access_log_redacts_uncertain_targets_without_raising(self):
        for path in ("/%", "/%0", "/%gg", "/%ff", "/%c0%80", "/%ed%a0%80", "/\ud800", "", "*", "relative", "http://localhost/%61pi/products/", "http://[broken/api/"):
            with self.subTest(path=repr(path)):
                record = self.access_record(f"GET {path}?unknown=review-private-marker HTTP/1.1")
                self.assertTrue(SafeApiTargetFilter().filter(record))
                self.assertNotIn("review-private-marker", record.getMessage())
                self.assertIn("[redacted]", record.getMessage())

    def test_api_access_log_redacts_malformed_request_lines(self):
        for line in ("", "review-private-marker", "GET  HTTP/1.1", "GET /api/?unknown=review-private-marker extra HTTP/1.1", "GET /api/?unknown=review-private-marker"):
            with self.subTest(line=line):
                record = self.access_record(line)
                self.assertTrue(SafeApiTargetFilter().filter(record))
                self.assertNotIn("review-private-marker", record.getMessage())
                self.assertIn("[redacted]", record.getMessage())

    def test_access_log_classification_matches_real_runserver_path(self):
        cases = (
            ("/api/products/", "/api/products/", True),
            ("/%61pi/products/", "/api/products/", True),
            ("/api%2Fproducts/", "/api/products/", True),
            ("/api%2fproducts/", "/api/products/", True),
            ("//api/products/", "/api/products/", True),
            ("/%2561pi/products/", "/%61pi/products/", False),
            ("/api%252Fproducts/", "/api%2Fproducts/", False),
            ("/%2Fapi/products/", "//api/products/", False),
            ("/./api/products/", "/./api/products/", False),
            ("/other/", "/other/", False),
            # runserver не выделяет path из absolute-form; журнал скрывает
            # такой нестандартный target консервативно, без смены маршрута.
            ("http://localhost/%61pi/products/", "http://localhost/api/products/", True),
        )
        for target, expected_path, redacted in cases:
            with self.subTest(target=target):
                handler = WSGIRequestHandler.__new__(WSGIRequestHandler)
                handler.raw_requestline = f"GET {target}?unknown=review-private-marker HTTP/1.1\r\n".encode("ascii")
                handler.rfile = BytesIO(b"\r\n")
                handler.client_address = ("127.0.0.1", 12345)
                handler.server = SimpleNamespace(base_environ=RequestFactory().get("/").environ)
                self.assertTrue(handler.parse_request())
                self.assertEqual(WSGIRequest(handler.get_environ()).path_info, expected_path)
                record = self.access_record(handler.requestline)
                SafeApiTargetFilter().filter(record)
                self.assertEqual("[redacted]" in record.getMessage(), redacted)
                self.assertEqual("review-private-marker" not in record.getMessage(), redacted)

    @staticmethod
    def access_record(line):
        return logging.LogRecord("django.server", logging.INFO, "", 0, '"%s" %s %s', (line, "400", "99"), None)

    def test_malformed_query_is_400_before_view_or_sql(self):
        for debug in (False, True):
            for query in ("q=%ffab", "q=%", "q=%0", "q=%gg", "q=%ed%a0%80ab", "unknown=%ff", "%=1"):
                with self.subTest(debug=debug, query=query), override_settings(DEBUG=debug):
                    response = self.client.get("/api/products/?" + query)
                    self.assertEqual((response.status_code, response.json()), (400, INVALID_REQUEST))

    def test_disallowed_host_is_safe_json_without_security_log(self):
        for debug in (False, True):
            with self.subTest(debug=debug), override_settings(DEBUG=debug, ALLOWED_HOSTS=["testserver"]):
                with self.assertNoLogs("django.security", level="WARNING"):
                    response = self.client.get("/api/products/", HTTP_HOST="private-value.invalid")
                self.assertEqual((response.status_code, response.json()), (400, INVALID_REQUEST))

    def test_write_without_slash_is_400_before_common_middleware_redirect(self):
        for debug in (False, True):
            for method in ("post", "put", "patch", "delete"):
                with self.subTest(debug=debug, method=method), override_settings(DEBUG=debug):
                    response = getattr(self.client, method)("/api/products", data=b"private-value", content_type="text/plain")
                    self.assertEqual((response.status_code, response.json()), (400, INVALID_REQUEST))


def read_urls(data):
    product, generic, category = data.shop_milk.pk, data.milk.pk, data.milk.category_id
    return (
        "/api/countries/", "/api/stores/", "/api/brands/", "/api/categories/",
        f"/api/categories/{category}/", "/api/generic-products/",
        f"/api/generic-products/{generic}/", "/api/products/", f"/api/products/{product}/",
        f"/api/products/{product}/prices/", f"/api/products/{product}/prices/summary/",
        f"/api/products/{product}/alternatives/", f"/api/generic-products/{generic}/comparison/",
    )


@tag("integration")
class RequestBoundaryTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.urls = read_urls(save_samples())

    def assert_invalid_request(self, response):
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response["Content-Type"], "application/json")
        self.assertEqual(response.json(), INVALID_REQUEST)
        for private in ("TooManyFieldsSent", "DATA_UPLOAD", "unknown", "private-value", "traceback"):
            self.assertNotIn(private, response.content.decode())

    def test_field_limit_boundary_all_routes_both_debug_modes(self):
        self.assertEqual(settings.DATA_UPLOAD_MAX_NUMBER_FIELDS, 1000)
        for debug in (False, True):
            for url in self.urls:
                with self.subTest(debug=debug, url=url), override_settings(DEBUG=debug):
                    response = self.client.get(url + "?" + "&".join(["unknown=1"] * 1000))
                    self.assertEqual(response.status_code, 200)
                    with self.assertNumQueries(0):
                        response = self.client.get(url + "?" + "&".join(["unknown=private-value"] * 1001))
                        self.assert_invalid_request(response)

    def test_limit_also_precedes_405_and_has_no_security_exception_log(self):
        query = "?" + "&".join(["unknown=private-value"] * 1001)
        for debug in (False, True):
            for url in self.urls:
                with self.subTest(debug=debug, url=url), override_settings(DEBUG=debug), self.assertNumQueries(0):
                    with self.assertNoLogs("django.security", level="WARNING"):
                        self.assert_invalid_request(self.client.post(url + query, data=b"bad json", content_type="application/json"))

    def test_long_parameters_are_validated_without_sql(self):
        for url in SEARCH_URLS:
            with self.subTest(url=url), self.assertNumQueries(0):
                response = self.client.get(url + "?q=" + "a" * 60000)
                self.assertEqual(response.status_code, 400)
                self.assertEqual(response.json()["error"]["code"], "invalid_parameter")
        for key in ("page", "page_size", "category", "country", "ordering"):
            with self.subTest(key=key), self.assertNumQueries(0):
                response = self.client.get("/api/products/?" + key + "=" + "a" * 60000)
                self.assertEqual(response.status_code, 400)
                self.assertEqual(response.json()["error"]["code"], "invalid_parameter")
        response = self.client.get(self.urls[9] + "?date_from=" + "a" * 60000)
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["error"]["code"], "invalid_parameter")

    def test_boundary_path_ids_remain_404_on_all_detail_routes(self):
        for pk in (str(2**63), "0", "9" * 5000, "%00", "%ff", "%"):
            for url in self.urls:
                if any(segment.isdecimal() for segment in url.split("/")):
                    path = "/".join(pk if segment.isdecimal() else segment for segment in url.split("/"))
                    response = self.client.get(path)
                    self.assertEqual(response.status_code, 404)
                    self.assertEqual(response.json()["error"]["code"], "not_found")

    def test_unknown_arrays_empty_names_and_long_query_keep_contract(self):
        for query in ("=private-value&=1", "q[]=private-value&q[a]=1", "unknown=" + "a" * 60000, "q=x&q=milk", "q=milk&q="):
            response = self.client.get("/api/products/?" + query)
            self.assertEqual(response.status_code, 200)
        self.assertEqual(self.client.get("/api/products/?q=milk&q=x").status_code, 400)

    def test_unusual_accept_is_safe_200_or_406(self):
        cases = (
            ("garbage", 406), ("/", 406), ("application/", 406), ("application/json; x=\"unterminated", 200),
            ("application/json; q=broken", 200), ("application/json; indent=" + "9" * 60000, 200),
            ("application/json," + "text/plain," * 4000, 200), ("application/json; q=0", 200),
        )
        for value, expected in cases:
            with self.subTest(value=value[:60]):
                response = self.client.get("/api/products/", HTTP_ACCEPT=value)
                self.assertEqual(response.status_code, expected)
                if expected == 406:
                    self.assertEqual(response.json(), {"error": {"code": "not_acceptable", "message": "Доступен только JSON."}})


@tag("integration")
class WSGIQueryEncodingTests(TransactionTestCase):
    """Полный WSGIHandler отправляет request_started: соединение здесь в autocommit."""

    def test_get_body_and_non_utf8_charset_cannot_change_query_decoding(self):
        from catalog.models import Category, GenericProduct, Product
        from config.wsgi import application

        category = Category.objects.create(name="Тестовая категория")
        generic = GenericProduct.objects.create(name="Тестовое молоко", category=category, base_unit="l")
        product = Product.objects.create(name="Тестовое молоко", generic=generic)
        for content_type in ("text/plain", "application/json; charset=latin1", "application/json; charset=base64", "multipart/form-data; boundary=broken"):
            with self.subTest(content_type=content_type):
                environ = RequestFactory().generic("GET", "/api/products/?q=%D0%BC%D0%BE%D0%BB", b"bad json").environ
                environ["CONTENT_TYPE"] = content_type
                started = []
                response = application(environ, lambda *args: started.append(args))
                try:
                    body = b"".join(response)
                finally:
                    response.close()
                self.assertEqual(started[0][0], "200 OK")
                self.assertEqual([row["id"] for row in json.loads(body)["results"]], [product.pk])
