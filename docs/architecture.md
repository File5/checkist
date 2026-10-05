# Архитектура Checkist

## Реализовано

Система состоит из локальных React/TypeScript/Vite SPA и Django/DRF API, предметной модели чеков, приложения `recognition` и трёх Compose services: Postgres, Redis и Celery worker. Распознавание выполняет отдельная host-команда `recognition_worker` рядом с Codex CLI. Docker Desktop использует Linux daemon. Браузер обращается к Vite на своём origin, proxy передаёт `/api` в Django без rewrite. Django и OCR-воркер обращаются к опубликованному Postgres, Celery — к service DNS внутри Compose-сети.

| Процесс | Dev на хосте | QA на хосте | В Docker-сети |
| --- | --- | --- | --- |
| Django/DRF | `127.0.0.1:8000` | `127.0.0.1:18000` | API-контейнер в основной архитектуре отсутствует |
| Postgres | `127.0.0.1:15432` | `127.0.0.1:25432` | `postgres:5432` |
| Redis | `127.0.0.1:6379` | `127.0.0.1:16379` | `redis:6379` |
| Celery worker | Нет published ports | Нет published ports | `checkist@worker`, broker через `redis:6379/0` |
| `recognition_worker` | Host-процесс, без HTTP-порта | Host-процесс, тот же QA DB/MEDIA, что у API | В Compose не запускается |
| SPA / Vite dev и preview | `127.0.0.1:5173` | `127.0.0.1:15173` | Контейнера нет |

`localhost` внутри worker означает сам контейнер. Compose переопределяет `POSTGRES_HOST=postgres`, `POSTGRES_PORT=5432` и три Redis URL; изменение host-портов не меняет внутренние порты. Порт 15432 выбран, потому что 5432 в проверенной Windows-среде занят локальным Postgres.

## Потоки и состояние

