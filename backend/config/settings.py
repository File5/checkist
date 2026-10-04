import ipaddress
import os
import re
from pathlib import Path
from urllib.parse import urlsplit

from django.core.exceptions import ImproperlyConfigured
from dotenv import load_dotenv
from redis.backoff import NoBackoff
from redis.retry import Retry

BASE_DIR = Path(__file__).resolve().parent.parent
load_dotenv(BASE_DIR.parent / ".env", override=False)


def env_text(name, default):
    value = os.environ.get(name, default)
    if not value or any(ord(char) < 32 for char in value):
        raise ImproperlyConfigured(f"{name}: expected a nonempty value without control characters.")
    return value


def env_port(name, default):
    value = env_text(name, default)
    if not value.isascii() or not value.isdecimal() or not 1 <= int(value) <= 65535:
        raise ImproperlyConfigured(f"{name}: expected an integer port from 1 to 65535.")
    return int(value)


def valid_host(value):
    address = value
    if value.startswith("[") or value.endswith("]"):
        if not (value.startswith("[") and value.endswith("]") and ":" in value):
            return False
        address = value[1:-1]
    try:
        ipaddress.ip_address(address)
        return True
    except ValueError:
        return bool(re.fullmatch(
            r"(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?"
            r"(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*\.?",
            value,
        ))


def env_redis_url(name, default):
    value = env_text(name, default)
    try:
        parsed = urlsplit(value)
        valid = (
            parsed.scheme in {"redis", "rediss"}
            and parsed.hostname and valid_host(parsed.hostname)
            and (parsed.port is None or 1 <= parsed.port <= 65535)
            and re.fullmatch(r"/[0-9]+", parsed.path)
            and not parsed.query and not parsed.fragment
            and not any(char.isspace() for char in value)
        )
    except ValueError:
        valid = False
    if not valid:
        raise ImproperlyConfigured(
            f"{name}: expected redis://host:port/db or rediss://host:port/db without query parameters."
        )
    return value


debug_value = env_text("DJANGO_DEBUG", "1").lower()
if debug_value not in {"0", "1", "true", "false"}:
    raise ImproperlyConfigured("DJANGO_DEBUG: expected 0, 1, true or false.")
DEBUG = debug_value in {"1", "true"}
DEV_SECRET_KEY = "dev-only-checkist-key-change-before-deployment"
SECRET_KEY = env_text("DJANGO_SECRET_KEY", DEV_SECRET_KEY)
if not DEBUG and SECRET_KEY == DEV_SECRET_KEY:
    raise ImproperlyConfigured("DJANGO_SECRET_KEY: replace the development placeholder when DEBUG=0.")

ALLOWED_HOSTS = [host.strip() for host in env_text(
    "DJANGO_ALLOWED_HOSTS", "127.0.0.1,localhost"
).split(",")]
if not all(valid_host(host) for host in ALLOWED_HOSTS):
    raise ImproperlyConfigured("DJANGO_ALLOWED_HOSTS: expected comma-separated hostnames/IP addresses without wildcard.")

POSTGRES_HOST = env_text("POSTGRES_HOST", "127.0.0.1")
if not valid_host(POSTGRES_HOST):
    raise ImproperlyConfigured("POSTGRES_HOST: expected a hostname or IP address.")
REDIS_PORT = env_port("REDIS_PORT", "6379")

INSTALLED_APPS = [
    "django.contrib.admin",
    "django.contrib.auth",
    "django.contrib.contenttypes",
    "django.contrib.sessions",
    "django.contrib.messages",
    "django.contrib.staticfiles",
    "rest_framework",
    "health.apps.HealthConfig",
    "catalog.apps.CatalogConfig",
    "stores.apps.StoresConfig",
    "receipts.apps.ReceiptsConfig",
    "api.apps.ApiConfig",
]
MIDDLEWARE = [
    "django.middleware.security.SecurityMiddleware",
    "django.contrib.sessions.middleware.SessionMiddleware",
    "config.requests.ApiCommonMiddleware",
    "django.middleware.csrf.CsrfViewMiddleware",
    "django.contrib.auth.middleware.AuthenticationMiddleware",
    "django.contrib.messages.middleware.MessageMiddleware",
    "django.middleware.clickjacking.XFrameOptionsMiddleware",
]
ROOT_URLCONF = "config.urls"
TEMPLATES = [{
    "BACKEND": "django.template.backends.django.DjangoTemplates",
    "DIRS": [],
    "APP_DIRS": True,
    "OPTIONS": {"context_processors": [
        "django.template.context_processors.request",
        "django.contrib.auth.context_processors.auth",
        "django.contrib.messages.context_processors.messages",
    ]},
}]
WSGI_APPLICATION = "config.wsgi.application"
ASGI_APPLICATION = "config.asgi.application"

