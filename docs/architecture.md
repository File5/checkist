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

- SPA запрашивает `<VITE_API_BASE_URL>/health/` (default `/api/health/`), `Accept: application/json`, `credentials: omit`, `cache: no-store`. Адаптер валидирует JSON и соответствие HTTP/тела, сохраняет все checks при 503, ограничивает fetch и чтение тела 15 секундами. Страница показывает загрузку, успех, частичный отказ, безопасные ошибки и повтор; предыдущие запросы отменяются. Это технический health UI, без данных чеков: API чтения клиент пока не вызывает.
- `GET /api/health/` запускает три probes параллельно в `ThreadPoolExecutor(max_workers=3)`: SQL `SELECT 1`, Redis cache set/get/delete, Celery inspect ping. Соединения БД каждого probe-потока закрываются. Известный отказ зависимости даёт HTTP 503 с независимыми `checks`.
- `check_services` последовательно проверяет SQL/cache и публикует `health.ping` через реальный broker, затем читает результат. Control ping и выполнение задачи — разные проверки.
- Django global DRF permission — `IsAuthenticated`; health и API чтения явно открыты без authentication (`AllowAny`, `authentication_classes = []`). Пользовательского входа нет; перед внешним развёртыванием доступ нужно закрыть. Стандартные Django apps подключены, но `/admin/` не зарегистрирован.
- Приложения `stores`, `catalog`, `receipts` не имеют собственных URL, задач и команд: это модели и функции, вызываемые из кода. `receipts` зависит от `stores` и `catalog`, те друг от друга не зависят; `health` с ними не связан.
- Приложение `api` — весь HTTP-слой чтения предметной модели: 13 GET-эндпоинтов под `/api/` (справочники, категории, обобщённые продукты, товары, история цен, сравнение альтернатив). Моделей, миграций, задач и записи в БД у него нет. Оно зависит от `catalog`, `stores`, `receipts` и `config.exceptions`; обратных зависимостей нет, поэтому три приложения модели остаются независимыми от HTTP. `config/urls.py` подключает `api/health/` первым, затем `api/` → `api.urls`; последний маршрут `api.urls` — запасной JSON `404 not_found` для неизвестных путей с завершающим `/`.
- Запрос API чтения: `api.params.Params` разбирает query и копит ошибки в один `400`; views (`api/views/catalog.py`, `prices.py`, `compare.py`) строят выборки через `receipts.prices` (`price_history`, `price_groups`, `last_prices`, `price_summary`); `api.common` сериализует деньги строками из `Decimal` и строит дерево категорий в памяти одним запросом; `api.pagination.paginate` формирует страницу; `api.rates` разбирает курсы из запроса. Ошибки всех DRF views приводит к единому формату `config.exceptions.exception_handler`. Курсы валют сервер не хранит: пересчёт возможен только по курсам из запроса.
- `receipts.decimal_math` задаёт локальный Decimal-контекст для арифметики и округления цен на полном диапазоне моделей и курсов; его используют агрегаты и HTTP-слой. Нормализация в БД остаётся `numeric`. Многозапросное чтение не получает общего снимка: исчезнувшие между запросами группы пропускаются, без дополнительных SQL-запросов; гарантии — в [контракте](api-contract.md#общие-правила).

| Redis logical DB | Назначение | Локальная переменная |
| --- | --- | --- |
| 0 | Очередь/control Celery | `CELERY_BROKER_URL` |
| 1 | Результаты задач, TTL 60 секунд | `CELERY_RESULT_BACKEND` |
| 2 | Django RedisCache, prefix `checkist` | `DJANGO_CACHE_URL` |

Эти DB не являются границей безопасности. Redis без пароля — локальная dev/QA-конфигурация; публикация ограничена `127.0.0.1`. Health cache keys уникальны, TTL 5 секунд, удаление выполняется в `finally`. `health.ping` идемпотентна и не меняет бизнес-данные. При таймауте ожидания уже принятая task может выполниться позже.

Postgres содержит технические таблицы стандартных миграций `admin`, `auth`, `contenttypes`, `sessions` и 14 таблиц предметной модели. Собственных моделей/миграций `health` нет. Seed users и фотографии не нужны.

## Предметная модель

| Приложение | Таблицы | Код помимо моделей |
| --- | --- | --- |
| `stores` | `Country`, `Currency`, `TaxRate`, `Merchant`, `Store` | `normalize.py` — ключ адреса; сид-миграция `0002_seed_reference` |
| `catalog` | `Category`, `GenericProduct`, `Brand`, `Product` | `units.py` — единицы и приведение к базовой |
| `receipts` | `Receipt`, `ReceiptLine`, `ReceiptDiscount`, `ReceiptTax`, `ProductAlias` | `dedup.py` — фискальный ключ, поиск дубликатов и сопоставлений; `validation.py` — проверка чека; `prices.py` — история цен и её агрегаты по группам «товар, страна, валюта» |
| `api` | Нет | `views/` — эндпоинты чтения; `params.py`, `pagination.py`, `common.py`, `rates.py` — разбор query, страницы, сериализация, курсы из запроса |

Магазин определяется продавцом и нормализованным адресом. Чек защищён от повторного ввода тремя уровнями unique-ограничений. Каталог двухуровневый: обобщённый продукт для сравнения и конкретный товар. История цен отдельной таблицы не имеет и выводится из строк чеков. Сид-миграция создаёт три страны, три валюты и четыре ставки налога; чеки, магазины и товары не сидируются.

Поля, ограничения, JSON-поля, границы ответственности БД и приложения, порядок миграций и отката, известные ограничения — в [data-model.md](data-model.md). Эти данные доступны на чтение через API ([api-contract.md](api-contract.md#реализовано-api-чтения-каталога-и-цен)); API записи и админки нет: они вводятся только кодом. Несопоставленные позиции чеков в API не видны.

Compose создаёт сеть и тома отдельно по имени project: `checkist_dev` и `checkist_qa`. `postgres_data` хранит `/var/lib/postgresql/data`, `redis_data` — `/data` с AOF и `noeviction`. Worker собран из `backend/Dockerfile`, работает non-root (UID 10001), монтирует `backend/` в `/app:ro`, использует prefork/concurrency 2. Backend/frontend контейнеров, beat и Flower нет.

Postgres/Redis healthchecks запускаются каждые 5 секунд; worker — каждые 10 секунд. `depends_on: service_healthy` управляет стартом worker; healthy не гарантирует связи Windows с опубликованными портами и не заменяет SQL/cache/task проверки. При дальнейшей потере связи нужен отдельный сценарий отказа и восстановления.

## Конфигурация клиента

Vite dev/preview используют `/api` → `DEV_API_PROXY_TARGET` с сохранением пути, loopback host и `strictPort: true`. `envDir` указывает на корень, environment процесса выше файла. `envPrefix: []` отключает автоматическую публикацию env; `define` передаёт только `VITE_API_BASE_URL`. Секреты backend и Node-only proxy target не передаются браузеру. Публичный префикс фиксируется при сборке. Произвольный внешний API origin/CORS и production reverse proxy не настроены. Подробности — [frontend.md](frontend.md).

## Планируется

Продуктовые функции: хранение фото чеков; распознавание магазина и адреса, товаров и стоимостей; API записи и интерфейс ввода чеков и сопоставления позиций; экраны каталога и цен в клиенте; дашборд со статистикой. OCR-провайдер, хранение фото (`MEDIA_ROOT` не настроен), курсы валют и пользовательское разграничение ещё не выбраны/не реализованы. Production-архитектура и deployment не определены текущим scaffold.

Контракт, модель данных и реальные ограничения проверки: [api-contract.md](api-contract.md), [data-model.md](data-model.md), [verification.md](verification.md).
