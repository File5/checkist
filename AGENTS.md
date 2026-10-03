# Правила работы с Checkist

Перед правками прочитайте этот файл и относящиеся к задаче документы в `docs/`: [архитектуру](docs/architecture.md), [API-контракт](docs/api-contract.md), [разработку](docs/development.md), [проверки](docs/verification.md). Сверяйте утверждения с кодом, `compose.yaml` и `.env.example`. Требования конкретной задачи и проекта имеют приоритет; при существенном противоречии выясните решение, не меняйте контракт молча.

## Реализовано и планируется

Checkist предназначен для распознавания продуктовых чеков. Реализован серверный scaffold: Django/DRF, анонимный health API, probes Postgres/Redis/Celery, демонстрационная задача `health.ping`, CLI `check_services`, Compose и тесты. Используются только стандартные технические модели и миграции Django; URL административного интерфейса не подключён.

Планируется: база данных фото чеков; распознавание магазина и адреса, товаров и их стоимостей; категории товаров; дашборд со статистикой. OCR-провайдер и предметная модель не выбраны. React/TypeScript/Vite SPA появится на следующем этапе. Фото, OCR, бизнес-API, пользовательская авторизация и разграничение чеков пока не реализованы. Не выдавайте planned функции за готовый продукт и не выбирайте провайдера или схему данных без задачи.

## Стек, структура и владение

Python 3.13, Django 5.2.17, DRF 3.16.1, Celery 5.6.3, redis-py 6.4.0, psycopg 3.3.6, Postgres 17.11, Redis 7.4.11. Django работает локально, Celery — Linux Docker/prefork; запуск worker на Windows не является средой приёмки. Точные Python зависимости — `backend/requirements.txt`, прямые — `backend/requirements.in`. Будущий frontend: React + TypeScript + Vite, Node 24/npm; версий пакетов и npm scripts в репозитории ещё нет.

```text
backend/
  config/                 settings, URL, Celery, безопасные DRF ошибки
  health/                 API, probes, task, management command, tests
  manage.py
  requirements.in         прямые зависимости
  requirements.txt        закреплённый полный набор
  Dockerfile, .dockerignore
compose.yaml, .env.example
README.md, AGENTS.md, CLAUDE.md
docs/                     architecture, api-contract, development, verification
```

| Область | Владелец |
| --- | --- |
| `backend/`, контракт API, схема и миграции | Backend. Клиент согласует несовместимые изменения с backend. |
| `frontend/`, будущий `docs/frontend.md` | Frontend на этапе интеграции. |
| `compose.yaml`, `.env.example`, root-документы, общие `docs/`, ignore/attributes | Backend на серверном этапе; далее назначенный интегратор. |

Редактируйте только область своей задачи; перед общей правкой уточните активного владельца, если есть пересечение работ. Используйте существующий стек и инфраструктуру. Новые зависимости, платформы и дизайн-системы добавляйте только при необходимости. Текст — UTF-8, LF согласно `.gitattributes`.

## Env и секреты

- Один корневой `.env`, образец — `.env.example`. Backend читает его с `override=False`: environment процесса выше файла, затем defaults кода. В Docker явно заданы внутренние адреса worker.
- `.env`, `.env.*` (кроме `.env.example`), `.venv/`, артефакты сборки и `.orca-attachments/` игнорируются. Не коммитьте секреты, пользовательские пути, реальные фото чеков или логи с паролями/DSN.
- Образец содержит публичные значения только для локальной разработки. `DJANGO_DEBUG=0` отвергает известный placeholder `DJANGO_SECRET_KEY`; это не делает конфигурацию готовой к production.
- Redis доступен без пароля только через loopback и выделенную Docker-сеть. DB 0/1/2 разделяют broker/results/cache, но не обеспечивают авторизацию пользователей.
- `VITE_*` — будущие публичные browser-переменные; не помещайте в них секреты. `DEV_API_PROXY_TARGET` предназначен для будущей Node-конфигурации proxy.

## API и данные

