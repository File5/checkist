# Проверки и приёмка

## Граница проверки

Реализованы backend scaffold (health API, Postgres/Redis probes, Celery task/CLI, Compose), React/TypeScript/Vite SPA с настоящим health API через proxy и предметная модель данных чеков — приложения `catalog`, `stores`, `receipts` с миграциями и тестами ([data-model.md](data-model.md)) — и HTTP API чтения этой модели, приложение `api` с 13 GET-эндпоинтами ([api-contract.md](api-contract.md#реализовано-api-чтения-каталога-и-цен)). Контрактные тесты health используют mocks; integration-tag tests работают с реальными Postgres и Redis; выполнение очереди и result backend проверяет отдельный `check_services`. Ограничения БД, каскады, сиды, дедупликацию, проверку чека и историю цен проверяют integration tests трёх приложений на реальном Postgres. API чтения проверяют тесты `api`: без БД — разбор параметров, пагинация, сериализация, курсы и формат ошибок; с тегом `integration` — эндпоинты через тестовый клиент Django на реальном Postgres; настоящий HTTP — сценарии `curl.exe` [ниже](#http-api-чтения). Django admin (`/admin/`, 12 моделей и inline чека) проверяют `test_admin.py` трёх приложений и `health/tests/test_admin_site.py` через `django.test.Client`: это HTTP-запросы к настоящим страницам админки без браузера. Vitest проверяет клиентский API-адаптер с mocked fetch; CLI `backend/scripts/check_health_proxy.mjs` — настоящий HTTP и тот же адаптер через proxy в Node 24.

Реализован `recognition`: фото/вырезки MEDIA, очередь PostgreSQL, host-worker, FakeProvider/Codex CLI, автоматический импорт, локальный HTTP upload/cancel/retry и чтение всех строк чеков. Новый сквозной набор — [ниже](#распознавание-сквозная-серверная-проверка). Пользовательского входа, HTTP ручного редактирования и дашборда пока нет. Каталог и цены SPA уже подключены к API ([frontend.md](frontend.md)); И4 не меняет клиентские экраны распознавания и не подтверждает их React/proxy/UI интеграцию. Админку проверяют отдельно [без браузера](#админка-проверки-без-браузера) и [человеком](#ручная-приёмка-админки-человеком).

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
./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py test catalog stores receipts health api recognition --exclude-tag=integration --verbosity=2
./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py test catalog stores receipts health api recognition --tag=integration --verbosity=2
./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py check_services
```

Ожидается exit 0, отсутствие новых миграций, 257 тестов без БД и 866 integration, затем JSON с `celery_task.result={"message":"pong"}`. На пустой БД `migrate` применяет 23 миграции: 18 стандартных и 5 собственных, включая recognition.0001_initial. Числа соответствуют текущему коду и могут измениться вместе с тестами. Команда без тега БД не использует; integration нельзя заменять skip/eager. Runner создаёт и удаляет **`test_checkist_qa`**; Redis tests используют QA Redis DB 2 и уникальные ключи. Recognition tests используют временный MEDIA и fake/mock, настоящий Codex не вызывают. Не запускайте два DB-runner одновременно с одним именем test DB: --noinput может пересоздать БД другого своего прогона.

| Приложение | Без БД (`--exclude-tag=integration`) | С БД (`--tag=integration`) |
| --- | --- | --- |
| `catalog` | 9 | 80 |
| `stores` | 14 | 79 |
| `receipts` | 18 | 238 |
| `health` | 26 | 7 |
| `api` | 112 | 305 |
| `recognition` | 78 | 157 |
| Всего | 257 | 866 |

Текущие числа — И4 после согласованного уточнения, итоговый прогон [ниже](#повторный-прогон-после-согласованного-уточнения-и4), Windows, DB `checkist_qa_i4_final` / `test_checkist_qa_i4_final`, Postgres 25475, Redis 16405. Исторический С6: 247/846; merge-прогон без recognition: 179/671; F3–F6 до merge, без api: 67/404. Эти исторические результаты ниже сохраняются со своими датами и scope. Subtests отдельно не считаются. Гонки — TransactionTestCase и отдельные Postgres-соединения. Журналы ожидаемых безопасных HTTP 400/403/409/500 в негативных тестах не означают failure теста; окончательный exit code и сводка runner обязательны.

Unit/contract tests health покрывают точный 200, комбинации 503, сохранение независимых checks, анонимность, игнорирование query/Authorization, 405, 406, безопасный 500 при DEBUG, отсутствие публикации task из health, параллельность probes, cleanup кеша, bounded publication retries и негативную env-валидацию. Это не сетевой замер времени отказа.

Тесты `api` покрывают точные тела эндпоинтов на образцах, фильтры и сортировки, анонимный доступ и игнорирование `Authorization`, 405 и 406, 400 на каждый параметр, 404 на объект, страницу и неизвестный путь, `range_too_large`, пустую БД, смешанные валюты и пересчёт по курсам из запроса, единицы и причины несравнимости, исключение залога, возвратов и скидки на весь чек, границы страниц, число запросов (`assertNumQueries`), отсутствие закрытых полей в ответах, цикл в категориях и сохранение редиректа `/api/health` без слэша. Тесты с тегом `integration` обращаются к views через тестовый клиент Django, без сети.

Регрессии `api.tests.test_query_controls`: 6 тестов без БД и 6 integration. Проверяются NUL в начале, середине и конце `q`, все 65 символов Unicode Cc (C0, DEL, C1) до обрезки пробелов, соседние параметры (`country`, `currency`, `target_currency`, `rates`, `category`, `generic`, `brand`, `store`, `all`, `has_prices`, `ordering`, `interval`, `group_by`, `price`, `scope`, даты и пагинация), единый JSON `400`, `404` на NUL в идентификаторе пути, UTF-8 поиск, последнее повторённое значение и игнорирование неизвестных параметров. Для пяти поисковых списков на пустой БД `assertNumQueries(0)` подтверждает отказ до SQL. Запуск: `manage.py test api.tests.test_query_controls --noinput --verbosity=1` — 12 тестов.

Регрессии D1 и E1: `api.tests.test_request_errors` — 24 теста (17 без БД, 7 integration); два дополнительных теста в `test_errors` проверяют семейство Django request exceptions и безопасный 415. Граница 1000/1001 проверена на всех 13 маршрутах при обоих DEBUG, с точным JSON, без SQL при отказе. Проверяются percent-кодирование/UTF-8/суррогаты, Host, Accept/Content-Type, конструкторы настоящих WSGI/ASGI request, длинные значения, повторения/пустые имена/массивы, ID, отсутствие чтения body при GET/405, запись без слэша и редактирование access log. E1 проверяет однократное декодирование пути, регистр hex, начальные //, двойное кодирование, dot segments, absolute-form, пустые/битые targets и сохранение обычных путей вне API; нормализация сверена с настоящими парсером runserver и WSGIRequest. Неизвестные `RuntimeError`, `ValueError`, `LookupError`, `UnicodeDecodeError` из view остаются безопасным 500. Запуск: `manage.py test api.tests.test_request_errors api.tests.test_errors --noinput --verbosity=0` — 49 тестов. Полный WSGI-вызов с SQL использует `TransactionTestCase`: сигнал `request_started` закрывает соединение в атомарном обычном `TestCase`.

Регрессии `api.tests.test_read_resilience`: точные значения обоих маршрутов сравнения на границах моделей и курсов, отрицательная оплаченная цена при большой скидке, среднее и процент динамики нормализованных цен. Конкурентное удаление проверяет `TransactionTestCase` с autocommit: `connection.execute_wrapper` перед чтением последних цен коммитит удаление строки и чека через отдельное psycopg-соединение в тестовую БД; результаты SQL не подменяются. Покрыты `price_summary`, карточка и список товаров, оба сравнения (сравнимые и несравнимые предложения), сводка истории, карточка и список обобщённых продуктов, удаление единственной группы и сохранение более раннего наблюдения. Runner очищает данные через flush. Запуск: `manage.py test api.tests.test_read_resilience --tag=integration --noinput --verbosity=2` — 19 тестов.

## Распознавание: сквозная серверная проверка

Сначала полный QA environment выше, затем recognition overrides из [development.md](development.md#qa-сервер-worker-демо). MEDIA/scratch отдельно от dev. Автотесты не вызывают настоящий Codex:

```powershell
./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py test recognition.tests.test_e2e --tag=integration --noinput --verbosity=2
```

11 `TransactionTestCase` на PostgreSQL: настоящий APIClient с cookie/Origin/CSRF, multipart upload → queued → `recognition_worker --once` → succeeded/2 crops; original/preview/crop files и GET их URL байт в байт; receipts/lines/discounts/taxes; точный replay; другое фото по сильной идентичности и отдельно без номеров по store/time/total без новых lines/products; HTTP cancel queued и первого/второго recognize на отдельном соединении; сохранение первой импортированной части; retry failed/cancelled/partial; needs_review с нормализованным результатом, одновременно missing quantity/unit_price и противоречивыми totals. И4 добавляет observation как в С6: operation=null, ambiguous fiscal → Receipt/товары, succeeded/review=0, неблокирующие issues и replay без дублей. После уточнения И4 сквозной тест также подтверждает арифметический вывод отсутствующих quantity/unit_price/amount, pcs для штучной строки и повторное фото с валютой из известного магазина: succeeded, review=0, без дублей. Для MEDIA тест перепривязывает только document_root существующего DEBUG media route к TemporaryDirectory, API-маршруты остаются из config.urls. Это dispatch внутри Django, без HTTP-сокета и браузера.

Регрессия — обе полные команды шести приложений выше. Откат recognition на QA **до загрузок**, при остановленном OCR-worker:

```powershell
./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py migrate --noinput
./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py migrate recognition zero --noinput
./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py migrate recognition --noinput
```

Это удаляет всю recognition-историю, сохраняя domain и MEDIA; перед откатом ценных данных обязательны pg_dump и копия MEDIA. Integration `recognition.tests.test_models.RecognitionMigrationTests` отдельно проверяет откат/повтор на представительном Receipt с товаром/строкой и сравнивает все старые PK/поля. Восстановление backup этим тестом не подтверждается.

### HTTP/CLI без браузера

В QA запустить API 18000 и host-worker `--fake-scenario success2` по development.md. В третьем терминале после **того же** полного environment/recognition block выполнить:

```powershell
$apiBase='http://127.0.0.1:18000'
$cookieFile=Join-Path $env:RECEIPT_OCR_TEMP_ROOT 'qa-http-cookies.txt'
$csrfFile=Join-Path $env:RECEIPT_OCR_TEMP_ROOT 'qa-http-csrf.json'
$uploadFile=Join-Path $env:RECEIPT_OCR_TEMP_ROOT 'qa-http-upload.json'
$demoFile=Join-Path $env:MEDIA_ROOT 'demo/double.png'
curl.exe --fail-with-body -sS --max-time 15 -c $cookieFile -o $csrfFile "$apiBase/api/recognition/csrf/"
if ($LASTEXITCODE -ne 0) { throw 'CSRF request failed' }
$csrf=(Get-Content -Raw -Encoding UTF8 $csrfFile | ConvertFrom-Json).csrf_token
curl.exe --fail-with-body -sS --max-time 30 -b $cookieFile -c $cookieFile -H "Origin: $apiBase" -H "X-CSRFToken: $csrf" -F "file=@$demoFile" -o $uploadFile "$apiBase/api/recognition/photos/"
if ($LASTEXITCODE -ne 0) { throw 'Upload failed' }
$upload=Get-Content -Raw -Encoding UTF8 $uploadFile | ConvertFrom-Json
$jobUrl="$apiBase/api/recognition/jobs/$($upload.job.id)/"
$deadline=(Get-Date).AddMinutes(7)
do {
    $job=Invoke-RestMethod -Uri $jobUrl -TimeoutSec 15
    Write-Output "$($job.status) / $($job.stage)"
    if ($job.status -in 'succeeded','partial_succeeded','failed','cancelled') { break }
    if ((Get-Date) -ge $deadline) { throw 'Job polling timeout' }
    Start-Sleep -Milliseconds 500
} while ($true)
if ($job.status -ne 'succeeded' -or $job.items.Count -ne 2) { throw 'Expected two successful receipts; inspect Job/images' }
$images=Invoke-RestMethod -Uri "$apiBase/api/recognition/receipt-images/?job=$($job.id)" -TimeoutSec 15
foreach ($image in $images.results) {
    $cropFile=Join-Path $env:RECEIPT_OCR_TEMP_ROOT "qa-crop-$($image.id).png"
    curl.exe --fail-with-body -sS --max-time 15 -o $cropFile "$apiBase$($image.image_url)"
    if ($LASTEXITCODE -ne 0) { throw 'Crop GET failed' }
    $receipt=Invoke-RestMethod -Uri "$apiBase/api/receipts/$($image.receipt_id)/" -TimeoutSec 15
    $receipt
    Invoke-RestMethod -Uri "$apiBase$($receipt.lines_url)" -TimeoutSec 15
}
Invoke-RestMethod -Uri "$apiBase/api/receipts/" -TimeoutSec 15
curl.exe --fail-with-body -sS --max-time 30 -b $cookieFile -H "Origin: $apiBase" -H "X-CSRFToken: $csrf" -F "file=@$demoFile" "$apiBase/api/recognition/photos/"
if ($LASTEXITCODE -ne 0) { throw 'Replay failed' }
```

На новой QA БД первый upload — HTTP 202/reused=false; totals 4.42/6.00, 6 lines (5 product + 1 deposit), 5 product IDs; две crop PNG. Последний POST — HTTP 200/reused=true с теми же photo/job IDs. На уже заполненной QA повтор допустимо сразу даёт reused; это не новый OCR-прогон. `Invoke-RestMethod` бросает при HTTP-ошибке, curl exit проверяется явно. Для проверки статуса curl добавить `-w ' HTTP=%{http_code}'`. Cookie/token и ответы остаются в private scratch, не в публичном MEDIA.

Для cancel/retry: получить свежий CSRF, использовать тот же cookie/Origin/header и `Content-Type: application/json`, body `{}` на `${jobUrl}cancel/` или `${jobUrl}retry/`. Queued cancel — 200/cancelled, running — 202/cancel_requested до подтверждения worker; terminal cancel — 409, cancelled replay cancel — 200. Retry failed/partial/cancelled — 202 нового Job, одновременно active sibling —409. Для running cancel остановить свой worker, загрузить новый файл/создать retry, запустить `--fake-scenario pause_recognize`, дождаться stage=recognize и отправить cancel; для needs_review использовать partial_success/inconsistent_total. Не подменять реальный сбой endless retry и не использовать чужой job.

Реальный Codex: остановить fake worker, загрузить **ещё не обработанный** single.png, в worker terminal provider=codex_cli/native exe; запуск и замер:

```powershell
$duration=[System.Diagnostics.Stopwatch]::StartNew()
./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py recognition_worker --once
$workerExit=$LASTEXITCODE
$duration.Stop()
Write-Output "worker exit=$workerExit; seconds=$($duration.Elapsed.TotalSeconds)"
```

Проверить GET job/images и причины независимо от exit. `--once` может вернуть 0 при Job failed/partial; пустая очередь не является OCR-тестом. Если нет native exe/авторизации/сети, сохранить конкретный CommandError/Job.error/time, человеку проверить `codex.exe login status` и доступ к модели, затем повторить в QA. Автотесты не заменяют эту проверку.

### Ручная приёмка OCR человеком

UI загрузки/чеков ещё предстоит реализовать. После интеграции клиента (и `/media` proxy) человек выполняет следующие шаги; текущие [SPA health](#ручная-ui-приёмка-человеком) и [admin](#ручная-приёмка-админки-человеком) сценарии остаются отдельными:

1. QA fake/double.png: загрузка с клавиатуры, loading/stages, две читаемые вырезки без потери текста, чеки 4.42/6.00 и все строки/товары/скидки/залоги/налоги; original и EXIF preview. Проверить mobile/desktop, focus, refresh/back/forward, пустые состояния/ошибки.
2. Точный повтор — прежние photo/job IDs; другое изображение одного чека — новый Photo и тот же Receipt, без новых строк/товаров. Без strong key точный store/time/total связывает; разные реальные чеки с таким совпадением могут ложно объединиться — это ограничение правила v1, сверять с эталоном.
3. Partial_success/inconsistent_total: needs_review, доступный crop, безопасные нормализованные поля и понятные причины; успешная часть остаётся. Нет Draft/формы исправления OCR: API ручного разрешения причин v1 не реализует.
4. Остановить worker, upload → queued → cancel → cancelled. Pause_recognize → cancel_requested → cancelled; retry → новый Job, старый сохраняет outcome. После отмены второго OCR первая часть остаётся. Последний committed import делает cancel 409/job_terminal. Сеть/refresh/отмена browser fetch не отменяют серверную работу.
5. HEIC, битый/анимированный файл, >20 MiB/>40 MP, >10 чеков, нет CSRF/неверный Origin/выключенный flag, отсутствие API/worker/media: корректные ошибки, нет выдуманного успеха. Idle executor=false само по себе не доказывает отсутствие worker.
6. Реальный Codex: разрешённые к облачной обработке фото RU/KZ/DE вне git; эталон числа чеков, границ, полей/строк/сумм/налогов и нечитаемых мест. Проверить один/несколько чеков, поворот, длинный/мятый/термо-чек, блики/размытие, частично обрезанный и не-чек, повтор/лучший снимок/разные чеки с одинаковыми суммами. Сверить timezone магазина, CLI/model/schema versions, реальные durations/errors и каждый Receipt/needs_review с эталоном. Синтетический smoke не доказывает качество этих фото.
7. Проверить нет потери результата, дублей/ложного объединения и перезаписи заполненных значений при последовательном повторе. Не редактировать aggregate параллельно OCR ради гарантии: manual_locked/отпечаток формы и защита stale admin POST сознательно исключены из v1. По существующей админке пройти F4/F6 отдельно.

### Фактические результаты С6

Прогон 2026-10-04–05.

**Проверено и прошло.** Windows Python 3.13.9, Docker 29.8.1/Compose 5.5.1, QA PostgreSQL 17.11/Redis 7.4.11. Только новый Compose project/DB `checkist_qa_c6`, runner `test_checkist_qa_c6`, host Postgres 25466/Redis 16396/API 18006. Environment — весь QA-блок с согласованной заменой портов/DB/proxy; MEDIA и scratch в разных игнорируемых `.orca-attachments/c6/` каталогах, автотесты — TemporaryDirectory. Dev и чужой QA не менялись.

P = `./backend/.venv/Scripts/python.exe -X utf8`. Завершившиеся проверки ниже имеют exit 0; долгоживущие runserver/fake worker подтверждены HTTP и остановлены отдельно.

| Команда | Наблюдаемый результат |
| --- | --- |
| `py -3.13 -m venv backend/.venv`; `P -m pip install -r backend/requirements.txt`; `P -m pip check` | Установка закреплённого набора, No broken requirements |
| `docker compose -p checkist_qa_c6 config --quiet`; `up -d --wait --wait-timeout 90 postgres redis` | Отдельные healthy контейнеры/сеть/тома; socket.create_connection с timeout=2 на 25466/16396 — TCP OK |
| `P backend/manage.py check`; `makemigrations --check --dry-run` | 0 issues; No changes detected |
| `P backend/manage.py migrate --noinput`; `migrate recognition zero --noinput`; `migrate recognition --noinput` | 23 миграции на пустой QA; recognition.0001 unapply/reapply OK |
| `P backend/manage.py test recognition.tests.test_e2e --tag=integration --noinput --verbosity=2` | 9 OK, 10.282 с |
| `P backend/manage.py test catalog stores receipts health api recognition --exclude-tag=integration --noinput --verbosity=1` | 247 OK, 12.395 с, без skips |
| Та же команда с `--tag=integration` | 846 OK, 162.341 с, без skips; представительский reverse/reapply test включён; test DB удалена |
| `docker compose -p checkist_qa_c6 up -d --build --wait --wait-timeout 120 worker`; `P backend/manage.py check_services` | Worker healthy, настоящая Celery task/result pong |
| `docker compose -p checkist_qa_c6 exec -T worker python -m pip check`; `python -X utf8 manage.py check`; `makemigrations --check --dry-run`; `check_services` | Каждая команда exit 0, no broken/0 issues/no changes/реальный pong внутри Docker-сети |
| `P backend/manage.py seed_recognition_demo`; `runserver 127.0.0.1:18006 --noreload`; `recognition_worker --fake-scenario success2` | Синтетические demo-файлы, запущенные host API/worker |
| `P .orca-attachments/c6/http_smoke.py fake` (временный urllib/cookie/CSRF/multipart/assert script, не deliverable) | Реальный HTTP 202 → queued/running/succeeded; 2 Receipt, 6 lines, 5 product IDs; оригинал/preview/2 crops GET 200 image/png, проверены байты/hash; повтор HTTP 200 reused, те же IDs |
| `curl.exe --fail-with-body -sS --max-time 15 http://127.0.0.1:18006/api/health/`; curl admin/css | HTTP health 200/3 ok, admin 302, CSS 200; браузер не запускался |
| Native `codex.exe --version`; `codex.exe login status` | 0.160.0, Logged in using ChatGPT; auth/config не менялись |
| HTTP upload `single.png`; provider=codex_cli, `P backend/manage.py recognition_worker --once` | Exit 0, Job 2 **partial_succeeded**, wall time **102.738 с** включая startup; detect 9.553 с и recognize 92.061 с, оба attempts succeeded; 1 сохранённая PNG вырезка/needs_review |
| `P .orca-attachments/c6/http_smoke.py verify-codex` | Job/images доступны через настоящий HTTP; original/preview/crop 200, review=1, normalized result/причины сохранены, нового Receipt нет |

Подсчёт по приложениям в таблице выше — обнаружение DiscoverRunner плюс фактические полные прогоны. После этих прогонов менялись только документы; тесты и продуктовый код не менялись. Предупреждения override DATABASES относятся к существующим unit-тестам QA guard; отрицательные HTTP log entries — ожидаемые сценарии. Производственные дефекты С1–С5, требующие правки, в С6 не обнаружены; их код/контракт/миграции не изменены.

Завершение: свои runserver/fake worker остановлены Ctrl+C (shell exit 1 вследствие прерывания, fake worker сообщил корректную остановку); Codex --once завершился сам с exit 0. `docker compose -p checkist_qa_c6 down` — exit 0, контейнеры/сеть удалены, тома сохранены. `docker ps -a` с фильтром этого project, LISTEN 25466/16396/18006/15176 и Get-CimInstance фильтр своих python/codex процессов — пусто. QA MEDIA/приватные синтетические результаты оставлены в игнорируемом каталоге до приёмки; в коммит не входят. Финальные `P backend/manage.py check`, `makemigrations --check --dry-run`, `P -m pip check` повторены после документации — exit 0. UTF-8/LF/ссылки и `git diff --check` проверены отдельно, это проверки файлов, не OCR/UI.

**Проверено и не прошло.** Реальный Codex **не дал автоимпорт демо-чека**: operation=null, неоднозначный `/fiscal/register_serial`; внутренние причины missing_required/identity_conflict/ambiguous_value. API сохраняет безопасные missing_required `/operation`, identity_conflict `/` и invalid_value `/`, без закрытого фискального поля. Итог 4.42 и читаемые строки сохранены на needs_review; это не ошибка тестового runner и не доказательство готового OCR-качества. Повторный вызов модели не выполнялся, ожидания не ослаблялись. С6 сделал один реальный прогон, как задано.

Две первоначальные вспомогательные команды записи логов не запустили тесты из-за отсутствующего каталога (PowerShell Out-File, оболочка ошибочно вернула 0). После создания каталога `ErrorActionPreference=Stop` с перенаправленным native stderr прервал команды на обычных сообщениях Django runner, shell exit 1. Эти попытки не считались прогоном; тестовые БД/процессы после них проверены, затем обе команды выполнены напрямую без перенаправления и прошли с числами выше. Продукт/тесты для этого не менялись.

**Не проверено и почему.** Реальные фото/полевое OCR-качество и UI — нужны разрешённые фото/эталон и реализованный клиент; шаги ручной приёмки выше. Vite `/media` proxy ещё отсутствует; новый API через него и frontend lint/test/build не повторялись, frontend не менялся. Полный suite в Linux не повторялся: проверен Windows→QA путь, отдельно container checks/pong; Linux OCR/POSIX crash/watchdog не принят (watchdog исключён v1). Нагрузка/большие данные, облачные лимиты/истечение auth, backup restore и recovery после реального убийства worker — не испытывались в С6; deterministic leases/recovery/cancel покрыты существующими integration-тестами. Эти проверки не заменяются сборкой/статическим аудитом.

## Фактические результаты И4

2026-10-05. Исправлена причина С6: null operation и ambiguous/null необязательный fiscal больше не отправляют читаемый чек в needs_review. Исходный DTO сохраняется; при отсутствии явного возврата импорт использует sale с замечанием. Неблокирующие issues совместимы с imported/reused/updated и Job.succeeded; review-счётчик учитывает needs_review. Неоднозначная товарная идентичность оставляет product=NULL с замечанием, не откатывает чек. Для Receipt такой unmatched по-прежнему даёт review_required=true. Формы, список публичных кодов, fixtures/public и схема БД не изменены; новых зависимостей нет. В CLAUDE.md исправлено описание уже подключённых каталога/цен SPA; клиент распознавания принадлежит И5.

### Причины импорта: итоговая таблица

Это внутренние коды сервиса; API сохраняет прежний allowlist и заменяет неизвестные коды на invalid_value, закрытые pointers — на `/`. Таблица относится к новому импорту, не меняет прошлые terminal outcomes.

| Причина / условие | Блокирует импорт в needs_review | Действие |
| --- | --- | --- |
| operation=null или неоднозначный тип операции | Нет | sale без явного возврата; явный заголовок возврата/отрицательные товарные количества → refund; operation_defaulted и derived `/operation` |
| ambiguous/unreadable необязательные fiscal, касса/смена/номер, код товара, подсказка товара, налоговые детали | Нет | Значение отсутствует; optional_omitted, исходное наблюдение сохраняется |
| identity_conflict из-за неподтверждённого необязательного идентификатора | Нет | В сильный ключ попадают только observed поля; неполный номер не включает unique номера |
| Нет сильного ключа / слабая идентичность | Нет | Точный store/time/total → тот же Receipt, другое значение → новый; совпадение разных реальных чеков по слабому ключу остаётся ограничением v1 |
| identity_conflict: разные полные fiscal-ключи либо разные полные номер/касса/смена у кандидата | Да | Никакого нового domain graph; исходные данные и безопасная причина сохраняются |
| missing_required: нет названия продавца/магазина, даты/точного времени, итога или обязательного факта строки после безопасных выводов | Да | Обязательные инварианты текущей модели сохранены по решению человека; два неизвестных числа строки, неразрешимые единицы/округляемые количества или цены требуют review |
| Отсутствует одно из quantity/unit_price/amount при двух observed числах | Нет, если вывод представим в модели | Третье число арифметически; quantity/price без округления, amount до цента ROUND_HALF_UP; исходный DTO не заменяется, pointer в derived |
| Единица отсутствует у целого observed количества, без признаков цены за вес/объём | Нет | pcs с derived; unreadable/ambiguous единица и дробное количество без единицы всё ещё блокируют |
| Валюта отсутствует, но разрешён существующий магазин RU/KZ/DE | Нет | RUB/KZT/EUR из страны точки, currency_inferred; напечатанная валюта имеет приоритет; без разрешимой точки/правила — review |
| Нет ни одной строки | Да | Сохраняется needs_review без Receipt |
| country_unknown, currency_unknown, store_ambiguous/store_conflict, отсутствие адреса новой точки без разрешимой branch | Да | Не удалось разрешить обязательный магазин/валюту; страна может выводиться из RUB/KZT/EUR по существующему правилу |
| timezone_unknown, timestamp_ambiguous/conflict, конфликт выбранных timestamps | Да | Момент покупки нельзя определить однозначно без угадывания |
| ambiguous_value / identity_conflict в обязательных магазине/дате/времени/итоге/фактах строки | Да | Нет уверенно читаемых обязательных фактов |
| invalid_value обязательной строки: нулевое количество, отрицательная unit_price, quantity/amount разных знаков, положительный deposit_return | Да | Инварианты существующей модели/БД сохраняются |
| total_mismatch `/total`: абсолютная разница больше 0.01 | Да | Проверяется сумма строк − скидки + налог при prices_include_tax=False |
| Разница итога до 0.01; total_mismatch quantity×unit_price; receipt_invalid вторичного валидатора | Нет | Сохраняются напечатанные суммы и безопасные замечания, текст валидатора не публикуется |
| tax_mismatch, tax_rate_invalid/unconfirmed, неполные ReceiptTax | Нет | Непригодные налоговые детали отбрасываются; новая ставка только по observed kind/rate. Если налог необходим для общей суммы без налога, блокирует именно gross total_mismatch |
| merchant_tax_id_invalid, merchant_conflict необязательного tax_id_type | Нет | Неверный ID отбрасывается; конфликт типа у известного продавца даёт замечание без перезаписи |
| Неверные/нечитаемые скидки, parent/line_position, discount_total/discount_amount | Сами по себе нет | Пропуск непригодной скидки, отвязка неверного parent, арифметический пересчёт агрегатов; грубое расхождение общей суммы всё ещё блокирует |
| product_ambiguous/conflict/package_invalid | Нет | Читаемая строка остаётся; неизвестная подсказка отбрасывается, точный конфликт оставляет product=NULL; заполненный товар не заменяется |
| receipt_conflict / receipt_structure_conflict / receipt_line_conflict повторного фото | Нет | Связь с тем же Receipt, несовместимые уже заполненные части не перезаписываются; partial fiscal не смешиваются в новый ключ |
| clipped у читаемой вырезки | Нет | Импорт с замечанием; unreadable core остаётся needs_review |
| Некорректная/перекрывающаяся геометрия, invalid_output, ошибка провайдера/БД/хранилища | Технический failed, не ослаблен | Смешанный OCR не запускается; ошибки и факты закрыты прежними безопасными кодами |
| import_busy, отмена, потерянный fence | Это управление очередью | Busy откладывается до deadline; cancel/stale fence не записывает новый граф; уже сохранённые части остаются |

Решение человека по q_muudwwemcm: сохранить обязательные инварианты Receipt/ReceiptLine; до needs_review применять безопасные выводы валюты из страны найденного магазина, третьего числа строки из двух напечатанных и pcs для штучной строки без веса. Код после уточнения реализует это без изменения моделей/миграций receipts. Точное время, неизвестные факты и неоднозначные значения не выдумываются. Откат И4 — revert кода/тестов/docs, импортированные данные остаются; миграций и удаления данных нет.

### Проверено и прошло

Windows Python 3.13.9, Docker 29.8.1/Compose 5.5.1; PostgreSQL 17.11, Redis 7.4.11. Собственный Compose project/DB `checkist_qa_i4`, runner `test_checkist_qa_i4`; Postgres 25474, Redis 16404, host API 18014. Полный QA environment выше с согласованной заменой DB/портов/Redis URL/proxy; MEDIA/scratch — разные игнорируемые каталоги `.orca-attachments/i4/media` и `scratch`. Автотесты — TemporaryDirectory, fake/mock. Dev/чужие QA не менялись.

P = `./backend/.venv/Scripts/python.exe -X utf8`. У завершившихся проверок в таблице exit 0.

| Команда | Фактический результат |
| --- | --- |
| `py -3.13 -m venv backend/.venv`; `P -m pip install -r backend/requirements.txt`; `P -m pip check` | Закреплённый набор установлен; No broken requirements |
| `docker compose -p checkist_qa_i4 config --quiet`; `up -d --wait --wait-timeout 90 postgres redis` | Healthy отдельные сервисы; socket.create_connection(timeout=2) на 25474/16404 → TCP OK |
| `P backend/manage.py check`; `makemigrations --check --dry-run`; `migrate --noinput` | 0 issues; No changes detected; 23 миграции на пустой QA |
| `P backend/manage.py test catalog stores receipts health api recognition --exclude-tag=integration --noinput --verbosity=1` | Окончательный последовательный прогон: **253 OK, 12.112 с**, без skips |
| Та же команда с `--tag=integration` | **857 OK, 162.311 с**, без skips; тестовая БД удалена |
| `P backend/manage.py test recognition.tests.test_import --noinput --verbosity=1` | **42 OK, 8.504 с** перед окончательным полным прогоном |
| `docker compose -p checkist_qa_i4 up -d --build --wait --wait-timeout 120 worker`; `P backend/manage.py check_services` | Healthy prefork worker; реальные DB/Redis/Celery task/result → pong |
| `codex.exe --version`; `codex.exe login status` | Native 0.160.0; Logged in using ChatGPT; auth/config не менялись |
| `P backend/manage.py seed_recognition_demo`; `runserver 127.0.0.1:18014 --noreload` | Синтетические single/double; настоящий host HTTP API |
| HTTP retry single + `RECEIPT_OCR_PROVIDER=codex_cli`, `P backend/manage.py recognition_worker --once` | **80.917 с wall**, detect **9.941 с**, recognize **69.909 с**; Job 2 succeeded, reused=1, review=0; прежний Receipt 1 с 4 строками/3 товарами |
| HTTP upload double + та же команда worker | **171.983 с wall**, detect **13.776 с**, recognize **99.844/57.006 с**; Job 3 succeeded, imported=1/reused=1/review=0; первый чек тот же Receipt 1, второй создан как Receipt 2 |
| `P .orca-attachments/i4/http_smoke.py verify-single`, `verify-double`, `repeat-single`, `repeat-double` | urllib/cookie/CSRF/multipart/assert script; HTTP totals 4.42/6.00, 4/2 строки; каждый product-kind имеет product; точный повтор 200/reused с прежними Photo/последними Job IDs. Итог БД: **2 Receipt / 6 ReceiptLine / 5 Product** |

Скрипт smoke и приватные provider payload находятся в игнорируемом QA-каталоге, не deliverable. Воспроизводимые HTTP-команды — раздел выше. После последнего изменения продуктового кода обе полные команды выполнены последовательно; после них менялись только документы. Публичные fixture tests и проверки постоянного числа SQL включены в полный прогон; новый detail Receipt с warnings делает 1 SQL. Это не нагрузочный замер.

После документации `P -m pip check`, `P backend/manage.py check`, `makemigrations --check --dry-run`, `git diff --check` и проверка UTF-8/LF 18 изменённых файлов — exit 0. Свой host API остановлен после проверки PID/executable/порта; `docker compose -p checkist_qa_i4 down` — exit 0, без удаления томов. Аудит контейнеров project, LISTEN 25474/16404/18014/15187 и python/codex процессов своего worktree пуст; чужие процессы не останавливались.

### Проверено и не прошло

- До исправления `P backend/manage.py test recognition.tests.test_import.ImportTests.test_c6_codex_null_operation_and_ambiguous_optional_fiscal_autoimport --noinput --verbosity=1` — exit 1, `needs_review != created`. На окончательном коде входит в успешный полный прогон.
- Первый реальный single worker — exit 0, **108.990 с wall**, detect 8.757 с/recognize 98.914 с: уже создал Receipt 1, 4 строки и 3 товара, но Job 1 остался partial_succeeded/review=1 из-за старого подсчёта любых issues. `verify-single` — exit 1 на требовании succeeded. Причина исправлена в queue/pipeline; штатный HTTP retry и double выше прошли. Исторический Job 1 не переписывался. Это не замена требования безусловным повтором модели: исправлен конкретный дефект терминализации.
- Промежуточные импортные/queue tests ожидали review для теперь неблокирующих optional/product/clipped причин; ожидания заменены согласно заданию, проверки сохранения строк/неперезаписи/приватности/конфликтов сильных ключей сохранены и расширены. Промежуточный полный integration: 853 теста, exit 1 на старом clipped-ожидании. Дополнительный negative clipped test сперва имел observed total при null, поэтому получил failed схемы; evidence исправлен на unreadable, требования схемы не ослаблялись.
- Ошибка подготовки PowerShell: dot-source qa.ps1 был запрещён ExecutionPolicy; зависимый Compose запуск пошёл с dev defaults и отказал на занятом 15432 (exit 1). Своих запущенных контейнеров/данных не было; собственный project удалён и создан после загрузки своего environment через ScriptBlock, политика ОС не менялась.
- Ошибка организации проверки: точечный DB-runner был запущен параллельно полному с тем же `test_checkist_qa_i4`. Его --noinput пересоздал свою занятую test DB; exit 1/UniqueViolation contenttypes. Пересекающийся полный прогон остановлен (exit -1) и не принят. Проверено отсутствие test-соединений, удалена только собственная idle test DB; затем 42 tests и обе полные команды выше выполнены последовательно. QA domain `checkist_qa_i4` и реальные smoke-чеки не затронуты.

### Не проверено и почему; показ и ручной сценарий

- Реальные пользовательские фото и полевое качество OCR: проверены только синтетические демо. Человек сравнивает source/crop с эталоном, товары/суммы/дату, включая несколько чеков, возвраты, скидки и плохо читаемые необязательные реквизиты. Плохие обязательные факты/грубая сумма должны остаться needs_review.
- UI, Vite proxy, адаптивность, фокус/Back/Forward/refresh и доступность — приёмка человеком по разделам выше и docs/frontend.md. Frontend И4 не менялся; npm lint/test/build не запускались. Автоматического обхода UI и скриншотов нет. Показ — этот фактический markdown-отчёт с данными и командами, не макет и не подтверждение визуального поведения.
- Для просмотра результата: применить QA environment с DB `checkist_qa_i4`, портами 25474/16404/API 18014 и теми же MEDIA/scratch, поднять `docker compose -p checkist_qa_i4 up -d --wait postgres redis`, `P backend/manage.py runserver 127.0.0.1:18014 --noreload`. GET `/api/recognition/jobs/2/`, `/3/`, `/api/receipts/1/lines/`, `/2/lines/`: succeeded/review=0, totals 4.42/6.00, 4/2 строки, 5 товаров. Оригиналы — synthetic `demo/single.png` / `double.png`; MEDIA URL выданы API. Новый пустой собственный QA project позволяет повторить создание с нуля через seed/upload/worker; на сохранённом QA повтор исходных байтов вернёт уже выполненные jobs.
- Клиент каталога/цен запускается по docs/frontend.md (`npm.cmd ci`, `npm.cmd run dev -- --port 15187`, proxy target 18014). Сценарий загрузки/просмотра распознавания и его UI-приёмку передаёт И5; этот backend-отчёт не обещает ещё не проверенные экраны. Админка — напрямую Django `/admin/`, is_staff; createsuperuser выполняет человек в QA.
- Linux OCR/watchdog, нагрузка, cloud limits/auth expiry и восстановление backup не испытывались; стандартные race/cancel/recovery/миграционный reverse/reapply тесты входят в полный integration. Deployment/release/merge не выполнялись. QA-тома и игнорируемые синтетические MEDIA сохраняются для человека; процессы/Compose после проверки останавливаются без down -v.

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

### Повторный прогон после согласованного уточнения И4

2026-10-05, окончательный код. Дополнены безопасные выводы перед needs_review: валюта из страны существующего Store (RU/KZ/DE), третье число строки из двух observed чисел, pcs при целой observed штучной строке без признаков цены за вес/объём. Количество/цена не округляются; сумма — ROUND_HALF_UP до цента. Исходный DTO сохраняется, derived фиксирует выводы. Отрицательный fake partial_missing_quantity/partial_success теперь оставляет неизвестными quantity **и** unit_price: это непригодный результат, а один пропуск уже восстанавливается. Требование needs_review для действительно непригодных данных и ожидания реального OCR не ослаблены. Все публичные JSON-формы/fixtures/allowlist сохранены; frontend не менялся.

#### Проверено и прошло

Windows Python 3.13.9, Docker 29.8.1, Compose 5.5.1, native Codex 0.160.0, model gpt-6.1-sol. Новые собственные project/БД **checkist_qa_i4_final**, runner test_checkist_qa_i4_final, новые тома, PostgreSQL 17.11 на 25475, Redis 7.4.11 на 16405, host API 18015. Полный QA environment этого документа со всеми DB/портами/Redis URL/proxy replacements; loopback/debug/CSRF, MEDIA/scratch раздельно в игнорируемом `.orca-attachments/i4-final/`. Dev/соседние QA не затронуты, auth/config Codex не менялись. P = `./backend/.venv/Scripts/python.exe -X utf8`. Все команды в таблице — exit 0.

| Команда | Фактический результат |
| --- | --- |
| `docker compose -p checkist_qa_i4_final config --quiet`; `up -d --wait --wait-timeout 90 postgres redis` | Новые healthy сервисы; ограниченные socket.create_connection(timeout=2) на обоих опубликованных портах прошли |
| `P -m pip check`; `P backend/manage.py check`; `makemigrations --check --dry-run`; `migrate --noinput` | No broken requirements, 0 issues, No changes detected, 23 миграции в пустую QA |
| `P backend/manage.py test recognition.tests.test_import recognition.tests.test_import_policy recognition.tests.test_provider recognition.tests.test_pipeline recognition.tests.test_e2e --noinput --verbosity=1` | Промежуточные 110 tests OK, 34.531 с; после них добавлены дополнительные регрессии и выполнен полный прогон ниже |
| `P backend/manage.py test catalog stores receipts health api recognition --exclude-tag=integration --noinput --verbosity=1` | **257 tests OK, 11.426 с**, без skips, без БД |
| `P backend/manage.py test catalog stores receipts health api recognition --tag=integration --noinput --verbosity=1` | **866 tests OK, 165.178 с**, без skips; test_checkist_qa_i4_final создана/удалена runner |
| `docker compose -p checkist_qa_i4_final up -d --build --wait --wait-timeout 120 worker`; `P backend/manage.py check_services` | Healthy Linux prefork; настоящие DB/Redis/Celery task/result: pong |
| `P backend/manage.py seed_recognition_demo`; `runserver 127.0.0.1:18015 --noreload` | Синтетические single/double и настоящий host HTTP |
| HTTP multipart/CSRF single → `RECEIPT_OCR_PROVIDER=codex_cli P backend/manage.py recognition_worker --once` | **78.748 с wall**, detect **9.439 с**, recognize **68.170 с**; Job 1 succeeded/imported=1/review=0, Receipt 1/4 строки/3 товара |
| HTTP multipart/CSRF double → та же команда worker | **137.082 с wall**, detect **12.701 с**, recognize **66.881 / 56.161 с**; Job 2 succeeded/imported=1/reused=1/review=0, Receipt 1 переиспользован, Receipt 2 создан |
| `P .orca-attachments/i4-final/http_smoke.py verify-single`, `verify-double`, `repeat-single`, `repeat-double`; `P .orca-attachments/i4-final/check_db.py final` | HTTP asserts и ORM asserts: итоги **4.42 / 6.00 EUR**, 4/2 строки, у всех product-строк есть товар. Повторы HTTP 200/reused, прежние Photo/Job. Итог **2 Receipt / 6 ReceiptLine / 5 Product**, оба Job succeeded и review=0 |

Smoke/check_db — просмотренные локальные вспомогательные scripts в игнорируемом QA-каталоге. Воспроизводимые HTTP/CLI-команды приведены выше, приватные payload/логи в сдачу не входят. Полный suite включает согласованность prompt/schema/validator, наблюдение С6, конфликты сильных ключей, арифметику и её отрицательные случаи, CSRF/loopback/privacy, N+1 и 11 server e2e. Эти проверки не подтверждают React в браузере.

После документации повторены `P -m pip check`, `P backend/manage.py check`, `makemigrations --check --dry-run`, `git diff --check` и UTF-8/LF аудит 13 изменённых файлов — exit 0. Ctrl+C завершил свою runserver-сессию (exit 1 вследствие остановки); `docker compose -p checkist_qa_i4_final down` — exit 0 без удаления томов. Проверки `docker ps -a` по своему project, `Get-NetTCPConnection` по 25475/16405/18015/15188 и `Get-CimInstance Win32_Process` по python/codex своего worktree подтвердили отсутствие созданных контейнеров/слушателей/процессов — exit 0.

#### Проверено и не прошло

- До исправления уточнения: `P backend/manage.py test recognition.tests.test_import.ImportTests.test_missing_currency_uses_country_of_existing_store_and_reuses_receipt recognition.tests.test_import.ImportTests.test_missing_line_quantity_is_derived_from_printed_price_and_amount --noinput --verbosity=1` — **exit 1, 2 failures** (`needs_review != linked/created`). После исправления обе регрессии вошли в успешные 866 tests.
- Первая вспомогательная TCP-проба через PowerShell Python `-c` — **exit 1, SyntaxError** из-за передачи кавычек; зависимые команды не запускались. Проба исправлена передачей Python через UTF-8 stdin, TCP прошёл. Продуктовый код не менялся ради диагностики.
- На окончательном коде отказов тестов и реальных single/double не было. Журналы ожидаемых негативных HTTP-ответов в suite не считаются failures.

#### Не проверено и почему; ручной показ

- Реальные пользовательские фотографии, разнообразие магазинов/веса/возвратов, OCR-качество: в задаче разрешены синтетические demo. Человек сравнивает source/crop с каноническими Receipt/строками/товарами. Неизвестные обязательные значения после безопасных выводов и грубая сумма должны остаться needs_review. Слабый ключ может объединить разные реальные чеки с точно совпавшими магазином/моментом/итогом — ограничение v1.
- React UI/Vite proxy/фокус/доступность/адаптивность и скриншоты — только человек. Frontend И4 не менялся, npm проверки не запускались; клиент загрузки/чеков относится к И5. Показ: [фактический отчёт И4](../backend/recognition/I4_ACCEPTANCE.md), без фиктивных скриншотов.
- Повторить: полный QA environment с DB checkist_qa_i4_final, PG25475/Redis16405/API18015, раздельными MEDIA/scratch; `docker compose -p checkist_qa_i4_final up -d --wait postgres redis`, runserver 127.0.0.1:18015. Прочитать `/api/recognition/jobs/1/`, `/2/`, `/api/receipts/1/`, `/2/` и `/lines/`; MEDIA напрямую на Django. Для нового настоящего OCR-прогона — отдельная пустая QA, seed, CSRF multipart upload и codex_cli worker --once (succeeded job нельзя retry). После интеграции И5 запустить QA Vite на 15188 с proxy target 18015 и вручную пройти upload single/double → статус → чек/товары → повтор/отмена/needs_review, включая клавиатуру, узкий экран и refresh.
- Нагрузка, backup restore, production/deployment/merge не выполнялись; схема не меняется, откат — revert кода/тестов/docs без удаления импортированных записей. Контейнеры/host API этого прогона остановлены, QA-тома и синтетические MEDIA сохранены.

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
docker compose -p checkist_qa exec -T worker python -X utf8 manage.py test catalog stores receipts health api --tag=integration --verbosity=2
docker compose -p checkist_qa exec -T worker python -X utf8 manage.py check_services
docker compose -p checkist_qa exec -T worker celery -A config inspect ping --destination=checkist@worker --timeout=2
docker compose -p checkist_qa ps
```

Ожидается exit 0 для каждой команды; зависимости без конфликтов, check без ошибок, migrations применены/уже актуальны, `No changes detected`, 671 integration test passed, реальный pong через task/results и отдельный control pong. `ps` должен показывать три healthy services с QA host-портами. Docker build может использовать cache: это не новая установка с нуля, но `pip check` проверяет реально установленные зависимости образа.

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

### Регрессия управляющих символов в поиске

На пустой QA-БД после `migrate` и затем на образцах повторите на настоящем QA `runserver` (в другом project замените порт):

```powershell
foreach ($list in @("products", "stores", "brands", "generic-products", "categories")) {
    curl.exe -i --max-time 15 "http://127.0.0.1:18000/api/$list/?q=%00a"
    if ($LASTEXITCODE -ne 0) { throw "HTTP transport failed" }
    curl.exe -i --max-time 15 "http://127.0.0.1:18000/api/$list/?q=%D0%BC%D0%BE%D0%BB"
    if ($LASTEXITCODE -ne 0) { throw "HTTP transport failed" }
}
```

Для NUL все пять списков должны вернуть `400`, `application/json`, `error.code=invalid_parameter` и `error.fields.q=["Управляющие символы недопустимы."]`; `q` не вырезается. UTF-8 «мол» — `200`, на пустой БД `results: []`, на образцах товары/обобщённые продукты/категории содержат совпадения. Дополнительно замените `%00` на `%09`, `%0A`, `%7F` и `%C2%85` и проверьте те же `400`; `?country=RU%00` и `?ordering=name%00` у `products` — `400` с соответствующим именем в `fields`. Curl exit 0 означает только транспортный успех, поэтому сверяйте статус и JSON.

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

## Фактические результаты исправления E1, 2026-10-04

Причина обхода: access log классифицировал сырой target, Django — однократно декодированный путь. Фильтр теперь учитывает декодирование runserver и удаление начальных // до него; двойное кодирование и dot segments не нормализует повторно. Битые/неоднозначные targets скрывает консервативно, обычные пути вне API сохраняет. Контракт, модели, миграции и зависимости не менялись; откат — revert коммита без операций с БД (возвращает обход).

Собственная Windows QA: Python 3.13.9, Compose project/БД `checkist_qa_e1_mutrq9fm46`, тестовая БД `test_checkist_qa_e1_mutrq9fm46`, новые тома, Postgres 25488, Redis 16435, runserver DEBUG=1/0 на 18056/18057. Каждый процесс получил полный QA environment выше с этими DB/портами/URL, публичными user/password из образца и отдельным тестовым ключом для DEBUG=0. Dev и чужие QA не затронуты.

**Проверено и прошло:** команды ниже из корня, Python — `./backend/.venv/Scripts/python.exe -X utf8`; все exit 0. Полный набор выполнен дважды после последней правки кода/тестов; результаты последнего прогона:

- `docker compose -p checkist_qa_e1_mutrq9fm46 config --quiet`; `… up -d --wait --wait-timeout 90 postgres redis`; TCP-пробы с Windows — оба порта доступны; `… up -d --build --wait --wait-timeout 120 worker` — Linux prefork worker healthy (build cache).
- `… -m pip check` — No broken requirements found; `… backend/manage.py check` — 0 issues; `… backend/manage.py makemigrations --check --dry-run` — No changes detected. `… backend/manage.py migrate --noinput` применил 22 существующие миграции в новую QA-БД.
- `… backend/manage.py test catalog stores receipts health api --exclude-tag=integration --verbosity=1` — **174 OK**, 6.002 с; `… backend/manage.py test catalog stores receipts health api --tag=integration --noinput --verbosity=1` — **425 OK**, 41.559 с, тестовая БД создана/удалена runner.
- `… backend/manage.py check_services` — SQL/cache ok, настоящая task через broker/results вернула `{"message":"pong"}`. `save_samples()` внесён только в собственную QA: product=1, generic=1, category=2.
- `… backend/manage.py runserver 127.0.0.1:18056 --noreload` и аналогично 18057 при DEBUG=0; stderr записан напрямую Python subprocess в UTF-8. `… backend/scripts/check_request_errors.py --port 18056 --product-id 1 --generic-id 1 --category-id 2 --server-log backend/.venv/e1-debug1.stderr.log` и аналогично 18057/`e1-debug0.stderr.log` — **696 проверок на каждом сервере**, 1392 всего: на каждом 200×231, 400×301, 404×56, 405×53, 406×52, 414×1, 431×2; без 500, health 200. Первые 10 запросов — пять путей (`/api/`, `/%61pi/`, `/api%2F`, `/api%2f`, `//api/`) × 200/400: все записи `/api/[redacted]`, маркер отсутствует в журнале, `access_log=passed`. 414/431 — ожидаемые отказы до Django.
- Уборка: свои runserver остановлены; `docker compose -p checkist_qa_e1_mutrq9fm46 down` — exit 0, контейнеры/сеть удалены, тома сохранены. Фильтр project в `docker ps -a` и LISTEN на четырёх своих портах пусты; временный `.env` удалён. Полные UTF-8 журналы обоих серверов повторно проверены: маркера нет.

**Проверено и не прошло:** до исправления `… backend/manage.py test api.tests.test_request_errors.RequestSyntaxTests.test_api_access_log_decodes_path_once_like_runserver --verbosity=1` — exit 1, 20 failures, target/маркер оставались в журнале; теперь регрессия входит в успешный набор. Подготовительный запуск через `Start-Process` отвергнут политикой CLI; заменён управляемой сессией с Python subprocess. Первая проверка владельца процесса перед остановкой — exit 1: venv использует системный executable; после проверки полного пути venv в command line остановлены только свои серверы. На окончательном состоянии проваленных обязательных проверок нет.

**Не проверено и почему:** UI — только человек, автоматического обхода/скриншотов нет; [ручной сценарий](#ручная-ui-приёмка-человеком). Frontend/proxy, stop/recovery, нагрузка, журналы внешних серверов и rollback/restore БД не повторялись: эти участки и схема не менялись; для отдельной проверки использовать QA-сценарии этого документа. Сетевой ASGI-сервер не запускался: проверен принятый WSGI/runserver, ASGI application покрыт существующим полным набором.

Повтор HTTP: в собственной QA после `save_samples()` запустить runserver отдельно при DEBUG=1/0, сохранить stderr в обычный UTF-8 файл (например, `subprocess.run([...], stderr=open(log_path, "wb"))`), затем вызвать расширенный скрипт с фактическими ID и `--server-log <файл>`. Без этой опции скрипт явно сообщает `access_log=not_checked`. После проверки остановить свои серверы и выполнить `docker compose -p <свой-project> down` без `-v`.

## Фактические результаты исправления D1, 2026-10-04

Причина исходного 500: DRF content negotiation читает `request.query_params` до `Params`, Django поднимает `TooManyFieldsSent`, а общий handler раньше относил его к внутренним ошибкам. Теперь handler возвращает фиксированный `400 invalid_request` для всего семейства `SuspiciousOperation`, `BadRequest`, `UnreadablePostError`, `MultiPartParserError`. Дополнительно общий `config.requests` защищает Host и декодирование query/заголовков до DRF и Content-Type в конструкторе WSGI/ASGIRequest; предотвращает RuntimeError записи без слэша; не пишет exception text/значения в security log и скрывает request target в `django.server`. Неизвестные ошибки реализации сохраняют 500. Штатные 1000 полей, модели, зависимости и миграции сохранены. Несовместимость и откат описаны в [контракте](api-contract.md#производительность-и-откат).

Среда: Windows, Python 3.13.9, собственный `backend/.venv` с закреплённым requirements.txt. Собственные Compose project/БД `checkist_qa_d1_mutq000l2q`, новые тома, тестовая БД `test_checkist_qa_d1_mutq000l2q`; Postgres 25486, Redis 16433, runserver DEBUG=1 на 18054 и DEBUG=0 на 18055. Dev, чужая QA и локальный Postgres не использовались. В каждом QA-процессе применялся полный блок environment выше с этими именем/портами/URL и публичными реквизитами образца; для DEBUG=0 использован отдельный тестовый secret key, отличный от placeholder. Environment передавался прямо в команды, системная ExecutionPolicy не менялась.

### Проверено и прошло

Команды Python — `./backend/.venv/Scripts/python.exe -X utf8 …`, из корня worktree. Все завершившиеся проверочные команды таблицы — exit 0; runserver работал до явной остановки своих процессов после HTTP-аудита, его завершение не объявляется проверкой с exit 0. Финальный полный прогон повторён после последней правки кода, тестов и HTTP-скрипта; после него менялась только документация. Прежние числа 155/418 в исторических отчётах ниже относятся к их состоянию ветки.

| Фактическая команда | Результат |
| --- | --- |
| `py -3.13 -m venv backend/.venv`; `… -m pip install -r backend/requirements.txt` | Собственный venv, закреплённые зависимости установлены |
| `docker compose -p checkist_qa_d1_mutq000l2q config --quiet`; `… up -d --wait --wait-timeout 90 postgres redis` | Оба healthy, собственные контейнеры/сеть/тома |
| Python stdin: `socket.create_connection(("127.0.0.1", port), timeout=2)` для 25486/16433 | Оба TCP OK до записей/миграций |
| `… -m pip check` | No broken requirements found |
| `… backend/manage.py check` | 0 issues |
| `… backend/manage.py makemigrations --check --dry-run` | No changes detected |
| `… backend/manage.py migrate --noinput` | 22 существующие миграции в пустую собственную QA-БД |
| `… backend/manage.py test api.tests.test_request_errors api.tests.test_errors --noinput --verbosity=0` | 44 OK, 1.449 с |
| `… backend/manage.py test catalog stores receipts health api --exclude-tag=integration --verbosity=1` | **169 OK**, 3.789 с, без БД; повтор полного набора после уточнения HTTP-скрипта |
| `… backend/manage.py test catalog stores receipts health api --tag=integration --noinput --verbosity=1` | **425 OK**, 25.624 с; runner создал/удалил тестовую БД; повтор полного набора после уточнения HTTP-скрипта |
| `docker compose -p checkist_qa_d1_mutq000l2q up -d --build --wait --wait-timeout 120 worker` | Linux/prefork worker healthy; build использовал cache |
| `… backend/manage.py check_services` | SQL/cache ok, реальная Celery broker/results: `{"message":"pong"}` |
| `… backend/manage.py runserver 127.0.0.1:18054 --noreload`; аналогично 18055 при `DJANGO_DEBUG=0` | Два настоящих HTTP-сервера; health 200 при обоих DEBUG |
| `… backend/scripts/check_request_errors.py --port 18054 --product-id 1 --generic-id 1 --category-id 2`; аналогично `--port 18055` | **686 HTTP-проверок на каждом сервере, 1372 всего**, без 500; распределение на каждом: 200×226, 400×296, 404×56, 405×53, 406×52, 414×1, 431×2 |

Данные HTTP — вымышленные `api.tests.factories.save_samples()`, внесённые Python stdin только в собственную QA-БД; ID получены из результата функции, не предполагаются равными 1 в других БД. HTTP-скрипт данные не меняет. Серверные SQL-запросы не подменялись; ноль SQL при отказе подтверждён integration-тестами, а не HTTP-счётчиком. Логи намеренных 500 в успешных тестах handler не являются отказом тестов.

| Вход / участок класса | Что именно проверено и результат |
| --- | --- |
| 1000 / 1001 query-полей | Все 13 маршрутов × DEBUG 0/1: 200 / точный JSON 400. HTTP также повторяет границу с Content-Type charset=utf-8 и base64; 1001 до 405 — 400. Integration: SQL=0 при отказе, никаких exception text/значений в JSON |
| Семейство request exceptions | Все классы `SuspiciousOperation`/`BadRequest` из django.core.exceptions плюс UnreadablePostError/MultiPartParserError поднимаются тестовой DRF-view и дают точный 400 при обоих DEBUG; защитный middleware отдельно проверен. ParseError DRF — существующий безопасный 400; неподдерживаемый media type — 415 без деталей |
| Body/form/files | Реальный HTTP: GET с невалидным JSON/multipart — 200; POST — 405; 101 multipart-файл не читается (GET 200 / POST 405), Content-Length 3 MiB на GET не вызывает чтения/лимита. WSGI-регрессия со stream.read, который поднимает UnreadablePostError, подтверждает отсутствие чтения на GET и всех 405. RequestDataTooBig/TooManyFilesSent/ошибки парсера на штатных read-only view недостижимы; общий handler проверен через явное поднятие исключений |
| Percent/UTF-8/суррогаты query | На всех маршрутах `%ff`, одиночный `%`, `%0`, `%gg`, `%ed%a0%80`, `%c0%80`, ошибочные неизвестные значения/имена — JSON 400; обычный UTF-8 и `%25` допустимы. ASGI application: raw invalid byte и surrogate path — безопасный 400. Params отвергает суррогаты до передачи в БД |
| Очень длинные значения/query | В пределах runserver: q=60000 символов на пяти списках — 400 invalid_parameter; известные числа/коды/сортировка/дата — 400 в тестах. Unknown=60000 символов — 200. Большой query с 1001 коротким полем — 400 по числу, а не байтам |
| Повторы/пустые имена/массивы | Последнее q применяется, пустое последнее q игнорируется; `=…`, `q[]`, `q[a]` — 200 как неизвестные имена. Повторы учитываются в лимите |
| Host / Accept / Content-Type | DisallowedHost — JSON 400, без Django security log. Ошибка charset расширенного параметра Accept/Content-Type — 400 до view, в том числе конструктор WSGI/ASGI. Несовместимые Accept — 406; безопасные формы, принятые DRF, — 200. Charset тела не меняет UTF-8 поиска. Accept indent=60000 цифр, длинный список Accept и X-header=60000 символов — 200 без исключений |
| ID / путь | Все семь маршрутов объектов: 2^63, 0, отрицательное число, 5000 цифр, NUL, `%ff`, `%`, `%ed%a0%80` — JSON 404. WSGI/Django repercent-encodes недопустимые байты пути; числовой маршрут не совпадает. Уже декодированный surrogate ASGI path — 400 |
| Запись без слэша | Все 13 путей × четыре метода × DEBUG 0/1 — JSON 400 до CommonMiddleware; GET-редирект и health-тесты без правок сохранены |
| Граница до Django | Настоящий runserver: request line >65536 байт — 414 HTML; header line >65536 или пакет из 101 дополнительного заголовка (плюс служебные http.client) — 431 HTML. Django/DRF и JSON-handler не вызываются; эти ответы проверены отдельно, не названы JSON |
| Внутренние ошибки | RuntimeError, ValueError, LookupError, UnicodeDecodeError и DRF APIException из view — безопасный 500 при обоих DEBUG; не превращаются в 4xx |

Уборка: оба runserver остановлены, `docker compose -p checkist_qa_d1_mutq000l2q down` без `-v`; контейнеры/сеть удалены, тома сохранены. Фильтр своего project в `docker ps -a` и LISTEN на 25486/16433/18054/18055 пусты. После финального коммита рабочее дерево чистое.

### Проверено и не прошло

- До исправления: `manage.py test api.tests.test_request_errors --tag=integration --noinput --verbosity=1` — exit 1, один тест, **26 failures** (`500 != 400` на всех маршрутах при обоих DEBUG). Граница 1000 проходила. Это исходная падающая регрессия; теперь проходит.
- `manage.py test api.tests.test_errors.ErrorFormatTests.test_django_request_errors_are_safe_400_even_in_debug --verbosity=0` до handler-правки — exit 1, **22 failures** (`500 != 400`). После исправления входит в успешный полный набор.
- `manage.py test api.tests.test_request_errors.RequestSyntaxTests.test_content_type_constructor_error_is_safe_wsgi_400 --verbosity=0` до подключения safe request — exit 1, **2 errors**, `LookupError: unknown encoding` в Django constructor. После исправления проходит.
- Во время расширения аудита новые тесты выявили отказы Host, malformed query и записи без слэша; затем две ошибки самого сценария: `date_from` на products по контракту игнорируется (перенесён на prices), DRF допускает незакрытую кавычку после JSON media type (ожидание согласовано с фактическим безопасным разбором). Полный WSGIHandler внутри обычного TestCase закрывал транзакционное соединение сигналом request_started и провоцировал тестовые 500: сценарий перенесён в TransactionTestCase, без подмены SQL/сигналов. Эти промежуточные неуспешные прогоны исправлены; тесты не отключались, ожидание отсутствия 500 не ослаблялось.
- Процедурный сбой подготовки QA: загрузка временного `.ps1` отвергнута ExecutionPolicy, хотя общая shell-команда закончилась exit 0. Созданный собственный project `checkist_qa_mutq000l2q` с defaults остановлен до миграций/записей; тома сохранены. Новый отдельный project `checkist_qa_d1_mutq000l2q` запущен с environment непосредственно в командах. Dev/чужие контейнеры не менялись, системные настройки не менялись.

На окончательном состоянии неуспешных обязательных проверок нет.

### Не проверено и почему

- UI — по правилам проекта только человек. Автоматического browser-обхода и скриншотов нет. Для ручной приёмки поднять собственные QA API/Vite и пройти [сценарий UI](#ручная-ui-приёмка-человеком): загрузка, повтор, stop/recovery, Offline/timeout, клавиатура, screen reader, узкая ширина и масштаб.
- Frontend lint/test/build, Vite proxy и stop/recovery не повторялись: frontend/probes не менялись; health подтверждён неизменёнными тестами, настоящим HTTP и check_services. Воспроизводимые команды — [сквозная проверка](#сквозная-проверка-клиента-через-vite-proxy).
- ASGI проверен прямым вызовом настоящего application в регрессиях; отдельный сетевой ASGI-сервер не запускался, его нет в зависимостях проекта. HTTP выполнен на принятом WSGI/runserver.
- Реальное отключение upload-сокета не провоцировалось: read-only view не читает тело, поэтому UnreadablePostError проверен явным исключением и unreadable stream; шаг для будущего API записи — отдельный QA endpoint с реальным body parser и отменой upload, с собственным контрактом.
- Нагрузка/большая БД, внешние серверы/proxy и их лимиты/журналы не проверялись; текущие assertNumQueries прошли. Для отдельного прогона нужен представительный QA-набор и конкретная конфигурация сервера.
- Rollback/restore БД не выполнялся: схема не менялась. Миграции применены в новую QA и повторно runner к тестовой БД; откат D1 — revert коммита без операций с БД. Проверка отката модели — отдельная QA по [сценарию](#модель-данных-catalog-stores-receipts).

Повтор HTTP-аудита: после QA-блока запустить runserver с `DJANGO_DEBUG=1`, внести `save_samples()` в собственную QA и получить его ID, затем `… backend/scripts/check_request_errors.py --port <QA-port> --product-id <id> --generic-id <id> --category-id <id>`. Остановить сервер и повторить при `DJANGO_DEBUG=0` с неплейсхолдерным тестовым secret key; скрипт не пишет данные и ожидает healthy worker для health. После проверки остановить сервер и только свой Compose project без удаления томов.

## Фактические результаты исправления C1, 2026-10-04

Причина `500`: `Params.search` проверял только длину, поэтому NUL попадал в PostgreSQL `text` через `icontains`/точное сравнение. Теперь общий `Params.raw`, которым пользуется поиск и остальные парсеры, отвергает Unicode Cc до `strip()` и возвращает ошибку параметра для последующего `check()`. Символы не вырезаются, сообщения не содержат входных значений. Все пять поисковых списков согласованы. Дополнительно прекращено молчаливое удаление управляющих пробельных символов на краях кодов, дат, перечислений, курсов и чисел. Доступ, JSON успешных ответов, модели, зависимости и миграции не менялись; ужесточение входа и откат описаны в [контракте](api-contract.md#общие-правила).

Среда: Windows, Python 3.13.9, собственный `backend/.venv` с закреплённым `requirements.txt`. Собственные Compose project/БД `checkist_qa_mutompk71t`, новые тома, тестовая БД `test_checkist_qa_mutompk71t`; Postgres `17.11-alpine` на 25473, Redis `7.4.11-alpine` на 16420, HTTP на 18041. Dev, чужая QA и локальный Postgres не использовались. В каждом QA-вызове применялся полный environment-блок этого документа с указанными DB/портами/URL, `COMPOSE_PROJECT_NAME=checkist_qa_mutompk71t`, публичными `POSTGRES_USER/PASSWORD` из образца, `DJANGO_DEBUG=1`, `DJANGO_ALLOWED_HOSTS=127.0.0.1,localhost`, `VITE_API_BASE_URL=/api`, `DEV_API_PROXY_TARGET=http://127.0.0.1:18041`. Для UTF-8 Python stdin использовался `$OutputEncoding = [System.Text.UTF8Encoding]::new($false)`.

### Проверено и прошло

Все завершившиеся команды ниже — exit 0. Код и тесты в полном прогоне совпадают с итоговыми; последующие изменения — только документация.

| Фактическая команда | Результат |
| --- | --- |
| `py -3.13 -m venv backend/.venv`; `./backend/.venv/Scripts/python.exe -X utf8 -m pip install -r backend/requirements.txt` | Собственный venv и закреплённые зависимости установлены |
| `docker compose -p checkist_qa_mutompk71t config --quiet` | Без ошибок |
| `docker compose -p checkist_qa_mutompk71t up -d --wait --wait-timeout 90 postgres redis` | Оба healthy; собственные сеть и тома |
| Python stdin: `socket.create_connection(("127.0.0.1", port), timeout=2)` для 25473/16420 | Оба `TCP OK` до действий с БД |
| `./backend/.venv/Scripts/python.exe -X utf8 -m pip check` | `No broken requirements found.` |
| `… backend/manage.py check` | `System check identified no issues (0 silenced).` |
| `… backend/manage.py makemigrations --check --dry-run` | `No changes detected` |
| `… backend/manage.py migrate --noinput` | 22 существующие миграции применены в пустую собственную QA-БД |
| `… backend/manage.py test api.tests.test_query_controls --noinput --verbosity=1` | 12 регрессий `OK`, 1.766 с; 6 без БД, 6 integration |
| `… backend/manage.py test catalog stores receipts health api --exclude-tag=integration --verbosity=1` | 155 тестов `OK`, 3.869 с, без БД |
| `… backend/manage.py test catalog stores receipts health api --tag=integration --noinput --verbosity=1` | 418 тестов `OK`, 33.596 с; runner создал и удалил `test_checkist_qa_mutompk71t` |
| `docker compose -p checkist_qa_mutompk71t up -d --build --wait --wait-timeout 120 worker` | Linux/prefork worker healthy; установка зависимостей использовала build cache |
| `… backend/manage.py check_services` | SQL/cache `ok`, настоящая очередь/results: `celery_task.result={"message":"pong"}` |

Логи `Internal Server Error` внутри успешного набора без БД относятся к намеренным тестам безопасного обработчика ошибок.

**Настоящий HTTP:** `./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py runserver 127.0.0.1:18041 --noreload` в управляемой PTY-сессии. На пустой БД `curl.exe -i --max-time 15 "http://127.0.0.1:18041/api/<список>/?q=%00a"` выполнен для `products`, `stores`, `brands`, `generic-products`, `categories`: каждый curl exit 0, каждый ответ — `400`, `application/json`, точное `invalid_parameter` с `fields.q=["Управляющие символы недопустимы."]`.

Два Python stdin-скрипта (`… python.exe -X utf8 -`, `urllib.request.urlopen(..., timeout=15)` с обработкой `HTTPError`) проверили статус, Content-Type и JSON, оба exit 0:

- На пустой БД: **45 HTTP-проверок** — 40 поисков с NUL в начале/середине/конце, TAB, LF, CR, DEL и C1 дают `400`; UTF-8 «мол» на всех пяти списках даёт `200`, `results: []`.
- Образцы внесены один раз: `… backend/manage.py shell -c "from api.tests.factories import save_samples; d = save_samples(); print('QA samples: product', d.shop_milk.pk, 'generic', d.milk.pk, 'category', d.milk.category_id, 'store', d.shop_store.pk)"` — exit 0, product/generic/store `1`, category `2`.
- На образцах: **126 HTTP-проверок** — те же 45 поисков; 75 случаев NUL/TAB/C1 на остальных читаемых параметрах справочников, товаров, истории, сводки и обоих сравнений дают `400` с именем параметра в `fields`; NUL в трёх идентификаторах пути даёт JSON `404 not_found`; последнее повторённое `q` и неизвестный параметр сохраняют прежнюю семантику (`200`); `scope` у `/comparison/` игнорируется (`200`) по контракту; health — `200`, `status=ok`. UTF-8 поиск даёт один товар, один обобщённый продукт и две категории (совпадение и предок).

Уборка: Ctrl+C остановил runserver (exit 1 вследствие прерывания); `docker compose -p checkist_qa_mutompk71t down` — exit 0, свои контейнеры/сеть удалены, тома сохранены. Фильтр своего project в `docker ps -a` пуст; `Get-NetTCPConnection` не обнаружил LISTEN на 25473/16420/18041/15191. Временный `.env` удалён, venv игнорируется Git.

### Проверено и не прошло

- **До исправления:** `manage.py test api.tests.test_query_controls.QueryControlParamsTests.test_search_rejects_nul_at_every_position --exclude-tag=integration --verbosity=2` — exit 1, 1 тест, 4 failures: NUL в начале/середине/конце принимался, одиночный NUL давал лишь ошибку длины.
- **До исправления:** `manage.py test api.tests.test_query_controls.EmptySearchControlTests.test_nul_search_returns_400_before_sql --tag=integration --noinput --verbosity=1` — exit 1, 1 тест, 15 failures: четыре SQL-списка давали `500`, категории — `200`. После исправления все эти сценарии входят в успешные целевой и полный прогоны; ожидания не ослаблялись.
- Служебный сбой: `orca-board done --help` вместо справки выполнил преждевременную сдачу с пустой сводкой. Workflow сохранил код/тесты автоматическим коммитом `347c050`, затем начал удалять worktree; параллельный `manage.py check` прервался с exit 1, `ModuleNotFoundError: No module named 'celery.app'`. Задача возвращена в работу через `task reopen` без запуска другого воркера; восстановлен тот же worktree и та же ветка, пересоздан собственный venv. Полные проверки выше выполнены после восстановления. Это процедурный сбой, на итоговом коде failed-проверок нет.

### Не проверено и почему

- Визуальное/интерактивное поведение React проверяет человек. Frontend не менялся и API каталога пока не вызывает; browser automation и скриншотов нет. Для отдельной приёмки запустить QA API/Vite и выполнить [ручной сценарий](#ручная-ui-приёмка-человеком): загрузка, повтор, stop/recovery, Offline/timeout, клавиатура/screen reader, 375 px/zoom 200%.
- Frontend lint/test/build, Vite proxy и stop/recovery зависимостей не повторялись: клиент/probes не менялись. Для отдельного прогона — команды [сквозной проверки](#сквозная-проверка-клиента-через-vite-proxy). Health покрыт полным набором, настоящим HTTP и `check_services`.
- Нагрузка и замеры на больших данных не выполнялись; существующие `assertNumQueries` прошли, а отклонённый `q` проверен с нулём SQL-запросов. Для нагрузки нужен представительный набор в отдельной QA-БД.
- Откат/восстановление БД не выполнялись: схема не менялась, существующие миграции применены в новую QA-БД. Для отдельной проверки миграций — [сценарий модели данных](#модель-данных-catalog-stores-receipts) на собственной одноразовой БД. Откат C1 не требует операций с БД.

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

- **На момент этого отчёта `POST` / `PUT` / `PATCH` на путь `/api/…` без завершающего `/` при `DJANGO_DEBUG=1` отдавал HTML `500`**, а не JSON. Воспроизведение: `curl.exe -i --max-time 15 -X POST http://127.0.0.1:18052/api/nope` (так же `/api/products`, `/api/health`) — `500`, `Content-Type: text/html`, отладочная страница Django `RuntimeError at /api/nope` с traceback. Причина: `CommonMiddleware` с `APPEND_SLASH` отказывался перенаправлять запрос с телом в режиме отладки; запрос до DRF и его обработчика ошибок не доходил. Для `/api/health` поведение существовало и раньше, запасной маршрут `api.urls` распространил его на любой путь под `/api/`. При `DJANGO_DEBUG=0` (второй сервер на 18053 с временным `DJANGO_SECRET_KEY`) те же запросы давали `301` на путь со слэшем. Это ограничение **устранено в D1**: теперь [JSON 400 при обоих DEBUG](api-contract.md#запись-без-завершающего-слэша); `GET` и все пути со слэшем сохранены.
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

Исторический прогон до модели данных, админки и API чтения: числа health 21/2 ниже относятся к тому состоянию; текущий набор health — 26/7 в [прогоне F5](#фактические-результаты-после-f4-2026-10-04). Frontend в F4/F5 не менялся.

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

Числа тестов в этом разделе (62 и 158) относятся к состоянию до появления админки и приложения `api`; актуальные — в [прогоне F5](#фактические-результаты-после-f4-2026-10-04). Источник: задача T5 (`task_musd0fst2t`), состояние ветки после слияния T0–T4; код и тесты в этой задаче не менялись. Windows-хост: Python 3.13.9, Docker 29.8.1 (Linux daemon), Postgres 17.11. Использован отдельный Compose project `checkist_qa_t5` с новыми томами, БД `checkist_qa_t5`, тестовая БД `test_checkist_qa_t5`, Postgres 25432, Redis 16379: том `checkist_qa` уже существовал и не гарантировал пустую БД. Dev-данные и локальный Postgres не затронуты. Environment — блок выше с `POSTGRES_DB = "checkist_qa_t5"`.

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