LOGGING = {
    "version": 1,
    "disable_existing_loggers": False,
    "filters": {"safe_api_target": {"()": "config.requests.SafeApiTargetFilter"}},
    "formatters": {"django.server": {
        "()": "django.utils.log.ServerFormatter", "format": "[{server_time}] {message}", "style": "{",
    }},
    "handlers": {"django.server": {
        "class": "logging.StreamHandler", "level": "INFO", "formatter": "django.server",
        "filters": ["safe_api_target"],
    }},
    "loggers": {"django.server": {"handlers": ["django.server"], "level": "INFO", "propagate": False}},
}

DATABASES = {"default": {
    "ENGINE": "django.db.backends.postgresql",
    "NAME": env_text("POSTGRES_DB", "checkist_dev"),
    "USER": env_text("POSTGRES_USER", "checkist"),
    "PASSWORD": env_text("POSTGRES_PASSWORD", "checkist_dev_only"),
    "HOST": POSTGRES_HOST,
    "PORT": env_port("POSTGRES_PORT", "15432"),
    "CONN_MAX_AGE": 0,
    "OPTIONS": {"connect_timeout": 2, "options": "-c statement_timeout=2000"},
}}
CACHES = {"default": {
    "BACKEND": "django.core.cache.backends.redis.RedisCache",
    "LOCATION": env_redis_url("DJANGO_CACHE_URL", "redis://127.0.0.1:6379/2"),
    "KEY_PREFIX": "checkist",
    "OPTIONS": {
        "socket_connect_timeout": 1,
        "socket_timeout": 1,
        "retry_on_timeout": False,
        "retry": Retry(NoBackoff(), 0),
    },
}}

CELERY_BROKER_URL = env_redis_url("CELERY_BROKER_URL", "redis://127.0.0.1:6379/0")
CELERY_RESULT_BACKEND = env_redis_url("CELERY_RESULT_BACKEND", "redis://127.0.0.1:6379/1")
CELERY_TASK_SERIALIZER = "json"
CELERY_RESULT_SERIALIZER = "json"
CELERY_ACCEPT_CONTENT = ["json"]
CELERY_RESULT_ACCEPT_CONTENT = ["json"]
CELERY_TASK_ALWAYS_EAGER = False
CELERY_TASK_PUBLISH_RETRY = False
CELERY_RESULT_EXPIRES = 60
CELERY_WORKER_PREFETCH_MULTIPLIER = 1
CELERY_BROKER_CONNECTION_TIMEOUT = 1
CELERY_BROKER_TRANSPORT_OPTIONS = {
    "socket_connect_timeout": 1,
    "socket_timeout": 1,
    "retry_on_timeout": False,
    "max_retries": 0,
}
CELERY_REDIS_SOCKET_CONNECT_TIMEOUT = 1
CELERY_REDIS_SOCKET_TIMEOUT = 1
CELERY_REDIS_RETRY_ON_TIMEOUT = False
CELERY_RESULT_BACKEND_ALWAYS_RETRY = False
CELERY_RESULT_BACKEND_TRANSPORT_OPTIONS = {
    "retry_policy": {"max_retries": 0, "interval_start": 0, "interval_step": 0, "interval_max": 0},
}

REST_FRAMEWORK = {
    "DEFAULT_PERMISSION_CLASSES": ["rest_framework.permissions.IsAuthenticated"],
    "DEFAULT_RENDERER_CLASSES": ["rest_framework.renderers.JSONRenderer"],
    "EXCEPTION_HANDLER": "config.exceptions.exception_handler",
    "URL_FORMAT_OVERRIDE": None,
}
AUTH_PASSWORD_VALIDATORS = [
    {"NAME": "django.contrib.auth.password_validation.UserAttributeSimilarityValidator"},
    {"NAME": "django.contrib.auth.password_validation.MinimumLengthValidator"},
    {"NAME": "django.contrib.auth.password_validation.CommonPasswordValidator"},
    {"NAME": "django.contrib.auth.password_validation.NumericPasswordValidator"},
]
LANGUAGE_CODE = "ru"
TIME_ZONE = "UTC"
USE_I18N = True
USE_TZ = True
STATIC_URL = "static/"
DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"
