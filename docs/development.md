# Локальная разработка

## Реализовано и планируется

Локально запускаются Django/DRF, React/TypeScript/Vite SPA и host `recognition_worker`; Postgres, Redis и Celery worker — в Linux Docker. SPA пока показывает health через proxy ([frontend.md](frontend.md)). Реализованы stores/catalog/receipts, 13 GET каталога/цен и новый локальный recognition/receipts API: загрузка фото, очередь PostgreSQL, detect/crop/recognize/import, отмена и retry. Провайдеры — Codex CLI и явно выбранный FakeProvider. Данные также вводят через [Django admin](#админка). Серверная часть статистики (траты за период, походы, разложение среднего чека, ряды цен) реализована, [запуск с демо](#qa-статистика-для-клиента) — ниже; её клиент — экраны `/stats`, `/stats/receipts` и график цен в карточке товара — тоже ([frontend.md](frontend.md#статистика-траты-средний-чек-и-график-цен-ф1ф7)). Разделение пользователей реализовано: у чеков и фото есть владелец, режим доступа задаёт `CHECKIST_AUTH_MODE` — [режимы доступа и учётные записи](#режимы-доступа-и-учётные-записи); запуск на сервере — отдельный документ [deployment.md](deployment.md). API ручных правок, дашборд и серверные курсы валют ещё не реализованы.

## Версии и установка Windows

| Компонент | Версия / источник |
| --- | --- |
| Python локально | Проверен 3.13.9; использовать minor 3.13 через launcher |
| Django / DRF | 5.2.17 / 3.16.1 |
| Celery / redis-py | 5.6.3 / 6.4.0 |
| psycopg / python-dotenv | 3.3.6 / 1.2.4 |
| Pillow | 12.3.0; декодирование, EXIF, preview и вырезки |
| Postgres / Redis images | `postgres:17.11-alpine` / `redis:7.4.11-alpine` |
| Worker Python image | `python:3.13.16-slim-bookworm` |
| Docker / Compose, проверенная среда | 29.8.1 / 5.5.1, Linux daemon |
| Node / npm | Проверены 24.18.0 / 11.16.0; полный lock — `frontend/package-lock.json` |
| React / TypeScript / Vite | 19.3.0 / 5.9.3 / 8.3.2 |

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

Не используйте bare `python`, если PATH ведёт на другую версию. Активация venv и `Activate.ps1` не нужны. `-X utf8` позволяет воспроизводимо печатать русские ошибки/JSON. Для frontend используйте `npm.cmd`, поскольку PowerShell ExecutionPolicy может блокировать `npm.ps1`; системную политику менять не нужно.

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
| `CHECKIST_AUTH_MODE` | В образце `local_single` — один пользователь `local`, без входа, только при `DJANGO_DEBUG=1`. **Без строки действует `accounts`** — вход обязателен. См. [режимы](#режимы-доступа-и-учётные-записи) |
| `AUTH_LOGIN_FAILURE_LIMIT`, `AUTH_LOGIN_IP_FAILURE_LIMIT`, `AUTH_LOGIN_LOCK_SECONDS` | В образце не заданы; defaults кода 5 / 50 / 900: неудач входа на пару «логин и адрес», на адрес и длина окна в секундах. Границы 1..1000, 1..100000, 1..86400 |
| `VITE_API_BASE_URL` | `/api`, публичный префикс browser-клиента |
| `DEV_API_PROXY_TARGET` | `http://127.0.0.1:8000`, только Node-конфигурация Vite proxy |

Backend валидирует порты (1–65535), hostnames/IP, Redis/rediss URL с `/db` без query/fragment, непустые значения и boolean. `DJANGO_DEBUG=0` с известным dev secret отвергается, как и `DJANGO_DEBUG=0` вместе с `CHECKIST_AUTH_MODE=local_single` (`ImproperlyConfigured` при загрузке настроек: не стартуют `check`, `runserver`, воркер). Серверные переменные (`DJANGO_TRUST_PROXY`, `DJANGO_SECURE_COOKIES`, `DJANGO_HSTS_SECONDS`, `DJANGO_STATIC_ROOT`) в образце закомментированы, их значения по умолчанию следуют за `DJANGO_DEBUG` и локальный запуск не меняют; описание — [deployment.md](deployment.md).

Vite читает тот же корневой `.env` через `envDir`, process environment имеет приоритет. `envPrefix: []` и `define` публикуют только `VITE_API_BASE_URL`, без DB-реквизитов, `DJANGO_SECRET_KEY` и `DEV_API_PROXY_TARGET`. Не помещайте секреты в публичный адрес. После изменения env перезапустите Vite; изменение browser-префикса требует новой сборки. Proxy `/api` сохраняет путь, CORS для внешнего origin не настроен.

В worker всегда используются `postgres:5432`, `redis:6379/0`, `/1`, `/2`, независимо от host-портов. Compose явно передаёт `POSTGRES_DB/USER/PASSWORD`, поэтому QA process overrides распространяются и на worker. `DJANGO_SETTINGS_MODULE=config.settings` устанавливают entry points; Dockerfile также задаёт `PYTHONDONTWRITEBYTECODE=1`, `PYTHONUNBUFFERED=1`.

## Dev-запуск

Windows-запуск с зависимостями проверен в изолированной [QA-среде `checkist_qa2`](verification.md#фактические-результаты-windows-проверки-2026-10-03): Postgres 25433, Redis 16380, Django 18001. Следующий блок — инструкция для отдельной dev-среды; проверка выполнялась с QA overrides, без обращения к dev-данным.

Проверьте свободные порты 15432, 6379, 8000 и 5173:

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

В другом терминале из корня запустите клиент:

```powershell
Set-Location frontend
npm.cmd ci
npm.cmd run lint
npm.cmd run test
npm.cmd run build
npm.cmd run dev
```

Откройте `http://127.0.0.1:5173`; HTTP-проба — `curl.exe -i --max-time 15 http://127.0.0.1:5173/api/health/`. При dev defaults proxy идёт на API 8000 без rewrite. `strictPort: true` запрещает тихий выбор другого порта. `npm.cmd run preview` показывает сборку на том же 5173 с тем же proxy; предварительно остановите dev-сервер. Это локальная приёмка, deployment не настроен.

Для тестовых миграций, очереди и отключений сервисов используйте только [QA-блок и сквозной сценарий](verification.md#сквозная-проверка-клиента-через-vite-proxy): API 18000, Vite 15173, `DEV_API_PROXY_TARGET=http://127.0.0.1:18000`, `VITE_API_BASE_URL=/api`. Все npm-команды выше выполняются с QA environment; dev-команда — `npm.cmd run dev -- --port 15173`. Unit-тесты адаптера используют mocked fetch; реальный adapter/HTTP проверяет `node backend/scripts/check_health_proxy.mjs healthy` из корня при запущенных QA API и Vite. UI принимает человек.

## Режимы доступа и учётные записи

Контракт — [api-contract.md](api-contract.md#реализовано-пользователи-вход-и-доступ-по-владельцу), решение — [multi-user.md](multi-user.md). **Команды этого раздела разработчики не запускали**; их проверяет QA ([verification.md](verification.md#разделение-пользователей-проверки-qa)).

| | `local_single` | `accounts` |
| --- | --- | --- |
| Когда | Обычная разработка и прежние проверки; значение образца `.env` и QA | Проверка входа и разделения; единственный режим сервера |
| Вход | Нет: каждый запрос — пользователь `local` | Логин и пароль, сессионная cookie |
| Нужно ещё | `DJANGO_DEBUG=1`; для чеков, распознавания, статистики, слияний и предположений — `ALLOW_LOCAL_RECOGNITION_API=1` и loopback | Учётная запись с паролем; `ALLOW_LOCAL_RECOGNITION_API` не действует |
| Что видно | Чеки и фото пользователя `local` | Свои чеки и фото; каталог и цены общие |

Значение читается при старте процесса: после смены перезапустите `runserver`. Environment процесса выше `.env`, поэтому режим одного запуска меняется переменной терминала. Воркеру распознавания режим безразличен: владельца он берёт из задания.

### Запуск в `local_single`

Ничего дополнительного: образец `.env` уже содержит `CHECKIST_AUTH_MODE=local_single`, последовательность [dev-запуска](#dev-запуск) прежняя, экрана входа в SPA нет. Если `.env` создан до появления переменной, добавьте строку вручную — иначе действует `accounts` и клиент покажет вход. Пользователя `local` создаёт `migrate` (а при его отсутствии — первый запрос); прежние чеки и фото миграции отдали ему.

### Запуск в `accounts`

```powershell
$env:CHECKIST_AUTH_MODE = "accounts"
./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py migrate --noinput
# прежние данные принадлежат пользователю local: задайте ему пароль, чтобы под ним войти
./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py changepassword local
# либо отдельная учётная запись оператора (is_staff, все права, вход в /admin/)
./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py createsuperuser
./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py runserver 127.0.0.1:8000
```

- Обе команды интерактивные, пароль проверяют четыре стандартных валидатора Django. Пароли не записывайте в `.env`, документы, коммиты и отчёты.
- До `changepassword local` войти под `local` нельзя: у записи нет пригодного пароля. Сама запись обычная — без `is_staff` и без права модератора.
- Остальных пользователей заводит оператор в `/admin/` → Users. Регистрации и сброса пароля по почте нет: забытый пароль меняет оператор (`changepassword <логин>` либо админка). Пользователя не удаляют, а выключают (`Active` снят): `PROTECT` не даст удалить его вместе с чеками.
- **Право модератора каталога** — `catalog | product | Can moderate the shared catalog` в User permissions пользователя либо его группы; у суперпользователя оно есть без выдачи. Без него слияния и предположения доступны только на чтение. `is_staff` модератору не нужен: staff видит в админке чеки всех.
- Клиент: `npm.cmd run dev` как обычно; вход появляется на том адресе, который открыт. Origin Vite должен быть в `DJANGO_CSRF_TRUSTED_ORIGINS` (образец содержит 5173 и 15173), иначе вход ответит `403 csrf_failed`.
- Вход в `/admin/` на том же хосте — это и вход в приложение: cookie сессии привязана к хосту, а не к порту. Выход в SPA завершает и сеанс админки.
- Пять неверных паролей подряд для одного логина закрывают вход с этого адреса на 15 минут — и в приложении, и в `/admin/login/`. Для проверки срок сокращают переменной `AUTH_LOGIN_LOCK_SECONDS` до запуска сервера; снять блокировку раньше можно, удалив строки `accounts_loginfailure` (в админке они только для чтения).
- Прежние proxy-скрипты (`check_recognition_proxy.mjs` и остальные) в `accounts` не работают и сами отказываются стартовать без `CHECKIST_AUTH_MODE=local_single` в своём терминале.

### QA: две учётные записи для клиента

Только пустая QA- либо тестовая база (`checkist_qa…` / `test_…`): команда отказывает, если в базе уже есть товары, чеки, фото или группы слияния.

```powershell
$env:CHECKIST_AUTH_MODE = "accounts"
$env:ACCOUNTS_DEMO_MODERATOR_PASSWORD = "<пароль demo_moderator>"
$env:ACCOUNTS_DEMO_USER_PASSWORD = "<пароль demo_user>"
./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py migrate --noinput
./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py seed_accounts_demo --moderator-password $env:ACCOUNTS_DEMO_MODERATOR_PASSWORD --user-password $env:ACCOUNTS_DEMO_USER_PASSWORD | Out-File -Encoding utf8 (Join-Path $env:TEMP "checkist-accounts-demo.json")
```

`seed_accounts_demo` создаёт вымышленных `demo_moderator` (с правом модератора) и `demo_user`: у каждого чек одного вымышленного магазина с общим товаром, своим товаром и написанием дубля, фото с заданием и вырезкой, файлы которых лежат в `MEDIA_ROOT`; два написания образуют одну ожидающую группу слияния со строками обоих. Печатает одну строку JSON с идентификаторами — её читает `frontend/scripts/check_accounts_proxy.mjs`; пароли не печатаются и хранятся только хэшами. Пароли придумывает QA: разные, проходящие валидаторы. Полный порядок с отдельным Compose-проектом, портами и ручным сценарием — [frontend/src/features/auth/ACCEPTANCE.md](../frontend/src/features/auth/ACCEPTANCE.md).

### Откат миграций владельца

Перед `migrate receipts 0002_alter_receipttax_options` и `migrate recognition 0001_initial` выполните `manage.py ownership check-rollback`: exit 0 и пустой список групп — откат допустим; exit 1 — у двух владельцев есть одинаковый чек либо файл, откат упадёт. Откат стирает владельцев; подробности — [data-model.md](data-model.md#откат-владельца).

## Распознавание: запуск для клиента

API и OCR-worker должны использовать **одни и те же** DB и абсолютный MEDIA_ROOT. Private scratch — другой каталог, вне MEDIA; оба каталога доступны текущему host-пользователю. Задания выполняет `recognition_worker`, Celery нужен только прежним health-проверкам. Health 200 не означает, что OCR-worker запущен. Состояние воркера отдаёт `executor.state` в ответах recognition API: `absent` — воркер этой БД не запущен и ничего не выполняется, `idle` — запущен и ждёт заданий, `busy` — есть задание с действующей lease; `executor.available` = `state != "absent"`. Признак `idle` — сессионная advisory-блокировка, которую `recognition_worker` держит в своей БД: API с другой БД (dev вместо QA) этот воркер не увидит. Проверка: `curl.exe -sS --max-time 15 http://127.0.0.1:18000/api/recognition/csrf/` до и после запуска `recognition_worker --fake-scenario success2`; сценарий — [verification.md](verification.md#состояние-воркера-executorstate).

### Настройки recognition

Образец корневого `.env` содержит defaults; process overrides имеют приоритет. Не передавайте provider/model/scenario/пути через HTTP или VITE env.

| Переменная | Default / граница |
| --- | --- |
| `ALLOW_LOCAL_RECOGNITION_API` | `0`; включить `1` вместе с `DJANGO_DEBUG=1`, peer должен быть loopback. Действует только в `CHECKIST_AUTH_MODE=local_single`; в `accounts` доступ даёт вход |
| `DJANGO_CSRF_TRUSTED_ORIGINS` | Точные локальные origins с портом; образец включает Vite 5173/15173. Другой порт добавлять явно. Не локальный origin принимается только как `https://<хост из DJANGO_ALLOWED_HOSTS>` без порта и пути |
| `MEDIA_ROOT`, `MEDIA_URL` | `<worktree>/media`, `/media/`; абсолютный root, URL в v1 фиксирован строго `/media/` |
| `RECEIPT_OCR_TEMP_ROOT` | Приватный worktree-specific каталог системного temp; абсолютный путь, не пересекается с MEDIA |
| `RECEIPT_OCR_PROVIDER` | `codex_cli` либо явно `fake`; fallback после ошибки отсутствует |
| `RECEIPT_OCR_MODEL` | `gpt-6.1-sol` |
| `RECEIPT_OCR_CODEX_EXECUTABLE` | `codex`; на Windows для worker нужен **native .exe**, не .cmd/.ps1 и не строка shell-команды |
| `RECEIPT_OCR_FAKE_SCENARIO` | Команда читает server environment, default success2; `--fake-scenario` выше по приоритету. Не задан в `.env.example` |
| `RECEIPT_OCR_PREPARE_TIMEOUT_SECONDS`, `RECEIPT_OCR_CROP_TIMEOUT_SECONDS` | 30/30, допустимо 1..300; проверки между шагами, hard deadline синхронного Pillow отсутствует |
| `RECEIPT_OCR_DETECT_TIMEOUT_SECONDS`, `RECEIPT_OCR_RECOGNIZE_TIMEOUT_SECONDS` | 90/180 на вызов, 1..2400 |
| `RECEIPT_OCR_JOB_TIMEOUT_SECONDS` | 2400 от первого claim, 1..86400; включает retry/recovery, исключает исходное queued ожидание |
| `RECEIPT_OCR_CANCEL_GRACE_SECONDS` | 2, 1..10; POSIX TERM→KILL. Windows Job Object останавливается сразу |
| `RECEIPT_OCR_LEASE_SECONDS`, `RECEIPT_OCR_HEARTBEAT_SECONDS` | 30/5; lease 10..300, heartbeat 1..30, heartbeat×2 строго меньше lease |
| `RECEIPT_OCR_MAX_CONCURRENCY`, `RECEIPT_OCR_MAX_ATTEMPTS` | Только 1 worker; 1..2 попытки провайдера, default 2 |
| `RECEIPT_IMAGE_MAX_BYTES`, `RECEIPT_IMAGE_MAX_PIXELS`, `RECEIPT_IMAGE_MAX_RECEIPTS` | Фиксированные 20971520 / 40000000 / 10; другие env-значения отвергаются |

`MEDIA_URL` можно не задавать (default `/media/`) или задать ровно `/media/`. Любое другое значение, включая пустое, `/pictures/`, `/media` и абсолютный URL, вызывает `ImproperlyConfigured` при загрузке настроек: `check`, `runserver` и `recognition_worker` не стартуют. Клиентские проверки URL и Vite dev/preview proxy рассчитаны только на `/media/`; изменение префикса требует согласованной правки клиента и proxy.

Авторизация Codex берётся у существующего host-пользователя; child наследует `CODEX_HOME`, если он уже установлен. Worker проверяет version/flags/login status, не делает login/logout и не меняет auth/config. `RECEIPT_OCR_CODEX_HOME` и `RECEIPT_OCR_DEFAULT_COUNTRY` сейчас **не загружаются из env в settings**: одноимённые getattr hooks в коде не являются готовыми env-настройками. Не создавайте пустой home вместо авторизованного. Для стандартной установки Windows путь проверяют так:

```powershell
$codexExe = Join-Path $env:LOCALAPPDATA 'Programs/OpenAI/Codex/bin/codex.exe'
Test-Path $codexExe
& $codexExe --version
& $codexExe login status
```

Если установлен в другом месте, задайте фактический абсолютный `.exe`. Передавать секреты в browser env нельзя. Поддержанные команды/structured output — [OpenAI Docs](https://learn.chatgpt.com/docs/developer-commands?surface=cli); фактическую совместимость устанавливает startup и отдельный QA-прогон.

### Dev

После обычной установки/миграций и запуска Postgres по разделу выше, в **терминалах API и worker** применить:

```powershell
$env:DJANGO_DEBUG='1'
$env:ALLOW_LOCAL_RECOGNITION_API='1'
$env:MEDIA_ROOT=Join-Path (Get-Location) 'media'
$env:RECEIPT_OCR_TEMP_ROOT=Join-Path $env:TEMP 'checkist-dev-ocr-scratch'
$env:RECEIPT_OCR_PROVIDER='codex_cli'
$env:RECEIPT_OCR_CODEX_EXECUTABLE=Join-Path $env:LOCALAPPDATA 'Programs/OpenAI/Codex/bin/codex.exe'
```

API: `./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py runserver 127.0.0.1:8000 --noreload`.
В другом терминале: `./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py recognition_worker`.
`--once` восстанавливает leases и обрабатывает не более одного готового job; пустая очередь даёт exit 0. Ненулевой exit означает отказ команды, но exit 0 с `Job …: failed/partial_succeeded` требует проверки самого Job.

Тестовые загрузки, демо и настоящую OCR-приёмку проводите в QA по следующему блоку. `seed_recognition_demo` намеренно отвергает dev-БД, поэтому демо не является шагом dev-запуска.

### QA: сервер, worker, демо

В каждом терминале из корня сначала **весь** QA environment из [verification.md](verification.md#изолированная-qa-среда) (DB checkist_qa, Postgres 25432, Redis 16379, три Redis URLs, API 18000, Vite 15173), затем одинаковые overrides:

```powershell
$env:DJANGO_DEBUG='1'
$env:ALLOW_LOCAL_RECOGNITION_API='1'
$env:DJANGO_CSRF_TRUSTED_ORIGINS='http://127.0.0.1:15173,http://localhost:15173'
$env:MEDIA_ROOT=Join-Path $env:TEMP 'checkist-qa-recognition-media'
$env:RECEIPT_OCR_TEMP_ROOT=Join-Path $env:TEMP 'checkist-qa-recognition-scratch'
$env:RECEIPT_OCR_PROVIDER='fake'
docker compose -p checkist_qa config --quiet
docker compose -p checkist_qa up -d --wait --wait-timeout 90 postgres redis
```

Перед host-командами выполнить ограниченные TCP-пробы из [диагностики](#диагностика-нет-доступа-с-windows-к-портам-docker). Если выбран другой свободный QA project/порт, согласованно изменить **все** DB/Redis/API/proxy/origins; не останавливать чужой QA. Затем каждую команду отдельно, прекращая зависимые шаги после ошибки:

```powershell
./backend/.venv/Scripts/python.exe -X utf8 -m pip check
./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py check
./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py migrate --noinput
./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py seed_recognition_demo
```

Seed разрешён для `test_*` или `checkist_qa` с необязательным `_suffix`, идемпотентно создаёт только `MEDIA/demo/single.png` и `double.png`, печатает пути. Он не создаёт DB-записи. Игнорируемые MEDIA-файлы не переносятся при merge: повторить seed в итоговом worktree.

Терминал API с тем же env:

```powershell
./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py runserver 127.0.0.1:18000 --noreload
```

Терминал OCR-worker с тем же env:

```powershell
./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py recognition_worker --fake-scenario success2
```

Загрузить `double.png` HTTP-сценарием из [verification.md](verification.md#распознавание-сквозная-серверная-проверка). Для single.png остановить свой worker и запустить `--fake-scenario one_receipt`. Сценарии partial_success / inconsistent_total / no_receipts / provider_auth_failure / pause_detect / pause_recognize — для негативной приёмки. Налоговые evidence промпта v5 — одна вырезка, чек TESTKAUF из 25 строк на 23.95 EUR: `tax_evidence_missing` (ставки и налоговые итоги без подтверждений чтения: чек сохранён, ставок и итогов нет, 29 замечаний) и `tax_evidence_present` (те же данные с подтверждениями: 25 ставок, 2 итога, 2 замечания); это разные чеки одного магазина, их загружают разными файлами в одну базу — [проверка И6](verification.md#и6-налоговые-evidence-и-сгруппированные-замечания). Полный список — [providers/README.md](../backend/recognition/providers/README.md). Fake не читает текст произвольного фото. Смена scenario не перерабатывает уже завершённый одинаковый файл: использовать retry для failed/partial/cancelled либо другой файл/новую QA-среду.

Клиент: существующие npm-команды, QA `npm.cmd run dev -- --port 15173`. Все новые действия требуют CSRF cookie/token (`credentials: same-origin`), в отличие от health. API возвращает относительные URL с фиксированным `MEDIA_URL=/media/`; Vite dev/preview передают `/api` и `/media` на один Django. Сквозная HTTP-проверка и ручная UI-приёмка — в [verification.md](verification.md#распознавание-сквозная-проверка-клиента-и5).

### QA: подтверждение неполного распознавания для клиента

Сервер с вырезками `needs_review` — для клиента формы подтверждения и ручной приёмки ([контракт](api-contract.md#подтверждение-вырезки-needs_review-человеком)). Новые команды и демо-данные не нужны: неполный результат дают существующие fake-сценарии воркера. Запуск — блок [QA: сервер, worker, демо](#qa-сервер-worker-демо) целиком (свой Compose-проект, БД и порты при параллельной работе), отличается только сценарий воркера:

```powershell
./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py recognition_worker --fake-scenario partial_success
```

Затем загрузить `MEDIA/demo/double.png` (клиентом либо HTTP-сценарием из verification.md) и дождаться завершения задания.

| Сценарий воркера | Что получится | Что исправить, чтобы подтверждение прошло |
| --- | --- | --- |
| `partial_success` | чек 1 сохранён, чек 2 — `needs_review`: у первой строки не прочитаны количество и цена | ввести количество `1.000` и цену `1.5000` первой строки (либо оставить оба пустыми — сервер выведет одну штуку по сумме `1.50`); после подтверждения задание становится `succeeded` |
| `partial_missing_quantity` | обе вырезки `needs_review`, та же причина | чек 1 — `2.000` и `1.2900`; чек 2 — `1.000` и `1.5000` |
| `inconsistent_total` | обе вырезки `needs_review`: итог `123.45` не равен сумме строк | итог `4.42` (чек 1) и `6.00` (чек 2); без правки — `409 review_invalid` с `total_mismatch` |

Суммы синтетических чеков (`recognition/providers/fake.py`): чек 1 — 2.58 + 1.00 + 0.79 + 0.25 минус скидка 0.20 = 4.42 EUR; чек 2 — 1.50 + 4.50 = 6.00 EUR. Смена сценария не перерабатывает уже загруженный файл: для нового сценария нужен другой файл, retry задания либо чистая QA-база. Пока задание не завершено, подтверждение отвечает `409 job_active`; во время импорта воркером — `409 review_busy`.

Проверка без браузера напрямую на Django (id зависят от базы; тела — вне репозитория, образец — `backend/recognition/tests/fixtures/public/review-confirm-request.json`):

```powershell
$B = 'http://127.0.0.1:18000'
$T = (curl.exe -s -c jar.txt "$B/api/recognition/csrf/" | ConvertFrom-Json).csrf_token
$H = @('-b', 'jar.txt', '-H', 'Content-Type: application/json', '-H', "X-CSRFToken: $T", '-H', "Origin: $B")
curl.exe -s -b jar.txt "$B/api/recognition/receipt-images/?job=1"
curl.exe -s @H -X POST --data-binary '@confirm.json' "$B/api/recognition/receipt-images/2/confirm/"
curl.exe -s -b jar.txt "$B/api/recognition/jobs/1/"
```

`Origin` должен совпадать с адресом Django либо входить в `DJANGO_CSRF_TRUSTED_ORIGINS` (для запросов через Vite — его origin). Подтверждение меняет данные: повторяемый сценарий требует чистой QA-базы.

### QA: слияние дублей для клиента

Сервер с демо-каталогом дублей — для клиента и ручной приёмки. В терминале из корня сначала **весь** QA environment из [verification.md](verification.md#изолированная-qa-среда), затем:

```powershell
$env:DJANGO_DEBUG='1'
$env:ALLOW_LOCAL_RECOGNITION_API='1'
$env:PRODUCT_MERGE_AUTO_DETECT='1'
$env:DJANGO_CSRF_TRUSTED_ORIGINS='http://127.0.0.1:15173,http://localhost:15173'
$env:MEDIA_ROOT=Join-Path $env:TEMP 'checkist-qa-recognition-media'
$env:RECEIPT_OCR_TEMP_ROOT=Join-Path $env:TEMP 'checkist-qa-recognition-scratch'
docker compose -p checkist_qa up -d --wait --wait-timeout 90 postgres redis
./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py migrate --noinput
./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py seed_product_merge_demo
./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py product_merges detect --dry-run
./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py product_merges detect
./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py runserver 127.0.0.1:18000 --noreload
```

- `seed_product_merge_demo` разрешён только для `test_*` и `checkist_qa` с необязательным `_суффиксом`; создаёт двух вымышленных продавцов, 9 чеков, 42 строки и 35 товаров; повтор ничего не меняет. Демо-названия не должны совпадать с уже существующими товарами — используйте чистую QA-базу (новый том либо другой `-p`).
- `detect --dry-run` печатает найденные группы и ничего не пишет; `detect` создаёт 7 ожидающих групп, повтор — `created: 0, extended: 0`. На чистой базе id товаров: пицца 2 / 9 / 15 (оставляемый 2), молоко 1 / 6 / 13 / 18 / 21 (оставляемый 1, конфликт `generic` у 1 и 13), «Pizza Hot Dog» — 3.
- Эталонные ответы для схем клиента — `backend/merges/tests/fixtures/public/*.json`; контракт — [api-contract.md](api-contract.md#реализовано-локальный-api-слияния-дублей-товаров-с2).
- На dev `PRODUCT_MERGE_AUTO_DETECT` остаётся `0`, пока владелец не решит применить слияния к dev-данным; `detect` на dev без такого решения не запускайте.
- Сценарий HTTP без браузера и ручная приёмка — [verification.md](verification.md#слияние-дублей-http-без-браузера).

Клиент — во втором терминале с тем же environment, **в PowerShell** (Git Bash переписывает `VITE_API_BASE_URL=/api` в путь Windows):

```powershell
Set-Location frontend
npm.cmd ci
npm.cmd run dev -- --port 15173
# либо сборка: npm.cmd run build; npm.cmd run preview -- --port 15173
```

Экраны — `http://127.0.0.1:15173/catalog/merges`; сценарий для человека и тестовые данные — [frontend/src/features/merges/ACCEPTANCE.md](../frontend/src/features/merges/ACCEPTANCE.md). Проверка адаптеров настоящим HTTP без браузера, из корня в третьем терминале с тем же environment: `node frontend/scripts/check_product_merges_proxy.mjs http://127.0.0.1:15173`. Скрипт подтверждает, отменяет и исключает записи, поэтому запускается один раз на свежей базе после `seed_product_merge_demo` и `detect`; имя базы должно быть `checkist_qa` либо `checkist_qa_<суффикс>`, порты — не dev. Без QA Celery worker `/api/health/` отвечает 503 — слияние от него не зависит.

### QA: предположения категорий для клиента

Сервер с демо-каталогом и применёнными предположениями — для клиента и ручной приёмки. Настройки (корневой `.env`, process overrides выше):

| Переменная | Default / граница |
| --- | --- |
| `ALLOW_LOCAL_RECOGNITION_API` | Тот же флаг, что у распознавания и слияний: `1` вместе с `DJANGO_DEBUG=1` и loopback открывает `/api/product-classifications/`; отдельного флага нет |
| `PRODUCT_CLASSIFICATION_AUTO_SUGGEST` | `0`; `1` — ставить запуск в очередь после импорта чека и после подтверждения вырезки `needs_review`; нужна и воркеру, и процессу API. Держите `0`, пока владелец не решит применять предположения к базе |
| `PRODUCT_CLASSIFICATION_TIMEOUT_SECONDS` | 180, допустимо 1..2400 — срок одного запроса к модели; lease запуска — этот срок + 60 с |
| `PRODUCT_CLASSIFICATION_BATCH_SIZE` | 25, 1..50 — товаров в одном запросе к модели |
| `PRODUCT_CLASSIFICATION_RUN_LIMIT` | 200, 1..1000 — товаров в одном запуске; остальные кандидаты попадут в следующий (`remaining`) |
| `RECEIPT_OCR_PROVIDER`, `RECEIPT_OCR_MODEL`, `RECEIPT_OCR_CODEX_EXECUTABLE`, `RECEIPT_OCR_TEMP_ROOT`, `RECEIPT_OCR_MAX_ATTEMPTS` | Провайдер, модель, исполняемый файл, каталог приватных файлов попытки и число попыток пакета общие с распознаванием. `fake` — явный `FakeClassifier`; `codex_cli` — один текстовый вызов Codex CLI без изображения. Сбой никогда не включает fake |
| `PRODUCT_CLASSIFICATION_FAKE_SCENARIO` | Только для `fake`: сценарий по умолчанию (`mixed`); `--fake-scenario` команды `suggest` и `--classification-fake-scenario` воркера выше по приоритету. Не задан в `.env.example` |

В терминале из корня сначала **весь** QA environment из [verification.md](verification.md#изолированная-qa-среда), затем:

```powershell
$env:DJANGO_DEBUG='1'
$env:ALLOW_LOCAL_RECOGNITION_API='1'
$env:RECEIPT_OCR_PROVIDER='fake'
$env:PRODUCT_MERGE_AUTO_DETECT='0'
$env:PRODUCT_CLASSIFICATION_AUTO_SUGGEST='0'
$env:DJANGO_CSRF_TRUSTED_ORIGINS='http://127.0.0.1:15173,http://localhost:15173'
$env:MEDIA_ROOT=Join-Path $env:TEMP 'checkist-qa-recognition-media'
$env:RECEIPT_OCR_TEMP_ROOT=Join-Path $env:TEMP 'checkist-qa-recognition-scratch'
docker compose -p checkist_qa up -d --wait --wait-timeout 90 postgres redis
./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py migrate --noinput
./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py seed_product_classification_demo
./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py product_classifications suggest --dry-run --fake-scenario mixed
./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py product_classifications suggest --fake-scenario mixed
./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py runserver 127.0.0.1:18000 --noreload
```

- `seed_product_classification_demo` разрешён только для `test_*` и `checkist_qa` с необязательным `_суффиксом`; создаёт вымышленного продавца «Kategoriemarkt», 3 чека, 14 строк, 12 товаров; в каталоге заранее есть «Продукты питания» → «Молочные продукты» и «Молоко» (`l`). Ответ — `{"created": true, "merchants": 1, "products": 12, "receipts": 3, "lines": 14}`, повтор — `{"created": false}`. Нужна чистая QA-база (новый том либо отдельный `-p`, например `checkist_qa_class`): демо-названия не должны совпадать с существующими.
- `suggest --dry-run` вызывает классификатор и печатает проверенные предположения, ничего не пишет. `suggest` выполняет запуск прямо в процессе команды (`trigger: "command"`): `requested: 10, applied: 9, unknown: 1` — 9 ожидающих записей в 7 группах («Кефир» и «Колбаса» по две записи, «Молоко», «Сок», «Средство для мытья посуды», «Сыр», «Хлеб»), создано 6 обобщённых продуктов и 4 категории; «Demo Art. 4711» остаётся без категории. Повтор — `requested: 1, applied: 0, unknown: 1`.
- Id не фиксируются: на чистой базе записи 1–9, но клиент и скрипты ищут их по названиям.
- `product_classifications reconcile` сверяет все ожидающие записи с каталогом; `product_classifications cancel-pending` возвращает каталог к исходному виду (`removed_generics: 6, removed_categories: 4`) — обязателен перед `migrate classification zero`, [откат](data-model.md#откат-classification).
- Кнопка «Предложить категории» (`POST /api/product-classifications/runs/`) только ставит запуск в очередь. Исполняет очередь `recognition_worker`; без него запуск остаётся `queued`, а `executor.state` — `absent`. Запуск воркера — [ниже](#qa-очередь-предположений-и-воркер).
- Эталонные ответы для схем клиента — `backend/classification/tests/fixtures/public/*.json`; контракт — [api-contract.md](api-contract.md#реализовано-локальный-api-предположений-категорий-товаров).
- На dev `PRODUCT_CLASSIFICATION_AUTO_SUGGEST` остаётся `0`, а `suggest` без решения владельца не запускается: предположения сразу меняют `Product.generic`.

Проверка без клиента, во втором терминале (cookie и токен CSRF обязательны для POST):

```powershell
$base = 'http://127.0.0.1:18000/api'
$session = New-Object Microsoft.PowerShell.Commands.WebRequestSession
$token = (Invoke-RestMethod "$base/recognition/csrf/" -WebSession $session).csrf_token
Invoke-RestMethod "$base/product-classifications/status/" -WebSession $session
$page = Invoke-RestMethod "$base/product-classifications/?status=pending" -WebSession $session
$record = $page.results[0]
$body = @{ version = $record.version; generic_id = $record.suggested.generic.id } | ConvertTo-Json
Invoke-RestMethod "$base/product-classifications/$($record.id)/confirm/" -Method Post -WebSession $session `
  -ContentType 'application/json' -Headers @{ 'X-CSRFToken' = $token; Origin = 'http://127.0.0.1:18000' } -Body $body
```

Ожидается: состояние — `pending_count: 9`, `unclassified_count: 1`, `run.status: "succeeded"`, `executor.state: "absent"`; подтверждение — запись `confirmed`, повтор того же запроса — снова `200`. Клиент (Vite 15173) запускается так же, как для [слияния дублей](#qa-слияние-дублей-для-клиента); его proxy-скрипт `frontend/scripts/check_product_classifications_proxy.mjs` появляется на шаге клиента.

### QA: очередь предположений и воркер

Запуск из очереди исполняет `recognition_worker` — тот же процесс и тот же провайдер, что у распознавания; отдельной команды нет. Проход: задание распознавания, если оно есть, иначе один пакет запуска; `--once` — одна единица работы и выход. Статусы и восстановление — [data-model.md](data-model.md#очередь-запусков-classification), что видит клиент — [api-contract.md](api-contract.md#предположения-очередь-и-воркер).

Сценарий fake предположений — флаг `--classification-fake-scenario`, иначе `PRODUCT_CLASSIFICATION_FAKE_SCENARIO`, иначе `mixed`; с `RECEIPT_OCR_PROVIDER=codex_cli` флаг — ошибка запуска. API и воркер используют одну базу и одно окружение. На чистой QA-базе, вместо `suggest` из [предыдущего раздела](#qa-предположения-категорий-для-клиента) (тот же environment, `migrate` и `seed_product_classification_demo` выполнены, API запущен на 18000):

```powershell
# второй терминал: поставить запуск кнопкой (POST) и посмотреть очередь
$base = 'http://127.0.0.1:18000/api'
$session = New-Object Microsoft.PowerShell.Commands.WebRequestSession
$token = (Invoke-RestMethod "$base/recognition/csrf/" -WebSession $session).csrf_token
Invoke-RestMethod "$base/product-classifications/runs/" -Method Post -WebSession $session -ContentType 'application/json' -Headers @{ 'X-CSRFToken' = $token } -Body '{}'
Invoke-RestMethod "$base/product-classifications/status/" -WebSession $session   # run.status queued, executor.state absent
# третий терминал, тот же environment: один пакет и выход
./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py recognition_worker --once --fake-scenario success2 --classification-fake-scenario mixed
# либо постоянный воркер (Ctrl+C — остановка): executor.state idle, во время пакета busy
./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py recognition_worker --fake-scenario success2 --classification-fake-scenario mixed
```

- Без HTTP запуск ставит `manage.py shell -c "from classification import services; print(services.request_run(trigger='manual'))"`.
- Ожидается: `Recognition worker ready.`, затем `Classification run 1: succeeded`; `GET status/` — `pending_count: 9`, `unclassified_count: 1`, `run.status: "succeeded"`, `progress` `requested 10, processed 10, applied 9, unknown 1, skipped 0`; `GET /api/product-classifications/?status=pending` — 9 записей в 7 группах, как у `suggest --fake-scenario mixed`.
- Несколько пакетов: `$env:PRODUCT_CLASSIFICATION_BATCH_SIZE='4'` у воркера — три прохода `--once` печатают `queued`, `queued`, `succeeded`, а `GET runs/1/` между ними показывает `status: "queued"` с заполненным `started_at` и `processed` 4 и 8.
- Негативные сценарии: `provider_error` (две попытки, `failed` / `provider_unavailable`), `auth_failure` (`auth_required`, без повтора), `invalid_output`, `foreign_product`, `missing_product` (`invalid_output`, без повтора), `unknown` (успех без изменений), `service_target` (успех, все пункты отброшены), `existing`, `new_category`, `rejected_again`, `pause` (пакет длится до срока либо остановки — для проверки `busy` и `Ctrl+C`). В сбойных сценариях каталог не меняется; после `failed` кнопка ставит новый запуск.
- Автозапуск: `$env:PRODUCT_CLASSIFICATION_AUTO_SUGGEST='1'` и воркеру, и процессу API (подтверждение вырезки ставит запуск из API, а `status.auto_suggest` показывает значение процесса API). После обработки фото (`Job N: succeeded`) в `status/` появляется `run` с `status: "queued"`, `trigger: "import"`, `scope: "products"`; следующий проход воркера выполняет пакет. Если в очереди уже ждёт запуск — свой `products` либо ручной `scope: "all"` от кнопки, не начатый или между пакетами, — отдельный запуск не создаётся: товары чека дописываются в ждущий за его курсором, у него растут `progress.requested` и `version` (сверх `PRODUCT_CLASSIFICATION_RUN_LIMIT` — `remaining`). С `0` запуск не ставится, товары подбирает кнопка. Повторное фото запуск не ставит.
- Возврат каталога — `product_classifications cancel-pending` при остановленном воркере: запуск, выполняющий пакет, даёт отказ «занято».

**Время одного запроса к модели** с fake не показательно. Измерение — только в QA, на демо-каталоге с вымышленными названиями, с нативным `codex.exe` и действующим входом (`codex login status`); это настоящие модельные запросы, по отдельному решению человека:

```powershell
$env:RECEIPT_OCR_PROVIDER='codex_cli'
# 1. Один запрос без записи в базу: время запроса и проверки ответа.
Measure-Command { ./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py product_classifications suggest --dry-run | Out-Host }
# 2. Тот же запрос через очередь и воркер: один пакет вместе с применением.
./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py shell -c "from classification import services; print(services.request_run(trigger='manual'))"
Measure-Command { ./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py recognition_worker --once | Out-Host }
# 3. Точное время по строкам попыток (без запуска Django и стартовой проверки Codex):
./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py shell -c "from classification.models import ClassificationAttempt as A; [print(a.run_id, a.batch, a.ordinal, a.status, a.error_code, len(a.product_ids), (a.finished_at - a.started_at).total_seconds()) for a in A.objects.order_by('pk')]"
```

`Measure-Command` включает запуск интерпретатора и стартовую проверку Codex воркером (`--version`, `exec --help`, `login status`); время самого запроса — `finished_at - started_at` строки `ClassificationAttempt` (у успешной попытки в него входит и применение ответа). В отчёт: число товаров пакета, время, число предложенных, «не знаю» и отброшенных по причинам (`ClassificationRun.stats`), ошибка — если нет `codex.exe`, входа или сети. Демо-каталог — 10 кандидатов, один пакет; несколько пакетов даёт меньший `PRODUCT_CLASSIFICATION_BATCH_SIZE`. Срок запроса — `PRODUCT_CLASSIFICATION_TIMEOUT_SECONDS`.

Фактическое измерение И1 (2026-10-07, Codex CLI 0.160.0, модель `gpt-6.1-sol`, демо-каталог, текстовый вызов без `-i`): `suggest --dry-run` — 12.3 с всей команды; пакет из 10 товаров через очередь и `recognition_worker --once` — 11.1 с всей команды, попытка — 9.71 с; 9 предложено, 1 «не знаю», отброшенных нет. Предложенные названия и пути — [verification.md](verification.md#фактические-результаты-и1-окончательная-ветка-2026-10-07).

### QA: статистика для клиента

Сервер с демо-данными статистики — для экранов статистики, proxy-скрипта и ручной приёмки. В терминале из корня сначала **весь** QA environment из [verification.md](verification.md#изолированная-qa-среда), затем:

```powershell
$env:DJANGO_DEBUG='1'
$env:ALLOW_LOCAL_RECOGNITION_API='1'
$env:PRODUCT_MERGE_AUTO_DETECT='0'
docker compose -p checkist_qa up -d --wait --wait-timeout 90 postgres redis
./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py migrate --noinput
./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py seed_stats_demo
./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py runserver 127.0.0.1:18000 --noreload
```

- `seed_stats_demo` разрешён только для `test_*` и `checkist_qa` с необязательным `_суффиксом`. На свежей базе печатает `{"created": true, "merchants": 3, "products": 39, "receipts": 466, "lines": 5604, "discounts": 151}`, повтор — `{"created": false}` и ничего не меняет. Случайности нет: числа одинаковы при каждом запуске.
- Данные вымышлены: 2019 год — сентябрь 2026, два немецких магазина разных продавцов (EUR) и казахстанский (KZT), дерево категорий, «Молоко» в каждом магазине, часть товаров в «Не разобрано», несопоставленные строки, залог и возврат тары, услуга, скидки строки и чека, один чек возврата, один чек с ценами без налога. Состав — `backend/receipts/demo.py`, ожидаемые числа — `backend/receipts/tests/test_demo.py`.
- Эталонные ответы совпадают с ответами этого сервера только на **свежей** базе: id в них — категория «Продукты питания» 1, «Молоко» 1, товары молока 1 / 2 / 3, магазины 1 / 2 / 3. Если в базе до демо уже были товары или магазины, id сдвинутся, а одноимённые обобщённые продукты в других категориях изменят суммы по категориям. Список эталонов и запросов — [api-contract.md](api-contract.md#эталонные-ответы-статистики).
- Эндпоинты только читают: одну базу можно использовать повторно. Воркер распознавания и Celery не нужны; `MEDIA_ROOT` и `DJANGO_CSRF_TRUSTED_ORIGINS` для статистики не требуются (POST нет).
- `PRODUCT_MERGE_AUTO_DETECT=0` задавайте явно: значение из `.env` может быть другим. Демо слияния (`seed_product_merge_demo`) можно добавить в ту же базу, но id эталонов статистики верны только когда `seed_stats_demo` выполнен первым.
- В `local_single` при `ALLOW_LOCAL_RECOGNITION_API=0` `/api/stats/*` отвечает `403 permission_denied`, а `/api/products/{id}/prices/series/` остаётся доступным. Демо-чеки принадлежат пользователю `local`: в `accounts` их видит только он.

Проверка без браузера во втором терминале:

```powershell
$B = 'http://127.0.0.1:18000'
curl.exe -s "$B/api/stats/spending/"
curl.exe -s "$B/api/stats/receipts/series/?interval=year"
curl.exe -s "$B/api/stats/receipts/compare/?base_from=2020-01-01&base_to=2020-12-31&current_from=2026-01-01&current_to=2026-09-30&limit=5"
curl.exe -s "$B/api/products/1/prices/series/?date_from=2025-01-01"
```

Vite dev/preview на 15173 запускается как в разделе выше (из PowerShell); proxy `/api` уже передаёт эти пути на Django. Экраны — `http://127.0.0.1:15173/stats`, `/stats/receipts` и `/catalog/products/1`; сценарий для человека и демо-числа — [frontend/src/features/stats/ACCEPTANCE.md](../frontend/src/features/stats/ACCEPTANCE.md). Проверка адаптеров настоящим HTTP без браузера, из корня в третьем терминале с тем же environment: `node frontend/scripts/check_stats_proxy.mjs dev http://127.0.0.1:15173` (для сборки — `preview`). Скрипт только читает, повторный запуск безопасен; ему нужна свежая база с демо, имя базы `checkist_qa` либо `checkist_qa_<суффикс>`, порты — не dev. Ожидаемые ответы и замер времени сервера — [verification.md](verification.md#статистика-серверная-часть-с5), проверка клиента — [там же](verification.md#статистика-клиент-ф7).

### Настоящий Codex в QA

Остановить fake-worker. В том же QA DB/MEDIA/scratch, в терминале worker:

```powershell
$env:RECEIPT_OCR_PROVIDER='codex_cli'
$env:RECEIPT_OCR_MODEL='gpt-6.1-sol'
$env:RECEIPT_OCR_CODEX_EXECUTABLE=Join-Path $env:LOCALAPPDATA 'Programs/OpenAI/Codex/bin/codex.exe'
./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py recognition_worker
```

Для одного измеряемого прогона сначала загрузить новое demo single.png при остановленном worker, затем запустить `recognition_worker --once`; замерить wall time и GET Job/images/receipts. Если этот файл уже обработан fake, точный upload переиспользует его job: для реального прогона нужна новая QA-среда/новое исходное изображение, а succeeded job не retryable. Синтетический smoke и итог С6 — в verification.md; качество реальных фото проверяет человек по эталону. После приёмки Ctrl+C только своих host-процессов и `docker compose -p checkist_qa down`, без `-v`.

## Админка

Django admin работает на том же локальном Django, что и API, отдельного процесса нет. Открывайте его **напрямую**: dev — `http://127.0.0.1:8000/admin/`, QA — `http://127.0.0.1:18000/admin/`. Через Vite (5173/15173) админка недоступна: proxy передаёт только `/api` и `/media`, а `/admin` и `/static` — нет.

Нужны применённые миграции (таблицы `auth`, `sessions`, `admin` создаёт `migrate`) и пользователь с `is_staff`. Готовых пользователей в проекте нет — создайте суперпользователя один раз для каждой БД:

```powershell
./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py createsuperuser
```

Команда интерактивная: логин, e-mail (можно пустой) и пароль вводятся в терминале; пароль проверяют четыре стандартных валидатора Django. Пользователь хранится только в БД того окружения, где выполнена команда: с QA environment из [verification.md](verification.md) он попадёт в `checkist_qa`, без него — в dev. Логин и пароль не записывайте в `.env`, `.env.example`, документы и коммиты. Тесты создают своих пользователей сами в тестовой БД.

Затем запустите `runserver` (команда выше; в QA — `runserver 127.0.0.1:18000`) и войдите на `/admin/`. Worker и Redis для админки не нужны, достаточно Postgres. Заголовок сайта — «Checkist — администрирование». Быстрая проверка без браузера: `curl.exe -i --max-time 15 http://127.0.0.1:8000/admin/` — ожидается 302 на `/admin/login/?next=/admin/`.

Что важно при работе:

- Стили и скрипты админки отдаёт `runserver` только при `DJANGO_DEBUG=1`. При `DJANGO_DEBUG=0` их собирает `collectstatic` и раздаёт обратный прокси, secure-cookie и HTTPS — тоже настройки сервера: [deployment.md](deployment.md).
- У чека есть обязательное поле `Owner`: при добавлении подставлен текущий пользователь, при изменении оно только для чтения; в списке — колонка и фильтр владельца. Оператор видит чеки всех пользователей.
- Вход в админку защищён тем же счётчиком неудач, что и вход в приложение, и в режиме `accounts` является входом в приложение.
- `purchased_at` чека вводится в UTC, `purchased_on` — локальная дата магазина.
- Строку с привязанными залогами или скидками перенести в другой чек нельзя: сначала удалите или отвяжите связи в исходном чеке. Пустые Attributes товара (включая JSON `null`) сохраняются как `{}`, при правке очищая прежнее значение.
- Устаревший inline DELETE уже перенесённой/удалённой записи даёт HTTP 200 с общей ошибкой конфликта и просьбой открыть чек заново; весь POST не сохраняется. DELETE строки вместе с правкой/созданием залога или скидки, сохраняющей ссылку на удаляемую строку, даёт ошибку `parent`/`line`. В одном POST можно отвязать/перепривязать зависимость или удалить её; неизменённые зависимости удаляются каскадом. Ручные сценарии F4 — шаги 9–11 в [verification.md](verification.md#ручная-приёмка-админки-человеком).
- Правки категорий защищены общей транзакционной `pg_try_advisory_xact_lock`: при конфликте второй запрос сразу показывает ошибку `parent` с просьбой повторить сохранение. После первого сохранения повторная попытка создать цикл будет отклонена. Блокировки строк/выбранных связей чеков ожидающие и подчиняются `statement_timeout=2000` мс; formset перечитывает initial inline под NOWAIT. F4 превращает известные ошибки SQL блокировок (занятость, отмена/таймаут, deadlock) в `receipt_inline_busy` и HTTP 200 без сохранения. F6 также откатывает весь POST при известных конфликтах unique и таймаутах сохранения inline, показывая ошибку формы без повтора save. Остальные SQL-запросы сохраняют риск 500; детали и границы гарантии — в [data-model.md](data-model.md#конкурентные-правки).
- Занятые номера строк/скидок и ставки итогов по налогам нельзя использовать другой записью в том же POST, даже при DELETE или переносе занимающей записи: HTTP 200 с ошибкой `position`/`tax_rate`, без сохранения. Освобождение ключа сохраните отдельно. Перестановка 1↔2: три сохранения L1→3, L2→1, L1→2. Отвязка залога и DELETE родителя допустимы при сохранении свободного номера залога. Сценарии F6 — шаги 12–13 в verification.md.
- Названия моделей и полей в интерфейсе английские, остальной интерфейс русский.
- Тестовые чеки, магазины и товары вводите в QA, не в dev.

Какие модели доступны, что формы вычисляют и проверяют, остальные ограничения — в [data-model.md](data-model.md#админка). После правки `admin.py` выполните `manage.py check` (он проверяет конфигурацию админок) и тесты `test_admin.py`; тот же `check` в worker-контейнере обязателен, потому что worker импортирует `admin.py` при старте.

Исправления F1/F2/F4 не меняют схему: откат — revert их кода и тестов, без `migrate ... zero`. Отдельный откат F4 — `git revert a686413`; данные, миграции, модели и settings не затрагиваются. Сохранённые данные остаются, а прежние дефекты возвращаются, в том числе потеря перенесённой строки при устаревшем DELETE и HTTP 500 при правке зависимостей удаляемой строки; утраченные данные revert не восстанавливает. Детали — в [ограничениях админки](data-model.md#ограничения-админки).

## Данные, остановка и восстановление

`migrate` создаёт технические, предметные и recognition-таблицы, вносит справочники: KZ/RU/DE, KZT/RUB/EUR и четыре ставки, создаёт пользователя `local` без пароля — владельца прежних чеков и фото. Пользователя admin создаёт человек. Чеки, магазины и товары вводятся через [админку](#админка), кодом либо автоимпортом OCR; произвольного API редактирования нет. На пустой БД списки пусты; новый receipts API показывает и несопоставленные строки. Тестовые записи — только QA. `postgres_data`/`redis_data` изолированы именем project, MEDIA/scratch — отдельными host-каталогами. Ни Compose down, ни откат recognition, ни ORM deletion не удаляют MEDIA. Перед откатом на ценных данных нужны pg_dump и копия MEDIA; crash может оставить orphan, cleanup исключён v1.

Остановите Vite/preview и Django через Ctrl+C, затем `docker compose -p checkist_dev down`. Это удаляет контейнеры/сеть, сохраняет тома. Для возобновления выполните последовательность запуска выше; повторный `migrate` применяет только недостающие миграции. Правки worker-кода видны через mount, но задачи исполняет долгоживущий процесс: перезапустите worker; изменения зависимостей требуют `up --build`.

После потери Redis допустимо явное восстановление: запустить Redis, перезапустить worker и заново проверить `check_services` и health. Это recovery-проверка, а не сокрытие исходного failed результата. Stop/recovery-сценарии выполняйте в QA.

`down -v` удаляет данные и не нужен для обычной остановки. Значения `POSTGRES_DB/USER/PASSWORD` применяются Postgres image при **первой инициализации пустого тома**: изменение `.env` не перенастраивает существующий кластер. Для чистой одноразовой среды выделите новый project/тома и согласованные порты; ценные данные требуют backup/плана восстановления.

Миграции `catalog`, `stores`, `receipts` обратимы по схеме, но не по данным: откат (`migrate receipts zero`, затем `stores zero`, затем `catalog zero`) удаляет таблицы вместе со всеми чеками, магазинами и товарами. Перед откатом на ценных данных сделайте `pg_dump`; вернуть данные можно только из дампа. Если на сид-строки справочников есть ссылки, `PROTECT` остановит `migrate stores zero`. Порядок действий, пример дампа и ограничения — в [data-model.md](data-model.md#миграции-и-откат). Для будущих миграций оценивайте обратимость отдельно и восстанавливайте backup при необратимом изменении.

## Проверки модели данных

После изменения моделей, миграций, функций или админок трёх приложений выполните в QA-среде команды из [verification.md](verification.md#модель-данных-catalog-stores-receipts): `check`, `makemigrations --check --dry-run`, `migrate`, тесты `catalog stores receipts` без БД и с тегом `integration`. Тесты без тега БД не требуют и запускаются без Docker:

```powershell
./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py test catalog stores receipts --exclude-tag=integration --verbosity=2
```

Новую миграцию создаёт `makemigrations <app>`; проверьте её применение и откат на пустой QA-БД и обновите [data-model.md](data-model.md).

## Проверки API чтения

После изменения `backend/api/`, `backend/config/exceptions.py` или `backend/receipts/prices.py` выполните в QA-среде полный набор тестов с приложением `api` и HTTP-сценарии из [verification.md](verification.md#http-api-чтения). Тесты `api` без тега БД не требуют и запускаются без Docker:

```powershell
./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py test api --exclude-tag=integration --verbosity=2
```

Тесты с тегом `integration` используют образцы `receipts.tests.samples` и фабрики `backend/api/tests/factories.py`. Для ручной пробы в QA-БД образцы вносит `save_samples()`:

```powershell
./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py shell -c "from api.tests.factories import save_samples; save_samples()"
./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py runserver 127.0.0.1:18000 --noreload
curl.exe -i --max-time 15 "http://127.0.0.1:18000/api/products/?page_size=2"
```

Образцы вносятся один раз и только в QA-БД, не в dev. Не-ASCII в query передавайте с percent-encoding: иначе `curl.exe` может отправить строку не в UTF-8, и поиск ничего не найдёт. У `api` нет миграций: `makemigrations --check --dry-run` должен отвечать `No changes detected`, а откат изменений API — это возврат коммитов без действий с БД.

## Диагностика: нет доступа с Windows к портам Docker

Симптомы прежнего отказа: `Test-NetConnection 127.0.0.1 -Port <порт>` возвращает `TcpTestSucceeded=False`, локальное подключение истекает по таймауту, хотя контейнеры healthy и опубликованные порты отвечают изнутри WSL. Ограниченные socket-пробы тогда показывали:

```text
127.0.0.1:25432: TimeoutError: timed out
127.0.0.1:16379: TimeoutError: timed out
```

Локальный `migrate --noinput` в прежней проверке завершился с exit 1:

```text
psycopg.errors.ConnectionTimeout: connection timeout expired
django.db.utils.OperationalError: connection timeout expired
```

Для диагностики сначала настройте QA из verification.md и запустите QA Postgres/Redis, затем выполните TCP-пробы (для другого QA project подставьте его порты):

```powershell
Test-NetConnection 127.0.0.1 -Port 25432
Test-NetConnection 127.0.0.1 -Port 16379
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

`pg_isready` выше использует username образца; при изменённом QA username подставьте его. Healthy и PONG не подтверждают host-доступ. Проверьте режим сети WSL:

```powershell
wsl.exe -d docker-desktop -- wslinfo --networking-mode
```

В `~/.wslconfig` стояло `[wsl2] networkingMode=Mirrored`. Помогло выполненное человеком изменение: закомментировать строку, сохранив остальные настройки:

```ini
[wsl2]
# networkingMode=Mirrored
```

Затем человек выполнил `wsl --shutdown` и перезапустил Docker Desktop. После этого `wslinfo --networking-mode` вернул `virtioproxy`, а Windows TCP-пробы на QA2-портах 25433/16380 — `True`. При неизменном коде прошли Windows миграции, integration tests, `check_services` и HTTP 200/503/405/406; негативные ответы уложились в ≤10 с, после восстановления вернулся 200. Точные результаты — в [verification.md](verification.md#фактические-результаты-windows-проверки-2026-10-03).

Доступ восстановился после изменения окружения; строгая причинность Mirrored против VPN не изолирована. VPN мог быть дополнительным фактором: повторное включение Mirrored и отдельная проверка без VPN не выполнялись. Изменение WSL, VPN/firewall и перезапуск Docker Desktop — решение человека; агенты самостоятельно их не выполняют. После устранения такого отказа повторите локальные QA-команды и HTTP/negative сценарии из verification.md.
