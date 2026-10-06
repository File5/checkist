import ipaddress
import hashlib
import os
import re
import tempfile
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
    "recognition.apps.RecognitionConfig",
    "merges.apps.MergesConfig",
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


def env_integer(name, default, minimum, maximum):
    value = env_text(name, str(default))
    if not value.isascii() or not value.isdecimal() or not minimum <= int(value) <= maximum:
        raise ImproperlyConfigured(f"{name}: expected an integer from {minimum} to {maximum}.")
    return int(value)


def env_directory(name, default):
    path = Path(env_text(name, str(default))).expanduser()
    if not path.is_absolute():
        raise ImproperlyConfigured(f"{name}: expected an absolute directory path.")
    return path.resolve()


# Local recognition is opt-in. MEDIA and private provider scratch never overlap.
recognition_flag = env_text("ALLOW_LOCAL_RECOGNITION_API", "0").lower()
if recognition_flag not in {"0", "1", "true", "false"}:
    raise ImproperlyConfigured("ALLOW_LOCAL_RECOGNITION_API: expected 0, 1, true or false.")
ALLOW_LOCAL_RECOGNITION_API = recognition_flag in {"1", "true"}
# Duplicate search right after a receipt import. Off by default: turning it on
# lets the next import move links between products of this database.
merge_detect_flag = env_text("PRODUCT_MERGE_AUTO_DETECT", "0").lower()
if merge_detect_flag not in {"0", "1", "true", "false"}:
    raise ImproperlyConfigured("PRODUCT_MERGE_AUTO_DETECT: expected 0, 1, true or false.")
PRODUCT_MERGE_AUTO_DETECT = merge_detect_flag in {"1", "true"}
MEDIA_ROOT = env_directory("MEDIA_ROOT", BASE_DIR.parent / "media")
# Fixed v1 prefix shared with the client URL guards and Vite dev/preview proxy.
MEDIA_URL = os.environ.get("MEDIA_URL", "/media/")
if MEDIA_URL != "/media/":
    raise ImproperlyConfigured(
        "MEDIA_URL: v1 supports only /media/. Changing the prefix requires coordinated client and Vite proxy changes."
    )
scratch_suffix = hashlib.sha256(str(BASE_DIR).encode()).hexdigest()[:16]
RECEIPT_OCR_TEMP_ROOT = env_directory(
    "RECEIPT_OCR_TEMP_ROOT", Path(tempfile.gettempdir()) / f"checkist-ocr-{scratch_suffix}",
)
if MEDIA_ROOT.is_relative_to(RECEIPT_OCR_TEMP_ROOT) or RECEIPT_OCR_TEMP_ROOT.is_relative_to(MEDIA_ROOT):
    raise ImproperlyConfigured("MEDIA_ROOT and RECEIPT_OCR_TEMP_ROOT must be separate directories.")
RECEIPT_OCR_PROVIDER = env_text("RECEIPT_OCR_PROVIDER", "codex_cli")
if RECEIPT_OCR_PROVIDER not in {"codex_cli", "fake"}:
    raise ImproperlyConfigured("RECEIPT_OCR_PROVIDER: expected codex_cli or fake.")
RECEIPT_OCR_MODEL = env_text("RECEIPT_OCR_MODEL", "gpt-6.1-sol")
RECEIPT_OCR_CODEX_EXECUTABLE = env_text("RECEIPT_OCR_CODEX_EXECUTABLE", "codex")
RECEIPT_OCR_PREPARE_TIMEOUT_SECONDS = env_integer("RECEIPT_OCR_PREPARE_TIMEOUT_SECONDS", 30, 1, 300)
RECEIPT_OCR_CROP_TIMEOUT_SECONDS = env_integer("RECEIPT_OCR_CROP_TIMEOUT_SECONDS", 30, 1, 300)
RECEIPT_OCR_DETECT_TIMEOUT_SECONDS = env_integer("RECEIPT_OCR_DETECT_TIMEOUT_SECONDS", 90, 1, 2400)
RECEIPT_OCR_RECOGNIZE_TIMEOUT_SECONDS = env_integer("RECEIPT_OCR_RECOGNIZE_TIMEOUT_SECONDS", 180, 1, 2400)
RECEIPT_OCR_JOB_TIMEOUT_SECONDS = env_integer("RECEIPT_OCR_JOB_TIMEOUT_SECONDS", 2400, 1, 86400)
RECEIPT_OCR_CANCEL_GRACE_SECONDS = env_integer("RECEIPT_OCR_CANCEL_GRACE_SECONDS", 2, 1, 10)
RECEIPT_OCR_LEASE_SECONDS = env_integer("RECEIPT_OCR_LEASE_SECONDS", 30, 10, 300)
RECEIPT_OCR_HEARTBEAT_SECONDS = env_integer("RECEIPT_OCR_HEARTBEAT_SECONDS", 5, 1, 30)
if RECEIPT_OCR_HEARTBEAT_SECONDS * 2 >= RECEIPT_OCR_LEASE_SECONDS:
    raise ImproperlyConfigured("RECEIPT_OCR_HEARTBEAT_SECONDS must be less than half the lease.")
RECEIPT_OCR_MAX_CONCURRENCY = env_integer("RECEIPT_OCR_MAX_CONCURRENCY", 1, 1, 1)
RECEIPT_OCR_MAX_ATTEMPTS = env_integer("RECEIPT_OCR_MAX_ATTEMPTS", 2, 1, 2)
# Fixed v1 capabilities; changing these needs a matching API/client contract.
RECEIPT_IMAGE_MAX_BYTES = env_integer("RECEIPT_IMAGE_MAX_BYTES", 20971520, 20971520, 20971520)
RECEIPT_IMAGE_MAX_PIXELS = env_integer("RECEIPT_IMAGE_MAX_PIXELS", 40000000, 40000000, 40000000)
RECEIPT_IMAGE_MAX_RECEIPTS = env_integer("RECEIPT_IMAGE_MAX_RECEIPTS", 10, 10, 10)
csrf_origins = os.environ.get("DJANGO_CSRF_TRUSTED_ORIGINS", "")
CSRF_TRUSTED_ORIGINS = []
if csrf_origins:
    for origin in csrf_origins.split(","):
        origin = origin.strip()
        try:
            parsed = urlsplit(origin)
            valid = (
                parsed.scheme in {"http", "https"} and parsed.hostname in {"127.0.0.1", "localhost", "::1"}
                and parsed.port is not None and not parsed.path and not parsed.query and not parsed.fragment
                and not parsed.username and not parsed.password and not any(char.isspace() for char in origin)
            )
        except ValueError:
            valid = False
        if not valid:
            raise ImproperlyConfigured("DJANGO_CSRF_TRUSTED_ORIGINS: expected exact local origins with ports.")
        CSRF_TRUSTED_ORIGINS.append(origin)
