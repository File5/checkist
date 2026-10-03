# Локальная разработка

## Реализовано и планируется

Сейчас запускаются Django/DRF локально и Postgres, Redis, Celery worker в Linux Docker. React + TypeScript + Vite SPA планируется на следующем этапе; `frontend/` и его package scripts пока отсутствуют. База фото чеков, OCR магазина/адреса и товаров/стоимостей, категории и дашборд не реализованы; OCR-провайдер и предметная модель не выбраны.

## Версии и установка Windows

| Компонент | Версия / источник |
| --- | --- |
| Python локально | Проверен 3.13.9; использовать minor 3.13 через launcher |
| Django / DRF | 5.2.17 / 3.16.1 |
| Celery / redis-py | 5.6.3 / 6.4.0 |
| psycopg / python-dotenv | 3.3.6 / 1.2.4 |
| Postgres / Redis images | `postgres:17.11-alpine` / `redis:7.4.11-alpine` |
| Worker Python image | `python:3.13.16-slim-bookworm` |
| Docker / Compose, проверенная среда | 29.8.1 / 5.5.1, Linux daemon |
| Node / npm, для будущего frontend | Проверены 24.18.0 / 11.16.0; frontend-зависимости ещё не закреплены |

`backend/requirements.in` содержит прямые зависимости, `requirements.txt` — точные прямые и транзитивные версии. Устанавливайте полный набор из `.txt`; обновление lock должно сохранять совместимость Windows и Linux. Случайное обновление redis-py поверх набора не требуется.

Все команды ниже — PowerShell из корня репозитория, если не сказано иное. Проверяйте `$LASTEXITCODE` сразу после каждой native-команды и прекращайте зависимые шаги при ненулевом коде.

```powershell
py -3.13 --version
docker --version
docker compose version
docker info --format 'OS={{.OSType}}'
py -3.13 -m venv backend/.venv
./backend/.venv/Scripts/python.exe -X utf8 -m pip install -r backend/requirements.txt
./backend/.venv/Scripts/python.exe -X utf8 -m pip check
```

Не используйте bare `python`, если PATH ведёт на другую версию. Активация venv и `Activate.ps1` не нужны. `-X utf8` позволяет воспроизводимо печатать русские ошибки/JSON. При будущей установке frontend используйте `npm.cmd`, поскольку PowerShell ExecutionPolicy может блокировать `npm.ps1`; системную политику менять не нужно.

## `.env`

Первый запуск: `Copy-Item .env.example .env`. Существующий `.env` не перезаписывайте. Он не коммитится. Backend загружает **корневой** файл через python-dotenv, `override=False`: environment текущего процесса → `.env` → defaults кода. Значения Compose берутся из process environment/его `.env`; `-p` имеет приоритет над `COMPOSE_PROJECT_NAME`. Worker получает `env_file: .env` и явные container-overrides. Даже при process overrides файл `.env` нужен для `env_file`.

| Переменная | Default в образце / назначение |
| --- | --- |
| `COMPOSE_PROJECT_NAME` | `checkist_dev` |
| `POSTGRES_DB` | `checkist_dev` |
| `POSTGRES_USER`, `POSTGRES_PASSWORD` | Публичные dev-only реквизиты из образца; не рабочий секрет |
| `POSTGRES_HOST` | `127.0.0.1` для локального Django |
| `POSTGRES_PORT` | `15432`, одновременно published port и порт локального клиента |
| `REDIS_PORT` | `6379`, published port; URL ниже нужно менять вместе с ним |
| `CELERY_BROKER_URL` | `redis://127.0.0.1:6379/0` |
| `CELERY_RESULT_BACKEND` | `redis://127.0.0.1:6379/1` |
| `DJANGO_CACHE_URL` | `redis://127.0.0.1:6379/2` |
| `DJANGO_SECRET_KEY` | Известный dev-only placeholder из образца |
| `DJANGO_DEBUG` | `1`; поддержаны `0`, `1`, `true`, `false` без учёта регистра |
| `DJANGO_ALLOWED_HOSTS` | `127.0.0.1,localhost`; wildcard не разрешён |
| `VITE_API_BASE_URL` | `/api`, заготовка для будущего browser-клиента |
| `DEV_API_PROXY_TARGET` | `http://127.0.0.1:8000`, заготовка для будущего Vite proxy |

Backend валидирует порты (1–65535), hostnames/IP, Redis/rediss URL с `/db` без query/fragment, непустые значения и boolean. `DJANGO_DEBUG=0` с известным dev secret отвергается. Эти ограничения не заменяют production-настройку.

В worker всегда используются `postgres:5432`, `redis:6379/0`, `/1`, `/2`, независимо от host-портов. Compose явно передаёт `POSTGRES_DB/USER/PASSWORD`, поэтому QA process overrides распространяются и на worker. `DJANGO_SETTINGS_MODULE=config.settings` устанавливают entry points; Dockerfile также задаёт `PYTHONDONTWRITEBYTECODE=1`, `PYTHONUNBUFFERED=1`.

## Dev-запуск

Проверки данной задачи выполнялись только в [QA](verification.md). Следующий блок — инструкция для отдельной dev-среды; успешный локальный Windows запуск с зависимостями сейчас не подтверждён из-за описанного ниже TCP-отказа.

