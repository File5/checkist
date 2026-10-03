# Архитектура Checkist

## Реализовано

Серверный scaffold состоит из локального Django/DRF API и трёх Compose services: Postgres, Redis и Celery worker. Docker Desktop использует Linux daemon. Django обращается к опубликованным loopback-портам, worker — к service DNS внутри Compose-сети.

| Процесс | Dev на хосте | QA на хосте | В Docker-сети |
| --- | --- | --- | --- |
| Django/DRF | `127.0.0.1:8000` | `127.0.0.1:18000` | API-контейнер в основной архитектуре отсутствует |
| Postgres | `127.0.0.1:15432` | `127.0.0.1:25432` | `postgres:5432` |
| Redis | `127.0.0.1:6379` | `127.0.0.1:16379` | `redis:6379` |
| Celery worker | Нет published ports | Нет published ports | `checkist@worker`, broker через `redis:6379/0` |
| SPA, **планируется** | `127.0.0.1:5173` | `127.0.0.1:15173` | Контейнер не планируется для локального scaffold |

`localhost` внутри worker означает сам контейнер. Compose переопределяет `POSTGRES_HOST=postgres`, `POSTGRES_PORT=5432` и три Redis URL; изменение host-портов не меняет внутренние порты. Порт 15432 выбран, потому что 5432 в проверенной Windows-среде занят локальным Postgres.

## Потоки и состояние

- `GET /api/health/` запускает три probes параллельно в `ThreadPoolExecutor(max_workers=3)`: SQL `SELECT 1`, Redis cache set/get/delete, Celery inspect ping. Соединения БД каждого probe-потока закрываются. Известный отказ зависимости даёт HTTP 503 с независимыми `checks`.
- `check_services` последовательно проверяет SQL/cache и публикует `health.ping` через реальный broker, затем читает результат. Control ping и выполнение задачи — разные проверки.
- Django global DRF permission — `IsAuthenticated`; health явно открыт без authentication. Бизнес-эндпоинтов и пользовательского входа нет. Стандартные Django apps подключены, но `/admin/` не зарегистрирован.

| Redis logical DB | Назначение | Локальная переменная |
| --- | --- | --- |
| 0 | Очередь/control Celery | `CELERY_BROKER_URL` |
| 1 | Результаты задач, TTL 60 секунд | `CELERY_RESULT_BACKEND` |
| 2 | Django RedisCache, prefix `checkist` | `DJANGO_CACHE_URL` |

Эти DB не являются границей безопасности. Redis без пароля — локальная dev/QA-конфигурация; публикация ограничена `127.0.0.1`. Health cache keys уникальны, TTL 5 секунд, удаление выполняется в `finally`. `health.ping` идемпотентна и не меняет бизнес-данные. При таймауте ожидания уже принятая task может выполниться позже.

Postgres содержит технические таблицы стандартных миграций `admin`, `auth`, `contenttypes`, `sessions`. Собственных моделей/миграций `health` нет. Для scaffold не нужны seed users, чеки или фотографии.

Compose создаёт сеть и тома отдельно по имени project: `checkist_dev` и `checkist_qa`. `postgres_data` хранит `/var/lib/postgresql/data`, `redis_data` — `/data` с AOF и `noeviction`. Worker собран из `backend/Dockerfile`, работает non-root (UID 10001), монтирует `backend/` в `/app:ro`, использует prefork/concurrency 2. Backend/frontend контейнеров, beat и Flower нет.

Postgres/Redis healthchecks запускаются каждые 5 секунд; worker — каждые 10 секунд. `depends_on: service_healthy` управляет стартом worker; healthy не гарантирует связи Windows с опубликованными портами и не заменяет SQL/cache/task проверки. При дальнейшей потере связи нужен отдельный сценарий отказа и восстановления.

## Планируется

React + TypeScript + Vite SPA будет работать локально. Планируемый proxy `/api` → `DEV_API_PROXY_TARGET` сохранит префикс `/api`, чтобы browser использовал same-origin URL; сейчас proxy и frontend-код отсутствуют. `VITE_API_BASE_URL=/api` и `DEV_API_PROXY_TARGET=http://127.0.0.1:8000` пока только заготовлены в `.env.example`.

Продуктовые функции: база данных фото чеков; распознавание магазина и адреса, товаров и стоимостей; категории товаров; дашборд со статистикой. OCR-провайдер, хранение фото, предметная схема данных и пользовательское разграничение ещё не выбраны/не реализованы. Production-архитектура и deployment не определены текущим scaffold.

Контракт и реальные ограничения проверки: [api-contract.md](api-contract.md), [verification.md](verification.md).
