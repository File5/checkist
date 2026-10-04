# Проверки и приёмка

## Граница проверки

Реализованы backend scaffold (health API, Postgres/Redis probes, Celery task/CLI, Compose), React/TypeScript/Vite SPA с настоящим health API через proxy и предметная модель данных чеков — приложения `catalog`, `stores`, `receipts` с миграциями и тестами ([data-model.md](data-model.md)). Контрактные тесты health используют mocks; integration-tag tests работают с реальными Postgres и Redis; выполнение очереди и result backend проверяет отдельный `check_services`. Ограничения БД, каскады, сиды, дедупликацию, проверку чека и историю цен проверяют integration tests трёх приложений на реальном Postgres. Django admin (`/admin/`, 12 моделей и inline чека) проверяют `test_admin.py` трёх приложений и `health/tests/test_admin_site.py` через `django.test.Client`: это HTTP-запросы к настоящим страницам админки без браузера. Vitest проверяет клиентский API-адаптер с mocked fetch; CLI `backend/scripts/check_health_proxy.mjs` — настоящий HTTP и тот же адаптер через proxy в Node 24.

Планируются продуктовые функции: хранение фото чеков, распознавание магазина/адреса и товаров/стоимостей, API ввода чеков, статистический дашборд. OCR-провайдер не выбран. Бизнес-API и пользовательского входа в SPA нет. HTTP API у модели данных нет; её HTML-интерфейс — Django admin, проверки которого описаны в разделах [«Админка: проверки без браузера»](#админка-проверки-без-браузера) и [«Ручная приёмка админки человеком»](#ручная-приёмка-админки-человеком). Клиент описан в [frontend.md](frontend.md).

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
./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py test catalog stores receipts health --exclude-tag=integration --verbosity=2
./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py test catalog stores receipts health --tag=integration --verbosity=2
./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py check_services
```

Ожидается exit 0, отсутствие новых миграций, 67 тестов без БД и 404 integration tests, затем JSON с `celery_task.result={"message":"pong"}`. На пустой БД `migrate` применяет 22 миграции: 18 стандартных и 4 собственных. Числа соответствуют текущему коду и могут измениться вместе с тестами. Команда без тега не использует БД и может выполняться при TCP-отказе; integration-команда не должна заменяться skip/eager. Django runner создаёт и затем удаляет **`test_checkist_qa`**; Redis integration использует отдельный QA Redis DB 2 и уникальные временные ключи.

| Приложение | Без БД (`--exclude-tag=integration`) | С БД (`--tag=integration`) |
| --- | --- | --- |
| `catalog` | 9 | 80 |
| `stores` | 14 | 79 |
| `receipts` | 18 | 238 |
| `health` | 26 | 7 |
| Всего | 67 | 404 |

Числа после F1/F2/F4/F6 — см. [итоговый прогон F6](#фактические-результаты-f6-2026-10-04). F6 добавил 21 integration-тест `receipts` в `ReceiptInlineUniqueTests`. F1 добавил 14 integration-тестов `receipts`, F2 — 7 `catalog`, F4 — ещё 20 `receipts` в `ReceiptInlineTransactionTests`; subtests внутри метода отдельно не считаются. Тесты админки — integration, кроме пяти тестов маршрута в `health/tests/test_admin_site.py`, которым БД не нужна. Гонки проверяются `TransactionTestCase` на разных Postgres-соединениях, ошибки удаления — с настоящим commit. При прогоне тестов без БД в выводе дважды появляется `Internal Server Error: /api/health/`: это журнал контрактных тестов безопасного ответа 500, а не отказ.

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

Ожидается exit 0 у каждой команды, `No changes detected`, 41 тест без БД и 397 integration tests (без `health`).

Что проверяют тесты трёх приложений:

- без БД — `to_base` и единицы, `normalize_address` и `address_key`, `name_key`, сборку `fiscal_key`, согласованность образцов чеков;
- с БД — unique и check каждой таблицы, три уровня дедупликации и `find_duplicates`, отрицательные строки и итог, `PROTECT` / `CASCADE` / `SET_NULL`, сиды и их повторное и обратное применение, сохранение трёх образцов чеков и отказ при повторе, `validate_receipt`, `find_alias`, историю цен;
- с БД, админка (`test_admin.py`) — см. следующий раздел.

## Админка: проверки без браузера

Админка миграций не добавляет, поэтому `makemigrations --check --dry-run` обязан отвечать `No changes detected`. `manage.py check` здесь значим: он выполняет проверки конфигурации админок (`autocomplete_fields`, `search_fields` и т. п.). Тот же `check` нужен в worker-контейнере: worker импортирует `admin.py` при старте.

```powershell
./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py check
./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py makemigrations --check --dry-run
./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py test catalog stores receipts health --exclude-tag=integration --verbosity=2
./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py test catalog stores receipts health --tag=integration --verbosity=2
docker compose -p checkist_qa exec -T worker python -X utf8 manage.py check
```

Что проверяют тесты админки (`backend/<app>/tests/test_admin.py`, `backend/health/tests/test_admin_site.py`):

- маршрут `/admin/`, заголовки сайта, сохранение анонимного JSON у `/api/health/`;
- доступ: аноним и пользователь без `is_staff` перенаправляются на вход, неактивный staff не входит, staff без прав на модель получает 403, анонимный POST ничего не создаёт;
- регистрацию 12 моделей, отсутствие отдельных страниц у `ReceiptDiscount` и `ReceiptTax` и их наличие в inline чека;
- 200 у списка, добавления и правки; поиск, каждый фильтр, иерархию дат, сортировку; неизменность числа запросов списка при росте числа строк;
- сохранение через POST, включая чек с позицией, скидкой и итогом по ставке;
- ошибки формы вместо 500: дубликат адреса магазина, сопоставления и чека на каждом из трёх уровней, `gross != net + tax`, повтор `position`, нарушения check строк, цикл категорий, неизвестный часовой пояс, чужая родительская строка;
- F1: запрет переноса строки с залогом/скидкой, неизменность данных и повторный POST, сохранность связей после удаления целевого чека; разрешённый перенос без зависимостей, перенос залога с очищенным/заменённым `parent`, обычная правка inline и отказ без прав;
- F1: гонки переноса против создания залога/скидки в обоих порядках — второй POST ждёт блокировку строки, перечитывает её и получает ошибку формы;
- F2: пустые/отсутствующие/null Attributes → `{}` на add/change, сохранение непустого JSON, отказ некорректному JSON без изменения товара;
- F2: противоположные правки родителей на двух соединениях не сохраняют цикл; занятая advisory-блокировка немедленно отклоняет add/change корневой категории, после commit безопасный повтор сохраняется. Соединения гонок категорий проверяют штатный `statement_timeout=2s`;
- F4: устаревший DELETE перенесённой строки с новыми зависимостями в B и без них, перенесённых скидки/итога по налогу, уже удалённой строки — HTTP 200 с `receipt_inline_conflict`, без правок чека A; повтор того же POST также отклоняется. Гонка проходит на отдельных Postgres-соединениях, перенос строки и создание зависимостей B — настоящими admin POST;
- F4: DELETE с правкой/созданием залога или скидки к удаляемой строке, включая каскадные потомки, — ошибки `parent_deleted`/`line_deleted`, без HTTP 500 и частичных записей; разрешены отвязка зависимости, совместный DELETE и каскад неизменённых зависимостей, отдельное удаление скидки/итога по налогу;
- F4: занятые строка/скидка/итог по налогу при DELETE и занятый `parent`/`line` при создании зависимости — HTTP 200 с `receipt_inline_busy` при штатном `statement_timeout=2s`, без сохранения. SQLSTATE `40P01` обработан в коде, отдельной регрессии настоящего deadlock в этом наборе нет;
- F6: DELETE+UPDATE, перестановка, повторное занятие ключа удаляемой/каскадной записи, дубли новых/изменённых форм, включая скидки и налоги — HTTP 200 без записей; отдельные сохранения через свободный номер разрешены;
- F6: INSERT/UPDATE на ключ, занятый другой транзакцией после clean, — полный rollback и `receipt_inline_unique`; незавершённая вставка при штатных 2 с — `receipt_inline_busy`; журнал и уже сохранённые inline не меняются, конкурентная запись остаётся; неизвестный check violation не скрывается как unique;
- вычисляемые `address_key`, `name_key`, `fiscal_key`; блок предупреждений `validate_receipt` и экранирование в нём сохранённого текста;
- ответы автодополнения для каждого поля и его недоступность без `is_staff`.

Тесты создают пользователей сами в `test_checkist_qa` и входят через `force_login`; настоящая форма входа проверена только на отказ пользователю без `is_staff`. Данные вымышленные.

HTTP-проверка работающего сервера без браузера. В отдельном QA-терминале — `runserver 127.0.0.1:18000` (команда в разделе ниже), в другом:

```powershell
curl.exe -i --max-time 15 http://127.0.0.1:18000/admin/
curl.exe -i --max-time 15 http://127.0.0.1:18000/admin/login/
curl.exe -i --max-time 15 http://127.0.0.1:18000/api/health/
curl.exe -sS -o NUL -w 'HTTP=%{http_code} type=%{content_type}\n' --max-time 15 http://127.0.0.1:18000/static/admin/css/base.css
```

Ожидается: 302 с `Location: /admin/login/?next=/admin/`; 200 `text/html` с формой входа и заголовком «Checkist — администрирование»; 200 `application/json` с тремя checks `ok` (нужен QA worker); 200 `text/css`. Curl exit 0 не подтверждает HTTP-статус. Последняя проба показывает только то, что `runserver` отдаёт файл стилей при `DJANGO_DEBUG=1`; как страница выглядит в браузере, она не подтверждает.

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

Ожидается exit 0 для каждой команды; зависимости без конфликтов, check без ошибок, migrations применены/уже актуальны, `No changes detected`, 404 integration tests passed, реальный pong через task/results и отдельный control pong. `ps` должен показывать три healthy services с QA host-портами. Docker build может использовать cache: это не новая установка с нуля, но `pip check` проверяет реально установленные зависимости образа.

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

Автоматический обход browser UI не выполняется. Скриншотов и результатов визуальной/интерактивной приёмки пока нет. Админка принимается отдельным сценарием [ниже](#ручная-приёмка-админки-человеком). После проверки остановить оба локальных процесса и QA Compose по разделу завершения ниже.

## Ручная приёмка админки человеком

Выполняется в QA-среде в браузере; автоматически эти шаги не проходились. Нужны QA Postgres, применённые миграции и `runserver 127.0.0.1:18000` с полным QA environment; Vite, Redis и worker не нужны. Открывать напрямую `http://127.0.0.1:18000/admin/`, не через Vite. Данные вводить вымышленные.

Подготовка — суперпользователь в QA-БД (пароль вводится в терминале и нигде не сохраняется):

```powershell
./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py createsuperuser
```

1. **Вход и стили.** Открыть `/admin/`: перенаправление на форму входа. Войти. Страница оформлена (стили загружены, не «голый» HTML), заголовок «Checkist — администрирование», на главной — группы `Catalog`, `Receipts`, `Stores` и «Пользователи и группы». Неверный пароль даёт сообщение об ошибке, а не вход.
2. **Списки 12 моделей.** Открыть по очереди (названия английские и образованы автоматически, отсюда `Countrys` и `Currencys`): `Countrys`, `Currencys`, `Tax rates`, `Merchants`, `Stores`, `Categories`, `Generic products`, `Brands`, `Products`, `Receipts`, `Receipt lines`, `Product aliases`. У каждого проверить колонки, поиск и фильтры в правой панели (где они есть — см. [таблицу](data-model.md#какие-модели-доступны)). У `Receipts` — иерархию дат над списком. Отдельных списков скидок и итогов по налогам быть не должно; у `Receipt lines` нет кнопки добавления. В справочниках после `migrate` уже есть 3 страны, 3 валюты и 4 ставки.
3. **Ввод чека.** Создать продавца (`Merchants`) и магазин (`Stores`): поле `Address key` недоступно для ввода и заполняется после сохранения. Создать категорию, обобщённый продукт и товар. В `Receipts` добавить чек: магазин, валюта, `purchased_at` в UTC, `purchased_on` — локальная дата, `receipt_number`, `total`; в inline — две позиции, скидку (без привязки к строке) и итог по ставке, у которого `gross = net + tax`. Сохранить. Открыть чек: блок «Предупреждения проверки» показывает «Нарушений не найдено.» либо список расхождений — намеренно ошибиться в `total` и убедиться, что предупреждение появилось, а чек всё равно сохраняется. Ввести тот же чек ещё раз (те же магазин, `purchased_on`, `shift_number`, `register_code` и `receipt_number`): ошибка формы на странице, а не страница сбоя сервера. Итог с `gross`, не равным `net + tax`, — тоже ошибка формы.
4. **Автодополнение и сопоставление.** В форме чека поля магазина, товара и ставки ищут по вводу и подставляют значение. После сохранения чека в позиции-залоге поле `parent` и в скидке поле `line` предлагают только строки этого чека. Открыть `Receipt lines`, в фильтре по `product` выбрать «Пусто» (товар не задан), открыть строку, выбрать товар, сохранить: строка исчезает из отфильтрованного списка. В `Product aliases` добавить сопоставление: `Name key` заполняется сам; повтор того же названия у того же продавца — ошибка формы.
5. **Удаление.** Удалить страну, в которой есть продавец: админка отказывает и перечисляет защищённые объекты. Удалить чек: страница подтверждения перечисляет его позиции, скидки и итоги по налогам; после подтверждения чек и они удалены, магазин и товары на месте.
6. **Перенос строки с зависимостями (F1).** Создать два чека A/B с разными номерами. В A после первого сохранения привязать к товарной строке залог через `parent` и скидку через `line`. В `Receipt lines` открыть товарную строку, выбрать B в `receipt`, сохранить: ошибка поля `receipt` «Нельзя перенести строку…», обе связи и остальные поля остались в A. Повторить — тот же отказ. Удалить B и убедиться, что A, его строка, залог и скидка сохранились. Для отдельной проверки каждого вида зависимости повторить с одним залогом, затем с одной скидкой. Создать новый пустой B, отвязать залог (`parent` пустой) и скидку (`line` пустой) в A, сохранить A; перенести товарную строку в B со свободным `position` — успех. Отдельно проверить перенос самого залога: с `parent` из A отказ у `parent`, после очистки или выбора строки B — успех. Обычная правка названия/товара строки с зависимостями внутри A должна сохраняться.
7. **Attributes товара (F2).** Создать товар с пустым `Attributes`, сохранить и открыть снова: `{}`, без страницы сбоя. Сохранить `{"fat_percent": 2.5}`, открыть, очистить поле и сохранить: прежний JSON заменён на `{}`. Повторить с текстом `null` — снова `{}`. Ввести незавершённый JSON `{"fat_percent":` вместе с изменением названия: ошибка `Attributes`, после нового открытия ни JSON, ни название не изменились. Валидный непустой JSON сохраняется.
8. **Дерево категорий (F2).** Создать две корневые категории A/B. В двух вкладках открыть их правку до сохранения. Сохранить A с родителем B; в старой вкладке B выбрать родителем A и сохранить: ошибка `parent` о цикле, B остаётся корнем, A — ребёнком B. Проверить также выбор самой категории и более глубокого потомка — ошибка. Одновременные POST в браузере могут завершиться слишком быстро для воспроизведения `category_tree_busy`; для стабильной ручной проверки занятости используйте QA-блокировку ниже. Реальные гонки двух admin POST покрыты integration-тестами.
9. **Устаревший inline DELETE после переноса (F4).** Создать чеки A/B с разными номерами и строку L в A без зависимостей; позиция L свободна в B. Открыть форму A в первой вкладке и оставить её открытой. Во второй вкладке через `Receipt lines` перенести L в B, затем в форме B добавить залог с `parent=L` и скидку с `line=L`, сохранить. В старой вкладке A отметить L на DELETE, изменить также номер A на уникальный и сохранить: HTTP 200, общая ошибка inline «Запись уже перенесена в другой чек или удалена. Откройте чек заново.». Заново открыть A/B: номер A не изменён, L и обе зависимости остались в B. Повторить отправку прежней формы — снова отказ. Повторить на новых A/B без зависимостей в B, а затем с удалением L во второй вкладке вместо переноса — тот же конфликт. Эта проверка подтверждает устаревшую форму; точный порядок двух POST с переносом после чтения initial inline проверяется `ReceiptInlineTransactionTests`, без автоматического обхода браузера.
10. **DELETE и правка/создание зависимости (F4).** В сохранённом QA-чеке создать строку L и залог D с `parent=L`. В одном сохранении отметить L на DELETE, изменить `raw_name` D, оставить `parent=L` и изменить также номер чека: HTTP 200 с ошибкой у `parent` «Родительская строка удаляется в этом сохранении…». Заново открыть чек: L/D, связь, название D и номер чека прежние. Отдельно повторить со скидкой S: изменить её имя при DELETE L и оставить `line=L` — HTTP 200 с ошибкой `line` «Строка скидки удаляется в этом сохранении…», данные прежние. Повторить с созданием нового залога/скидки к L в том же POST; проверить также правку залога или скидки каскадного потомка L. Контроли на отдельных копиях чека: очистить `parent` D и `line` S одновременно с DELETE L — успешное сохранение (302), D/S остаются отвязанными; выбрать другую сохраняемую строку этого чека — связи сохраняются с ней; отметить L/D/S на DELETE — все удалены; удалить только L без содержательных правок D/S — они удалены каскадом. Страница сбоя сервера ни в одном из этих сценариев не ожидается.
11. **Занятая строка и таймаут (F4).** Открыть форму сохранённого чека, узнать id L и в QA-psql удержать её блокировку по инструкции ниже. Пока транзакция открыта, сохранить форму с DELETE L либо с новым залогом/скидкой к L: HTTP 200 с сообщением «Строки чека сейчас изменяются другим запросом. Откройте чек заново и повторите сохранение.», без изменений. Затем `ROLLBACK`, заново открыть чек и повторить разрешённую операцию — успех. Это проверка конкретной блокировки, не гарантия отсутствия 500 у всех SQL-запросов; границы — в [data-model.md](data-model.md#конкурентные-правки).
12. **Занятые позиции и ставки (F6).** Создать QA-чек со строками L1(position=1), L2(position=2). Отметить L1 DELETE, L2.position=1, изменить также номер чека: ошибка у `position` «Номер позиции уже занят…», HTTP 200. Заново открыть: строки, позиции и номер чека прежние. Повторить с L2 как залогом L1, очистив `parent` при DELETE L1 и смене позиции на 1: тот же отказ, исходная связь остаётся. Повторить перестановку 1↔2 без DELETE и создание новой строки на номер удаляемой: отказ без записей. Контроли: отвязать залог без смены номера одновременно с DELETE родителя — успех; после этого отдельным сохранением присвоить ему 1 — успех. Для перестановки выполнить три сохранения L1→свободный 3, L2→1, L1→2. Аналогично проверить две скидки: DELETE+UPDATE, перестановка и новая скидка на удаляемый номер отклоняются; освобождение номера отдельным сохранением разрешено. Для двух итогов по разным ставкам проверить смену на ставку удаляемого итога и обмен ставок — ошибка `tax_rate` «Эта ставка уже указана в чеке…»; отдельное освобождение ставки разрешено. Никакой страницы HTTP 500 и частичных записей.
13. **Незавершённая вставка на unique-ключ (F6).** В отдельном QA-терминале запустить `manage.py shell` с тем же environment. Открыть транзакцию и вставить строку на свободный номер по примеру ниже. Не завершать shell. В браузере добавить inline на этот же номер и изменить номер чека: примерно после штатного SQL-таймаута 2 с HTTP 200 с сообщением о занятости строк, весь POST без сохранения. В CLI выполнить rollback, заново открыть чек и повторить ввод — успех. Аналогично можно удержать новую скидку или итог по ставке. Настоящее конкурентное занятие ключа с commit строго между clean и save подтверждают шесть автоматических гонок; browser-сценарий проверяет ожидание незавершённой вставки.

Пример подготовки шага 13, только в QA: подставить id чека и свободный номер; реквизиты вымышленные. После браузерного отказа обязательно выполнить две последние строки:

```python
from decimal import Decimal
from django.db import transaction
from receipts.models import Receipt, ReceiptLine
transaction.set_autocommit(False)
r = Receipt.objects.get(pk=<QA_RECEIPT_ID>)
ReceiptLine.objects.create(receipt=r, position=<FREE_POSITION>, raw_name="Тестовая гонка", quantity=Decimal("1"), unit="pcs", unit_price=Decimal("1"), amount=Decimal("1"))
# После проверки браузером:
transaction.rollback()
transaction.set_autocommit(True)
```

Для шага 8, при открытой форме корневой категории, в отдельном QA-терминале запустите интерактивный psql (для другого project/БД/пользователя подставьте свои значения):

```powershell
docker compose -p checkist_qa exec postgres psql -U checkist -d checkist_qa
```

В psql выполните и оставьте транзакцию открытой:

```sql
BEGIN;
SELECT pg_advisory_xact_lock(1129010004, 1);
```

В браузере поменяйте имя корневой категории, оставьте `parent` пустым и сохраните. Ожидается немедленная ошибка `parent` «Категории сейчас изменяются другим запросом. Повторите сохранение.», без HTTP 500 и без изменения имени. Так же проверить добавление новой корневой категории — она не создаётся. Блокировку можно удерживать дольше 2 с: запрос формы не ждёт её и не расходует на ожидание `statement_timeout`. В psql выполнить `ROLLBACK;`, затем `\q`; повторить безопасное сохранение/добавление — успех. Эта CLI-подготовка воспроизводит занятую блокировку, а не два browser POST; остальные SQL-запросы админки сохраняют таймаут 2000 мс. Граница гарантий и обработка блокировок строк после F4 — в [data-model.md](data-model.md#конкурентные-правки).

Для шага 11 в таком же QA-psql, после открытия формы в браузере, задайте id строки L (число из URL её отдельной страницы):

```sql
\set line_id 123
BEGIN;
SELECT id FROM receipts_receiptline WHERE id = :line_id FOR UPDATE;
```

Замените `123` своим id и убедитесь, что SELECT вернул одну строку. Оставьте транзакцию открытой дольше 2 с и выполните browser POST. Ожидающая блокировка формы ограничена `statement_timeout=2000` мс, ошибки helper превращаются в `receipt_inline_busy`; повторная проверка formset с NOWAIT может отказать сразу. После ответа выполните `ROLLBACK;` и `\q`. Для скидки/итога по налогу можно аналогично удержать запись в `receipts_receiptdiscount`/`receipts_receipttax` и отправить её inline DELETE: ожидается немедленный конфликт занятости. Эти SQL только удерживают блокировки; используйте исключительно тестовые записи QA.

Дополнительно, по желанию: поменять `position` двух строк одним сохранением — ожидается ошибка формы (переставлять через свободный номер); выйти и убедиться, что `/admin/` снова требует входа.

После приёмки удалить введённые записи либо помнить, что они остались в томе `checkist_qa`; суперпользователь тоже остаётся в этой БД. Завершение — по разделу [«Завершение QA»](#завершение-qa).

## Фактические результаты F6, 2026-10-04

Задача `task_mutqy7fa3d`, база `835cbd5`. Изменены `backend/receipts/admin.py`, `backend/receipts/tests/test_admin.py` и шесть Markdown-файлов: `AGENTS.md`, `CLAUDE.md`, `README.md`, `docs/data-model.md`, `docs/development.md`, этот документ. Модели, settings, миграции, зависимости, публичный API и авторизация не менялись. Выбрано отклонение занятых ключей до save: HTTP 200 с ошибкой формы, без записей; освобождение номера/ставки сохраняется отдельно. Известные конфликты unique и ожидания при save откатывают весь POST и показывают ошибку без повторного сохранения. F1/F4 по связям и каскадам сохранены.

Среда: Windows Python 3.13.9, Docker 29.8.1 / Linux daemon, Compose 5.5.1; worker из `python:3.13.16-slim-bookworm`, Linux/prefork/concurrency 2. Новый Compose project `checkist_qa_f6_run`, БД `checkist_qa_f6`, тестовая БД `test_checkist_qa_f6`, отдельные сеть и тома; Postgres 25437, Redis 16384. API 18005 и Vite 15178 свободны, серверы не запускались. До запуска этих QA портов LISTEN отсутствовал. Dev и другие QA-контейнеры не изменялись. `.env` создан из образца, venv — из закреплённых зависимостей; оба игнорируются Git.

В каждом терминале задавать environment напрямую (PowerShell не разрешает dot-source `.ps1` в этой среде):

```powershell
$env:POSTGRES_DB = 'checkist_qa_f6'
$env:POSTGRES_HOST = '127.0.0.1'
$env:POSTGRES_PORT = '25437'
$env:REDIS_PORT = '16384'
$env:CELERY_BROKER_URL = 'redis://127.0.0.1:16384/0'
$env:CELERY_RESULT_BACKEND = 'redis://127.0.0.1:16384/1'
$env:DJANGO_CACHE_URL = 'redis://127.0.0.1:16384/2'
$env:VITE_API_BASE_URL = '/api'
$env:DEV_API_PROXY_TARGET = 'http://127.0.0.1:18005'
```

### Проверено и прошло

Ниже `manage.py` — точный префикс `./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py`. Все команды таблицы — **exit 0**. Тесты выполнены на окончательном коде; после них дописан фактический отчёт. Записи и задачи выполнялись только в QA.

| Команда | Фактический результат |
| --- | --- |
| `py -3.13 -m venv backend/.venv`; `./backend/.venv/Scripts/python.exe -X utf8 -m pip install -r backend/requirements.txt` | Venv создан, закреплённые зависимости установлены |
| `docker compose -p checkist_qa_f6_run config --quiet`; `… up -d --wait --wait-timeout 90 postgres redis` | Конфигурация валидна, отдельные Postgres/Redis healthy |
| `socket.create_connection(('127.0.0.1', port), timeout=2)` через venv Python, порты 25437/16384 | Оба Windows TCP OK до работы с БД |
| `./backend/.venv/Scripts/python.exe -X utf8 -m pip check` | No broken requirements found |
| `manage.py check` | 0 issues |
| `manage.py makemigrations --check --dry-run` | No changes detected |
| `manage.py migrate --noinput` | На пустой QA-БД применены 22 миграции; окончательный повтор — No migrations to apply |
| `manage.py test catalog stores receipts health --exclude-tag=integration --noinput --verbosity=2` | **67 OK**, 3.568 с; БД не использовалась |
| `manage.py test catalog stores receipts health --tag=integration --noinput --verbosity=2` | **404 OK**, 92.510 с; реальный Postgres/Redis, `test_checkist_qa_f6` создана и удалена |
| `./backend/.venv/Scripts/python.exe -X utf8 "$env:TEMP/checkist-f6/edge_review.py"` | Оригинальный runner `task_mutq6zvv31`: **3/3 OK**, 1.852 с; все HTTP 200, все записи чека/строк/скидок/налогов неизменны |
| `./backend/.venv/Scripts/python.exe -X utf8 "$env:TEMP/checkist-f6/extra_review.py"` | Runner из ответа `task_mutnyh9k1e`: **8/8 OK**, 3.583 с; ожидания не менялись; отвязка+DELETE HTTP 302, устаревший DELETE HTTP 200 и сохранность зависимостей B |
| `docker compose -p checkist_qa_f6_run up -d --build --wait --wait-timeout 120 worker` | Worker healthy, часть слоёв сборки из cache |
| `… exec -T worker python -m pip check`; `… exec -T worker python -X utf8 manage.py check`; `… exec -T worker python -X utf8 manage.py makemigrations --check --dry-run` | Зависимости без конфликтов, 0 issues, No changes detected; импорт админок в Linux |
| `manage.py check_services`; `… exec -T worker python -X utf8 manage.py check_services` | С Windows и из Linux: database/redis OK, настоящая Celery task/result `{"message":"pong"}` |
| `… exec -T worker celery -A config inspect ping --destination=checkist@worker --timeout=2`; `… ps` | Control pong, один worker; три healthy services |
| Анализ verbose-логов venv Python | 67/404 уникальных test IDs, суммы по приложениям совпадают; F1 **14**, F4 **20**, F6 **21**, skips/errors/failures нет |
| `docker compose -p checkist_qa_f6_run down` | Созданные контейнеры и сеть удалены, тома сохранены, `down -v` не выполнялся |
| `docker ps -a --filter label=com.docker.compose.project=checkist_qa_f6_run --format '{{.Names}} {{.Status}}'`; `docker network ls --filter name=checkist_qa_f6_run_default --format '{{.Name}}'`; `Get-NetTCPConnection -State Listen` с фильтром 25437/16384/18005/15178 | Пусто: контейнеров, сети и слушателей QA нет |
| `git diff --check` | Ошибок whitespace нет |

Числа реально выполненных тестов:

| Приложение | Без БД | Integration |
| --- | --- | --- |
| `catalog` | 9 | 80 |
| `stores` | 14 | 79 |
| `receipts` | 18 | 238 |
| `health` | 26 | 7 |
| Всего | **67** | **404** |

F6 добавил 21 метод в `ReceiptInlineUniqueTests` (`TransactionTestCase`): три исходных сценария, повтор отказа, дубли итогового состояния, INSERT/UPDATE и каскадные позиции, скидки/налоги, успешные отдельные сохранения и свободные номера, шесть гонок на отдельных соединениях с настоящим commit после clean, три subtest ожидания незавершённого unique при штатных 2 с. Snapshot включает также журнал действий. Отдельный тест настоящего check violation после clean подтверждает узкую обработку IntegrityError. Пользователи только вымышленные в тестовой БД, постоянного суперпользователя агент не создавал.

`orca-board task answer --task task_mutq6zvv31` возвращал только id без текста; задан штатный вопрос `q_mutr1ev43i` (ответ «Передать runner»). Оригинальный runner найден в оставленной проверяющим временной папке и скопирован без изменений. SHA-256 исходника и копии `edge_review.py`: `8CBEE122A4DBFBE04BD107D4915B50DB2D71019EF12E8E4D0D09FB3C896D654F`. Старый runner извлечён из Python-блока полного ответа `task_mutnyh9k1e` без изменения ожиданий. Raw-логи и оба runner находятся вне репозитория в `$env:TEMP/checkist-f6`.

### Проверено и не прошло

- **До исправления:** `./backend/.venv/Scripts/python.exe -X utf8 "$env:TEMP/checkist-f6/edge_review.py"` — exit 1, **3 FAIL**, 1.675 с: все HTTP 500, IntegrityError `receipts_receiptline_receipt_position_uniq`. Runner подтвердил rollback, но статус нарушал контракт. На окончательном коде та же команда — 3/3 OK, без изменения ожиданий.
- **Первый локальный прогон F6:** `manage.py test receipts.tests.test_admin.ReceiptInlineUniqueTests --noinput --verbosity=2` — exit 1, 19 тестов, один subtest FAIL: для каскадной занятой позиции стандартная проверка дублей Django сработала до новой проверки и вернула код None. Проверка занятых ключей перенесена перед `super().clean()`, ожидание сохранено. Затем F1/F4/F6 — 53/53 OK; после двух дополнительных контролей окончательный полный набор — 404/404 OK.
- **Подготовка environment:** dot-source временного `qa.ps1` — `PSSecurityException` из-за ExecutionPolicy. Команда оболочки продолжилась и создала только наш отдельный project `checkist_qa_f6` с defaults и собственными пустыми томами, до БД-команд. Он сразу остановлен `docker compose -p checkist_qa_f6 down`, exit 0. Для правильных overrides создан новый `checkist_qa_f6_run`; env в каждом вызове задавался напрямую, системная политика не менялась. Никаких тестовых записей/миграций в первом project не было; его пустые тома сохранены, контейнеров/сети нет.
- Вспомогательные скрипты обработки Markdown/логов первоначально завершались exit 1: UTF-8 stdin PowerShell не был задан, затем parser не учитывал сообщения журнала и переносы длинных test IDs. Исправлены кодировка передачи и разбор; окончательная запись документов и сверка всех 67/404 IDs — exit 0. Код продукта и ожидания тестов ради этих служебных ошибок не менялись.

На окончательном коде ни одна обязательная проверка не упала. Ожидаемый журнал HTTP 500 контрактных health-тестов и искусственного check violation не является отказом их проверок.

### Не проверено и почему

- **Визуальная/интерактивная приёмка, настоящий успешный вход и виджеты:** только человек по правилам проекта. Поднять QA с environment выше, `migrate`, человеком выполнить `createsuperuser`, `runserver 127.0.0.1:18005`, пройти шаги 1–13 на `/admin/`. Автоматического обхода browser UI, скриншотов и отдельного макета нет. Для SPA — существующий ручной сценарий с Vite `--port 15178`, proxy на 18005.
- **Полная копия 471 штатного теста в Linux:** host TCP доступен, весь набор выполнен на Windows с настоящими QA Postgres/Redis; worker отдельно проверен. При отдельной Linux-приёмке повторить `docker compose -p checkist_qa_f6_run exec -T worker python -X utf8 manage.py test catalog stores receipts health --tag=integration --noinput --verbosity=2` и вариант с `--exclude-tag=integration`.
- **Настоящий deadlock, другие SQLSTATE, прямые ORM/SQL-инварианты, нагрузка:** F6 покрывает конфликт с прямой конкурентной вставкой, но не добавляет гарантий целостности связей произвольным писателям. SQLSTATE `40P01` — обработка по коду, без отдельного настоящего deadlock. Остальные сценарии требуют отдельной задачи/представительных QA-данных; их нельзя считать проверенными.
- **Revert, миграционный откат, backup restore, production:** схема не менялась, новых миграций нет; эти побочные действия не требовались. Revert F6 описан в data-model.md, фактически не выполнялся. Миграционный откат — на отдельной пустой QA-БД; восстановление дампа — в новую БД со сравнением данных.
- **Живой runserver smoke, frontend lint/unit/build, Vite proxy, stop/recovery:** соответствующий код не менялся, не запускались. HTTP админки проверен Django Client с commit/rollback, очередь — настоящим `check_services`. Для повторения использовать команды HTTP/proxy и ручную приёмку выше.

## Фактические результаты после F4, 2026-10-04

Исторический прогон F5 до F6: его 67/383 и 18/217 у `receipts` сохранены как фактические результаты того состояния. Последующее ревью выявило конфликты позиций; актуальное поведение и результаты — в [прогоне F6](#фактические-результаты-f6-2026-10-04).

Задача F5 (`task_mutomytj20`), исходный HEAD `fb11b87` после слияния F4 (`a686413`). Код и тесты F4 сверены с `git log`, `git show a686413 -- backend/receipts/admin.py`, `backend/receipts/tests/test_admin.py` и полным отчётом ревью `orca-board task answer --task task_mutnyh9k1e`. В F5 изменены только шесть Markdown-файлов: этот документ, `data-model.md`, `development.md`, корневые `AGENTS.md`, `CLAUDE.md`, `README.md`. Код, тесты, модели, настройки, миграции, Compose и зависимости не менялись. Публичный health API, его потребители и правила доступа сохранены; F4 меняет валидацию и порядок сохранения HTML-форм админки, как описано выше.

Среда: Windows Python 3.13.9, Docker 29.8.1 / Linux daemon, Compose 5.5.1; Linux worker Python 3.13.16, Celery 5.6.3, prefork/concurrency 2. Выделены новый Compose project и БД `checkist_qa_f5`, новые тома и сеть, тестовая БД `test_checkist_qa_f5`, Postgres 25436, Redis 16383. Порты API 18004 и Vite 15177 зарезервированы для ручного повтора, серверы в этом прогоне не запускались. До старта фильтры контейнеров, томов project и LISTEN этих четырёх портов были пусты. Dev, другие QA и локальный Postgres не затрагивались. `.env` создан из образца, venv подготовлен с закреплённым набором; оба игнорируются Git.

Полный environment применялся в каждом QA-вызове из корня worktree; каждая Compose-команда использовала `-p checkist_qa_f5`:

```powershell
$env:POSTGRES_DB = 'checkist_qa_f5'
$env:POSTGRES_HOST = '127.0.0.1'
$env:POSTGRES_PORT = '25436'
$env:REDIS_PORT = '16383'
$env:CELERY_BROKER_URL = 'redis://127.0.0.1:16383/0'
$env:CELERY_RESULT_BACKEND = 'redis://127.0.0.1:16383/1'
$env:DJANGO_CACHE_URL = 'redis://127.0.0.1:16383/2'
$env:VITE_API_BASE_URL = '/api'
$env:DEV_API_PROXY_TARGET = 'http://127.0.0.1:18004'
```

### Проверено и прошло

Ниже `manage.py` означает точный префикс `./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py`. Все команды таблицы завершились с **exit 0**; зависимые шаги выполнялись после проверки exit предыдущего. Полный набор выполнен после правок описания F4; затем в документы добавлены фактические результаты. Код и тесты во время прогона не менялись.

| Фактическая команда | Наблюдаемый результат |
| --- | --- |
| `py -3.13 --version`; `docker --version`; `docker compose version`; `docker info --format 'OS={{.OSType}}'` | Версии среды выше; Linux daemon |
| `docker compose -p checkist_qa_f5 config --quiet` | Валидная конфигурация |
| `docker compose -p checkist_qa_f5 up -d --wait --wait-timeout 90 postgres redis` | Созданы отдельные тома/сеть; оба сервиса healthy |
| `socket.create_connection(('127.0.0.1', port), timeout=2)` через `./backend/.venv/Scripts/python.exe -X utf8 -`, порты 25436/16383 | Оба Windows TCP OK до действий с БД |
| `./backend/.venv/Scripts/python.exe -X utf8 -m pip check` | `No broken requirements found.` |
| `manage.py check` | `System check identified no issues (0 silenced).` |
| `manage.py makemigrations --check --dry-run` | `No changes detected` |
| `manage.py migrate --noinput` | На пустой QA-БД применены все 22 миграции: 18 стандартных и 4 собственных |
| `docker compose -p checkist_qa_f5 up -d --build --wait --wait-timeout 120 worker` | Worker healthy; слои установки зависимостей взяты из cache, код скопирован заново |
| `manage.py test catalog stores receipts health --exclude-tag=integration --noinput --verbosity=2` | **67 tests OK**, 3.213 с; `Skipping setup of unused database(s): default.` |
| `manage.py test catalog stores receipts health --tag=integration --noinput --verbosity=2` | **383 tests OK**, 66.686 с; runner создал, мигрировал и удалил `test_checkist_qa_f5` |
| `docker compose -p checkist_qa_f5 exec -T worker python --version`; `… python -m pip check` | Python 3.13.16; зависимости образа без конфликтов |
| `docker compose -p checkist_qa_f5 exec -T worker python -X utf8 manage.py check` | 0 issues, в том числе импорт/конфигурация админок в Linux |
| `docker compose -p checkist_qa_f5 exec -T worker python -X utf8 manage.py makemigrations --check --dry-run` | `No changes detected` |
| `docker compose -p checkist_qa_f5 exec -T worker celery -A config inspect ping --destination=checkist@worker --timeout=2` | Control pong, `1 node online.` |
| `docker compose -p checkist_qa_f5 ps`; `… logs --tail 25 worker` | Три healthy services, loopback 25436/16383, worker ready, зарегистрирована `health.ping`, prefork/concurrency 2 |
| `manage.py check_services`; `docker compose -p checkist_qa_f5 exec -T worker python -X utf8 manage.py check_services` | Оба: `database=ok`, `redis=ok`, `celery_task.status=ok`, настоящий `result={"message":"pong"}` через очередь и result backend |
| QA-psql запросы ниже | 22 записи миграций, 3 страны, 3 валюты, 4 ставки; тестовая БД удалена |
| Анализ двух raw verbose-логов через venv Python | Числа уникальных выполненных test IDs совпали с `Ran … / OK` и discovery; skipped/failures/errors нет, все 20 методов F4 выполнены |
| `docker compose -p checkist_qa_f5 down` | Созданные контейнеры и сеть удалены, два QA-тома сохранены |
| `docker ps -a --filter label=com.docker.compose.project=checkist_qa_f5 --format '{{.Names}} {{.Status}}'`; `Get-NetTCPConnection -State Listen` с фильтром 25436/16383/18004/15177; `docker network ls --filter name=checkist_qa_f5_default --format '{{.Name}}'` | Пустые результаты: контейнеров, слушателей и сети QA нет |
| `git diff --check` | Ошибок whitespace нет; изменены только `.md`, UTF-8/LF |

Фактическая проверка состояния QA-БД после runner:

```powershell
docker compose -p checkist_qa_f5 exec -T postgres psql -U checkist -d checkist_qa_f5 -tAc "SELECT count(*) FROM django_migrations; SELECT count(*) FROM stores_country; SELECT count(*) FROM stores_currency; SELECT count(*) FROM stores_taxrate; SELECT count(*) FROM pg_database WHERE datname = 'test_checkist_qa_f5';"
```

Ответ: `22`, `3`, `3`, `4`, `0`. Это проверка текущего состояния и сидов, не проверка восстановления backup.

| Приложение | Без БД: выполнено | Integration: выполнено |
| --- | --- | --- |
| `catalog` | 9 | 80 |
| `stores` | 14 | 79 |
| `receipts` | 18 | 217 |
| `health` | 26 | 7 |
| Всего | **67** | **383** |

Прошли все 20 регрессий `ReceiptInlineTransactionTests`: пять устаревших DELETE с повторной отправкой, шесть отказов DELETE с правкой/созданием зависимости (включая каскад), четыре разрешённых сценария удаления/отвязки и пять сценариев занятых записей при штатном `statement_timeout=2s`. Это HTTP через Django Client и настоящий Postgres с commit/отдельными соединениями, без браузера. Две строки `Internal Server Error: /api/health/` в unit-логе — ожидаемый журнал mocked теста безопасного 500, сам тест OK. Raw логи и подсчёты оставлены вне репозитория в `%TEMP%/checkist-f5-task_mutomytj20/` (`exclude-tag.log`, `tag.log` и соответствующие `.json`); пользовательские пути и логи в коммит не включены.

### Проверено и не прошло

Упавших тестов продукта, обязательных проверок и выявленных дефектов кода нет. Два сбоя вспомогательной оболочки сохранены отдельно:

- Скрипт замены Markdown через `./backend/.venv/Scripts/python.exe -X utf8 -` — exit 1, `ValueError: substring not found` до записи файлов: PowerShell передал русские строки here-string через исходную кодировку pipeline. После установки `$OutputEncoding = [System.Text.UTF8Encoding]::new($false)` скрипт завершился с exit 0; документы проверены. Код и ожидания тестов не менялись.
- JS-оболочка вызовов tools завершилась `Unable to store "qaUpSession". Only plain serializable objects can be stored.` после успешного Compose up (exit 0): попытка сохранить отсутствующий session id уже завершившейся команды. Это не отказ Docker или продукта; состояние QA затем подтверждено TCP-пробами и `ps`, команды прогона завершились нормально.

### Не проверено и почему

- **Браузер/UI, успешный вход через настоящую форму, виджеты и визуальное отображение ошибок** — принимает человек; автоматический обход запрещён. Для повтора поднять QA по блоку environment и командам выше, человеку создать суперпользователя `manage.py createsuperuser`, запустить `manage.py runserver 127.0.0.1:18004 --noreload`, открыть `http://127.0.0.1:18004/admin/` и пройти шаги 1–11 ручной приёмки. Для psql в шагах 8/11 заменить project и БД на `checkist_qa_f5`. После проверки остановить сервер и выполнить `docker compose -p checkist_qa_f5 down`.
- **Повтор всего набора в Linux** — host TCP доступен, все 450 тестов выполнены на Windows против QA Postgres/Redis; worker отдельно проверен командами таблицы. При необходимости повторить `docker compose -p checkist_qa_f5 exec -T worker python -X utf8 manage.py test catalog stores receipts health --tag=integration --noinput --verbosity=2`, затем ту же команду с `--exclude-tag=integration`. Это отдельная копия прогона, не выполненный fallback.
- **Настоящий deadlock (`40P01`), неизвестные SQLSTATE и таймауты остальных SQL** — в текущем наборе нет отдельных сценариев. Обработка `40P01` сверена только с кодом; занятость NOWAIT и ожидающие блокировки сверх 2 с подтверждены тестами F4. Не обобщать это на любые ошибки БД или deadline всего POST.
- **Нагрузочные объёмы, production/DEBUG=0, revert F4, миграционный откат и восстановление `pg_dump`** — схемы не менялись, задача не требует этих побочных действий. Для нагрузки нужны представительные QA-данные; для миграционного отката — отдельный пустой QA-проект по разделу модели данных; backup восстанавливать в новую БД со сравнением записей. Откат F4 описан как `git revert a686413`, фактически не выполнялся.
- **Живой runserver HTTP smoke, frontend lint/unit/build, Vite proxy, stop/recovery и браузер SPA** — в F5 не повторялись: задача ограничена документацией и итоговым серверным прогоном, соответствующий код не менялся. HTTP админки F4 подтверждён Django Client, health — contract/integration-тестами, очередь — настоящим `check_services`. Прежние live HTTP-результаты оставлены историческими; для повторения использовать разделы HTTP/proxy выше, для SPA — сценарий ручной UI-приёмки с QA Vite на 15177 и proxy target 18004.

## Фактические результаты исправлений F1/F2, 2026-10-04

Исторический прогон до F4: 67/363 и 18/197 у `receipts` ниже — результаты тогдашнего набора. Последующее ревью `task_mutnyh9k1e` выявило два не покрытых им дефекта inline DELETE, исправленных в `a686413`; актуальные числа и повтор всех тестов — в [прогоне F5](#фактические-результаты-после-f4-2026-10-04). Исторические результаты не заменяют проверку F4.

Задача F3 (`task_mutmy8f5c`), код ветки `d99787e` после слияния F1 (`7aa388d`) и F2 (`c895168`). В F3 меняются только `.md`; модели, тесты, настройки, зависимости и миграции сохранены. HTTP API, аутентификация и права не меняются. Изменения поведения форм: перенос строки с зависимостями теперь отклоняется; пустые/null Attributes при правке очищают прежнее значение; конкурирующий POST категории может получить `category_tree_busy` и требует явного повтора.

Среда: Windows Python 3.13.9, Docker 29.8.1 / Linux daemon, Compose 5.5.1, worker Python 3.13.16. Выделены новый Compose project и БД `checkist_qa_f3`, новые тома, тестовая БД `test_checkist_qa_f3`, Postgres 25435, Redis 16382, Django 18003; Vite не запускался (15176 зарезервирован для возможной ручной приёмки). Общие QA-проекты были заняты; их контейнеры, процессы и данные не затрагивались. Применён весь QA-блок выше с заменами `POSTGRES_DB=checkist_qa_f3`, `POSTGRES_PORT=25435`, `REDIS_PORT=16382`, портов во всех трёх Redis URL и `DEV_API_PROXY_TARGET=http://127.0.0.1:18003`; все Compose-команды — с `-p checkist_qa_f3`.

### Проверено и прошло

Ниже `manage.py` означает точный префикс `./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py`. Все завершившиеся команды таблицы — exit 0. Перед зависимым шагом проверялся exit предыдущего.

| Фактическая команда | Наблюдаемый результат |
| --- | --- |
| `Copy-Item .env.example .env` при отсутствии файла; `py -3.13 -m venv backend/.venv`; `./backend/.venv/Scripts/python.exe -X utf8 -m pip install -r backend/requirements.txt` | Подготовлены только игнорируемые env/venv, установлен закреплённый набор |
| `docker compose -p checkist_qa_f3 config --quiet`; `docker compose -p checkist_qa_f3 up -d --wait --wait-timeout 90 postgres redis` | Созданы отдельные тома/сеть, оба сервиса healthy |
| `socket.create_connection(('127.0.0.1', port), timeout=2)` через `./backend/.venv/Scripts/python.exe -X utf8 -`, порты 25435/16382 | Оба Windows TCP OK до локальных действий с БД |
| `./backend/.venv/Scripts/python.exe -X utf8 -m pip check` | `No broken requirements found.` |
| `manage.py check` | `System check identified no issues (0 silenced).` |
| `manage.py makemigrations --check --dry-run` | `No changes detected` |
| `manage.py migrate --noinput` | 22 миграции применены на пустой QA-БД: 18 стандартных и 4 собственных |
| `docker compose -p checkist_qa_f3 up -d --build --wait --wait-timeout 120 worker` | Worker healthy, prefork/concurrency 2; установка зависимостей образа использовала cache |
| `manage.py test catalog stores receipts health --exclude-tag=integration --noinput --verbosity=2` | 67 tests OK за 4.379 с, `Skipping setup of unused database(s): default.` |
| `manage.py test catalog stores receipts health --tag=integration --noinput --verbosity=2` | 363 tests OK за 51.987 с, без skipped tests; runner создал/мигрировал/удалил `test_checkist_qa_f3` |
| `docker compose -p checkist_qa_f3 exec -T worker python -m pip check` | Зависимости образа без конфликтов |
| `docker compose -p checkist_qa_f3 exec -T worker python -X utf8 manage.py check` | 0 issues, в том числе импорт и конфигурация админок в Linux |
| `docker compose -p checkist_qa_f3 exec -T worker python -X utf8 manage.py makemigrations --check --dry-run` | `No changes detected` |
| `manage.py check_services`; `docker compose -p checkist_qa_f3 exec -T worker python -X utf8 manage.py check_services` | Оба: database/redis OK, `celery_task.status=ok`, настоящий результат `message=pong` через очередь/results, eager не использовался |
| `docker compose -p checkist_qa_f3 exec -T worker celery -A config inspect ping --destination=checkist@worker --timeout=2` | Control pong, `1 node online.` |
| `docker compose -p checkist_qa_f3 ps` | Все три сервиса healthy, host-порты 25435/16382 |
| `manage.py runserver 127.0.0.1:18003 --noreload`, HTTP-валидатор ниже | Настоящие ответы: `/admin/` 302 с точным Location, `/admin/login/` 200 HTML с русским заголовком, CSS 200 text/css, health 200 с точным JSON и no-store |
| `docker compose -p checkist_qa_f3 down`; `docker ps -a --filter label=com.docker.compose.project=checkist_qa_f3 --format '{{.Names}} {{.Status}}'`; `Get-NetTCPConnection -State Listen` с фильтром 25435/16382/18003/15176 | Контейнеры/сеть удалены, фильтр пуст, слушателей нет; тома сохранены |

Числа по приложениям получены из фактически выполненных test IDs в verbose-логах, сверены с полным `Ran … / OK` и отдельно с discovery через `django.test.utils.iter_test_cases`: `catalog` **9/80**, `stores` **14/79**, `receipts` **18/197**, `health` **26/7** (без БД / integration), итого **67/363**. В этих 363 тестах прошли 10 сценариев переноса и 4 гонки F1; 4 сценария Attributes и 3 гонки категорий F2. Subtests отдельными тестами не считаются.

HTTP-валидатор выполнялся с Windows после запуска runserver; это HTTP, без обхода browser UI:

```powershell
$OutputEncoding = [System.Text.UTF8Encoding]::new()
@'
import json
from urllib.request import build_opener, HTTPRedirectHandler
from urllib.error import HTTPError
class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None
opener = build_opener(NoRedirect)
for path, status, content_type in [('/admin/', 302, 'text/html'), ('/admin/login/', 200, 'text/html'), ('/static/admin/css/base.css', 200, 'text/css'), ('/api/health/', 200, 'application/json')]:
    try:
        response = opener.open('http://127.0.0.1:18003' + path, timeout=15)
    except HTTPError as error:
        response = error
    with response:
        body = response.read()
        assert response.status == status, (path, response.status)
        assert response.headers.get_content_type() == content_type
        if path == '/admin/':
            assert response.headers['Location'] == '/admin/login/?next=/admin/'
        elif path == '/admin/login/':
            assert 'Checkist — администрирование' in body.decode('utf-8')
        elif path == '/api/health/':
            assert json.loads(body) == {'status': 'ok', 'checks': {name: {'status': 'ok'} for name in ('database', 'redis', 'celery')}}
            assert response.headers['Cache-Control'] == 'no-store'
        print(path, status, content_type, 'OK')
'@ | ./backend/.venv/Scripts/python.exe -X utf8 -
```

После HTTP runserver остановлен Ctrl+C в управляемой PTY-сессии (exit 1 вследствие прерывания). QA была остановлена, затем поднята повторно для исправленной HTTP-проверки командой `docker compose -p checkist_qa_f3 up -d --wait --wait-timeout 120 postgres redis worker` (exit 0); финальный `down` снова exit 0. Журналы полного тестового прогона хранились во временной папке вне репозитория; реальные данные/секреты в документы не переносились.

### Проверено и не прошло

Упавших тестов продукта и обязательных проверок нет. Сохранены три сбоя вспомогательных скриптов; код приложения не менялся, ожидания тестов не ослаблялись:

- Discovery: `manage.py shell -c 'from collections import Counter; from django.test.runner import DiscoverRunner; runner = DiscoverRunner(verbosity=0); suite = runner.build_suite(["catalog", "stores", "receipts", "health"]); tests = list(runner._flatten_suite(suite)) if hasattr(runner, "_flatten_suite") else []; print(len(tests))'` — exit 1, `NameError: name 'catalog' is not defined`. PowerShell потерял внутренние кавычки native-аргумента. Исправлено передачей Python через here-string/stdin и использованием `iter_test_cases`; discovery вернул текущие числа, exit 0. Это не запуск тестов.
- Первый подсчёт verbose-лога через `./backend/.venv/Scripts/python.exe -X utf8 -` и regex `\((catalog|stores|receipts|health)\.tests\.[^)]+\) \.\.\. ok` — exit 1, `AssertionError`: найдено 63 вместо 67. PowerShell форматирует перенаправленный stderr с переносами строк, а тест безопасного 500 вставляет журнал между ID и `ok`. Исправленный подсчёт уникальных полных test IDs без требования соседства `ok` подтвердил 67 и 363, сверив `Ran … / OK`, exit 0. Сам runner обе команды завершил с exit 0.
- Первый запуск HTTP-валидатора выше **без** строки `$OutputEncoding = …` — exit 1 на сравнении русского заголовка login. Диагностика показала `OutputEncoding=us-ascii` и поступившую в Python строку `Checkist ? ?????????????????`. При явном UTF-8 тот же валидатор с прежними assertions прошёл все четыре URL, exit 0. Этот отказ не был отказом страницы: сервер оба раза вернул 200 HTML.

### Не проверено и почему

- Визуальная/интерактивная приёмка админки и SPA, реальный вход с паролем, скриншоты — по правилам выполняет человек. Подготовить QA, `createsuperuser`, runserver на QA-порту; пройти [сценарий админки](#ручная-приёмка-админки-человеком), особенно шаги 6–8. Для SPA дополнительно запустить QA Vite и пройти [отдельный сценарий](#ручная-ui-приёмка-человеком). HTTP и `django.test.Client` этих результатов не подтверждают.
- Frontend lint/unit/build, Vite proxy и stop/recovery зависимостей в F3 не повторялись: код frontend/health/Compose не менялся, задача — документация F1/F2 и полный серверный прогон. Воспроизводимые команды и прежние результаты сохранены выше; текущий health подтверждён contract/integration-тестами и HTTP 200.
- Полная копия тестового прогона внутри Linux worker не выполнялась: host TCP работал, все 430 тестов выполнены на Windows против QA Postgres/Redis; контейнер проверен командами таблицы. Linux-раздел выше — воспроизводимый fallback при недоступности host-пути.
- Откат/revert F1/F2, восстановление `pg_dump`, нагрузка и длительная блокировка строк F1 сверх 2 с не выполнялись; схема не менялась, revert вернул бы исправленные дефекты. Для нагрузки/таймаутов нужна отдельная QA-проверка с представительным объёмом и управляемой блокировкой; пределы описаны в [data-model.md](data-model.md#конкурентные-правки). При необходимости проверки миграционного отката — отдельный пустой QA-проект и команды раздела [модели данных](#модель-данных-catalog-stores-receipts), восстановление дампа — в новую БД со сравнением строк.

## Фактические результаты проверки админки, 2026-10-03

Исторический прогон до F1/F2/F4: числа 67/342 и 73/183 ниже не являются текущими. Актуальные результаты — в [прогоне F5](#фактические-результаты-после-f4-2026-10-04).

Задача T5 (`task_musmfb796y`): состояние ветки после слияния T1–T4 (`f164bad`) плюс правки документов; код и тесты в этой задаче не менялись. Windows-хост: Python 3.13.9, Docker/Linux daemon. Использованы только Compose project и БД `checkist_qa`, тестовая `test_checkist_qa`, Postgres 25432, Redis 16379, Django 18000 — полный QA environment выше. Перед запуском контейнеров project и слушателей на QA-портах не было. Том `checkist_qa` существовал от прежних прогонов. Dev-контейнеры `checkist_dev` работали параллельно и не затрагивались.

### Проверено и прошло

Команды `manage.py` запускались как `./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py …`; у каждой — exit 0.

| Фактическая команда | Результат |
| --- | --- |
| `Copy-Item .env.example .env`, `py -3.13 -m venv backend/.venv`, `pip install -r backend/requirements.txt`, `pip check` | Созданы игнорируемые env/venv; `No broken requirements found.` |
| `docker compose -p checkist_qa config --quiet`, `up -d --wait --wait-timeout 90 postgres redis` | Оба healthy на `127.0.0.1:25432` и `127.0.0.1:16379` |
| `Test-NetConnection 127.0.0.1 -Port 25432`, `-Port 16379` | Оба `TcpTestSucceeded=True` |
| `manage.py check` | `System check identified no issues (0 silenced).` |
| `manage.py makemigrations --check --dry-run` | `No changes detected` |
| `manage.py migrate --noinput` | `No migrations to apply.` — в существующем томе миграции уже применены |
| `manage.py test catalog stores receipts health --exclude-tag=integration` | 67 tests OK, БД не использовалась |
| Та же команда отдельно по приложениям | `catalog` 9, `stores` 14, `receipts` 18, `health` 26 |
| `manage.py test catalog stores receipts health --tag=integration --noinput` | 342 tests OK за 88 с; `test_checkist_qa` создана и удалена runner |
| Та же команда отдельно по приложениям | `catalog` 73, `stores` 79, `receipts` 183, `health` 7 |
| `docker compose -p checkist_qa up -d --build --wait --wait-timeout 180 worker` | Worker healthy |
| `docker compose -p checkist_qa exec -T worker python -m pip check` | `No broken requirements found.` |
| `docker compose -p checkist_qa exec -T worker python -X utf8 manage.py check` | 0 issues: `admin.py` трёх приложений импортируются в Linux-контейнере |
| `docker compose -p checkist_qa exec -T worker python -X utf8 manage.py makemigrations --check --dry-run` | `No changes detected` |
| Linux-путь: `docker compose -p checkist_qa exec -T worker python -X utf8 manage.py test catalog stores receipts health --tag=integration --noinput`, затем `… --exclude-tag=integration` | Exit 0: найдено и выполнено 342 и 67 tests |
| `manage.py check_services` | `{"database": "ok", "redis": "ok", "celery_task": {"status": "ok", "result": {"message": "pong"}}}` |
| `manage.py runserver 127.0.0.1:18000 --noreload` | Сервер обслужил запросы ниже, затем остановлен |
| `curl.exe -sS -i --max-time 15 http://127.0.0.1:18000/admin/` | Curl exit 0; HTTP 302, `Location: /admin/login/?next=/admin/`, `X-Frame-Options: DENY` |
| `curl.exe -sS -i --max-time 15 http://127.0.0.1:18000/admin/login/` | Curl exit 0; HTTP 200, `text/html; charset=utf-8`, `<title>Войти \| Checkist</title>`, заголовок «Checkist — администрирование», форма с CSRF-токеном, ссылки на `/static/admin/css/*.css` |
| `curl.exe -sS -i --max-time 15 http://127.0.0.1:18000/api/health/` | Curl exit 0; HTTP 200, `application/json`, `Cache-Control: no-store`, три checks `ok` |
| `curl.exe -sS -o NUL -w '…' --max-time 15 http://127.0.0.1:18000/static/admin/css/base.css` | Curl exit 0; HTTP 200, `text/css`, 22 120 байт |

### Проверено и не прошло

Дефектов кода и упавших проверок нет. В выводе тестов без БД дважды встречается `Internal Server Error: /api/health/` — это ожидаемый журнал контрактных тестов ответа 500, тесты при этом OK.

### Не проверено и почему

- **Страницы админки в браузере**: внешний вид и стили, списки 12 моделей, ввод чека, автодополнение, удаление. Автоматический обход UI запрещён; принимает человек по [сценарию выше](#ручная-приёмка-админки-человеком). Суперпользователь в QA не создавался.
- **Вход через настоящую форму** (логин и пароль): тесты входят через `force_login`, форма проверена только на отказ пользователю без `is_staff`. Шаг 1 сценария.
- **Страницы удаления** (отказ по `PROTECT`, подтверждение каскада): автотестов на них нет, поведение — стандартное для Django. Шаг 5 сценария.
- **Перестановка `position` двух строк через свободный номер**: тестами покрыта только ошибка формы при повторе номера. Дополнительный шаг сценария.
- **Админка при `DJANGO_DEBUG=0`** и production-настройки (статика, secure cookies, HTTPS): не настроены и не проверялись, админка — только для dev/QA.
- **Поведение на больших объёмах** при `statement_timeout=2000` мс (поиск, подсчёт строк, страница чека с сотнями позиций): представительных данных нет, замеров нет. Шаги: наполнить QA-БД чеками, открыть списки с поиском и замерить время ответа.
- **`migrate` на пустой БД** в этом прогоне не повторялся: том уже содержал применённые миграции, а новых миграций задача не добавляет. Результат на пустой БД — в разделе ниже.
- **Frontend-проверки (`npm`), proxy и сценарии отказов health** не повторялись: код health, клиента и Compose не менялся. Результаты — в разделах ниже.

Уборка: runserver остановлен, `docker compose -p checkist_qa down` — контейнеры и сеть удалены, тома сохранены.

## Фактические результаты интеграции через proxy, 2026-10-03

Исторический прогон до модели данных и админки: числа health 21/2 ниже относятся к тому состоянию; текущий набор health — 26/7 в [прогоне F5](#фактические-результаты-после-f4-2026-10-04). Frontend в F4/F5 не менялся.

Задача `task_muscdxor28`. Windows Python 3.13.9, Node 24.18.0/npm 11.16.0, Docker 29.8.1/Linux, Compose 5.5.1. Использованы полный QA environment выше, только Compose project/БД `checkist_qa` и временная `test_checkist_qa`; Postgres 25432, Redis 16379, Django 18000, Vite 15173. Порты были свободны. Dev, локальный Postgres, WSL, VPN и Docker Desktop не изменялись.

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

Числа тестов в этом разделе (62 и 158) относятся к состоянию до появления админки; актуальные — в [прогоне F5](#фактические-результаты-после-f4-2026-10-04). Источник: задача T5 (`task_musd0fst2t`), состояние ветки после слияния T0–T4; код и тесты в этой задаче не менялись. Windows-хост: Python 3.13.9, Docker 29.8.1 (Linux daemon), Postgres 17.11. Использован отдельный Compose project `checkist_qa_t5` с новыми томами, БД `checkist_qa_t5`, тестовая БД `test_checkist_qa_t5`, Postgres 25432, Redis 16379: том `checkist_qa` уже существовал и не гарантировал пустую БД. Dev-данные и локальный Postgres не затронуты. Environment — блок выше с `POSTGRES_DB = "checkist_qa_t5"`.

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
