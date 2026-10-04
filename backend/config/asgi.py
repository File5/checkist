import os

from django.core.asgi import get_asgi_application

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings")
application = get_asgi_application()

from config.requests import SafeASGIRequest  # noqa: E402: Django должен быть настроен до импорта DRF.

application.request_class = SafeASGIRequest
