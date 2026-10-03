# Checkist

Checkist — проект распознавания чеков из продуктовых магазинов. Сейчас реализованы **клиентский и серверный каркас** — React-страница проверяет связь через Vite proxy с Django, Postgres, Redis и Linux Celery worker, — **модель данных чеков** и **HTTP API чтения** каталога и цен.

Реализовано:

- Django/DRF API `GET /api/health/` с независимыми проверками БД, кеша и control-связи Celery.
- Задача `health.ping` и команда `check_services`, проверяющая настоящее выполнение задачи и получение результата.
- Compose для Postgres, Redis и worker; контрактные и интеграционные тесты.
- React/TypeScript/Vite SPA на русском языке: загрузка, успех, частичный отказ сервисов, ошибки и кнопка повтора. HTTP 503 сохраняет независимые checks.
- Предметная модель данных чеков — приложения `stores` (страны, валюты, ставки налога, продавцы, магазины), `catalog` (категории, обобщённые продукты, бренды, товары) и `receipts` (чеки, позиции, скидки, итоги по налогам, сопоставление названий): модели, собственные миграции с сид-данными, дедупликация, проверка чека, история цен и тесты. Описание, порядок миграций и отката — в [docs/data-model.md](docs/data-model.md).
- HTTP API чтения — приложение `api`, 13 GET-эндпоинтов под `/api/`: страны, магазины, бренды, категории, обобщённые продукты, товары, история цен и её сводка, сравнение альтернативных товаров между странами и валютами. Контракт — [docs/api-contract.md](docs/api-contract.md#реализовано-api-чтения-каталога-и-цен). Эндпоинты открыты анонимно на чтение: перед любым внешним развёртыванием доступ нужно закрыть. Курсы валют сервер не хранит — пересчёт только по курсам из запроса. Записи через HTTP и админки нет: данные вводятся только кодом, а позиции чеков, не сопоставленные с товаром, в API не видны. Клиент эти эндпоинты пока не использует.

Планируется, ещё не реализовано: хранение фото чеков; распознавание магазина и его адреса, товаров и их стоимостей; HTTP API записи и интерфейс ввода чеков и сопоставления позиций; экраны каталога и цен; дашборд со статистикой. OCR-провайдер ещё не выбран. Пользовательского входа, API записи и серверных курсов валют пока нет.

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

Проверки миграций, очереди и отключения сервисов выполняйте только с QA overrides из [verification.md](docs/verification.md). В QA API слушает 18000, Vite — 15173, Postgres — 25432, Redis — 16379. Результаты реальной интеграции и границы проверки находятся там же; visual/browser UI принимает человек, HTTP 500 покрыт только mocks.

**Статус проверки модели данных:** в изолированной QA-среде `-p checkist_qa_t5` на пустой БД применены 22 миграции, включая `catalog.0001`, `stores.0001`, `stores.0002`, `receipts.0001`; откат трёх приложений и повторное применение успешны; 62 теста без БД и 158 integration tests приложений `catalog`, `stores`, `receipts`, `health` прошли. Восстановление из `pg_dump` и поведение на больших объёмах не проверялись. Подробности — в [проверках](docs/verification.md).

**Статус проверки API чтения:** в изолированной QA-среде `-p checkist_qa_a5` новых миграций нет (`No changes detected`); прошли 144 теста без БД и 393 integration tests приложений `catalog`, `stores`, `receipts`, `health`, `api`; 13 эндпоинтов и негативные сценарии проверены `curl.exe` на настоящем сервере с образцами чеков. Известное ограничение: `POST/PUT/PATCH` на путь без завершающего `/` при `DJANGO_DEBUG=1` получает HTML `500` от Django, а не JSON. Вызовы из браузера и SPA, `500` и `range_too_large` на настоящем сервере, большие объёмы не проверялись. Откат API — возврат коммитов, миграций нет. Подробности — в [проверках](docs/verification.md#фактические-результаты-проверки-api-чтения-2026-10-03).

## Документация

- [AGENTS.md](AGENTS.md) — обязательные правила работы ИИ-агентов и владение файлами.
- [Архитектура](docs/architecture.md) — процессы, адреса, данные и границы scaffold.
- [Модель данных](docs/data-model.md) — таблицы чеков, магазинов и каталога, ограничения, дедупликация, миграции и откат.
- [Контракт API](docs/api-contract.md) — health, API чтения каталога и цен, ошибки, права, таймауты и обработка 503 клиентом.
- [Frontend](docs/frontend.md) — клиентский адаптер, env/proxy, scripts и состояния страницы.
- [Разработка](docs/development.md) — env, установка, запуск, остановка и диагностика Windows/Docker.
- [Проверки](docs/verification.md) — изолированная QA-среда, фактические результаты и ручные сценарии.

Публикация и выпуск версии не входят в текущий scaffold.
