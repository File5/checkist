"""Настоящий HTTP-аудит ошибок read-only API (сервер и вымышленные QA-данные уже созданы).

Запускать отдельно при DJANGO_DEBUG=0 и 1. Скрипт не пишет данные и не обходит UI.
"""
import argparse
from collections import Counter
import http.client
import json
from pathlib import Path
import re
from urllib.parse import urlencode

INVALID_REQUEST = {"error": {"code": "invalid_request", "message": "Некорректный запрос."}}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--product-id", type=int, required=True)
    parser.add_argument("--generic-id", type=int, required=True)
    parser.add_argument("--category-id", type=int, required=True)
    parser.add_argument("--server-log", type=Path, help="Файл stderr runserver для проверки редактирования access log")
    args = parser.parse_args()
    log_offset = args.server_log.stat().st_size if args.server_log else None
    urls = (
        "/api/countries/", "/api/stores/", "/api/brands/", "/api/categories/",
        f"/api/categories/{args.category_id}/", "/api/generic-products/",
        f"/api/generic-products/{args.generic_id}/", "/api/products/", f"/api/products/{args.product_id}/",
        f"/api/products/{args.product_id}/prices/", f"/api/products/{args.product_id}/prices/summary/",
        f"/api/products/{args.product_id}/alternatives/", f"/api/generic-products/{args.generic_id}/comparison/",
    )
    counts = Counter()

    def check(path, expected, *, method="GET", headers=None, body=None, server_rejection=False, error_code=None):
        connection = http.client.HTTPConnection("127.0.0.1", args.port, timeout=15)
        try:
            connection.request(method, path, body=body, headers=headers or {})
            response = connection.getresponse()
            payload = response.read()
            assert response.status == expected, (method, path[:80], response.status, expected, payload[:160])
            if not server_rejection:
                assert response.getheader("Content-Type") == "application/json"
                data = json.loads(payload)
                if expected >= 400:
                    assert set(data) == {"error"}
                    assert {"code", "message"} <= set(data["error"]) <= {"code", "message", "fields"}
                    wanted_code = error_code or {404: "not_found", 405: "method_not_allowed", 406: "not_acceptable"}.get(expected)
                    if wanted_code:
                        assert data["error"]["code"] == wanted_code
                    assert b"private-value" not in payload
                    assert b"review-private-marker" not in payload
                    assert b"TooManyFieldsSent" not in payload
                    assert b"Traceback" not in payload
                    if expected == 400 and data["error"]["code"] == "invalid_request":
                        assert data == INVALID_REQUEST
            counts[expected] += 1
        finally:
            connection.close()

    access_statuses = []
    for path in ("/api/products/", "/%61pi/products/", "/api%2Fproducts/", "/api%2fproducts/", "//api/products/"):
        for query, status in (("unknown=review-private-marker", 200), ("q=%00review-private-marker", 400)):
            check(path + "?" + query, status, error_code="invalid_parameter" if status == 400 else None)
            access_statuses.append(status)

    for url in urls:
        check(url, 200)
        for content_type in (None, "application/json; charset=utf-8", "application/json; charset=base64"):
            headers = {} if content_type is None else {"Content-Type": content_type}
            for size, expected in ((1000, 200), (1001, 400)):
                check(url + "?" + "&".join(["unknown=1"] * size), expected, headers=headers, error_code="invalid_request" if expected == 400 else None)
        for query in ("q=%ffab", "q=%", "q=%0", "q=%gg", "q=%ed%a0%80ab", "unknown=%ff", "%=1", "q=%c0%80"):
            check(url + "?" + query, 400, error_code="invalid_request")
        for header in ("Host", "Accept", "Content-Type"):
            value = "private-value.invalid" if header == "Host" else "application/json; x*=private-codec''%ff"
            check(url, 400, headers={header: value}, error_code="invalid_request")
        for method in ("POST", "PUT", "PATCH", "DELETE"):
            check(url, 405, method=method, body=b"bad json", headers={"Content-Type": "application/json"})
            check(url + "?" + "&".join(["unknown=private-value"] * 1001), 400, method=method, error_code="invalid_request")
            check(url.rstrip("/"), 400, method=method, error_code="invalid_request")
        for accept, expected in (
            ("garbage", 406), ("/", 406), ("application/", 406), ("text/html", 406),
            ("application/json; q=broken", 200), ("application/json; x=\"unterminated", 200),
            ("application/json; indent=" + "9" * 60000, 200),
            ("application/json," + "text/plain," * 4000, 200),
        ):
            check(url, expected, headers={"Accept": accept})
        for content_type in ("text/plain", "application/json; charset=latin1", "multipart/form-data; boundary=broken"):
            check(url, 200, body=b"bad body", headers={"Content-Type": content_type})
        check(url, 200, headers={"X-Client-Test": "a" * 60000})
        check(url + "?unknown=" + "a" * 60000, 200)
        for query in ("=private-value&=1", "q[]=private-value&q[a]=1", "q="):
            check(url + "?" + query, 200)

    for url in ("/api/products/", "/api/stores/", "/api/brands/", "/api/generic-products/", "/api/categories/"):
        for query, expected in (({"q": "a" * 60000}, 400), ({"q": "мол"}, 200)):
            check(url + "?" + urlencode(query), expected, error_code="invalid_parameter" if expected == 400 else None)
        check(url + "?q=x&q=milk", 200)
        check(url + "?q=milk&q=x", 400, error_code="invalid_parameter")
        check(url + "?q=ab%25", 200)

    for url in urls:
        if any(segment.isdecimal() for segment in url.split("/")):
            for pk in (str(2**63), "0", "-1", "9" * 5000, "%00", "%ff", "%", "%ed%a0%80"):
                check("/".join(pk if segment.isdecimal() else segment for segment in url.split("/")), 404)

    multipart = b"".join(
        b'--test\r\nContent-Disposition: form-data; name="file"; filename="test.txt"\r\n\r\nx\r\n'
        for _ in range(101)
    ) + b"--test--\r\n"
    for method, status in (("GET", 200), ("POST", 405)):
        check("/api/products/", status, method=method, body=multipart, headers={"Content-Type": "multipart/form-data; boundary=test"})
    check("/api/products/", 200, headers={"Content-Length": str(3 * 1024 * 1024)})
    check("/api/products/" + "a" * 65536, 414, server_rejection=True)
    check("/api/products/", 431, headers={"X-Client-Test": "a" * 65536}, server_rejection=True)
    check("/api/products/", 431, headers={f"X-Test-{i}": "1" for i in range(101)}, server_rejection=True)
    check("/api/health/", 200)
    # Последующие HTTP-проверки уже прошли через тот же синхронный logging
    # handler: записи первых запросов должны быть в файле, без sleep/retry.
    if args.server_log:
        log = args.server_log.read_bytes()[log_offset:]
        assert b"review-private-marker" not in log, "Query marker leaked into server log"
        lines = re.findall(rb'"GET [^\r\n]* HTTP/1\.1" \d{3} \d+', log)
        expected = [f'"GET /api/[redacted] HTTP/1.1" {status} '.encode() for status in access_statuses]
        assert len(lines) >= len(expected), "Missing access log records"
        assert all(line.startswith(prefix) for line, prefix in zip(lines, expected)), "Unredacted or unexpected access log records"
    print(json.dumps({
        "checks": sum(counts.values()), "statuses": dict(sorted(counts.items())),
        "access_log": "passed" if args.server_log else "not_checked (use --server-log)",
        "access_log_requests": len(access_statuses),
    }))


if __name__ == "__main__":
    main()
