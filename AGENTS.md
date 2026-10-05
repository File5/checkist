# Правила работы с Checkist

Перед правками прочитайте этот файл и относящиеся к задаче документы в `docs/`: [архитектуру](docs/architecture.md), [модель данных](docs/data-model.md), [API-контракт](docs/api-contract.md), [разработку](docs/development.md), [проверки](docs/verification.md). Сверяйте утверждения с кодом, `compose.yaml` и `.env.example`. Требования конкретной задачи и проекта имеют приоритет; при существенном противоречии выясните решение, не меняйте контракт молча.

## Реализовано и планируется

Checkist предназначен для распознавания продуктовых чеков. Реализован scaffold: Django/DRF, анонимный health API, probes Postgres/Redis/Celery, демонстрационная задача `health.ping`, CLI `check_services`, Compose и тесты; React/TypeScript/Vite SPA показывает реальные health-ответы через proxy, частичные отказы, ошибки и повтор. Клиент описан в [docs/frontend.md](docs/frontend.md).

Реализована предметная модель данных — `stores`, `catalog`, `receipts`: модели, миграции с сид-данными, нормализация, дедупликация, проверка чека и история цен. `recognition` сохраняет исходное фото/вырезки/попытки и PostgreSQL-очередь; host-команда `recognition_worker` выполняет detect → crop → recognize → validate/import через Codex CLI либо явно выбранный FakeProvider. Новые магазины/товары создаются автоматически. Данные вводятся также через admin/код; HTTP произвольного редактирования нет. Описание — [docs/data-model.md](docs/data-model.md).

