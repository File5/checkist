# Архитектура Checkist

## Реализовано

Каркас состоит из локальных React/TypeScript/Vite SPA и Django/DRF API, предметной модели данных чеков и трёх Compose services: Postgres, Redis и Celery worker. Docker Desktop использует Linux daemon. Браузер обращается к Vite на своём origin, proxy передаёт `/api` в Django без rewrite. Django обращается к опубликованным loopback-портам, worker — к service DNS внутри Compose-сети.

| Процесс | Dev на хосте | QA на хосте | В Docker-сети |
| --- | --- | --- | --- |
| Django/DRF | `127.0.0.1:8000` | `127.0.0.1:18000` | API-контейнер в основной архитектуре отсутствует |
| Postgres | `127.0.0.1:15432` | `127.0.0.1:25432` | `postgres:5432` |
| Redis | `127.0.0.1:6379` | `127.0.0.1:16379` | `redis:6379` |
| Celery worker | Нет published ports | Нет published ports | `checkist@worker`, broker через `redis:6379/0` |
| SPA / Vite dev и preview | `127.0.0.1:5173` | `127.0.0.1:15173` | Контейнера нет |

`localhost` внутри worker означает сам контейнер. Compose переопределяет `POSTGRES_HOST=postgres`, `POSTGRES_PORT=5432` и три Redis URL; изменение host-портов не меняет внутренние порты. Порт 15432 выбран, потому что 5432 в проверенной Windows-среде занят локальным Postgres.

## Потоки и состояние

- SPA запрашивает `<VITE_API_BASE_URL>/health/` (default `/api/health/`), `Accept: application/json`, `credentials: omit`, `cache: no-store`. Адаптер валидирует JSON и соответствие HTTP/тела, сохраняет все checks при 503, ограничивает fetch и чтение тела 15 секундами. Страница показывает загрузку, успех, частичный отказ, безопасные ошибки и повтор; предыдущие запросы отменяются. Это технический health UI, без данных чеков.
- `GET /api/health/` запускает три probes параллельно в `ThreadPoolExecutor(max_workers=3)`: SQL `SELECT 1`, Redis cache set/get/delete, Celery inspect ping. Соединения БД каждого probe-потока закрываются. Известный отказ зависимости даёт HTTP 503 с независимыми `checks`.
- `check_services` последовательно проверяет SQL/cache и публикует `health.ping` через реальный broker, затем читает результат. Control ping и выполнение задачи — разные проверки.
- Django global DRF permission — `IsAuthenticated`; health явно открыт без authentication. Бизнес-эндпоинтов и пользовательского входа в SPA нет. `DEFAULT_AUTHENTICATION_CLASSES` не переопределён, поэтому действуют Session и Basic: пользователь админки пройдёт `IsAuthenticated` в будущем эндпоинте, если тот не задаст свои правила.
- `/admin/` — стандартный Django admin (`backend/config/urls.py`), HTML-интерфейс для пользователей с `is_staff`. Его открывают напрямую на Django (`127.0.0.1:8000`, QA — `18000`): Vite проксирует только `/api`, а `/admin` и `/static` — нет. Сессии хранятся в Postgres, статику админки отдаёт `runserver` при `DJANGO_DEBUG=1`. При `DJANGO_DEBUG=0` статика не отдаётся: `STATIC_ROOT`, `collectstatic`, secure cookies и HTTPS не настроены, админка — только для локальных dev/QA.
- Приложения `stores`, `catalog`, `receipts` не имеют своих URL, задач и команд: это модели, функции, вызываемые из кода, и `admin.py` с настройками админки. `receipts` зависит от `stores` и `catalog`, те друг от друга не зависят; `health` с ними не связан.

| Redis logical DB | Назначение | Локальная переменная |
| --- | --- | --- |
| 0 | Очередь/control Celery | `CELERY_BROKER_URL` |
| 1 | Результаты задач, TTL 60 секунд | `CELERY_RESULT_BACKEND` |
| 2 | Django RedisCache, prefix `checkist` | `DJANGO_CACHE_URL` |

