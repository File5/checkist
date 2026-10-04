# Правила работы с Checkist

Перед правками прочитайте этот файл и относящиеся к задаче документы в `docs/`: [архитектуру](docs/architecture.md), [модель данных](docs/data-model.md), [API-контракт](docs/api-contract.md), [разработку](docs/development.md), [проверки](docs/verification.md). Сверяйте утверждения с кодом, `compose.yaml` и `.env.example`. Требования конкретной задачи и проекта имеют приоритет; при существенном противоречии выясните решение, не меняйте контракт молча.

## Реализовано и планируется

Checkist предназначен для распознавания продуктовых чеков. Реализован scaffold: Django/DRF, анонимный health API, probes Postgres/Redis/Celery, демонстрационная задача `health.ping`, CLI `check_services`, Compose и тесты; React/TypeScript/Vite SPA показывает реальные health-ответы через proxy, частичные отказы, ошибки и повтор. Клиент описан в [docs/frontend.md](docs/frontend.md).

Реализована предметная модель данных — приложения `stores` (страны, валюты, ставки налога, продавцы, магазины), `catalog` (категории, обобщённые продукты, бренды, товары) и `receipts` (чеки, позиции, скидки, итоги по налогам, сопоставление названий): модели, миграции с сид-данными, функции нормализации, дедупликации, проверки чека и истории цен, тесты. Описание — [docs/data-model.md](docs/data-model.md). HTTP API для этих данных нет; их вводят через Django admin или кодом.

