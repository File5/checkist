# Checkist

Checkist — проект распознавания чеков из продуктовых магазинов. Сейчас реализованы **клиентский и серверный каркас** — React-страница проверяет связь через Vite proxy с Django, Postgres, Redis и Linux Celery worker — и **модель данных чеков**.

Реализовано:

- Django/DRF API `GET /api/health/` с независимыми проверками БД, кеша и control-связи Celery.
- Задача `health.ping` и команда `check_services`, проверяющая настоящее выполнение задачи и получение результата.
- Compose для Postgres, Redis и worker; контрактные и интеграционные тесты.
- React/TypeScript/Vite SPA на русском языке: загрузка, успех, частичный отказ сервисов, ошибки и кнопка повтора. HTTP 503 сохраняет независимые checks.
- Предметная модель данных чеков — приложения `stores` (страны, валюты, ставки налога, продавцы, магазины), `catalog` (категории, обобщённые продукты, бренды, товары) и `receipts` (чеки, позиции, скидки, итоги по налогам, сопоставление названий): модели, собственные миграции с сид-данными, дедупликация, проверка чека, история цен и тесты. Описание, порядок миграций и отката — в [docs/data-model.md](docs/data-model.md). HTTP API для этих данных нет.
- Django admin для ручного ввода и правки этих данных: `http://127.0.0.1:8000/admin/` напрямую на Django, не через Vite. Зарегистрированы 12 моделей, скидки и итоги по налогам правятся внутри чека. Только для локальных dev/QA; состав и ограничения — в [docs/data-model.md](docs/data-model.md#админка).

Планируется, ещё не реализовано: хранение фото чеков; распознавание магазина и его адреса, товаров и их стоимостей; HTTP API и интерфейс ввода чеков; дашборд со статистикой. OCR-провайдер ещё не выбран. Бизнес-API и пользовательского входа в SPA пока нет; единственный вход — в админку, для пользователей с `is_staff`.

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

Проверки миграций, очереди и отключения сервисов выполняйте только с QA overrides из [verification.md](docs/verification.md). В QA API слушает 18000, Vite — 15173, Postgres — 25432, Redis — 16379. Результаты реальной интеграции и границы проверки находятся там же; visual/browser UI принимает человек, HTTP 500 покрыт только mocks.

**Статус проверки модели данных:** 2026-10-04 на пустой БД отдельного QA-проекта `checkist_qa_f5` применены 22 миграции, включая `catalog.0001`, `stores.0001`, `stores.0002`, `receipts.0001`; новых миграций нет. F1/F2/F4 схему не меняют. Откат трёх приложений и повторное применение проверены в прежнем прогоне `checkist_qa_t5` (2026-10-03), в F5 не повторялись. Восстановление из `pg_dump` и поведение на больших объёмах не проверялись. Подробности — в [проверках](docs/verification.md).

**Статус проверки админки после F1/F2/F4:** 2026-10-04 в `checkist_qa_f5` прошли 67 тестов без БД и 383 integration tests: `catalog` 9/80, `stores` 14/79, `receipts` 18/217, `health` 26/7 (без БД / integration). Прошли все 20 регрессий F4 с настоящим commit и гонками на отдельных Postgres-соединениях. В worker прошли `pip check`, `check`, контроль миграций и control ping; `check_services` вернул настоящий `pong` с Windows и из контейнера. QA-контейнеры и сеть удалены, тома сохранены. Устаревший inline DELETE перенесённой/удалённой записи возвращает HTTP 200 с конфликтом без сохранения POST; DELETE с правкой/созданием залога или скидки к удаляемой строке — ошибку `parent`/`line`. Отвязки/перепривязки и совместное удаление разрешены, неизменённые зависимости удаляются каскадом. Известные ошибки SQL helper блокировок дают ошибку формы; прочие SQL сохраняют риск 500. Ограничения и откат кода без изменения данных/миграций — в [модели данных](docs/data-model.md#конкурентные-правки). Итоговый прогон — в [отчёте F5](docs/verification.md#фактические-результаты-после-f4-2026-10-04); исторические результаты F3 отмечены отдельно. Визуальное и интерактивное поведение принимает человек по [сценарию](docs/verification.md#ручная-приёмка-админки-человеком), включая шаги 6–11 для исправлений.

## Документация

- [AGENTS.md](AGENTS.md) — обязательные правила работы ИИ-агентов и владение файлами.
- [Архитектура](docs/architecture.md) — процессы, адреса, данные и границы scaffold.
- [Модель данных](docs/data-model.md) — таблицы чеков, магазинов и каталога, ограничения, дедупликация, админка, миграции и откат.
- [Контракт API](docs/api-contract.md) — ответы, права, таймауты и обработка 503 клиентом.
- [Frontend](docs/frontend.md) — клиентский адаптер, env/proxy, scripts и состояния страницы.
- [Разработка](docs/development.md) — env, установка, запуск, остановка и диагностика Windows/Docker.
- [Проверки](docs/verification.md) — изолированная QA-среда, фактические результаты и ручные сценарии.

Публикация и выпуск версии не входят в текущий scaffold.
