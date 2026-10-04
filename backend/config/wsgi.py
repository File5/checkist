import os

from django.core.wsgi import get_wsgi_application

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings")
application = get_wsgi_application()

from config.requests import SafeWSGIRequest  # noqa: E402: Django должен быть настроен до импорта DRF.

application.request_class = SafeWSGIRequest