Эти DB не являются границей безопасности. Redis без пароля — локальная dev/QA-конфигурация; публикация ограничена `127.0.0.1`. Health cache keys уникальны, TTL 5 секунд, удаление выполняется в `finally`. `health.ping` идемпотентна и не меняет бизнес-данные. При таймауте ожидания уже принятая task может выполниться позже.

Postgres содержит технические таблицы стандартных миграций `admin`, `auth`, `contenttypes`, `sessions` и 14 таблиц предметной модели. Собственных моделей/миграций `health` нет. Seed users и фотографии не нужны; пользователя для админки человек создаёт сам командой `createsuperuser`, в репозитории его реквизитов нет.

## Предметная модель

| Приложение | Таблицы | Код помимо моделей |
| --- | --- | --- |
| `stores` | `Country`, `Currency`, `TaxRate`, `Merchant`, `Store` | `normalize.py` — ключ адреса; сид-миграция `0002_seed_reference`; `admin.py` — 5 админок, форма магазина |
| `catalog` | `Category`, `GenericProduct`, `Brand`, `Product` | `units.py` — единицы и приведение к базовой; `admin.py` — 4 админки, защита от цикла категорий |
| `receipts` | `Receipt`, `ReceiptLine`, `ReceiptDiscount`, `ReceiptTax`, `ProductAlias` | `dedup.py` — фискальный ключ, поиск дубликатов и сопоставлений; `validation.py` — проверка чека; `prices.py` — история цен; `admin.py` — чек с тремя inline, строки чеков, сопоставления |

Магазин определяется продавцом и нормализованным адресом. Чек защищён от повторного ввода тремя уровнями unique-ограничений. Каталог двухуровневый: обобщённый продукт для сравнения и конкретный товар. История цен отдельной таблицы не имеет и выводится из строк чеков. Сид-миграция создаёт три страны, три валюты и четыре ставки налога; чеки, магазины и товары не сидируются.

Поля, ограничения, JSON-поля, границы ответственности БД и приложения, порядок миграций и отката, известные ограничения — в [data-model.md](data-model.md). HTTP API для этих данных нет: их вводят через админку или кодом. Какие модели зарегистрированы, что вычисляют и проверяют формы и чем админка ограничена — в разделе [«Админка»](data-model.md#админка).

Compose создаёт сеть и тома отдельно по имени project: `checkist_dev` и `checkist_qa`. `postgres_data` хранит `/var/lib/postgresql/data`, `redis_data` — `/data` с AOF и `noeviction`. Worker собран из `backend/Dockerfile`, работает non-root (UID 10001), монтирует `backend/` в `/app:ro`, использует prefork/concurrency 2. Backend/frontend контейнеров, beat и Flower нет.

Postgres/Redis healthchecks запускаются каждые 5 секунд; worker — каждые 10 секунд. `depends_on: service_healthy` управляет стартом worker; healthy не гарантирует связи Windows с опубликованными портами и не заменяет SQL/cache/task проверки. При дальнейшей потере связи нужен отдельный сценарий отказа и восстановления.

## Конфигурация клиента

Vite dev/preview используют `/api` → `DEV_API_PROXY_TARGET` с сохранением пути, loopback host и `strictPort: true`. `envDir` указывает на корень, environment процесса выше файла. `envPrefix: []` отключает автоматическую публикацию env; `define` передаёт только `VITE_API_BASE_URL`. Секреты backend и Node-only proxy target не передаются браузеру. Публичный префикс фиксируется при сборке. Произвольный внешний API origin/CORS и production reverse proxy не настроены. Подробности — [frontend.md](frontend.md).

## Планируется

Продуктовые функции: хранение фото чеков; распознавание магазина и адреса, товаров и стоимостей; API и интерфейс ввода чеков; дашборд со статистикой. OCR-провайдер, хранение фото (`MEDIA_ROOT` не настроен), курсы валют и пользовательское разграничение ещё не выбраны/не реализованы. Production-архитектура и deployment не определены текущим scaffold.

Контракт, модель данных и реальные ограничения проверки: [api-contract.md](api-contract.md), [data-model.md](data-model.md), [verification.md](verification.md).
