"""Запрет индексации: заголовок на каждом ответе Django и собственный /robots.txt.

Это просьба к поисковикам, а не защита: данные защищает вход.
"""
from django.http import HttpResponse
from django.utils.deprecation import MiddlewareMixin

ROBOTS_PATH = "/robots.txt"
ROBOTS_BODY = b"User-agent: *\nDisallow: /\n"
NOINDEX = "noindex, nofollow"


class NoIndexMiddleware(MiddlewareMixin):
    """Первая строка MIDDLEWARE: видит ответ любой нижележащей строки, включая отказы.

    На GET/HEAD /robots.txt отвечает сама, до проверки хоста и перенаправления на https,
    поэтому маршрута в urls.py нет. Остальные методы этого пути идут дальше как обычный запрос.
    """

    def process_request(self, request):
        if request.path_info != ROBOTS_PATH or request.method not in ("GET", "HEAD"):
            return None
        # CommonMiddleware сюда не доходит: длину ставим сами, тело HEAD не отдаём.
        response = HttpResponse(
            b"" if request.method == "HEAD" else ROBOTS_BODY, content_type="text/plain; charset=utf-8",
        )
        response["Content-Length"] = str(len(ROBOTS_BODY))
        return response

    def process_response(self, request, response):
        response["X-Robots-Tag"] = NOINDEX
        return response