Проверьте свободные порты 15432, 6379, 8000 и, позднее, 5173:

```powershell
Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
  Where-Object LocalPort -in @(15432, 6379, 8000, 5173) |
  Select-Object LocalAddress, LocalPort, OwningProcess
```

5432 занят локальным Postgres в проверенной среде. Его не останавливайте: Docker Postgres публикуется на 15432. Если нужный порт занят, измените соответствующий env и все связанные URL/аргументы CLI.

```powershell
docker compose -p checkist_dev config --quiet
docker compose -p checkist_dev up -d --wait --wait-timeout 90 postgres redis
./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py check
./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py migrate --noinput
docker compose -p checkist_dev up -d --build --wait --wait-timeout 120 worker
docker compose -p checkist_dev ps
docker compose -p checkist_dev logs --tail 50 worker
./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py check_services
./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py runserver 127.0.0.1:8000
```

Ожидается: три healthy services, миграции применены, `check_services` exit 0 с реальным pong, локальный Django слушает 8000. В другом терминале — `curl.exe -i --max-time 15 http://127.0.0.1:8000/api/health/`, ожидается 200 и три `ok`. Curl без `--fail` может вернуть exit 0 при HTTP 503/405: проверяйте статус и JSON отдельно. Worker уже запущен Compose; отдельный Windows Celery worker не нужен.

Будущий frontend будет запускаться локально через `npm.cmd` из `frontend/`, dev-порт 5173, QA 15173; полный порядок и фактические scripts появятся в `docs/frontend.md`. Пока не запускайте команды установки отсутствующего frontend.

## Данные, остановка и восстановление

Технические таблицы создаёт `migrate`; seed users/фото чеков не нужны. `postgres_data` и `redis_data` — именованные тома с префиксом Compose project. Redis хранит AOF; mount `backend:/app:ro` не хранит состояние приложения. Dev и QA не делят эти тома.

Остановите Django через Ctrl+C, затем `docker compose -p checkist_dev down`. Это удаляет контейнеры/сеть, сохраняет тома. Для возобновления выполните последовательность запуска выше; повторный `migrate` применяет только недостающие миграции. Правки worker-кода видны через mount, но задачи исполняет долгоживущий процесс: перезапустите worker; изменения зависимостей требуют `up --build`.

После потери Redis допустимо явное восстановление: запустить Redis, перезапустить worker и заново проверить `check_services` и health. Это recovery-проверка, а не сокрытие исходного failed результата. Stop/recovery-сценарии выполняйте в QA.

`down -v` удаляет данные и не нужен для обычной остановки. Значения `POSTGRES_DB/USER/PASSWORD` применяются Postgres image при **первой инициализации пустого тома**: изменение `.env` не перенастраивает существующий кластер. Для чистой одноразовой среды выделите новый project/тома и согласованные порты; ценные данные требуют backup/плана восстановления. Миграции не имеют автоматического универсального отката: оценивайте обратимость конкретной будущей миграции и восстанавливайте backup при необратимом изменении.

## Диагностика Windows → Docker published ports

На документационном этапе 2026-10-03 ограничение предыдущего worker воспроизвелось. При healthy QA Postgres/Redis:

```text
127.0.0.1:25432: TimeoutError: timed out
127.0.0.1:16379: TimeoutError: timed out
```

Локальный `./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py migrate --noinput` с QA environment завершился с exit 1. Точные строки исключений, без пользовательских путей:

```text
psycopg.errors.ConnectionTimeout: connection timeout expired
django.db.utils.OperationalError: connection timeout expired
```

Причина не установлена; проблема проброса Docker Desktop — предположение, не доказанный диагноз. Не перезапускайте Docker Desktop и не меняйте firewall/системные настройки в этой задаче.

Воспроизведение: сначала настройте QA из verification.md и запустите QA Postgres/Redis, затем выполните ограниченные TCP-пробы:

```powershell
@'
import socket
for port in (25432, 16379):
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=2):
            print(f"127.0.0.1:{port}: TCP OK")
    except OSError as error:
        print(f"127.0.0.1:{port}: {type(error).__name__}: {error}")
'@ | ./backend/.venv/Scripts/python.exe -X utf8 -
```

Скрипт печатает диагностический результат; exit 0 сам по себе не означает доступности портов. При таймауте не повторяйте локальные миграции/integration tests/check_services по кругу. Сопоставьте host-путь с доступностью внутри контейнеров:

```powershell
docker compose -p checkist_qa ps
docker compose -p checkist_qa port postgres 5432
docker compose -p checkist_qa port redis 6379
docker compose -p checkist_qa exec -T postgres pg_isready -U checkist -d checkist_qa
docker compose -p checkist_qa exec -T redis redis-cli ping
docker compose -p checkist_qa exec -T worker python -X utf8 manage.py check_services
```

`pg_isready` выше использует username образца; при изменённом QA username подставьте его. Healthy и PONG не подтверждают host-доступ. Linux SQL/cache/task проверки прошли, а успешные Windows миграции, интеграционные тесты и API с зависимостями остаются **непроверенными**. После устранения внешней причины повторите локальные QA-команды из verification.md, сравните HTTP 200/503 и негативное время ответа. Системную причину диагностирует человек или отдельная авторизованная задача.
