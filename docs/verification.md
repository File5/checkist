# Проверки и приёмка

## Граница проверки

Реализованы backend scaffold (health API, Postgres/Redis probes, Celery task/CLI, Compose), React/TypeScript/Vite SPA с настоящим health API через proxy и предметная модель данных чеков — приложения `catalog`, `stores`, `receipts` с миграциями и тестами ([data-model.md](data-model.md)) — и HTTP API чтения этой модели, приложение `api` с 13 GET-эндпоинтами ([api-contract.md](api-contract.md#реализовано-api-чтения-каталога-и-цен)). Контрактные тесты health используют mocks; integration-tag tests работают с реальными Postgres и Redis; выполнение очереди и result backend проверяет отдельный `check_services`. Ограничения БД, каскады, сиды, дедупликацию, проверку чека и историю цен проверяют integration tests трёх приложений на реальном Postgres. API чтения проверяют тесты `api`: без БД — разбор параметров, пагинация, сериализация, курсы и формат ошибок; с тегом `integration` — эндпоинты через тестовый клиент Django на реальном Postgres; настоящий HTTP — сценарии `curl.exe` [ниже](#http-api-чтения). Vitest проверяет клиентский API-адаптер с mocked fetch; CLI `backend/scripts/check_health_proxy.mjs` — настоящий HTTP и тот же адаптер через proxy в Node 24.

Планируются продуктовые функции: хранение фото чеков, распознавание магазина/адреса и товаров/стоимостей, API ввода чеков, статистический дашборд. OCR-провайдер не выбран. Пользовательского входа, API записи и админки нет. Клиент API чтения не вызывает, поэтому сквозной проверки этих эндпоинтов через proxy и UI нет. Клиент описан в [frontend.md](frontend.md).

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
$env:VITE_API_BASE_URL = "/api"
$env:DEV_API_PROXY_TARGET = "http://127.0.0.1:18000"
```

Проверьте LISTEN на 25432, 16379, 18000 и 15173 командой `Get-NetTCPConnection` из development.md, заменив список портов. При конфликте выберите свободные и согласованно измените все URL/CLI ports. Compose project изолирует контейнеры, сеть и тома; одни только разные Redis DB номера QA не изолируют. Настройки DB/user/password должны соответствовать уже инициализированному QA-тому.

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
./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py test catalog stores receipts health api --exclude-tag=integration --verbosity=2
./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py test catalog stores receipts health api --tag=integration --verbosity=2
./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py check_services
```

Ожидается exit 0, отсутствие новых миграций, 149 тестов без БД и 412 integration tests, затем JSON с `celery_task.result={"message":"pong"}`. На пустой БД `migrate` применяет 22 миграции: 18 стандартных и 4 собственных. Числа соответствуют текущему коду и могут измениться вместе с тестами. Команда без тега не использует БД и может выполняться при TCP-отказе; integration-команда не должна заменяться skip/eager. Django runner создаёт и затем удаляет **`test_checkist_qa`**; Redis integration использует отдельный QA Redis DB 2 и уникальные временные ключи.

| Приложение | Без БД (`--exclude-tag=integration`) | С БД (`--tag=integration`) |
| --- | --- | --- |
| `catalog` | 9 | 19 |
| `stores` | 14 | 31 |
| `receipts` | 18 | 106 |
| `health` | 21 | 2 |
| `api` | 87 | 254 |
| Всего | 149 | 412 |

Unit/contract tests health покрывают точный 200, комбинации 503, сохранение независимых checks, анонимность, игнорирование query/Authorization, 405, 406, безопасный 500 при DEBUG, отсутствие публикации task из health, параллельность probes, cleanup кеша, bounded publication retries и негативную env-валидацию. Это не сетевой замер времени отказа.

Тесты `api` покрывают точные тела эндпоинтов на образцах, фильтры и сортировки, анонимный доступ и игнорирование `Authorization`, 405 и 406, 400 на каждый параметр, 404 на объект, страницу и неизвестный путь, `range_too_large`, пустую БД, смешанные валюты и пересчёт по курсам из запроса, единицы и причины несравнимости, исключение залога, возвратов и скидки на весь чек, границы страниц, число запросов (`assertNumQueries`), отсутствие закрытых полей в ответах, цикл в категориях и сохранение редиректа `/api/health` без слэша. Тесты с тегом `integration` обращаются к views через тестовый клиент Django, без сети.

Регрессии `api.tests.test_read_resilience`: точные значения обоих маршрутов сравнения на границах моделей и курсов, отрицательная оплаченная цена при большой скидке, среднее и процент динамики нормализованных цен. Конкурентное удаление проверяет `TransactionTestCase` с autocommit: `connection.execute_wrapper` перед чтением последних цен коммитит удаление строки и чека через отдельное psycopg-соединение в тестовую БД; результаты SQL не подменяются. Покрыты `price_summary`, карточка и список товаров, оба сравнения (сравнимые и несравнимые предложения), сводка истории, карточка и список обобщённых продуктов, удаление единственной группы и сохранение более раннего наблюдения. Runner очищает данные через flush. Запуск: `manage.py test api.tests.test_read_resilience --tag=integration --noinput --verbosity=2` — 19 тестов.

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
docker compose -p checkist_qa exec -T worker python -X utf8 manage.py test catalog stores receipts health api --tag=integration --verbosity=2
docker compose -p checkist_qa exec -T worker python -X utf8 manage.py check_services
docker compose -p checkist_qa exec -T worker celery -A config inspect ping --destination=checkist@worker --timeout=2
docker compose -p checkist_qa ps
```

Ожидается exit 0 для каждой команды; зависимости без конфликтов, check без ошибок, migrations применены/уже актуальны, `No changes detected`, 412 integration tests passed, реальный pong через task/results и отдельный control pong. `ps` должен показывать три healthy services с QA host-портами. Docker build может использовать cache: это не новая установка с нуля, но `pip check` проверяет реально установленные зависимости образа.

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

## HTTP: API чтения

Проверка 13 эндпоинтов [API чтения](api-contract.md#реализовано-api-чтения-каталога-и-цен) на настоящем сервере. Нужны QA Postgres, применённые миграции и образцы в QA-БД; worker нужен только для `200` у health. Образцы вносятся один раз в **пустую** QA-БД, не в dev: при конфликте с уже внесёнными данными используйте новый Compose project с собственным томом.

```powershell
./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py shell -c "from api.tests.factories import save_samples; save_samples()"
./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py runserver 127.0.0.1:18000 --noreload
```

В образцах три товара (молоко RU с фасовкой 850 мл, молоко DE без фасовки, SSD KZ), три магазина в трёх странах и восемь чеков; идентификаторы в новой БД идут с 1. В другом QA-терминале:

```powershell
curl.exe -i --max-time 15 http://127.0.0.1:18000/api/health/
curl.exe -i --max-time 15 "http://127.0.0.1:18000/api/products/?page_size=2"
curl.exe -i --max-time 15 "http://127.0.0.1:18000/api/products/1/prices/summary/?interval=month"
curl.exe -i --max-time 15 "http://127.0.0.1:18000/api/products/1/alternatives/?target_currency=EUR&rates=RUB:0.0098"
curl.exe -i --max-time 15 "http://127.0.0.1:18000/api/products/?page_size=0"
curl.exe -i --max-time 15 -X POST http://127.0.0.1:18000/api/products/
curl.exe -i --max-time 15 -H "Accept: text/html" http://127.0.0.1:18000/api/products/
curl.exe -i --max-time 15 http://127.0.0.1:18000/api/nope/
curl.exe -i --max-time 15 "http://127.0.0.1:18000/api/brands/?page=2"
curl.exe -i --max-time 15 http://127.0.0.1:18000/api/health
```

| Запрос | Ожидается |
| --- | --- |
| `/api/health/` | `200`, три checks `ok` (при запущенном worker) |
| `/api/products/?page_size=2` | `200`, `count: 3`, `pages: 2`, два товара с `prices` |
| `/api/products/1/prices/summary/?interval=month` | `200`, одна группа `RU` / `RUB`, `min = max = avg = "111.0000"`, один интервал |
| `/api/products/1/alternatives/?target_currency=EUR&rates=RUB:0.0098` | `200`, `conversion.source: "request"`, у молока RU `converted.last: "1.2798"` и `rank_overall: 1`, у молока DE `not_comparable_reason: "no_package"` |
| `/api/products/?page_size=0` | `400 invalid_parameter`, `fields.page_size` |
| `POST /api/products/` | `405 method_not_allowed`, `Allow: GET, HEAD, OPTIONS` |
| `Accept: text/html` | `406 not_acceptable` |
| `/api/nope/` | `404 not_found` в JSON |
| `/api/brands/?page=2` | `404 page_out_of_range` |
| `/api/health` без слэша | `301` на `/api/health/` |

Ответы — `Content-Type: application/json`, без `Cache-Control`. Curl exit 0 не подтверждает HTTP-статус: сверяйте статус и тело. Не-ASCII в query передавайте с percent-encoding, например `?q=%D0%BC%D0%BE%D0%BB%D0%BE%D1%87`: строку без кодирования `curl.exe` может отправить не в UTF-8, и поиск вернёт пустой список. Остальные эндпоинты (`countries`, `stores`, `brands`, `categories`, `generic-products`, карточки, точки истории, `comparison`) проверяются так же; точные тела — в контракте. `500` и `range_too_large` на настоящем сервере не провоцируются: первый потребовал бы правки кода, второй — больше 1000 интервалов данных; оба покрыты тестами.

## Сквозная проверка клиента через Vite proxy

Сначала выполните QA setup, TCP, migrate, worker, серверные tests и `check_services` выше. Во всех терминалах примените полный QA-блок, включая `VITE_API_BASE_URL=/api`: browser URL должен использовать same-origin proxy. API запустите в отдельном терминале из корня:

```powershell
./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py runserver 127.0.0.1:18000 --noreload
```

В другом QA-терминале из корня:

```powershell
Set-Location frontend
npm.cmd ci
npm.cmd run lint
npm.cmd run test
npm.cmd run build
npm.cmd run dev -- --port 15173
```

Каждый завершившийся шаг должен иметь exit 0; dev и runserver работают до Ctrl+C. Vitest — mocked fetch в Node, build — типизация/bundle. Они не подтверждают React-поведение в браузере.

В третьем QA-терминале из корня:

```powershell
curl.exe -i --max-time 15 http://127.0.0.1:18000/api/health/
curl.exe -i --max-time 15 http://127.0.0.1:15173/api/health/
curl.exe -i --max-time 15 -X POST http://127.0.0.1:15173/api/health/
curl.exe -i --max-time 15 -H "Accept: text/html" http://127.0.0.1:15173/api/health/
node backend/scripts/check_health_proxy.mjs healthy
```

Ожидаются одинаковые тела 200 напрямую/через proxy, затем 405 и 406 с точными телами контракта. CLI без новых зависимостей использует Node 24 и встроенное чтение TypeScript: сравнивает полный JSON, HTTP, Content-Type, Cache-Control и Allow, вызывает настоящий `getHealth` через proxy, проверяет `kind` и сохранение всех checks. Он требует QA environment и loopback origins; при другом Vite-порте передайте origin вторым аргументом после state, например `healthy http://127.0.0.1:15174`. Это проверка исходного адаптера в Node с явным baseUrl, не browser runtime или собранного React UI.

Выключайте зависимости по одной. После каждого `stop` до восстановления выполните измерение:

```powershell
$taskDuration = Measure-Command {
  $script:taskHttp = curl.exe -sS -i --max-time 15 http://127.0.0.1:15173/api/health/
  $script:taskCurlExit = $LASTEXITCODE
}
$taskHttp
$taskDuration.TotalSeconds
if ($taskCurlExit -ne 0 -or $taskDuration.TotalSeconds -gt 10) {
  throw "HTTP request failed or exceeded the 10-second target"
}
```

Затем CLI с соответствующим state должен завершиться exit 0: ожидается точный 503, здоровые checks сохранены. CLI дополнительно требует ≤10 с для каждого своего HTTP 503. Восстановление каждый раз подтверждайте state `healthy` (200) и настоящим `check_services` (exit 0):

```powershell
docker compose -p checkist_qa stop worker
# Измерение выше
node backend/scripts/check_health_proxy.mjs worker
./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py check_services
# Пока worker остановлен, ожидается exit 1 с celery_task_unavailable
docker compose -p checkist_qa up -d --wait --wait-timeout 90 worker
node backend/scripts/check_health_proxy.mjs healthy
./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py check_services

docker compose -p checkist_qa stop postgres
# Измерение выше
node backend/scripts/check_health_proxy.mjs postgres
docker compose -p checkist_qa up -d --wait --wait-timeout 90 postgres
node backend/scripts/check_health_proxy.mjs healthy
./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py check_services

docker compose -p checkist_qa stop redis
# Измерение выше
node backend/scripts/check_health_proxy.mjs redis
docker compose -p checkist_qa up -d --wait --wait-timeout 90 redis
docker compose -p checkist_qa restart worker
docker compose -p checkist_qa up -d --wait --wait-timeout 90 worker
node backend/scripts/check_health_proxy.mjs healthy
./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py check_services
```

Проверяйте exit каждого шага; ожидаемый exit 1 служебной команды при stop worker — успешная негативная проверка. Любой другой failed шаг сохраняйте в отчёте, зависимые проверки не продолжайте. Таблица кодов отказов выше относится и к proxy.

Проверка bundle на значения секретов из корневого `.env` (не печатает сами значения), из корня после build:

```powershell
@'
from pathlib import Path
from dotenv import dotenv_values
values = dotenv_values('.env')
files = [path for path in Path('frontend/dist').rglob('*') if path.is_file()]
assert files, 'Bundle missing'
for name in ('POSTGRES_PASSWORD', 'DJANGO_SECRET_KEY'):
    secret = values.get(name)
    assert secret, f'{name} missing from root .env'
    for path in files:
        assert secret.encode('utf-8') not in path.read_bytes(), f'{name} found in {path}'
    print(f'{name}: absent from all {len(files)} bundle files (value redacted)')
'@ | ./backend/.venv/Scripts/python.exe -X utf8 -
```

## Ручная UI-приёмка человеком

При запущенных QA API и Vite открыть `http://127.0.0.1:15173`. Endpoint анонимный: логин, token, seed users, фото и чеки не нужны; в QA только технические таблицы и временные служебные ключи/задачи.

1. Первое открытие: «Проверяем соединение…» и disabled «Повторить» → «Соединение установлено», API отвечает и три сервиса доступны. Для просмотра loading замедлить сеть в DevTools; проверить, что блок не меняет высоту.
2. Выполнить `docker compose -p checkist_qa stop worker`, нажать «Повторить»: loading → «Некоторые сервисы недоступны», API/БД/Redis доступны, Celery — «Обработчик задач не отвечает». Выполнить `docker compose -p checkist_qa up -d --wait --wait-timeout 90 worker`, повторить — успех. По аналогии проверить stop/recovery Postgres и Redis; после Redis перезапустить worker командами выше.
3. Остановить QA API через Ctrl+C, оставить Vite. Повтор даёт понятную ошибку соединения: Vite возвращает пустой 502, адаптер трактует его как network error. Прежние успешные checks не остаются текущими. Вернуть API той же командой; повтор без reload восстанавливает успех.
4. В DevTools Offline → повтор: безопасная ошибка, кнопка доступна. Вернуть Online → повтор: успех. Для timeout задержать health-запрос более 15 с при доступном Vite: сообщение «Сервер не ответил за 15 секунд…», без вечной загрузки. Снять задержку и повторить. Проверить, что устаревший ответ не подменяет текущую проверку.
5. Tab до «Повторить», видимый focus, Enter/Space запускают запрос; сводка объявляется через aria-live со screen reader. Статусы понятны без цвета. На ширине около 375 px и масштабе 200% нет обрезания/горизонтального scroll, кнопка доступна; при reduced motion интерфейс статичен.
6. Страница честно отмечает каркас и планируемые фото/OCR/категории/дашборд. Рабочие бизнес-функции и распознанные чеки не представлены.

Автоматический обход browser UI не выполняется. Скриншотов и результатов визуальной/интерактивной приёмки пока нет. После проверки остановить оба локальных процесса и QA Compose по разделу завершения ниже.

## Фактические результаты исправлений B1, 2026-10-04

Исправлены две причины `500`: стандартный Decimal-контекст не вмещал пересчитанную цену с четырьмя дробными знаками, а `price_summary` возвращал группу с `last=None` после конкурентного удаления. Арифметика и округление используют локальный контекст 128 цифр; отсутствующие группы пропускаются в агрегатах и сравнении без роста числа запросов. Формат JSON, доступ, пределы курсов и полей моделей сохранены; миграций и новых зависимостей нет. Откат исправлений — `git revert` коммита B1, без операций с БД; он возвращает оба дефекта.

Среда: Windows, Python 3.13.9 из существующего venv (только запуск, без изменения внешнего checkout). Команды Python ниже — `python.exe -X utf8 -B`, из корня worktree. Собственный Compose project и БД `checkist_qa_mutmwx0t3`, новые тома; тестовая БД `test_checkist_qa_mutmwx0t3`, Postgres 25471, Redis 16418, HTTP 18039. Dev, чужая QA и локальный Postgres не использовались. Перед каждой QA-командой применялся полный environment-блок выше с этими DB/портами/URL, а также `COMPOSE_PROJECT_NAME=checkist_qa_mutmwx0t3`, публичные реквизиты из `.env.example`, `DJANGO_DEBUG=1` и loopback `DJANGO_ALLOWED_HOSTS`. Временный `.env` создан из образца для Compose и в git не входит.

### Проверено и прошло

Все завершившиеся команды ниже — exit 0. Обязательный полный прогон повторён после последней правки Python-файлов; существующие проверки `assertNumQueries` не изменялись.

| Фактическая команда | Результат |
| --- | --- |
| `docker compose -p checkist_qa_mutmwx0t3 config --quiet` | Конфигурация без ошибок |
| `docker compose -p checkist_qa_mutmwx0t3 up -d --wait --wait-timeout 90 postgres redis` | Оба healthy, созданы собственные сеть и тома |
| `socket.create_connection(("127.0.0.1", port), timeout=2)` через Python stdin для 25471 и 16418 | Оба `TCP OK` до действий с БД |
| `python.exe -X utf8 -B -m pip check` | `No broken requirements found.` |
| `… backend/manage.py check` | `System check identified no issues (0 silenced).` |
| `… backend/manage.py makemigrations --check --dry-run` | `No changes detected` |
| `… backend/manage.py migrate --noinput` | 22 существующие миграции применены в собственную пустую QA-БД |
| `… backend/manage.py test catalog stores receipts health api --exclude-tag=integration --verbosity=1` | 149 тестов, `OK`, без БД |
| `… backend/manage.py test catalog stores receipts health api --tag=integration --noinput --verbosity=1` | 412 тестов, `OK`; runner создал и удалил `test_checkist_qa_mutmwx0t3` |
| `… backend/manage.py test api.tests.test_common.NumberTests api.tests.test_compare_rates api.tests.test_decimal_math api.tests.test_read_resilience --noinput --verbosity=1` | 42 целевых теста, `OK` |
| `docker compose -p checkist_qa_mutmwx0t3 up -d --build --wait --wait-timeout 120 worker` | Worker healthy; установка зависимостей использовала build cache |
| `… backend/manage.py check_services` | SQL/cache `ok`, настоящая очередь и result backend: `celery_task.result={"message":"pong"}` |
| `git diff --check` | Ошибок whitespace нет |

**Настоящий HTTP:** временный QA-скрипт запускался командой `… backend/manage.py shell -c "from pathlib import Path; exec(Path('_qa_b1_http.py').read_text(encoding='utf-8'))"`. Он внёс `save_samples()` один раз, товар `4` с фасовкой `0.001 ml` и ценой `9999999999.00`, затем товары `5` и `6` с единственным наблюдением по `100 RUB`. Внутри `connection.execute_wrapper` вызван `call_command("runserver", "127.0.0.1:18039", use_reloader=False, use_threading=False)`: один поток позволил выполнить удаление перед реальным SQL HTTP-запроса. Перед `SELECT DISTINCT ON` для каждого из товаров `5`/`6` отдельное psycopg-соединение коммитило удаление строки и чека; оба `rowcount=1`, оба commit подтверждены выводом сервера. Результаты SQL и ответы не подменялись.

В другом QA-терминале Python-скрипт через stdin (`python.exe -X utf8 -B -`, exit 0) выполнил `urllib.request.urlopen(..., timeout=15)` и проверил HTTP 200, `application/json` и следующие точные значения:

| Запрос к `http://127.0.0.1:18039` (в этом порядке) | Фактический ответ |
| --- | --- |
| `/api/products/5/` | 200 после конкурентного commit; `prices: []`, `last_observed_at: null`, `stores: []` |
| `/api/products/` | 200 после второго конкурентного commit; товар `6` сохранился с пустыми ценами, цена товара `4` осталась `"9999999999000000.0000"` |
| `/api/products/4/alternatives/?target_currency=EUR&rates=RUB:999999999999` | 200; у товара `4` все четыре поля `converted.last/min/max/avg` — `"9999999998990000000001000000.0000"` |
| `/api/generic-products/1/comparison/?target_currency=EUR&rates=RUB:999999999999` | 200; те же четыре точных значения |

Для повторения Decimal-сценария в новом QA project: внести образцы один раз, создать товар и наблюдение через `make_product(d.milk, "Review precision", package=("0.001", Unit.ML))` и `observe(p, d.shop_store, "RUB", date(2026, 11, 1), "9999999999.00")`, запустить QA `runserver --noreload`, запросить оба URL с напечатанными id. Конкурентный сценарий воспроизводит команда `manage.py test api.tests.test_read_resilience.ConcurrentReceiptDeletionTests --tag=integration --noinput --verbosity=2`: 13 тестов на двух настоящих соединениях. Для повторения через HTTP тот же callback удаления нужно установить вокруг однопоточного `runserver` (`use_threading=False`), затем запросить карточку и список в другом терминале; для каждого сценария создать отдельный товар с одним новым чеком. Обычная одновременная отправка DELETE и GET не гарантирует нужный момент гонки.

### Проверено и не прошло

- **До исправлений:** `manage.py test api.tests.test_read_resilience --tag=integration --noinput --verbosity=1` — exit 1, 16 тестов, 13 failures (включая subtests). Воспроизведены HTTP 500 на обоих маршрутах пересчёта, процентах динамики, карточке/списке после удаления и возвращение `PriceGroup(last=None)`. После исправления причины эти 16 тестов прошли; затем регрессии расширены до 19 и включены в полный успешный прогон.
- Промежуточный целевой запуск 42 тестов — exit 1, два `FieldError` в новых фикстурах: использовано неверное имя обратной связи `receiptline` вместо `lines`. Исправлена фикстура; повторный целевой и полный прогоны прошли, ожидания не ослаблялись.
- Остановка созданного runserver через Ctrl+C — exit 1 вследствие прерывания процесса, не отказ HTTP-проверки.

На окончательном состоянии ветки упавших проверок нет.

### Не проверено и почему

- Визуальная и интерактивная UI-приёмка — по правилам выполняет человек; frontend не менялся и API чтения пока не вызывает. Автоматического обхода и скриншотов нет. После штатного QA-запуска API/Vite выполнить [ручной сценарий](#ручная-ui-приёмка-человеком): загрузка, повтор, stop/recovery, Offline/Online, клавиатура, 375 px и 200%.
- Frontend lint/test/build, Vite proxy и stop/recovery health не повторялись: их код не менялся; health unit/integration и настоящая Celery task прошли. Для следующего этапа — команды frontend и сквозной сценарий выше.
- Нагрузочные замеры и откат/восстановление БД не выполнялись: схема и индексы не менялись, проверено постоянство числа SQL-запросов. Для нагрузки нужен представительный QA-набор; для backup/rollback — сценарий модели данных выше.

Уборка: runserver остановлен, временный `_qa_b1_http.py` удалён; собственные контейнеры и сеть удаляются `docker compose -p checkist_qa_mutmwx0t3 down`, тома сохраняются. Временный `.env` удаляется после Compose. Проверки отсутствия контейнеров и слушателей собственного project выполняются при сдаче; чужие процессы не затрагиваются.

## Фактические результаты проверки API чтения, 2026-10-03

Источник: задача A5 (`task_musmijs47d`), состояние ветки после слияния A1–A4 (код — коммит `c6ad35c`); в этой задаче менялись только документы. Windows-хост: Python 3.13.9, Docker 29.8.1 (Linux daemon), Compose 5.5.1. Project `checkist_qa` в это время был занят другим запуском, поэтому использован отдельный Compose project `checkist_qa_a5` с новыми томами: БД `checkist_qa_a5`, тестовая БД `test_checkist_qa_a5`, Postgres 25452, Redis 16399, Django 18052. Environment — блок выше с этими значениями. В worktree своего venv нет: использован интерпретатор venv основного checkout с `-B`; `.env` скопирован из `.env.example` для `env_file` Compose и в git не попадает. Dev-данные и локальный Postgres не затронуты.

### Проверено и прошло

Команды `manage.py` запускались как `python.exe -X utf8 -B backend/manage.py …` из корня worktree. Все перечисленные команды — exit 0.

| Фактическая команда | Результат |
| --- | --- |
| `docker compose -p checkist_qa_a5 config --quiet`, `up -d --wait --wait-timeout 90 postgres redis` | Оба healthy на `127.0.0.1:25452` и `127.0.0.1:16399` |
| `socket.create_connection(('127.0.0.1', port), timeout=2)` для 25452 и 16399 | Оба `TCP OK` до действий с БД |
| `python.exe -X utf8 -m pip check` | `No broken requirements found.` |
| `manage.py check` | `System check identified no issues (0 silenced).` |
| `manage.py makemigrations --check --dry-run` | `No changes detected` |
| `manage.py migrate --noinput` на пустой БД | 22 миграции `OK`: 18 стандартных и 4 собственных; у `api` миграций нет |
| `manage.py test catalog stores receipts health api --exclude-tag=integration --verbosity=2` | `Ran 144 tests … OK`, БД не использовалась |
| `manage.py test catalog stores receipts health api --tag=integration --noinput --verbosity=2` | `Ran 393 tests … OK`; `test_checkist_qa_a5` создана и удалена runner |
| Те же две команды отдельно для каждого приложения | `catalog` 9 и 19, `stores` 14 и 31, `receipts` 18 и 106, `health` 21 и 2, `api` 82 и 235 |
| `docker compose -p checkist_qa_a5 up -d --build --wait --wait-timeout 180 worker`, `manage.py check_services` | Worker healthy; `celery_task.result={"message":"pong"}` |
| Linux-путь: `docker compose -p checkist_qa_a5 exec -T worker python -X utf8 manage.py makemigrations --check --dry-run`, `… test catalog stores receipts health api --tag=integration --noinput`, `… --exclude-tag=integration`, `python -m pip check` | `No changes detected`, 393 и 144 tests OK, зависимости образа без конфликтов |
| `manage.py shell -c "from api.tests.factories import save_samples; …"` | В QA-БД внесены образцы: 3 товара, 2 обобщённых продукта, 3 категории, 3 магазина (RU, DE, KZ), 8 чеков |
| `manage.py runserver 127.0.0.1:18052 --noreload` | Сервер обслужил HTTP-проверки ниже |

HTTP на настоящем сервере, `curl.exe -i --max-time 15 …` (curl exit 0 в каждом случае; статус и тело сверены):

| Запрос | Фактический ответ |
| --- | --- |
| `/api/health/` | `200`, три checks `ok`, `Cache-Control: no-store` |
| `/api/products/?page_size=2` | `200`, `count: 3`, `pages: 2`; товары 2 и 3 (сортировка БД: латиница раньше кириллицы), у каждого `prices` с одной парой «страна, валюта» |
| `/api/products/1/prices/summary/?interval=month` | `200`, группа `RU` / `RUB` / `pcs`, `count: 1`, `min = max = avg = "111.0000"`, `change_percent: null`, интервал `2026-09-01` |
| `/api/products/1/alternatives/?target_currency=EUR&rates=RUB:0.0098` | `200`; `conversion` с `source: "request"`, `overall.min: "1.2798"`; у товара 1 `normalized_price: "130.5882"`, `converted.last: "1.2798"`, `rank_overall: 1`; у товара 2 `not_comparable_reason: "no_package"`, `converted: null` |
| `/api/products/?page_size=0` | `400 invalid_parameter`, `fields.page_size: ["Допустимо от 1 до 200."]` |
| `POST /api/products/`, `DELETE /api/products/1/` | `405 method_not_allowed`; у `POST` проверен заголовок `Allow: GET, HEAD, OPTIONS` |
| Остальные 10 эндпоинтов: `countries` (и `all=1`), `stores` (и `country=de&q=li`), `brands`, `categories` (и `q`), `categories/1`, `generic-products`, `generic-products/1`, `products/1`, `products/2/prices`, `generic-products/1/comparison` | `200`, тела соответствуют контракту; примеры в [api-contract.md](api-contract.md#реализовано-api-чтения-каталога-и-цен) взяты из этих ответов |
| Сводка: `interval=week`, `interval=day&price=list&group_by=none`, `price=normalized&group_by=store`, `price=normalized&group_by=none` у товара без фасовки | `200`; недели с понедельника; при `normalized` у товара 2 — `skipped_without_normalized: 6`, `groups: []` |
| Сравнение: `country=de,ru&date_from=2026-10-01`, `target_currency=RUB` без `rates`, `scope=category`, `comparison` с `target_currency=KZT&rates=RUB:5.5,EUR:520` | `200`; товар без наблюдений в окне — `offers: []` и `not_comparable_reason: "no_observations"`; `scope` у `comparison` игнорируется |
| `Accept: text/html` на `/api/products/` и на `/api/nope/` | `406 not_acceptable` |
| `Authorization: Basic …` на `/api/brands/` | `200`, заголовок игнорируется |
| `/api/nope/`, `POST /api/nope/`, `/api/`, `/api/products/abc/`, `/api/products/0/`, `/api/products/99999999999999999999999/` (и `…/prices/`, `…/comparison/`), `/api/categories/999/`, `/api/products/999/prices/summary/` | `404 not_found` в JSON |
| `/api/brands/?page=2`, `/api/brands/?q=zzz&page=2` | `404 page_out_of_range`; `/api/brands/?q=zzz` — `200`, `count: 0`, `pages: 0` |
| `/api/products`, `/api/health`, `/api/nope` без слэша (GET) | `301` на путь со слэшем |
| Девять недопустимых параметров в одном запросе `/api/products/` (`q=a`, `category=x`, `generic=0`, `brand=-1`, `country=XX`, `has_prices=yes`, `ordering=price`, `page=0`, `page_size=201`) | Один `400` с девятью ключами в `fields`; `country=DE,RU` — `400` |
| История: `date_from > date_to`; `date_from=2026-13-01`, `country=XX`, `currency=USD`, `store=999`, `ordering=x`, `page_size=501`; сводка: `interval=year`, `group_by=x`, `price=y` | `400 invalid_parameter` с сообщением на каждый параметр |
| `rates`: `RUB:0`, `RUB:-1`, `abc`, `RUB:1e3`, `USD:1.1`, `EUR:1` при цели `EUR`, `RUB:1,RUB:2`, 11 пар, `rates` без `target_currency`, `target_currency=USD`; `page_size=101`, `scope=x`, `country=DE,XX` | `400 invalid_parameter` |
| `HEAD /api/products/`, `OPTIONS /api/products/` | `200`; `OPTIONS` — метаданные DRF |
| Поиск в 16 сохранённых ответах подстрок `legal_name`, `tax_id`, `raw_text`, `fiscal`, `"extra"`, `number`, `shift`, `register`, `cashier`, `ИНН`, `ИП ` | Совпадений нет |

### Проверено и не прошло

Тесты и сценарии контракта прошли. Зафиксированы два наблюдения, код не менялся:

- **`POST` / `PUT` / `PATCH` на путь `/api/…` без завершающего `/` при `DJANGO_DEBUG=1` отдаёт HTML `500`**, а не JSON. Воспроизведение: `curl.exe -i --max-time 15 -X POST http://127.0.0.1:18052/api/nope` (так же `/api/products`, `/api/health`) — `500`, `Content-Type: text/html`, отладочная страница Django `RuntimeError at /api/nope` с traceback. Причина: `CommonMiddleware` с `APPEND_SLASH` отказывается перенаправлять запрос с телом в режиме отладки; запрос до DRF и его обработчика ошибок не доходит. Для `/api/health` поведение существовало и раньше, запасной маршрут `api.urls` распространил его на любой путь под `/api/`. При `DJANGO_DEBUG=0` (второй сервер на 18053 с временным `DJANGO_SECRET_KEY`) те же запросы дают `301` на путь со слэшем. Контракт описывает это как [известное ограничение](api-contract.md#известное-ограничение-запись-без-завершающего-слэша); `GET` и все пути со слэшем не затронуты.
- Первый запрос `curl.exe "…/api/categories/?q=молоч"` из Git Bash вернул `200` с пустым `results`: кириллица ушла не в UTF-8. Тот же запрос с percent-encoding (`?q=%D0%BC%D0%BE%D0%BB%D0%BE%D1%87`) вернул обе ожидаемые категории. Это особенность клиента командной строки, а не сервера.

### Не проверено и почему

- Вызовы API чтения из браузера, через Vite proxy и из SPA: клиент эти эндпоинты не использует, экранов нет. Шаги для человека: при запущенных QA API и Vite открыть `http://127.0.0.1:15173/api/products/?page_size=2` и сверить тело с ответом напрямую с 18000.
- `500 internal_error` и `400 range_too_large` на настоящем сервере: первый потребовал бы правки кода, для второго нужно больше 1000 интервалов данных. Оба покрыты тестами `api`.
- Потолок 5000 категорий и превышение `statement_timeout=2000` мс на настоящем сервере; производительность на больших объёмах — замеров нет, проверено только постоянство числа запросов (`assertNumQueries`).
- Осмысленность сравнения на настоящих данных: верно ли товары объединены в обобщённые продукты, заданы ли фасовки, понятен ли ответ для будущих экранов. Оценивает человек; в образцах сравнима только одна цена (молоко RU).
- Поведение за пределами loopback, CORS и внешний origin: не настроены. Решение о закрытии доступа перед внешним развёртыванием остаётся за человеком.
- Отказы зависимостей health (503) и сквозная проверка клиента в этом прогоне не повторялись: код health и frontend не менялся, результаты — в разделах ниже.

Уборка: оба runserver остановлены; `docker compose -p checkist_qa_a5 down -v` — контейнеры, сеть и тома этого project удалены (project создан только для этого прогона); временный `.env` удалён. `docker ps -a` с фильтром своего project пуст, слушателей на 25452, 16399, 18052 и 18053 нет.

## Фактические результаты интеграции через proxy, 2026-10-03

Числа тестов в этом разделе относятся к состоянию до появления API чтения. Задача `task_muscdxor28`. Windows Python 3.13.9, Node 24.18.0/npm 11.16.0, Docker 29.8.1/Linux, Compose 5.5.1. Использованы полный QA environment выше, только Compose project/БД `checkist_qa` и временная `test_checkist_qa`; Postgres 25432, Redis 16379, Django 18000, Vite 15173. Порты были свободны. Dev, локальный Postgres, WSL, VPN и Docker Desktop не изменялись.

Потребитель API — `frontend/src/api/health.ts`. Аудит пути/trailing slash, заголовков, credentials, runtime-схемы, 200/503/405/406/500, кодов checks и `frontend/vite.config.ts` подтвердил соответствие контракту. Proxy сохраняет `/api`, `envDir` указывает на корень, process overrides работают; `VITE_API_BASE_URL` публичен, proxy target остаётся в Node. Расхождений клиента/сервера/env не выявлено, серверные правки и миграции не понадобились. JSON-контракт и доступ не изменены; несовместимости нет. Добавлена воспроизводимая CLI-проверка настоящего адаптера и HTTP, обновлены общие документы.

Последний абзац `docs/frontend.md` содержит историческую ремарку frontend-этапа о ещё не обновлённых общих документах. Теперь они обновлены этой интеграцией; сам файл сохранён согласно границе владения задачи.

### Проверено и прошло

Все завершившиеся команды ниже — exit 0, кроме явно ожидаемого негативного `check_services` и Ctrl+C при уборке.

| Фактические команды | Результат |
| --- | --- |
| `py -3.13 -X utf8 --version`, `node --version`, `npm.cmd --version`, `docker info --format 'Server={{.ServerVersion}} OS={{.OSType}}'`, `docker compose version` | Версии выше; Linux daemon доступен |
| `docker ps -a --filter label=com.docker.compose.project=checkist_qa --format '{{.Names}} {{.Status}}'`, `Get-NetTCPConnection -State Listen` с фильтром QA-портов | Перед запуском контейнеров и слушателей нет |
| `Copy-Item .env.example .env` при отсутствии файла, `py -3.13 -X utf8 -m venv backend/.venv`, `./backend/.venv/Scripts/python.exe -X utf8 -m pip install -r backend/requirements.txt`, `./backend/.venv/Scripts/python.exe -X utf8 -m pip check` | Подготовлены игнорируемые env/venv; зависимости без конфликтов |
| `docker compose -p checkist_qa config --quiet`, `docker compose -p checkist_qa up -d --wait --wait-timeout 90 postgres redis`, `docker compose -p checkist_qa ps` | Оба healthy, опубликованы на 127.0.0.1:25432/16379 |
| `socket.create_connection(('127.0.0.1', port), timeout=2)` через `py -3.13 -X utf8 -`, port 25432 и 16379 | Оба TCP OK с Windows; до локальных действий с БД |
| `./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py check`, `./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py migrate --noinput` | 0 issues; в существующем QA-томе `No migrations to apply` |
| `docker compose -p checkist_qa up -d --build --wait --wait-timeout 120 worker`, `docker compose -p checkist_qa exec -T worker python -m pip check` | Worker healthy; build использовал cache установки, зависимости образа без конфликтов |
| `./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py makemigrations --check --dry-run` | No changes detected |
| `./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py test health --exclude-tag=integration --verbosity=2` | 21 tests OK, mocks/unit/contract, БД не использована |
| `./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py test health --tag=integration --verbosity=2` | 2 tests OK, настоящий SQL/cache; runner создал/мигрировал/удалил `test_checkist_qa` |
| `./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py check_services` | Настоящая очередь и results вернули `{"message":"pong"}` |
| В `frontend/`: `npm.cmd ci`, `npm.cmd run lint`, `npm.cmd run test`, `npm.cmd run build` | Установка по lock, lint без warnings, 49 mocked adapter tests OK, типизация и bundle созданы |
| `./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py runserver 127.0.0.1:18000 --noreload`, в `frontend/` `npm.cmd run dev -- --port 15173` | Управляемые PTY-сессии обслужили реальные запросы, затем остановлены |
| Четыре `curl.exe -i --max-time 15` из сквозного сценария выше | Напрямую и через proxy одинаковый 200; POST через proxy — 405; Accept text/html — 406; точные JSON и headers |
| `node --check backend/scripts/check_health_proxy.mjs`, `node backend/scripts/check_health_proxy.mjs healthy` | Синтаксис и реальные HTTP/адаптер прошли; healthy повторён после каждого recovery и в конце |
| Python bundle-проверка из сквозного сценария выше | Значения POSTGRES_PASSWORD и DJANGO_SECRET_KEY из `.env` отсутствуют во всех 3 файлах dist; сами значения не выводились |

Отказы по одному измерялись `Measure-Command` для `curl.exe -sS -i --max-time 15 http://127.0.0.1:15173/api/health/`. Curl exit 0; полный JSON/headers и сохранение checks также проверены CLI с настоящим frontend adapter:

| Команда отказа (exit 0) | CLI (exit 0) | Точный proxy HTTP 503 | Measure-Command |
| --- | --- | --- | --- |
| `docker compose -p checkist_qa stop worker` | `node backend/scripts/check_health_proxy.mjs worker` | database/redis ok, celery worker_unavailable | 1.0586939 с |
| `docker compose -p checkist_qa stop postgres` | `node backend/scripts/check_health_proxy.mjs postgres` | database database_unavailable, redis/celery ok | 2.0816441 с |
| `docker compose -p checkist_qa stop redis` | `node backend/scripts/check_health_proxy.mjs redis` | database ok, redis redis_unavailable, celery broker_unavailable | 2.0732798 с |

Все времена ≤10 с; `status=degraded`, общий `dependency_unavailable` и сообщение точные. CLI дополнительно подтвердил те же состояния напрямую, через proxy и в `getHealth` с `kind=degraded`. При stop worker `check_services` ожидаемо дал exit 1 и `celery_task_unavailable`, database/redis ok: негативная проверка прошла. Recovery выполнен точными `up/restart` командами сквозного сценария выше (каждая exit 0); после Redis worker явно перезапущен. После каждого recovery и в конце — 200 и `check_services` exit 0 с настоящим pong.

Дополнительный отказ API: Ctrl+C остановил runserver, `curl.exe -i --max-time 15 http://127.0.0.1:15173/api/health/` дал пустой 502 (curl exit 0). Node-проверка через `node --input-type=module -` использовала настоящий `fetch` и `getHealth({baseUrl:'http://127.0.0.1:15173/api'})`: точный `{kind:'error',reason:'network'}`, exit 0. API запущен повторно той же командой; финальные `healthy` и `check_services` снова exit 0. Для воспроизведения остановите API и выполните из корня:

```powershell
@'
import assert from 'node:assert/strict'
import { getHealth } from './frontend/src/api/health.ts'
const response = await fetch('http://127.0.0.1:15173/api/health/')
assert.equal(response.status, 502)
assert.equal(await response.text(), '')
assert.deepEqual(await getHealth({baseUrl:'http://127.0.0.1:15173/api'}), {kind:'error',reason:'network'})
console.log('Stopped API: proxy empty 502; real adapter returns network error')
'@ | node --input-type=module -
```

Уборка подтверждена: Ctrl+C остановил обе runserver-сессии и Vite (exit 1 вследствие прерывания, для npm подтверждён `Terminate batch job: Y`); `docker compose -p checkist_qa down` exit 0, контейнеры и сеть удалены, тома сохранены. `docker ps -a` с фильтром своего project пуст, `Get-NetTCPConnection` не нашёл LISTEN на четырёх QA-портах; `Get-CimInstance Win32_Process` не нашёл node/python/cmd с путём этого worktree. Фоновых процессов задачи не осталось.

### Проверено и не прошло

Продуктовых failed-проверок нет. `npm.cmd ci` сообщил deprecated warning выбранного ESLint 9.39.5; установка exit 0, lint exit 0 без предупреждений. Ожидаемые 503/502 и негативный CLI exit 1 учтены выше как успешные проверки отказов.

### Не проверено и почему

- React browser runtime, визуальная/интерактивная приёмка, keyboard/screen reader/responsive, Offline/timeout через DevTools, скриншоты: по правилам выполняет человек по сценарию выше. Node adapter и mocked tests этого не подтверждают.
- HTTP 500 на реальном сервере не провоцировался изменением кода; безопасный handler подтверждён только mocked contract tests.
- Vite preview, production hosting/reverse proxy и внешний API origin/CORS не запускались; в этой интеграции проверен dev proxy, публикация не задана.
- Фото/OCR/бизнес-данные/пользовательское разграничение не реализованы; тестовых пользователей и чеков нет. Dev и локальный Postgres не использованы.

## Фактические результаты проверки модели данных, 2026-10-03

Числа тестов в этом разделе относятся к состоянию до появления приложения `api`. Источник: задача T5 (`task_musd0fst2t`), состояние ветки после слияния T0–T4; код и тесты в этой задаче не менялись. Windows-хост: Python 3.13.9, Docker 29.8.1 (Linux daemon), Postgres 17.11. Использован отдельный Compose project `checkist_qa_t5` с новыми томами, БД `checkist_qa_t5`, тестовая БД `test_checkist_qa_t5`, Postgres 25432, Redis 16379: том `checkist_qa` уже существовал и не гарантировал пустую БД. Dev-данные и локальный Postgres не затронуты. Environment — блок выше с `POSTGRES_DB = "checkist_qa_t5"`.

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
- На момент этой backend QA2-проверки frontend отсутствовал, proxy/UI не проверялись. Более поздняя интеграция `task_muscdxor28` описана выше; UI и скриншоты остаются ручной приёмкой.
- Dev-данные и локальный Postgres: намеренно не использовались, все записи, миграции и публикации задач выполнялись только в QA2.

## Завершение QA

Ctrl+C локальные QA-процессы, затем `docker compose -p checkist_qa down` (для QA2 — `docker compose -p checkist_qa2 down`). Это удаляет только выделенные QA-контейнеры; не используйте глобальные stop/prune. Не удаляйте тома автоматически. Закройте QA-терминалы, чтобы environment overrides не попали в последующий dev-запуск. Убедитесь, что фильтр своего QA project в `docker ps -a` возвращает пустой вывод.

Отчёт всегда разделяет **«проверено и прошло / проверено и не прошло / не проверено и почему»**, включает команды, exit codes, ограничения и воспроизведение. Принятие результата не разрешает самостоятельно merge, публикацию или release.