Backend владеет [контрактом](docs/api-contract.md). Точный URL — `/api/health/`; JSON-only; анонимный GET; HTTP 503 содержит валидное тело с `checks`. GET выполняет control ping, но не публикует Celery-task и не проверяет result backend. Реальную очередь/результат проверяет `check_services`; eager/local вызов не заменяет интеграцию. Клиент обязан валидировать JSON во время выполнения и сохранять `checks` при 503.

Глобальная DRF permission — `IsAuthenticated`, health явно использует `AllowAny` и пустой список authentication classes. Это не готовая пользовательская система. При новых API установите потребителей, валидацию, доступ к объектам и границы пользователей; не раскрывайте внутренние ошибки. Изменение формата отражайте в контракте, тестах, клиенте и отчёте с перечнем несовместимости.

Собственных миграций сейчас нет. Новые миграции добавляйте по соглашениям Django; применённые не переписывайте. Для изменения данных предусмотрите транзакции, конкуренцию, идемпотентность, таймауты, обратимость и восстановление. Проверяйте миграции на изолированных представительных данных; оценивайте объём запросов, индексы, N+1 и пагинацию, когда они затронуты.

## Запуск и проверки

Windows: `py -3.13`, прямой `./backend/.venv/Scripts/python.exe`, `-X utf8`; не требуется `Activate.ps1`. Для будущего frontend используйте `npm.cmd`, без изменения ExecutionPolicy. Полный запуск — [development.md](docs/development.md); `.env` предварительно создать из образца. Dev Compose project — `checkist_dev`, API 8000, Postgres 15432, Redis 6379.

Все тестовые записи, миграции, публикации задач и отключения сервисов выполняйте в QA, не в dev и не на локальном Postgres. В каждом QA-терминале сначала примените весь блок environment из [verification.md](docs/verification.md): БД `checkist_qa`, Compose `-p checkist_qa`, Postgres 25432, Redis 16379, API 18000, будущий Vite 15173. QA имеет отдельные контейнеры, сеть и тома; тестовый runner создаёт `test_checkist_qa`.

После QA-настройки:

```powershell
docker compose -p checkist_qa config --quiet
./backend/.venv/Scripts/python.exe -X utf8 -m pip check
./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py check
./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py makemigrations --check --dry-run
./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py test health --exclude-tag=integration --verbosity=2
./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py test health --tag=integration --verbosity=2
./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py check_services
```

Проверяйте exit code каждого шага. Не продолжайте зависимые шаги после ошибки. Если Windows не достигает Docker-портов, сначала выполните ограниченную TCP-диагностику из development.md; не повторяйте заведомо невозможный прогон. Linux-проверки из verification.md подтверждают только путь внутри контейнерной сети. Docker Desktop не перезапускайте и системные настройки без задания не меняйте. После проверки остановите созданные процессы и выполните `docker compose -p checkist_qa down`; тома сохраняются, `down -v` удаляет данные.

## Отчёт и приёмка

Отчёт делите на три группы:

1. **Проверено и прошло:** точные команды, exit codes, наблюдаемые результаты, тестовая среда/БД.
2. **Проверено и не прошло:** команда, фактическая ошибка, воспроизведение и известная причина либо отметка, что причина не установлена.
3. **Не проверено и почему:** ограничения и воспроизводимые шаги для человека/следующего этапа.

Mocks проверяют контракт, сборка — сборку, статический аудит — исходники. Они не подтверждают пользовательское поведение или настоящие зависимости. Не выдумывайте скриншоты и результаты; не отключайте упавший тест, не ослабляйте ожидания и не скрывайте дефект безусловным retry. Проверки выбирайте по затронутому поведению и риску; после исправления повторяйте необходимые проверки на окончательном состоянии.

Визуальную и интерактивную приёмку UI выполняет **человек**. Не используйте автоматический обход browser UI; разрешены HTTP/CLI/unit/lint/build. Передайте ручной сценарий из verification.md. Сейчас UI отсутствует, поэтому его приёмка не выполнена.

Самостоятельные публикация, deployment, merge и release запрещены без явного задания. Работайте в своей ветке/worktree; не переключайте ветку и не меняйте соседние worktrees. Сдача и принятие результата не означают выпуск или слияние: ими управляет workflow проекта.