Подключён Django admin: `/admin/` открывается напрямую на Django (dev `http://127.0.0.1:8000/admin/`, QA — порт 18000), не через Vite. Зарегистрированы 12 моделей, `ReceiptDiscount` и `ReceiptTax` доступны только inline внутри чека; вход — пользователю с `is_staff`, суперпользователя создаёт человек командой `manage.py createsuperuser`. Админка рассчитана только на локальные dev/QA: production-настроек статики, secure cookies и HTTPS нет. Состав, проверки форм и ограничения — в [docs/data-model.md](docs/data-model.md#админка), запуск — в [docs/development.md](docs/development.md#админка), ручная приёмка — в [docs/verification.md](docs/verification.md#ручная-приёмка-админки-человеком).

Планируется: хранение фото чеков; распознавание магазина и адреса, товаров и их стоимостей; дашборд со статистикой. OCR-провайдер не выбран. Фото, OCR, бизнес-API, пользовательская авторизация и разграничение чеков, курсы валют пока не реализованы. Не выдавайте planned функции за готовый продукт, не выбирайте провайдера и не меняйте схему данных без задачи.

## Стек, структура и владение

Python 3.13, Django 5.2.17, DRF 3.16.1, Celery 5.6.3, redis-py 6.4.0, psycopg 3.3.6, Postgres 17.11, Redis 7.4.11. Django работает локально, Celery — Linux Docker/prefork; запуск worker на Windows не является средой приёмки. Точные Python зависимости — `backend/requirements.txt`, прямые — `backend/requirements.in`. Frontend: React 19.3.0, TypeScript 5.9.3, Vite 8.3.2, Node 24/npm 11; scripts — `frontend/package.json`, полный набор — `frontend/package-lock.json`.

```text
backend/
  config/                 settings, URL (`/admin/`, `/api/health/`), Celery, безопасные DRF ошибки
  health/                 API, probes, task, management command, tests
  stores/                 справочники и магазины: models, normalize, admin, migrations, tests
  catalog/                каталог товаров: models, units, admin, migrations, tests
  receipts/               чеки: models, dedup, validation, prices, admin, migrations, tests
  manage.py
  requirements.in         прямые зависимости
  requirements.txt        закреплённый полный набор
  Dockerfile, .dockerignore
  scripts/                HTTP/CLI-проверка настоящего API через proxy
frontend/                 React SPA, API-адаптер, Vite config, npm lock и tests
compose.yaml, .env.example
README.md, AGENTS.md, CLAUDE.md
docs/                     architecture, data-model, api-contract, development, frontend, verification
```

| Область | Владелец |
| --- | --- |
| `backend/`, контракт API, схема и миграции | Backend. Клиент согласует несовместимые изменения с backend. |
| `frontend/`, `docs/frontend.md` | Frontend. |
| `compose.yaml`, `.env.example`, root-документы, общие `docs/`, ignore/attributes | Backend на серверном этапе; далее назначенный интегратор. |

Редактируйте только область своей задачи; перед общей правкой уточните активного владельца, если есть пересечение работ. Используйте существующий стек и инфраструктуру. Новые зависимости, платформы и дизайн-системы добавляйте только при необходимости. Текст — UTF-8, LF согласно `.gitattributes`.

## Env и секреты

- Один корневой `.env`, образец — `.env.example`. Backend читает его с `override=False`: environment процесса выше файла, затем defaults кода. В Docker явно заданы внутренние адреса worker.
- `.env`, `.env.*` (кроме `.env.example`), `.venv/`, артефакты сборки и `.orca-attachments/` игнорируются. Не коммитьте секреты, пользовательские пути, реальные фото чеков или логи с паролями/DSN.
- Образец содержит публичные значения только для локальной разработки. `DJANGO_DEBUG=0` отвергает известный placeholder `DJANGO_SECRET_KEY`; это не делает конфигурацию готовой к production.
- Redis доступен без пароля только через loopback и выделенную Docker-сеть. DB 0/1/2 разделяют broker/results/cache, но не обеспечивают авторизацию пользователей.
- `VITE_API_BASE_URL` — публичный browser-префикс (`/api`); не помещайте в него секреты. Vite читает корневой `.env`, `envPrefix: []` и `define` передают только этот публичный параметр. `DEV_API_PROXY_TARGET` используется только Node-конфигурацией proxy, без переписывания `/api`.

## API и данные

Backend владеет [контрактом](docs/api-contract.md). Точный URL — `/api/health/`; JSON-only; анонимный GET; HTTP 503 содержит валидное тело с `checks`. GET выполняет control ping, но не публикует Celery-task и не проверяет result backend. Реальную очередь/результат проверяет `check_services`; eager/local вызов не заменяет интеграцию. Клиент обязан валидировать JSON во время выполнения и сохранять `checks` при 503.

Глобальная DRF permission — `IsAuthenticated`, health явно использует `AllowAny` и пустой список authentication classes. Это не готовая пользовательская система. `DEFAULT_AUTHENTICATION_CLASSES` не переопределён, действуют Session и Basic: пользователь админки (его сессия и пароль) пройдёт `IsAuthenticated` в любом будущем DRF-эндпоинте, если тот не задаст свои правила. `/admin/` — HTML-интерфейс Django, в контракт API он не входит. При новых API установите потребителей, валидацию, доступ к объектам и границы пользователей; не раскрывайте внутренние ошибки. Изменение формата отражайте в контракте, тестах, клиенте и отчёте с перечнем несовместимости.

Собственные миграции: `catalog.0001_initial`, `stores.0001_initial`, `stores.0002_seed_reference` (страны, валюты, ставки налога), `receipts.0001_initial`; у `health` моделей и миграций нет. Схема, ограничения БД, инварианты приложения, порядок применения и отката — в [docs/data-model.md](docs/data-model.md); меняя модели, обновляйте его. Откат трёх приложений удаляет все данные чеков: перед ним нужен `pg_dump`. Админка миграций не добавляет: `models.py` она не меняет, `verbose_name` у моделей нет. Тесты приложения лежат в `backend/<app>/tests/test_*.py` (админки — `test_admin.py`, маршрут и доступ — `health/tests/test_admin_site.py`): с реальной БД — `TestCase` или `TransactionTestCase` с `@tag("integration")`, без БД — `SimpleTestCase`. Для гонок нужны `TransactionTestCase` и отдельные Postgres-соединения. Реальные ФИО и ИНН физических лиц (предприниматель, кассир) в код, тесты и документацию не переносите — используйте вымышленные.

Формы админки запрещают перенос строки чека с зависимыми залогами/скидками, нормализуют пустые `Product.attributes` в `{}` и сериализуют правки категорий транзакционной неблокирующей advisory-блокировкой. F4 проверяет актуальную принадлежность всех initial inline, включая DELETE: устаревшая запись даёт HTTP 200 с `receipt_inline_conflict`, весь POST без сохранения. DELETE с правкой/созданием зависимости к удаляемой строке даёт ошибку `parent_deleted`/`line_deleted`; отвязка, перепривязка и совместное удаление разрешены, неизменённые зависимости удаляются каскадом. Helper блокировок превращает SQLSTATE `55P03`/`57014`/`40P01` в `receipt_inline_busy`, F6 также обрабатывает известные конфликты и таймауты сохранения inline; остальные SQL сохраняют риск 500. Гарантии, конфликт второго запроса, влияние `statement_timeout` и откат исправлений только через revert кода/тестов (F4 — `a686413`, без изменения данных/миграций) — в [docs/data-model.md](docs/data-model.md#конкурентные-правки); прямые ORM/SQL-записи этих гарантий не получают. F6 отклоняет занятые position строк/скидок и tax_rate итогов, включая DELETE+UPDATE и перестановки: HTTP 200 без записей; освобождение ключа сохраняется отдельно. Гонка после clean откатывает весь POST, без повтора save. Текущий набор: 67 без БД / 404 integration, по приложениям и с ручной приёмкой F4/F6 — [docs/verification.md](docs/verification.md).

Новые миграции добавляйте по соглашениям Django; применённые не переписывайте. Для изменения данных предусмотрите транзакции, конкуренцию, идемпотентность, таймауты, обратимость и восстановление. Проверяйте миграции на изолированных представительных данных; оценивайте объём запросов, индексы, N+1 и пагинацию, когда они затронуты.

## Запуск и проверки

Windows: `py -3.13`, прямой `./backend/.venv/Scripts/python.exe`, `-X utf8`; не требуется `Activate.ps1`. Для frontend используйте `npm.cmd`, без изменения ExecutionPolicy. Полный запуск — [development.md](docs/development.md); `.env` предварительно создать из образца. Dev Compose project — `checkist_dev`, API 8000, Vite 5173, Postgres 15432, Redis 6379.

Все тестовые записи, миграции, публикации задач и отключения сервисов выполняйте в QA, не в dev и не на локальном Postgres. В каждом QA-терминале сначала примените весь блок environment из [verification.md](docs/verification.md): БД `checkist_qa`, Compose `-p checkist_qa`, Postgres 25432, Redis 16379, API 18000, Vite 15173. QA имеет отдельные контейнеры, сеть и тома; тестовый runner создаёт `test_checkist_qa`.

После QA-настройки:

```powershell
docker compose -p checkist_qa config --quiet
./backend/.venv/Scripts/python.exe -X utf8 -m pip check
./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py check
./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py makemigrations --check --dry-run
./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py migrate --noinput
./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py test catalog stores receipts health --exclude-tag=integration --verbosity=2
./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py test catalog stores receipts health --tag=integration --verbosity=2
./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py check_services
```

Тесты без тега `integration` БД не используют; с тегом — требуют QA Postgres, а `health` ещё и QA Redis. `check_services` требует запущенный QA worker. Проверку отката миграций см. в [verification.md](docs/verification.md#модель-данных-catalog-stores-receipts).

В `frontend/`: `npm.cmd ci`, `npm.cmd run lint`, `npm.cmd run test`, `npm.cmd run build`. При запущенных QA API/Vite из корня: `node backend/scripts/check_health_proxy.mjs healthy`; stop/recovery и states `worker`, `postgres`, `redis` — по verification.md. Эта проверка использует настоящий fetch и клиентский адаптер в Node, без обхода UI.

Проверяйте exit code каждого шага. Не продолжайте зависимые шаги после ошибки. Если Windows не достигает Docker-портов, сначала выполните ограниченную TCP-[диагностику](docs/development.md#диагностика-нет-доступа-с-windows-к-портам-docker); не повторяйте заведомо невозможный прогон. Linux-проверки из verification.md подтверждают только путь внутри контейнерной сети. Изменение WSL Mirrored и перезапуск Docker Desktop в диагностике — решение человека; агентам самостоятельно системные настройки не менять и Docker Desktop не перезапускать. После проверки остановите созданные процессы и выполните `docker compose -p checkist_qa down`; тома сохраняются, `down -v` удаляет данные.

## Отчёт и приёмка

Отчёт делите на три группы:

1. **Проверено и прошло:** точные команды, exit codes, наблюдаемые результаты, тестовая среда/БД.
2. **Проверено и не прошло:** команда, фактическая ошибка, воспроизведение и известная причина либо отметка, что причина не установлена.
3. **Не проверено и почему:** ограничения и воспроизводимые шаги для человека/следующего этапа.

Mocks проверяют контракт, сборка — сборку, статический аудит — исходники. Они не подтверждают пользовательское поведение или настоящие зависимости. Не выдумывайте скриншоты и результаты; не отключайте упавший тест, не ослабляйте ожидания и не скрывайте дефект безусловным retry. Проверки выбирайте по затронутому поведению и риску; после исправления повторяйте необходимые проверки на окончательном состоянии.

Визуальную и интерактивную приёмку UI выполняет **человек**. Не используйте автоматический обход browser UI; разрешены HTTP/CLI/unit/lint/build. Передайте ручной сценарий из verification.md — для SPA и отдельно для админки. Наличие SPA, HTTP-прогон и Node-вызов адаптера не подтверждают визуальное и интерактивное поведение React в браузере.

Самостоятельные публикация, deployment, merge и release запрещены без явного задания. Работайте в своей ветке/worktree; не переключайте ветку и не меняйте соседние worktrees. Сдача и принятие результата не означают выпуск или слияние: ими управляет workflow проекта.
