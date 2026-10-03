# Checkist

Checkist — проект распознавания чеков из продуктовых магазинов. Сейчас реализован **серверный scaffold**, который проверяет связь Django с Postgres, Redis и Linux Celery worker.

Реализовано:

- Django/DRF API `GET /api/health/` с независимыми проверками БД, кеша и control-связи Celery.
- Задача `health.ping` и команда `check_services`, проверяющая настоящее выполнение задачи и получение результата.
- Compose для Postgres, Redis и worker; стандартные миграции Django; контрактные и интеграционные тесты.

Планируется, ещё не реализовано: база данных фото чеков; распознавание магазина и его адреса, товаров и их стоимостей; распределение товаров по категориям; дашборд со статистикой. OCR-провайдер и предметная модель данных ещё не выбраны. SPA на React + TypeScript + Vite появится на следующем этапе; сейчас `frontend/` отсутствует.

## Требования

Python 3.13 с `py` launcher, Docker Desktop с Linux daemon и Docker Compose. Для будущего frontend нужны Node 24 и npm. Установленные в среде документационного этапа версии: Python 3.13.9, Node 24.18.0, npm 11.16.0, Docker 29.8.1, Compose 5.5.1. Точные зависимости backend закреплены в `backend/requirements.txt`.

## Быстрый запуск на Windows

PowerShell, из корня репозитория. Если `.env` уже есть, сохраните его настройки; копирование выполняйте только при первом запуске. Не меняйте ExecutionPolicy: используйте Python из venv напрямую.

```powershell
Copy-Item .env.example .env
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

**Статус проверки:** Windows-сценарий прошёл без правок проекта в изолированной QA-среде `-p checkist_qa2`: Postgres 25433, Redis 16380, Django 18001. Установка, 18 миграций, 21 unit/contract test, 2 integration tests и `check_services` с реальным pong успешны. Реальные HTTP 200/405/406 и 503 при отказах worker/Postgres/Redis проверены; ответы 503 получены за 1.06/2.03/2.06 с (округлено), цель ≤10 с выполнена. После восстановления — HTTP 200 и `check_services` exit 0. Доступ восстановился после изменения WSL при неизменном коде; отдельное влияние Mirrored и VPN не изолировано. Dev-данные не использовались. HTTP 500 проверен только mocks, UI ещё отсутствует. Диагностика и точные результаты — в документах ниже.

## Документация

- [AGENTS.md](AGENTS.md) — обязательные правила работы ИИ-агентов и владение файлами.
- [Архитектура](docs/architecture.md) — процессы, адреса, данные и границы scaffold.
- [Контракт API](docs/api-contract.md) — ответы, права, таймауты и обработка 503 клиентом.
- [Разработка](docs/development.md) — env, установка, запуск, остановка и диагностика Windows/Docker.
- [Проверки](docs/verification.md) — изолированная QA-среда, фактические результаты и ручные сценарии.

`docs/frontend.md` будет добавлен frontend-разработчиком на следующем этапе. Публикация и выпуск версии не входят в текущий scaffold.
