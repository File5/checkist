# Проверки и приёмка

## Граница проверки

Реализованы backend scaffold (health API, Postgres/Redis probes, Celery task/CLI, Compose) и предметная модель данных чеков — приложения `catalog`, `stores`, `receipts` с миграциями и тестами ([data-model.md](data-model.md)). Контрактные тесты health используют mocks; integration-tag tests работают с реальными Postgres и Redis; выполнение очереди и result backend проверяет отдельный `check_services`. Ограничения БД, каскады, сиды, дедупликацию, проверку чека и историю цен проверяют integration tests трёх приложений на реальном Postgres.

Планируются React/TypeScript/Vite SPA и продуктовые функции: хранение фото чеков, распознавание магазина/адреса и товаров/стоимостей, API ввода чеков, статистический дашборд. OCR-провайдер не выбран. Frontend-код и UI пока отсутствуют, поэтому frontend-проверки не выполнены. У модели данных нет API и админки, поэтому HTTP-проверок для неё нет.

Ни сборка образа, ни `check`, ни mocked API tests не доказывают реальную HTTP/клиентскую интеграцию. Визуальную и интерактивную приёмку выполняет человек; автоматический обход browser UI запрещён. HTTP, CLI и unit tests можно автоматизировать.

## Изолированная QA-среда

Все записи, миграции, отправки задач и отключения зависимостей выполняются в **`-p checkist_qa`**, не в dev/локальном Postgres. Тестам нужны только таблицы и сид-данные, которые создаёт `migrate`; фото и seed users не требуются. Прежде чем использовать имя project, убедитесь, что QA не занята другим запуском. Не останавливайте чужие процессы.

PowerShell из корня репозитория; `.env` и venv должны быть подготовлены по [development.md](development.md). В **каждом** QA-терминале задайте:

```powershell
$env:POSTGRES_DB = "checkist_qa"
$env:POSTGRES_HOST = "127.0.0.1"
$env:POSTGRES_PORT = "25432"
$env:REDIS_PORT = "16379"
$env:CELERY_BROKER_URL = "redis://127.0.0.1:16379/0"
$env:CELERY_RESULT_BACKEND = "redis://127.0.0.1:16379/1"
$env:DJANGO_CACHE_URL = "redis://127.0.0.1:16379/2"
$env:DEV_API_PROXY_TARGET = "http://127.0.0.1:18000"
```

Проверьте LISTEN на 25432, 16379, 18000 и будущем 15173 командой `Get-NetTCPConnection` из development.md, заменив список портов. При конфликте выберите свободные и согласованно измените все URL/CLI ports. Compose project изолирует контейнеры, сеть и тома; одни только разные Redis DB номера QA не изолируют. Настройки DB/user/password должны соответствовать уже инициализированному QA-тому.

```powershell
docker compose -p checkist_qa config --quiet
docker compose -p checkist_qa up -d --wait --wait-timeout 90 postgres redis
```