Подключён Django admin: `/admin/` открывается напрямую на Django (dev `http://127.0.0.1:8000/admin/`, QA — порт 18000), не через Vite. Зарегистрированы 12 моделей, `ReceiptDiscount` и `ReceiptTax` доступны только inline внутри чека; вход — пользователю с `is_staff`, суперпользователя создаёт человек командой `manage.py createsuperuser`. Админка рассчитана только на локальные dev/QA: production-настроек статики, secure cookies и HTTPS нет. Состав, проверки форм и ограничения — в [docs/data-model.md](docs/data-model.md#админка), запуск — в [docs/development.md](docs/development.md#админка), ручная приёмка — в [docs/verification.md](docs/verification.md#ручная-приёмка-админки-человеком).

Реализован HTTP API чтения — приложение `api` без моделей и миграций, 13 GET-эндпоинтов под `/api/`: справочники, категории, обобщённые продукты, товары, история цен, сравнение альтернативных товаров между странами и валютами. Эндпоинты открыты анонимно; перед любым внешним развёртыванием доступ нужно закрыть. Курсы валют не хранятся: пересчёт только по курсам из запроса. Несопоставленные позиции чеков в API не видны. SPA вызывает каталог, карточки товаров и историю/сводку цен; сравнение альтернатив пока не подключено. Контракт — [docs/api-contract.md](docs/api-contract.md#реализовано-api-чтения-каталога-и-цен).

Новый локальный API: upload фото, списки/detail фото/jobs/receipt-images, cancel/retry и `/api/receipts/` со всеми строками, включая непривязанные товары. Доступ только DEBUG + `ALLOW_LOCAL_RECOGNITION_API=1` + loopback, CSRF обязателен для unsafe методов даже анонима. MEDIA раздаётся только DEBUG, без проверки флага API; Vite dev/preview проксирует `/api` и `/media`. SPA реализует загрузку, опрос/cancel/retry заданий и просмотр чеков со всеми строками; см. docs/frontend.md и сценарий И5 в docs/verification.md.

Облегчённая v1: нет ReceiptDraft/ручного подтверждения, MutationRequest/Idempotency-Key, cleanup, POSIX watchdog, WorkerSlot-модели, manual_locked/отпечатка формы и защиты stale admin POST от OCR. Неполные/противоречивые результаты сохраняются на ReceiptImage как needs_review/failed с normalized_result/issues. Повтор по SHA-256 переиспользует последний job; другое фото связывается по сильному ключу либо точному store/time/total, дополняет лишь пустые поля/непривязанные товары при совместимых строках. Уже заполненные значения не перезаписываются, уже импортированные части cancel не удаляет. Планируются API ручных правок/сопоставления, пользовательская авторизация/разграничение, дашборд, серверные курсы и другие providers. Не выдавайте это за готовые функции и не меняйте схему/провайдера без задачи.

Слияние дублей товаров: приложение `merges` находит похожие названия одного продавца и сливает товары **предварительно** — строки и написания сразу переносятся на оставляемый товар, журнал хранит исходную принадлежность, человек подтверждает, отменяет группу либо исключает запись через локальный `/api/product-merges/` (доступ и CSRF как у recognition; коды `merge_conflict` / `merge_resolved` / `merge_changed` / `merge_busy`). Поглощённые товары скрыты из 13 GET (`merges.visibility`), их id отвечает `404`; формы ответов и число запросов прежние. Импорт и слияния идут по очереди под `IMPORT_LOCK`; поиск после импорта — только при `PRODUCT_MERGE_AUTO_DETECT=1` (по умолчанию `0`), вручную — `manage.py product_merges detect [--dry-run]`. Перед `migrate merges zero` обязателен `product_merges cancel-pending`; подтверждённое слияние средствами приложения не отменяется. `recognition/resolution.py` остаётся точным. Эталонные JSON — `backend/merges/tests/fixtures/public/`, демо только для QA — `seed_product_merge_demo`. Клиентские экраны слияния пока не реализованы.

## Стек, структура и владение

Python 3.13, Django 5.2.17, DRF 3.16.1, Celery 5.6.3, redis-py 6.4.0, psycopg 3.3.6, Pillow 12.3.0, Postgres 17.11, Redis 7.4.11. Django и `recognition_worker` работают на host рядом с native Codex CLI; Celery — Linux Docker/prefork (Windows Celery не среда приёмки). Health/Celery не проверяют OCR-worker/auth. Точные зависимости — `backend/requirements.txt`, прямые — `requirements.in`. Frontend: React 19.3.0, TypeScript 5.9.3, Vite 8.3.2, Node 24/npm 11; scripts/lock — в frontend.

```text
backend/
  config/                 settings, URL (`/admin/`, `/api/health/`), Celery, безопасные DRF ошибки
  health/                 API, probes, task, management command, tests
  stores/                 справочники и магазины: models, normalize, admin, migrations, tests
  catalog/                каталог товаров: models, units, admin, migrations, tests
  receipts/               чеки: models, dedup, validation, prices, admin, migrations, tests
  recognition/            models/migration, queue/storage/images, DTO/providers/supervisor, import/pipeline, host-команды/tests
  merges/                 слияние дублей товаров: models/migration, detection, services, visibility, admin, команды, демо, tests
  api/                    HTTP: каталог/цены, локальные recognition/receipts/product-merges, сериализация, CSRF, params/pagination/tests
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
- MEDIA_ROOT и RECEIPT_OCR_TEMP_ROOT — абсолютные непересекающиеся каталоги; API/host-worker используют одну DB и MEDIA. В QA отдельные от dev каталоги. Не коммитьте MEDIA/приватные provider payload. Auth существующего host-пользователя не меняйте; Windows worker требует native `.exe`. Настройки/команды — [development.md](docs/development.md#распознавание-запуск-для-клиента).

## API и данные

Backend владеет [контрактом](docs/api-contract.md). Точный URL — `/api/health/`; JSON-only; анонимный GET; HTTP 503 содержит валидное тело с `checks`. GET выполняет control ping, но не публикует Celery-task и не проверяет result backend. Реальную очередь/результат проверяет `check_services`; eager/local вызов не заменяет интеграцию. Клиент обязан валидировать JSON во время выполнения и сохранять `checks` при 503.

Прежний API каталога/цен: только GET. Новые локальные recognition/receipts views добавляют upload/cancel/retry и чтение чеков; контракт — [api-contract.md](docs/api-contract.md). Все API JSON, завершающий `/` обязателен; деньги — Decimal строками без float, цены разных валют не складываются/усредняются; ошибки — `{"error": {"code", "message", "fields?"}}` из config/exceptions.py. В ответах нет raw_text/fiscal/fiscal_key/extra, legal_name/tax_id, номеров чека/кассы/смены и provider stderr/raw payload. Query/страницы — api.params.Params/api.pagination.paginate; зависимостей django-filter нет. Число запросов не растёт с размером страницы — assertNumQueries.

Глобальная DRF permission — `IsAuthenticated`, health и API чтения явно используют `AllowAny` и пустой список authentication classes. Это не готовая пользовательская система. `DEFAULT_AUTHENTICATION_CLASSES` не переопределён, действуют Session и Basic: пользователь админки (его сессия и пароль) пройдёт `IsAuthenticated` в любом будущем DRF-эндпоинте, если тот не задаст свои правила. `/admin/` — HTML-интерфейс Django, в контракт API он не входит. При новых API установите потребителей, валидацию, доступ к объектам и границы пользователей; не раскрывайте внутренние ошибки. Изменение формата отражайте в контракте, тестах, клиенте и отчёте с перечнем несовместимости.

Собственные миграции: catalog.0001_initial, stores.0001_initial/0002_seed_reference, receipts.0001_initial, recognition.0001_initial, merges.0001_initial. У health/api моделей/миграций нет; откат HTTP — revert. Схема/инварианты/откат — [data-model.md](docs/data-model.md); обновляйте при изменении моделей. Откат recognition удаляет историю очереди/фото/попыток, сохраняет domain и MEDIA; перед ним остановить uploads/worker, pg_dump + копия MEDIA. Повтор migrate не восстанавливает связи; cleanup отсутствует. Откат предметной модели удаляет чеки и зависимую recognition-схему. Админка миграций не добавляет. Тесты — backend/<app>/tests/test_*.py: DB — TestCase/TransactionTestCase с @tag("integration"), без БД — SimpleTestCase. Гонки — TransactionTestCase + отдельные Postgres-соединения; OCR tests — fake/mock и временные MEDIA/scratch, настоящий Codex только отдельным QA-прогоном. Используйте вымышленные ФИО/ИНН.

Формы админки запрещают перенос строки чека с зависимыми залогами/скидками, нормализуют пустые `Product.attributes` в `{}` и сериализуют правки категорий транзакционной неблокирующей advisory-блокировкой. F4 проверяет актуальную принадлежность всех initial inline, включая DELETE: устаревшая запись даёт HTTP 200 с `receipt_inline_conflict`, весь POST без сохранения. DELETE с правкой/созданием зависимости к удаляемой строке даёт ошибку `parent_deleted`/`line_deleted`; отвязка, перепривязка и совместное удаление разрешены, неизменённые зависимости удаляются каскадом. Helper блокировок превращает SQLSTATE `55P03`/`57014`/`40P01` в `receipt_inline_busy`, F6 также обрабатывает известные конфликты и таймауты сохранения inline; остальные SQL сохраняют риск 500. Гарантии, конфликт второго запроса, влияние `statement_timeout` и откат исправлений только через revert кода/тестов (F4 — `a686413`, без изменения данных/миграций) — в [docs/data-model.md](docs/data-model.md#конкурентные-правки); прямые ORM/SQL-записи этих гарантий не получают. F6 отклоняет занятые position строк/скидок и tax_rate итогов, включая DELETE+UPDATE и перестановки: HTTP 200 без записей; освобождение ключа сохраняется отдельно. Гонка после clean откатывает весь POST, без повтора save. Полный набор backend после И4: 257 без БД / 866 integration (recognition e2e — 11); И5: frontend 897 тестов, настоящий fake HTTP через Vite dev/preview, по приложениям и с ручной приёмкой F4/F6 — [docs/verification.md](docs/verification.md).

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
./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py test catalog stores receipts health api recognition merges --exclude-tag=integration --verbosity=2
./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py test catalog stores receipts health api recognition merges --tag=integration --verbosity=2
./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py check_services
```

Тесты без тега `integration` БД не используют; с тегом — требуют QA Postgres, а `health` ещё и QA Redis. HTTP-сценарии API чтения через `curl.exe` — в [verification.md](docs/verification.md#http-api-чтения). `check_services` требует запущенный QA worker. Проверку отката миграций см. в [verification.md](docs/verification.md#модель-данных-catalog-stores-receipts).

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
