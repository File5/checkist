# Checkist

Checkist распознаёт фото продуктовых чеков через локальный сервер: сохраняет исходник, вырезает чеки, извлекает данные через Codex CLI и импортирует их в PostgreSQL. Есть модель каталога/цен, API, Django admin и отдельный host-worker с отменой/retry. React SPA показывает каталог и цены, загрузку фото, статус/отмену/повтор обработки, форму исправления и подтверждения неполного результата и чеки со строками и ссылками на товары; health доступен отдельно.

Реализовано:

- Django/DRF API `GET /api/health/` с независимыми проверками БД, кеша и control-связи Celery.
- Задача `health.ping` и команда `check_services`, проверяющая настоящее выполнение задачи и получение результата.
- Compose для Postgres, Redis и worker; контрактные и интеграционные тесты.
- React/TypeScript/Vite SPA на русском языке: каталог/история цен, загрузка JPEG/PNG/WebP, задания с cancel/retry, чеки со всеми строками, скидками/налогами и изображениями; health с частичными отказами и повтором. HTTP 503 сохраняет независимые checks.
- Предметная модель данных чеков — приложения `stores` (страны, валюты, ставки налога, продавцы, магазины), `catalog` (категории, обобщённые продукты, бренды, товары) и `receipts` (чеки, позиции, скидки, итоги по налогам, сопоставление названий): модели, собственные миграции с сид-данными, дедупликация, проверка чека, история цен и тесты. Описание, порядок миграций и отката — в [docs/data-model.md](docs/data-model.md).
- Прежние 13 GET каталога/цен открыты анонимно, сохраняют контракт; несопоставленных строк в API цен нет. Курсы только из запроса. Новый локальный API загружает фото, показывает jobs/images и чеки **со всеми строками**, отменяет/повторяет задания. Доступ: DEBUG + флаг + loopback; запись с CSRF даже для анонима. Контракт — [docs/api-contract.md](docs/api-contract.md).
- `recognition`: четыре новые таблицы, PostgreSQL-очередь, `recognition_worker` рядом с Codex CLI, отдельные MEDIA/scratch. FakeProvider для детерминированных тестов; новые магазины/товары создаются автоматически. Повторы связываются по SHA-256/идентичности чека, заполненные значения не перезаписываются. Неполный результат остаётся needs_review с причинами; отмена сохраняет уже импортированные части.
- Подтверждение неполного распознавания: человек исправляет данные вырезки `needs_review` в форме на экране задания и одним `POST /api/recognition/receipt-images/{id}/confirm/` сохраняет чек через тот же импорт. Отказ ничего не сохраняет и возвращает причины; повтор того же запроса не создаёт дублей; уже существующий чек не перезаписывается. Серверного черновика нет: несохранённые правки теряются при перезагрузке страницы. [Контракт](docs/api-contract.md#подтверждение-вырезки-needs_review-человеком), [проверки и ручная приёмка](docs/verification.md#подтверждение-вырезки-needs_review-итог-интеграции).
- Категории новых товаров: приложение `classification` спрашивает модель о товарах, попавших при распознавании в служебное «Не разобрано», и сразу приписывает их к предложенному обобщённому продукту и категории с пометкой «требует подтверждения». На экране `/catalog/classification` человек подтверждает, выбирает другой обобщённый продукт либо отклоняет (товар возвращается в «Не разобрано», созданные пустые записи каталога убираются, тот же вариант повторно не предлагается); пометки видны в каталоге и карточке товара. Локальный `/api/product-classifications/` с тем же доступом и CSRF, что у распознавания; запуск исполняет `recognition_worker`. Автозапуск после импорта — `PRODUCT_CLASSIFICATION_AUTO_SUGGEST` (по умолчанию `0`), вручную — кнопка «Предложить категории» либо `manage.py product_classifications suggest [--dry-run]`; перед `migrate classification zero` — `product_classifications cancel-pending`. Описание — [docs/data-model.md](docs/data-model.md#classification-предположение-обобщённого-продукта), [контракт](docs/api-contract.md#реализовано-локальный-api-предположений-категорий-товаров), [запуск в QA](docs/development.md#qa-предположения-категорий-для-клиента), [приёмка](frontend/src/features/classification/ACCEPTANCE.md).
- Django admin для ручного ввода и правки этих данных: `http://127.0.0.1:8000/admin/` напрямую на Django, не через Vite. Зарегистрированы 12 моделей, скидки и итоги по налогам правятся внутри чека. Только для локальных dev/QA; состав и ограничения — в [docs/data-model.md](docs/data-model.md#админка).

Планируются HTTP правка сохранённых чеков и сопоставление товаров, пользовательский вход/разграничение, дашборд, серверные курсы валют, OpenAI API/Claude CLI providers и production hosting. Облегчённая v1 не включает ReceiptDraft и серверный черновик, MutationRequest/Idempotency-Key, cleanup, POSIX watchdog, manual_locked, защиту stale admin POST от OCR, правку сохранённого чека через API и выбор товара каталога при подтверждении. Качество реальных фото требует ручной приёмки.

## Требования

Python 3.13 с `py` launcher, Docker Desktop с Linux daemon, Docker Compose, Node 24 и npm 11. Проверенная среда интеграции: Python 3.13.9, Node 24.18.0, npm 11.16.0, Docker 29.8.1, Compose 5.5.1. Зависимости закреплены в `backend/requirements.txt` и `frontend/package-lock.json`.

## Быстрый запуск на Windows

PowerShell, из корня репозитория. Если `.env` уже есть, сохраните его настройки; копирование выполняйте только при первом запуске. Не меняйте ExecutionPolicy: используйте Python из venv напрямую.

```powershell
if (!(Test-Path .env)) { Copy-Item .env.example .env }
py -3.13 -m venv backend/.venv
./backend/.venv/Scripts/python.exe -X utf8 -m pip install -r backend/requirements.txt
./backend/.venv/Scripts/python.exe -X utf8 -m pip check
docker compose -p checkist_dev config --quiet
docker compose -p checkist_dev up -d --wait --wait-timeout 90 postgres redis
./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py migrate --noinput
docker compose -p checkist_dev up -d --build --wait --wait-timeout 120 worker
./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py check_services
./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py runserver 127.0.0.1:8000
```

В другом терминале: `curl.exe -i --max-time 15 http://127.0.0.1:8000/api/health/`. Ожидается HTTP 200 с тремя `ok`. Postgres опубликован на `127.0.0.1:15432`, Redis — на `127.0.0.1:6379`; порт 5432 занят локальным Postgres в проверенной среде.

Админка: один раз создайте суперпользователя — `./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py createsuperuser` (логин и пароль вводятся в терминале и в репозиторий не попадают), затем откройте `http://127.0.0.1:8000/admin/`. Подробности — в [development.md](docs/development.md#админка).

В отдельном терминале из корня запустите клиент (используйте `npm.cmd`, без изменения ExecutionPolicy):

```powershell
Set-Location frontend
npm.cmd ci
npm.cmd run lint
npm.cmd run test
npm.cmd run build
npm.cmd run dev
```

Откройте `http://127.0.0.1:5173`. Корневой `.env` задаёт `VITE_API_BASE_URL=/api` и Node-only `DEV_API_PROXY_TARGET=http://127.0.0.1:8000`; proxy сохраняет `/api/health/`. Проверяйте exit code каждого шага. Остановите Vite и Django через Ctrl+C, затем `docker compose -p checkist_dev down` из корня.

Проверки миграций, очереди и отключения сервисов выполняйте только с QA overrides из [verification.md](docs/verification.md). В QA API 18000, Vite 15173, Postgres 25432, Redis 16379. Visual/browser UI принимает человек.

## Сервер распознавания для клиента

В каждом терминале сначала полный [QA environment и recognition overrides](docs/development.md#qa-сервер-worker-демо), одинаковые DB/MEDIA и отдельный private scratch. После запуска QA Postgres/Redis и успешной TCP-пробы:

```powershell
./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py migrate --noinput
./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py seed_recognition_demo
./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py runserver 127.0.0.1:18000 --noreload
```

В другом терминале с тем же environment, provider=fake:

```powershell
./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py recognition_worker --fake-scenario success2
```

Загрузить `MEDIA/demo/double.png` с CSRF, опрашивать Job, открыть crops/receipts/lines — [HTTP-сценарий](docs/verification.md#httpcli-без-браузера). Для single.png — one_receipt; для Codex остановить fake-worker, provider=codex_cli, native `.exe`, существующий host login. `--once` обрабатывает до одного job; его exit 0 не гарантирует автоимпорт. Seed разрешён только QA/test, не dev; после merge его повторяют в итоговом worktree. [Dev-запуск, env и ограничения](docs/development.md#распознавание-запуск-для-клиента).

Vite dev/preview проксирует `/api` и `/media`. Новый API требует cookie/CSRF и same-origin credentials, точный Origin клиента должен быть в DJANGO_CSRF_TRUSTED_ORIGINS; прежний health остаётся анонимным. Полный [QA-запуск клиента, CLI dev/preview и ручная приёмка И5](docs/verification.md#распознавание-сквозная-проверка-клиента-и5). После проверки остановить свои host-процессы и `docker compose -p checkist_qa down`, без `-v`.

**Текущее состояние миграций (множественные числа в админке, 2026-10-07):** 27 миграций на пустой базе — к прежним 25 добавлены `stores.0003` и `receipts.0002` (только `AlterModelOptions`, без SQL и данных; в админке `Countries`, `Currencies`, `Receipt taxes`). Проверки на этом состоянии выполняет QA; результаты ниже получены до этих миграций.

**Проверено и прошло (предположения категорий, И1, 2026-10-07, окончательная ветка):** backend 421 тест без БД и 1435 integration с `classification`, 25 миграций на пустой базе, `check_services`; frontend `npm.cmd ci` / `lint` / `test` (1934 теста, 51 файл) / `build` — exit 0; настоящий Django + fake через Vite dev **и preview**: `check_review_proxy.mjs`, `check_recognition_proxy.mjs`, `check_product_merges_proxy.mjs` и `check_product_classifications_proxy.mjs` (62 запроса, 21 POST) — exit 0; сквозной сценарий импорт → автозапуск → воркер → выключенный API → `cancel-pending` → `migrate classification zero`. Реальная модель в QA на демо-каталоге (Codex CLI 0.160.0, 2 запроса): 10 товаров одним запросом примерно за 10 с, 9 предложено, 1 «не знаю». Экран и пометки в браузере принимает человек — [команды и результаты](docs/verification.md#фактические-результаты-и1-окончательная-ветка-2026-10-07). На машине с `codex.exe` в PATH и выполненным входом любой запуск с `RECEIPT_OCR_PROVIDER=codex_cli`, дошедший до провайдера, делает настоящий модельный запрос: для проверок ставьте `fake`, в тестах с `codex_cli` — `RECEIPT_OCR_CODEX_EXECUTABLE="nonexistent-checkist-codex"` и подмену запуска процесса.

**Проверено и прошло (подтверждение вырезки, четвёртый заход после проверки интерфейса, 2026-10-06, только клиент):** frontend `npm.cmd ci` / `lint` / `test` (1521 тест, 44 файла) / `build` — exit 0; backend и proxy-скрипты не запускались, сервер не менялся; исправление строки «Запрос не отправлен…» в браузере принимает человек — [результаты четвёртого захода](docs/verification.md#фактические-результаты-четвёртый-заход-после-проверки-интерфейса-2026-10-06).

**Проверено и прошло (подтверждение вырезки, третий заход после проверки интерфейса, 2026-10-06):** backend 335 тестов без БД и 1130 integration, frontend `npm.cmd ci` / `lint` / `test` (1509 тестов, 44 файла; повторный заход — 1480 / 44, до исправлений клиента — 1446 / 43) / `build` — exit 0; настоящий Django + fake host-worker через Vite dev **и preview**: `check_review_proxy.mjs` (64 запроса, 15 POST confirm), `check_recognition_proxy.mjs`, `check_product_merges_proxy.mjs` — exit 0; расхождений клиента и сервера нет. Сверка настоящих ответов с эталонами прямым HTTP выполнена в итоге интеграции и на повторном и третьем заходах не повторялась: сервер не менялся. Экран формы в браузере, включая исправления фокуса после удаления записи и исчезающих кнопок и чтение списка после отказа второй вырезки, принимает человек: [результаты третьего захода](docs/verification.md#фактические-результаты-третий-заход-после-проверки-интерфейса-2026-10-06), [команды и сценарий](docs/verification.md#подтверждение-вырезки-needs_review-итог-интеграции), [шаги](frontend/src/features/recognition/ACCEPTANCE.md).

**Проверено и прошло (И5, 2026-10-05):** `npm.cmd ci`, `npm.cmd run lint`, `npm.cmd run test` (897/32), `npm.cmd run build` — exit 0; настоящий Django + fake host-worker через Vite dev **и preview** — exit 0: 2 чека/6 строк/5 товаров, PNG MEDIA, CSRF, повтор, отмена queued/running, retry, needs_review и ошибки файлов. Сборка и HTTP не подтверждают визуальное/интерактивное поведение React. [Показ и сценарий](frontend/I5_ACCEPTANCE.md).

**Проверено и прошло (С6, 2026-10-04–05):** Windows → изолированные QA Postgres/Redis, 247 тестов без БД + 846 integration (включая 9 новых сквозных), check/pip check/makemigrations, миграция recognition вперёд/назад/вперёд, настоящая Celery task/result. Реальный HTTP + fake: 2 вырезки/чека, 6 строк, 5 товаров, media GET и SHA-256 replay. Старые админские F4/F6 и 13 GET входят в регрессию. [Команды и результаты](docs/verification.md#фактические-результаты-с6).

**Проверено и не прошло (исторический С6):** один реальный Codex CLI 0.160.0 прогон на синтетическом single.png за 102.738 с не дал автоимпорт: Job partial_succeeded, вырезка needs_review (не определена операция, неоднозначен реквизит кассы). В И4 причина исправлена и настоящий single/double прошёл с автоимпортом 2 чеков/6 строк/5 товаров; [итоговый прогон И4](docs/verification.md#повторный-прогон-после-согласованного-уточнения-и4). Это серверный OCR-прогон; качество реальных пользовательских фото и браузерный UI он не подтверждает.

**Не проверено:** реальные фото/полевое качество, визуальное/интерактивное поведение UI загрузки/чеков и формы подтверждения — принимает человек; [ручной сценарий](docs/verification.md#ручная-приёмка-ocr-человеком). Полный Linux OCR/suite, нагрузка и восстановление backup не проверены. Подробности и исторические отчёты админки/API — в verification.md.

## Документация

- [AGENTS.md](AGENTS.md) — обязательные правила работы ИИ-агентов и владение файлами.
- [Архитектура](docs/architecture.md) — процессы, адреса, данные и границы scaffold.
- [Модель данных](docs/data-model.md) — таблицы чеков, магазинов и каталога, ограничения, дедупликация, админка, миграции и откат.
- [Контракт API](docs/api-contract.md) — health, API чтения каталога и цен, ошибки, права, таймауты и обработка 503 клиентом.
- [Frontend](docs/frontend.md) — клиентский адаптер, env/proxy, scripts и состояния страницы.
- [Разработка](docs/development.md) — env, установка, запуск, остановка и диагностика Windows/Docker.
- [Проверки](docs/verification.md) — изолированная QA-среда, фактические результаты и ручные сценарии.

Публикация и выпуск версии не входят в текущий scaffold.