Выполните ограниченные Windows TCP-пробы из [диагностики](development.md#диагностика-нет-доступа-с-windows-к-портам-docker) **до** локальных действий с БД. Если они не проходят, сохраните отказ в отчёте и перейдите к диагностике и независимым Linux-проверкам; зависимые host-команды не повторяйте до восстановления доступа. Exit code проверяйте после каждого шага; failed обязательный шаг сохраняйте в отчёте.

## Локальные Windows-команды

Если TCP доступен, порядок такой:

```powershell
./backend/.venv/Scripts/python.exe -X utf8 -m pip check
./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py check
./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py migrate --noinput
docker compose -p checkist_qa up -d --build --wait --wait-timeout 120 worker
./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py makemigrations --check --dry-run
./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py test catalog stores receipts health --exclude-tag=integration --verbosity=2
./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py test catalog stores receipts health --tag=integration --verbosity=2
./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py check_services
```

Ожидается exit 0, отсутствие новых миграций, 62 теста без БД и 158 integration tests, затем JSON с `celery_task.result={"message":"pong"}`. На пустой БД `migrate` применяет 22 миграции: 18 стандартных и 4 собственных. Числа соответствуют текущему коду и могут измениться вместе с тестами. Команда без тега не использует БД и может выполняться при TCP-отказе; integration-команда не должна заменяться skip/eager. Django runner создаёт и затем удаляет **`test_checkist_qa`**; Redis integration использует отдельный QA Redis DB 2 и уникальные временные ключи.

| Приложение | Без БД (`--exclude-tag=integration`) | С БД (`--tag=integration`) |
| --- | --- | --- |
| `catalog` | 9 | 19 |
| `stores` | 14 | 31 |
| `receipts` | 18 | 106 |
| `health` | 21 | 2 |
| Всего | 62 | 158 |

Unit/contract tests health покрывают точный 200, комбинации 503, сохранение независимых checks, анонимность, игнорирование query/Authorization, 405, 406, безопасный 500 при DEBUG, отсутствие публикации task из health, параллельность probes, cleanup кеша, bounded publication retries и негативную env-валидацию. Это не сетевой замер времени отказа.

## Модель данных: catalog, stores, receipts

Команды выполняются в QA-среде после блока environment выше; нужен только QA Postgres (тестам `health` с тегом `integration` — ещё и Redis). Worker для проверок модели данных не нужен.

```powershell
./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py check
./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py makemigrations --check --dry-run
./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py migrate --noinput
./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py test catalog stores receipts --exclude-tag=integration --verbosity=2
./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py test catalog stores receipts --tag=integration --verbosity=2
```

Ожидается exit 0 у каждой команды, `No changes detected`, 41 тест без БД и 156 integration tests (без `health`).

Что проверяют тесты трёх приложений:

- без БД — `to_base` и единицы, `normalize_address` и `address_key`, `name_key`, сборку `fiscal_key`, согласованность образцов чеков;
- с БД — unique и check каждой таблицы, три уровня дедупликации и `find_duplicates`, отрицательные строки и итог, `PROTECT` / `CASCADE` / `SET_NULL`, сиды и их повторное и обратное применение, сохранение трёх образцов чеков и отказ при повторе, `validate_receipt`, `find_alias`, историю цен.

Образцы чеков — тестовые данные, собранные по пересказу; соответствие настоящим чекам автоматически не проверяется и остаётся за человеком.

**Откат и повторное применение миграций.** Выполняйте только на QA-БД, в которой нет нужных данных: откат удаляет все таблицы трёх приложений. Чтобы проверка начиналась с пустой БД, используйте новый Compose project с собственным томом (как QA2 ниже) — существующий том `checkist_qa` может содержать таблицы прежних прогонов.

```powershell
./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py migrate receipts zero --noinput
./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py migrate stores zero --noinput
./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py migrate catalog zero --noinput
./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py showmigrations catalog stores receipts
./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py migrate --noinput
./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py makemigrations --check --dry-run
```

Ожидается exit 0; после отката `showmigrations` показывает четыре миграции как `[ ]`, после повторного `migrate` — как `[X]`, в справочниках снова 3 страны, 3 валюты и 4 ставки. Если в БД есть продавец, магазин или своя ставка в сид-стране, `migrate stores zero` ожидаемо завершится с `ProtectedError` и exit 1 — см. [data-model.md](data-model.md#миграции-и-откат).

## Linux-проверки при недоступном host-пути

Они проверяют контейнерную сеть и **не подтверждают** работу локального Django на Windows. При healthy QA Postgres/Redis:

```powershell
docker compose -p checkist_qa up -d --build --wait --wait-timeout 120 worker
docker compose -p checkist_qa exec -T worker python -m pip check
docker compose -p checkist_qa exec -T worker python -X utf8 manage.py check
docker compose -p checkist_qa exec -T worker python -X utf8 manage.py migrate --noinput
docker compose -p checkist_qa exec -T worker python -X utf8 manage.py makemigrations --check --dry-run
docker compose -p checkist_qa exec -T worker python -X utf8 manage.py test catalog stores receipts health --tag=integration --verbosity=2
docker compose -p checkist_qa exec -T worker python -X utf8 manage.py check_services
docker compose -p checkist_qa exec -T worker celery -A config inspect ping --destination=checkist@worker --timeout=2
docker compose -p checkist_qa ps
```

Ожидается exit 0 для каждой команды; зависимости без конфликтов, check без ошибок, migrations применены/уже актуальны, `No changes detected`, 158 integration tests passed, реальный pong через task/results и отдельный control pong. `ps` должен показывать три healthy services с QA host-портами. Docker build может использовать cache: это не новая установка с нуля, но `pip check` проверяет реально установленные зависимости образа.

## HTTP: позитивные и негативные сценарии

Ниже — воспроизводимый порядок проверки; фактический Windows QA2-прогон описан в [результатах](#фактические-результаты-windows-проверки-2026-10-03). Требуется рабочий Windows → Docker TCP-путь. В отдельном терминале с полным QA environment:

```powershell
./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py runserver 127.0.0.1:18000
```

В другом QA-терминале:

```powershell
curl.exe -i --max-time 15 http://127.0.0.1:18000/api/health/
curl.exe -i --max-time 15 -X POST http://127.0.0.1:18000/api/health/
curl.exe -i --max-time 15 -H "Accept: text/html" http://127.0.0.1:18000/api/health/
```

Ожидается соответственно 200 со всеми checks `ok`, 405 `method_not_allowed`, 406 `not_acceptable`; JSON и `Cache-Control: no-store`. Curl exit 0 не подтверждает HTTP 200. Полный формат — [api-contract.md](api-contract.md). Не вызывайте исключения изменением backend-кода ради проверки 500: безопасный handler проверяют существующие contract tests.

Выключайте зависимости **по одной**, каждый раз возвращайте baseline 200 и успешный `check_services`. Фиксируйте status/body и измеренное время GET; цель не более 10 секунд. Превышение — failed проверка, ожидание не ослабляйте.

```powershell
docker compose -p checkist_qa stop worker
curl.exe -sS --max-time 15 -w '\nHTTP=%{http_code} seconds=%{time_total}\n' http://127.0.0.1:18000/api/health/
./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py check_services
docker compose -p checkist_qa up -d --wait --wait-timeout 90 worker
./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py check_services
curl.exe -i --max-time 15 http://127.0.0.1:18000/api/health/

docker compose -p checkist_qa stop postgres
curl.exe -sS --max-time 15 -w '\nHTTP=%{http_code} seconds=%{time_total}\n' http://127.0.0.1:18000/api/health/
docker compose -p checkist_qa up -d --wait --wait-timeout 90 postgres
./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py check_services
curl.exe -i --max-time 15 http://127.0.0.1:18000/api/health/

docker compose -p checkist_qa stop redis
curl.exe -sS --max-time 15 -w '\nHTTP=%{http_code} seconds=%{time_total}\n' http://127.0.0.1:18000/api/health/
docker compose -p checkist_qa up -d --wait --wait-timeout 90 redis
docker compose -p checkist_qa restart worker
docker compose -p checkist_qa up -d --wait --wait-timeout 90 worker
./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py check_services
curl.exe -i --max-time 15 http://127.0.0.1:18000/api/health/
```

| Состояние | Ожидаемый GET |
| --- | --- |
| Worker остановлен | 503, `celery.code=worker_unavailable`, БД/cache OK; `check_services` exit 1 |
| Postgres остановлен | 503, `database.code=database_unavailable`, остальные checks сохраняются |
| Redis остановлен | 503, `redis.code=redis_unavailable`, `celery.code=broker_unavailable`, БД OK |
| Зависимость восстановлена | 200, все checks OK; `check_services` exit 0 |

Перезапуск worker после Redis — явный шаг восстановления control-связи; исходный отказ остаётся в отчёте. Таймаут task не отменяет принятую задачу, но повтор служебного ping безопасен.

## Планируется: frontend и ручная UI-приёмка

После появления `frontend/` и `docs/frontend.md` используйте фактические scripts проекта через `npm.cmd`: установка по lock, lint, unit tests, build. Их успешное выполнение не заменяет HTTP через Vite proxy и ручную приёмку. QA proxy должен вести на `http://127.0.0.1:18000`, Vite использовать порт 15173. Проверьте `curl.exe -i --max-time 15 http://127.0.0.1:15173/api/health/`: тот же контракт, `/api` не удалён.

Человеку после интеграции открыть `http://127.0.0.1:15173`:

1. Первое открытие: loading → success, статусы БД, Redis, Celery видны текстом. Для loading можно замедлить сеть в DevTools.
2. Остановить QA worker; «Повторить» показывает частичный отказ Celery, сохраняя БД/Redis. Восстановить worker, повторить — success.
3. Остановить QA API через Ctrl+C; повтор даёт понятную network error. Вернуть API; повтор восстанавливает состояние без перезагрузки страницы.
4. Offline/throttling: ошибка/timeout, loading не зависает; после online повтор успешен, старый success не остаётся текущим.
5. Проверить Tab/Enter, видимый focus, текстовые статусы/aria-live и ширину около 375 px без обрезания/горизонтального scroll.
6. Страница честно отмечает scaffold и planned фото/OCR/категории/dashboard, не показывает вымышленные распознанные чеки как рабочие данные.

Это будущий сценарий, сейчас UI и скриншотов нет.

## Фактические результаты проверки модели данных, 2026-10-03

Источник: задача T5 (`task_musd0fst2t`), состояние ветки после слияния T0–T4; код и тесты в этой задаче не менялись. Windows-хост: Python 3.13.9, Docker 29.8.1 (Linux daemon), Postgres 17.11. Использован отдельный Compose project `checkist_qa_t5` с новыми томами, БД `checkist_qa_t5`, тестовая БД `test_checkist_qa_t5`, Postgres 25432, Redis 16379: том `checkist_qa` уже существовал и не гарантировал пустую БД. Dev-данные и локальный Postgres не затронуты. Environment — блок выше с `POSTGRES_DB = "checkist_qa_t5"`.

### Проверено и прошло

Все команды `manage.py` запускались как `./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py …`.

| Фактическая команда | Результат |
| --- | --- |
| `pip install -r backend/requirements.txt`, `pip check` | Exit 0, `No broken requirements found.` |
| `docker compose -p checkist_qa_t5 config --quiet`, `up -d --wait --wait-timeout 90 postgres redis` | Exit 0, оба healthy; `\dt` в новой БД — таблиц нет |
| `Test-NetConnection 127.0.0.1 -Port 25432`, `-Port 16379` | Оба `TcpTestSucceeded=True` |
| `manage.py check` | Exit 0, 0 issues |
| `manage.py makemigrations --check --dry-run` | Exit 0, `No changes detected` |
| `manage.py migrate --noinput` на пустой БД | Exit 0, 22 миграции OK, из них `catalog.0001`, `stores.0001`, `stores.0002`, `receipts.0001`; в справочниках 3 страны, 3 валюты, 4 ставки |
| `manage.py migrate receipts zero --noinput`, затем `stores zero`, затем `catalog zero` | Каждый exit 0; `showmigrations` — четыре `[ ]`; таблиц `catalog_*`, `stores_*`, `receipts_*` в БД 0 |
| `manage.py migrate --noinput` повторно | Exit 0, четыре миграции применены заново; снова 3 страны, 3 валюты, 4 ставки |
| `manage.py makemigrations --check --dry-run` после повторного применения | Exit 0, `No changes detected` |
| `manage.py test catalog stores receipts health --exclude-tag=integration --noinput --verbosity=2` | Exit 0, 62 tests OK, БД не использовалась |
| `manage.py test catalog stores receipts health --tag=integration --noinput --verbosity=2` | Exit 0, 158 tests OK; `test_checkist_qa_t5` создана и удалена runner |
| Те же две команды отдельно для каждого приложения | Каждая exit 0: `catalog` 9 и 19, `stores` 14 и 31, `receipts` 18 и 106, `health` 21 и 2 |
| Негативная проверка: создан продавец в `DE`, затем `migrate receipts zero` и `migrate stores zero` | `stores zero` — exit 1, `ProtectedError: … referenced through protected foreign keys: 'Merchant.country'`; `stores.0002` осталась `[X]`, 3 страны, 4 ставки и продавец на месте. Ожидаемый отказ |
| `pg_dump -U checkist -d checkist_qa_t5 -Fc -f /tmp/checkist.dump` в контейнере postgres, `docker compose cp` на хост | Exit 0, дамп 84 293 байта, `pg_restore -l` перечисляет 24 `TABLE DATA`. Восстановление из дампа не выполнялось |
| `docker compose -p checkist_qa_t5 up -d --build --wait --wait-timeout 180 worker`, `manage.py check_services` | Exit 0, worker healthy, `celery_task.result={"message":"pong"}` |
| Linux-путь: `docker compose -p checkist_qa_t5 exec -T worker python -X utf8 manage.py makemigrations --check --dry-run`, `… test catalog stores receipts health --tag=integration`, `… --exclude-tag=integration` | Exit 0: `No changes detected`, 158 и 62 tests OK |

Прямой запрос к `pg_constraint` показал: внешние ключи трёх приложений созданы как `NO ACTION`, `DEFERRABLE`; `PROTECT`, `CASCADE` и `SET_NULL` исполняет Django ORM, а не БД.

### Проверено и не прошло

Дефектов кода не выявлено. Один сбой вспомогательного действия в ходе негативной проверки: после `migrate receipts zero` команда `Merchant.objects.all().delete()` завершилась с exit 1 — `ProgrammingError: relation "receipts_productalias" does not exist`: ORM текущего кода каскадирует в уже удалённую таблицу. Продавец удалён после повторного `migrate`. Следствие для отката на непустой БД описано в [data-model.md](data-model.md#миграции-и-откат).

### Не проверено и почему

- Восстановление данных из `pg_dump` (`pg_restore`): проверено только создание и оглавление дампа. Шаги: восстановить дамп в новую пустую БД и сравнить число строк в таблицах.
- Применение и откат миграций на БД с представительным объёмом чеков и влияние `statement_timeout=2000` мс: таких данных нет, проверялась пустая БД и одна ссылка-продавец.
- Соответствие образцов чеков настоящим чекам, качество сопоставления названий и разумность категорий: фото в репозитории нет, оценивает человек.
- Производительность `price_history` и поиска дубликатов на больших объёмах: замеров нет.
- HTTP-сценарии health (200/405/406/503) в этом прогоне не повторялись: код health не менялся, результаты — в разделе ниже.

Уборка: `docker compose -p checkist_qa_t5 down` — контейнеры и сеть удалены, тома `checkist_qa_t5_*` сохранены.

## Фактические результаты Windows-проверки, 2026-10-03

Числа тестов и миграций в этом разделе относятся к состоянию до появления модели данных. Источник: задача `task_musbjwnl1i`, полный отчёт — `orca-board task answer --task task_musbjwnl1i`. Серверный каркас проверен с Windows-хоста без правок backend/Compose/env: Python 3.13.9, Docker 29.8.1 (Linux daemon), Compose 5.5.1. Использованы только project/БД `checkist_qa2`, тестовая БД `test_checkist_qa2`, Postgres 25433, Redis 16380, Django 18001; dev и локальный Postgres не затронуты.

Для повторения этого прогона в командах и environment выше замените `checkist_qa` на `checkist_qa2`, 25432 → 25433, 16379 → 16380 во всех Redis URL, 18000 → 18001 в адресе API и proxy target. Это отдельная QA-среда; основной шаблон выше остаётся `checkist_qa`.

После выполненного человеком изменения `~/.wslconfig` (комментирования `networkingMode=Mirrored`), `wsl --shutdown` и перезапуска Docker Desktop доступ восстановился при неизменном коде; `wslinfo` сообщает `virtioproxy`. Строгая причинность Mirrored против VPN не изолирована; решение и диагностика описаны в [development.md](development.md#диагностика-нет-доступа-с-windows-к-портам-docker).

### Проверено и прошло

| Фактическая команда | Результат |
| --- | --- |
| `py -3.13 -X utf8 --version`, `docker info`, `docker compose version` | Каждый exit 0: Python 3.13.9, Docker 29.8.1/Linux, Compose 5.5.1 |
| `wsl.exe -d docker-desktop -- wslinfo --networking-mode` | Exit 0, `virtioproxy` |
| `Copy-Item .env.example .env`, `py -3.13 -X utf8 -m venv backend/.venv` | Созданы только игнорируемые локальные env/venv |
| `./backend/.venv/Scripts/python.exe -X utf8 -m pip install -r backend/requirements.txt` | Exit 0, закреплённый набор установлен на Windows |
| `./backend/.venv/Scripts/python.exe -X utf8 -m pip check` | Exit 0, `No broken requirements found.` |
| `docker compose -p checkist_qa2 config --quiet` | Exit 0 |
| `docker compose -p checkist_qa2 up -d --wait --wait-timeout 90 postgres redis` | Exit 0, оба healthy |
| `docker compose -p checkist_qa2 ps`, `docker compose -p checkist_qa2 port postgres 5432`, `docker compose -p checkist_qa2 port redis 6379` | Каждый exit 0, привязки `127.0.0.1:25433->5432` и `127.0.0.1:16380->6379` |
| `Test-NetConnection 127.0.0.1 -Port 25433`, `Test-NetConnection 127.0.0.1 -Port 16380` | Оба `TcpTestSucceeded=True`; обёртки с проверкой boolean — exit 0 |
| `./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py check` | Exit 0, 0 issues |
| `./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py migrate --noinput` | Exit 0, 18 стандартных миграций OK в `checkist_qa2` |
| `docker compose -p checkist_qa2 up -d --build --wait --wait-timeout 120 worker` | Exit 0, worker healthy; build использовал cache |
| `docker compose -p checkist_qa2 exec -T worker python -m pip check` | Exit 0, зависимости образа без конфликтов |
| `./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py makemigrations --check --dry-run` | Exit 0, `No changes detected` |
| `./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py test health --exclude-tag=integration --verbosity=2` | Exit 0, 21 tests OK; mocks/unit/contract, БД не использовалась |
| `./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py test health --tag=integration --verbosity=2` | Exit 0, 2 tests OK; реальный SQL/cache round-trip, `test_checkist_qa2` создана и удалена runner |
| `./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py check_services` | Exit 0, SQL/cache OK, настоящая task вернула `{"message":"pong"}` через result backend |
| `./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py runserver 127.0.0.1:18001 --noreload` | Сервер запущен в управляемой PTY-сессии, обслужил HTTP-проверки ниже |
| `curl.exe -i --max-time 15 http://127.0.0.1:18001/api/health/` | Curl exit 0; HTTP 200 с точной схемой и тремя checks `ok` |
| `curl.exe -i --max-time 15 -X POST http://127.0.0.1:18001/api/health/` | Curl exit 0; HTTP 405, `method_not_allowed` |
| `curl.exe -i --max-time 15 -H "Accept: text/html" http://127.0.0.1:18001/api/health/` | Curl exit 0; HTTP 406, `not_acceptable` |

HTTP status, полное JSON-тело и заголовки проверены отдельно: `Content-Type: application/json`, `Cache-Control: no-store`, `Allow: GET, HEAD, OPTIONS`; сообщения совпали с контрактом. Отказы проверялись по одному, время GET измерялось PowerShell:

```powershell
$taskDuration = Measure-Command {
  $script:taskHttp = curl.exe -sS -i --max-time 15 http://127.0.0.1:18001/api/health/
  $script:taskCurlExit = $LASTEXITCODE
}
```

| Фактическая команда отказа (exit 0) | Наблюдаемый HTTP 503 (curl exit 0) | Measure-Command |
| --- | --- | --- |
| `docker compose -p checkist_qa2 stop worker` | `worker_unavailable`, database/redis `ok` | 1.057378 с |
| `docker compose -p checkist_qa2 stop postgres` | `database_unavailable`, redis/celery `ok` | 2.028070 с |
| `docker compose -p checkist_qa2 stop redis` | `redis_unavailable` + `broker_unavailable`, database `ok` | 2.063928 с |

Во всех 503 сохранены независимые checks, точные `status=degraded` и `error.code=dependency_unavailable`; тело и заголовки проверены временным Python-валидатором. Цель ≤10 секунд выполнена во всех трёх сценариях. При остановленном worker `check_services` ожидаемо вернул exit 1 с `celery_task_unavailable`, сохранив database/redis `ok`: негативная проверка прошла.

После каждого восстановления GET вернул 200, `check_services` — exit 0 с настоящим pong. Все Compose stop/recovery-команды завершились с exit 0; после Redis worker явно перезапущен, как в HTTP-сценарии выше.

Уборка: Ctrl+C остановил runserver (exit 1 вследствие ручного прерывания); `docker compose -p checkist_qa2 down` — exit 0, контейнеры/сеть удалены, тома сохранены. `docker ps -a --filter label=com.docker.compose.project=checkist_qa2 --format '{{.Names}} {{.Status}}'` — exit 0, пусто. Проверки `Get-CimInstance Win32_Process` и `Get-NetTCPConnection -State Listen` подтвердили отсутствие своих runserver-процессов и слушателей на 25433/16380/18001.

### Проверено и не прошло

Продуктовых ошибок не выявлено. В отчёте сохранены два сбоя вспомогательных действий:

- `Start-Process` для фонового runserver отклонён автоматической политикой до исполнения: `blocked by policy`. Прямой запуск в управляемой PTY-сессии затем прошёл.
- Первый временный Python JSON-валидатор через PowerShell `-c` завершился с exit 1: `SyntaxError: unexpected character after line continuation character`. Исправлена передача аргумента, повторная полная проверка реального ответа прошла; код продукта не менялся.

### Не проверено и почему

- Точный механизм прежнего TCP-таймаута и отдельное влияние Mirrored/VPN: отказ больше не воспроизводится; повторное включение Mirrored и отключение VPN не выполнялись.
- HTTP 500 на реальном сервере специально не провоцировался изменением кода; безопасный handler проверен только существующими mocked contract tests.
- Frontend/proxy, UI и скриншоты: `frontend/` ещё нет. После интеграции выполнить фактические scripts и ручной сценарий выше человеком.
- Dev-данные и локальный Postgres: намеренно не использовались, все записи, миграции и публикации задач выполнялись только в QA2.

## Завершение QA

Ctrl+C локальные QA-процессы, затем `docker compose -p checkist_qa down` (для QA2 — `docker compose -p checkist_qa2 down`). Это удаляет только выделенные QA-контейнеры; не используйте глобальные stop/prune. Не удаляйте тома автоматически. Закройте QA-терминалы, чтобы environment overrides не попали в последующий dev-запуск. Убедитесь, что фильтр своего QA project в `docker ps -a` возвращает пустой вывод.

Отчёт всегда разделяет **«проверено и прошло / проверено и не прошло / не проверено и почему»**, включает команды, exit codes, ограничения и воспроизведение. Принятие результата не разрешает самостоятельно merge, публикацию или release.