- SPA запрашивает `<VITE_API_BASE_URL>/health/` (default `/api/health/`), `Accept: application/json`, `credentials: omit`, `cache: no-store`. Адаптер валидирует JSON и соответствие HTTP/тела, сохраняет все checks при 503, ограничивает fetch и чтение тела 15 секундами. Страница показывает загрузку, успех, частичный отказ, безопасные ошибки и повтор; предыдущие запросы отменяются. Это технический health UI, без данных чеков: API чтения клиент пока не вызывает.
- `GET /api/health/` запускает три probes параллельно в `ThreadPoolExecutor(max_workers=3)`: SQL `SELECT 1`, Redis cache set/get/delete, Celery inspect ping. Соединения БД каждого probe-потока закрываются. Известный отказ зависимости даёт HTTP 503 с независимыми `checks`.
- `check_services` последовательно проверяет SQL/cache и публикует `health.ping` через реальный broker, затем читает результат. Control ping и выполнение задачи — разные проверки.
- Django global DRF permission — `IsAuthenticated`; health и API чтения явно открыты без authentication (`AllowAny`, `authentication_classes = []`). Пользовательского входа в SPA нет; перед внешним развёртыванием доступ нужно закрыть. `DEFAULT_AUTHENTICATION_CLASSES` не переопределён, поэтому действуют Session и Basic: пользователь админки пройдёт `IsAuthenticated` в будущем эндпоинте, если тот не задаст свои правила.
- `/admin/` — стандартный Django admin (`backend/config/urls.py`), HTML-интерфейс для пользователей с `is_staff`. Его открывают напрямую на Django (`127.0.0.1:8000`, QA — `18000`): Vite проксирует только `/api`, а `/admin` и `/static` — нет. Сессии хранятся в Postgres, статику админки отдаёт `runserver` при `DJANGO_DEBUG=1`. При `DJANGO_DEBUG=0` статика не отдаётся: `STATIC_ROOT`, `collectstatic`, secure cookies и HTTPS не настроены, админка — только для локальных dev/QA.
- Приложения `stores`, `catalog`, `receipts` не имеют своих URL, задач и команд: это модели, функции, вызываемые из кода, и `admin.py` с настройками админки. `receipts` зависит от `stores` и `catalog`, те друг от друга не зависят; `health` с ними не связан.
- Приложение `api` — HTTP-слой: прежние 13 GET каталога/цен и новые локальные recognition/receipts routes. Собственных моделей/миграций нет; новые POST вызывают сервисы записи recognition, провайдера из HTTP не запускают. Оно зависит от catalog/stores/receipts/recognition и config.exceptions; приложения моделей остаются независимыми от HTTP. `config/urls.py` подключает `api/health/` первым, затем `api/` → `api.urls`; последний маршрут `api.urls` — запасной JSON `404 not_found` для неизвестных путей с завершающим `/`.
- Запрос API чтения: `api.params.Params` разбирает query и копит ошибки в один `400`; views (`api/views/catalog.py`, `prices.py`, `compare.py`) строят выборки через `receipts.prices` (`price_history`, `price_groups`, `last_prices`, `price_summary`); `api.common` сериализует деньги строками из `Decimal` и строит дерево категорий в памяти одним запросом; `api.pagination.paginate` формирует страницу; `api.rates` разбирает курсы из запроса. Ошибки всех DRF views приводит к единому формату `config.exceptions.exception_handler`. Курсы валют сервер не хранит: пересчёт возможен только по курсам из запроса.
- Ошибки запроса до `Params` и DRF защищены общим слоем `config.requests`: WSGI/ASGI request classes безопасно разбирают Content-Type в конструкторе; `ApiCommonMiddleware` заменяет стандартный CommonMiddleware, проверяет Host, percent-кодирование и UTF-8 query, разбор Accept и запись без слэша. Кодировка query не зависит от charset body. Семейство `SuspiciousOperation`, `BadRequest`, ошибки чтения/разбора тела дают JSON `400 invalid_request` без текста исключения; штатный лимит query — 1000 полей. Неизвестные ошибки реализации остаются `500 internal_error`. Access log `django.server` скрывает request target API. Путь вне `/api/` сохраняет стандартное поведение Django; отказы HTTP-сервера до Django (414/431) не покрыты JSON-handler. Read-only views/health не читают body; новый API загрузки использует bounded multipart parser, cancel/retry — bounded UTF-8 JSON `{}` и явную CSRF-проверку до тела.
- `receipts.decimal_math` задаёт локальный Decimal-контекст для арифметики и округления цен на полном диапазоне моделей и курсов; его используют агрегаты и HTTP-слой. Нормализация в БД остаётся `numeric`. Многозапросное чтение не получает общего снимка: исчезнувшие между запросами группы пропускаются, без дополнительных SQL-запросов; гарантии — в [контракте](api-contract.md#общие-правила).

| Redis logical DB | Назначение | Локальная переменная |
| --- | --- | --- |
| 0 | Очередь/control Celery | `CELERY_BROKER_URL` |
| 1 | Результаты задач, TTL 60 секунд | `CELERY_RESULT_BACKEND` |
| 2 | Django RedisCache, prefix `checkist` | `DJANGO_CACHE_URL` |

Эти DB не являются границей безопасности. Redis без пароля — локальная dev/QA-конфигурация; публикация ограничена `127.0.0.1`. Health cache keys уникальны, TTL 5 секунд, удаление выполняется в `finally`. `health.ping` идемпотентна и не меняет бизнес-данные. При таймауте ожидания уже принятая task может выполниться позже.

Postgres содержит технические таблицы стандартных миграций `admin`, `auth`, `contenttypes`, `sessions`, 14 таблиц предметной модели и 4 таблицы `recognition`. Собственных моделей/миграций `health` и `api` нет. Пользователя для админки человек создаёт сам командой `createsuperuser`. `seed_recognition_demo` создаёт два синтетических изображения только в QA/test MEDIA, без пользователей, заданий и предметных записей.

## Предметная модель

| Приложение | Таблицы | Код помимо моделей |
| --- | --- | --- |
| `stores` | `Country`, `Currency`, `TaxRate`, `Merchant`, `Store` | `normalize.py` — ключ адреса; сид-миграция `0002_seed_reference`; `admin.py` — 5 админок, форма магазина |
| `catalog` | `Category`, `GenericProduct`, `Brand`, `Product` | `units.py` — единицы и приведение к базовой; `admin.py` — 4 админки, защита от цикла категорий |
| `receipts` | `Receipt`, `ReceiptLine`, `ReceiptDiscount`, `ReceiptTax`, `ProductAlias` | `dedup.py` — фискальный ключ, поиск дубликатов и сопоставлений; `validation.py` — проверка чека; `prices.py` — история цен и её агрегаты по группам «товар, страна, валюта»; `admin.py` — чек с тремя inline, строки чеков, сопоставления |
| `api` | Нет | `views/` — эндпоинты чтения; `params.py`, `pagination.py`, `common.py`, `rates.py` — разбор query, страницы, сериализация, курсы из запроса |
| `recognition` | `SourcePhoto`, `ProcessingJob`, `ReceiptImage`, `RecognitionAttempt` | `queue`, `storage`, `images`, DTO/схемы, providers/supervisor, `resolution`/`importer`, `pipeline`, host-команды |

Магазин определяется продавцом и нормализованным адресом. Чек защищён от повторного ввода тремя уровнями unique-ограничений. Каталог двухуровневый: обобщённый продукт для сравнения и конкретный товар. История цен отдельной таблицы не имеет и выводится из строк чеков. Сид-миграция создаёт три страны, три валюты и четыре ставки налога; чеки, магазины и товары не сидируются.

Поля, ограничения и откат — в [data-model.md](data-model.md). Существующие 13 GET каталога/цен сохраняют контракт и исключают несопоставленные позиции. Новый локальный API загружает фото, управляет заданиями и читает чеки со всеми строками; произвольного API редактирования нет. Состав админки прежний, `recognition` в ней не зарегистрирован.

Compose создаёт сеть и тома отдельно по имени project: `checkist_dev` и `checkist_qa`. `postgres_data` хранит `/var/lib/postgresql/data`, `redis_data` — `/data` с AOF и `noeviction`. Worker собран из `backend/Dockerfile`, работает non-root (UID 10001), монтирует `backend/` в `/app:ro`, использует prefork/concurrency 2. Backend/frontend контейнеров, beat и Flower нет.

Postgres/Redis healthchecks запускаются каждые 5 секунд; worker — каждые 10 секунд. `depends_on: service_healthy` управляет стартом worker; healthy не гарантирует связи Windows с опубликованными портами и не заменяет SQL/cache/task проверки. При дальнейшей потере связи нужен отдельный сценарий отказа и восстановления.

## Конфигурация клиента

Vite dev/preview используют `/api` → `DEV_API_PROXY_TARGET` с сохранением пути, loopback host и `strictPort: true`. `envDir` указывает на корень, environment процесса выше файла. `envPrefix: []` отключает автоматическую публикацию env; `define` передаёт только `VITE_API_BASE_URL`. Секреты backend и Node-only proxy target не передаются браузеру. Публичный префикс фиксируется при сборке. Произвольный внешний API origin/CORS и production reverse proxy не настроены. Подробности — [frontend.md](frontend.md).

## Распознавание: облегчённая v1

```mermaid
flowchart LR
  U[POST photo + CSRF] --> P[SourcePhoto + queued Job]
  P --> W[Host recognition_worker]
  W --> D[prepare → detect]
  D --> C[Pillow crop → ReceiptImage]
  C --> R[recognize → validate]
  R --> I[Atomic import + image outcome]
  I --> DB[Receipt / lines / products]
  I --> Q[needs_review / failed + issues]
  P --> G[GET job / images / receipts]
  I --> G
```

Очередь находится в PostgreSQL. Сессионная advisory-блокировка разрешает один host-worker; `SKIP LOCKED` выбирает готовый job. Lease 30 с, отдельный heartbeat каждые 5 с, `run_token` и `version` защищают записи от старого владельца. Recovery выполняет сам воркер перед claim, сохраняет результаты завершённых вырезок, обнаружение и успешный OCR; явный HTTP retry создаёт новый job и повторяет detect. Без воркера recovery не происходит. `executor.available` подтверждает только действующий executing lease: живой idle-worker тоже показывает false, его heartbeat отдельно не хранится.

Исходные байты остаются неизменными в MEDIA. EXIF-ориентация применяется к отдельному RGB PNG preview, метаданные убираются; bbox вырезается с padding 1%, quad сохраняется, перспективное выравнивание не выполняется. Допускаются JPEG/PNG/WebP, один кадр, до 20 MiB/40 MP/10 чеков. Пути UUID, staging вне MEDIA, атомарное переименование; API выдаёт относительные `/media/` URL. Раздача MEDIA включена только при DEBUG и не проверяет флаг API. Vite сейчас проксирует только `/api`; media proxy добавляет этап клиента.

Геометрия detect/crop требует bbox в диапазоне 0..1 с положительной площадью и охватом всех углов quad, строго выпуклого обхода quad по часовой стрелке и угла текста −180..180; порядок углов относительно текста и циклическое начало сохраняются при любом повороте. Между разными чеками разрешены касание и пересечение осевых bbox до 10% площади меньшей рамки включительно (`MAX_RECEIPT_BBOX_OVERLAP_FRACTION` в `recognition/pipeline.py`, без env-настройки). Небольшое пересечение учитывает свободное поле bbox вокруг наклонной бумаги: у шести рамок из прогона 05.10.2026 максимум около 4,4%. Пересечение выше порога, дубликаты и вложенные рамки дают `geometry_requires_review` до создания вырезок; приватный detect сохраняется для разбора. Доля от меньшей рамки выявляет вложение независимо от размера внешней; допуск не гарантирует отсутствие чужого текста в padding вырезки. Форматы сохранённых данных и API не меняются; откат — revert кода, уже созданные вырезки и чеки сохраняются, автоматической переработки старых failed jobs нет (нужен явный retry).

Provider выполняет только извлечение, без ORM. `FakeProvider` — фиксированные синтетические DTO/управляемая отмена; `CodexCLIProvider` — detect v1 и observation v2, отдельные приватные scratch-каталоги, JSON Schema, проверка JSONL completion и результата. CLI работает без shell/web/multi-agent tools, с `shell=False`, read-only и `--ephemeral`; авторизация существующего host-пользователя. Windows Job Object останавливает своё дерево, POSIX — process group (watchdog исключён). Неудача Codex не включает fake. Структурированный ответ сам по себе не доказывает правильность распознавания. [OpenAI Docs](https://learn.chatgpt.com/docs/non-interactive-mode).

Import сериализован отдельной transaction advisory-блокировкой и fenced job row. Точные store/product/alias/GTIN совпадения переиспользуются, новые магазины и товары создаются автоматически; неподтверждённая идентичность оставляет issues. Повторное фото связывается по сильному ключу либо точному store/time/total и дополняет только пустые поля и непривязанные товары при совместимой структуре строк. Суммы и существующие значения не перезаписываются. Неполный/противоречивый результат сохраняется на вырезке, domain-записи откатываются; часть needs_review может иметь Receipt, например при несопоставленном товаре.

Cancel queued сразу даёт cancelled, running — cancel_requested до остановки провайдера. Перед импортом проверяется durable cancel; последний import и terminal status фиксируются одним commit. Уже сохранённые чеки остаются. Ошибка одного crop не теряет другие; terminal statuses: succeeded, partial_succeeded (включая только review), failed, cancelled. Повтор провайдера — максимум одна дополнительная попытка для transient ошибок; budget 2400 с от первого claim, detect 90 с, recognize 180 с/crop.

Доступ новых API: DEBUG + `ALLOW_LOCAL_RECOGNITION_API=1` + loopback peer; unsafe методы требуют CSRF даже для анонима. Авторизации пользователей/владельца чека нет. Health/Celery не проверяют OCR-воркер, Codex или его auth. Запуск — [development.md](development.md#распознавание-запуск-для-клиента), проверки — [verification.md](verification.md#распознавание-сквозная-серверная-проверка).

## Планируется

Клиент загрузки фото/чеков, экраны каталога и цен, ручное сопоставление/редактирование через API, дашборд, серверные курсы валют и пользовательское разграничение. OpenAI API/Claude CLI пока не реализованы. Production-архитектура, retention/cleanup и deployment не определены; защита ручных админских правок от параллельного OCR исключена из v1.

Контракт, модель данных и реальные ограничения проверки: [api-contract.md](api-contract.md), [data-model.md](data-model.md), [verification.md](verification.md).
