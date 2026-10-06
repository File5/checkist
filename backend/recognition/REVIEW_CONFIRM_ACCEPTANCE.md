# Подтверждение неполного распознавания: сквозная серверная проверка

Серверная часть этапа интеграции: сквозной автотест и настоящий HTTP для `POST /api/recognition/receipt-images/{id}/confirm/` ([контракт](../../docs/api-contract.md#подтверждение-вырезки-needs_review-человеком)). Дефектов сервера не найдено: код `backend/`, контракт и эталоны `review-*.json` **не менялись**, формат ответов прежний. Добавлены только тест `backend/api/tests/test_recognition_review_e2e.py` и этот файл. Экран формы — работа frontend; браузер здесь не использовался.

## Сценарий пользователя на уровне HTTP

1. Загрузить фото двух чеков (`MEDIA/demo/double.png`) — `202`, задание `queued`.
2. Воркер с fake-сценарием завершает задание как `partial_succeeded`; у вырезки `needs_review` есть причины (`issues`) и `normalized_result` — из него форма берёт значения.
3. Человек исправляет значения и отправляет всю форму одним `POST …/confirm/`.
4. Отказ (`400 invalid_parameter`, `409 review_invalid`) ничего не сохраняет; успех (`200`) создаёт чек, вырезка становится `imported` с `confirmed_at`, задание пересчитывается, после последней вырезки — `succeeded` без повтора.

| Сценарий воркера | До подтверждения | Что отправлено | Результат |
| --- | --- | --- | --- |
| `partial_success` | чек 1 сохранён, чек 2 — `needs_review`: не прочитаны количество и цена первой строки | количество `1.000`, цена `1.5000` | `200`; задание `succeeded`, `review_required: false`, `can_retry: false`; retry — `409 retry_not_allowed` |
| `inconsistent_total` | обе вырезки `needs_review`: итог `123.45` | без правок | `409 review_invalid`, причины `optional_omitted` (`/taxes`, warning) и `total_mismatch` (`/total`, error); чеков, товаров, магазинов по-прежнему 0 |
| | | итог `4.42` (чек 1), затем `6.00` (чек 2) | `200` и `200`; после первой — `partial_succeeded` (1 сохранён, 1 на проверке), после второй — `succeeded` |
| `partial_missing_quantity` | обе вырезки `needs_review`: не прочитаны количество и цена первой строки | количество `"2"`, цена числом `1.29` | `400 invalid_parameter`, `fields`: `lines.0.quantity`, `lines.0.unit_price` |
| | | верное количество, цена `9.9900` | `409 review_invalid`, `total_mismatch` на `/lines/0/amount` |
| | | чек 1 — `2.000` и `1.2900`; чек 2 — `1.000` и `1.5000` | `200` и `200`, задание `succeeded` |
| любой | вырезка уже подтверждена | то же тело ещё раз | `200`, тот же ответ, записей нет, `version` задания не растёт |
| | | другое тело (итог `9.99`) | `409 review_resolved`, ничего не меняется |

Итог во всех сценариях одинаков и совпадает с автоматическим импортом `success2`: 2 чека, 6 строк, 1 скидка, 3 налоговых итога, 2 магазина, 5 товаров. Чек 1 — TESTMARKT, 4.42 EUR: MILCH 1 L 2 × 1.2900 = 2.58 со скидкой 0.20, APFEL 0.500 кг, MINERALWASSER, залог к ней; налоги A 7 % 3.16 + 0.22 = 3.38 и B 19 % 0.87 + 0.17 = 1.04. Чек 2 — TESTSHOP, 6.00 EUR: BROT 1.50, KAESE 2 × 2.2500; налог A 5.61 + 0.39 = 6.00.

Особенность, которую стоит показать в форме: пустые количество **и** цена при заданной сумме строки — не ошибка. Сервер выводит одну штуку по сумме (`MILCH 1 L`: 1 × 2.58 вместо 2 × 1.29), как при автоматическом импорте. Это задокументированное правило контракта, а не дефект.

## Проверено и прошло

2026-10-06, Windows, Python 3.13 из venv основного checkout, собственная QA: Compose `checkist_qa_muwthlvxb6`, PostgreSQL 25571, Redis 16571, API 18571; MEDIA и scratch — временные каталоги, провайдер `fake`. Настоящий Codex не вызывался. `P` — `python.exe -X utf8 backend/manage.py` с полным QA environment из [verification.md](../../docs/verification.md#изолированная-qa-среда) и этими портами.

| Команда | Результат |
| --- | --- |
| `docker compose -p checkist_qa_muwthlvxb6 config --quiet`; `up -d --wait --wait-timeout 90 postgres redis` | exit 0, оба healthy |
| `P check` | exit 0, 0 issues |
| `P makemigrations --check --dry-run` | exit 0, `No changes detected` |
| `P test api.tests.test_recognition_review_e2e --tag=integration --noinput --verbosity=2` | exit 0, **4 tests OK** |
| `P test catalog stores receipts health api recognition merges --exclude-tag=integration --verbosity=1` | exit 0, **335 tests OK** (как до задачи) |
| `P test catalog stores receipts health api recognition merges --tag=integration --noinput --verbosity=1` | exit 0, **1130 tests OK** (1126 + 4 новых) |
| Настоящий HTTP, три сценария, каждый на чистой базе (ниже) | три прогона `RESULT: OK` |

Автотест (`TransactionTestCase`, PostgreSQL, `APIClient` с cookie, Origin и CSRF) идёт по настоящим маршрутам: upload → `recognition_worker --once --fake-scenario …` → GET вырезки → POST confirm → GET. Тело запроса собирается только из публичного `normalized_result`, как это делает форма. Четыре теста:

- `success2` без человека — эталонное состояние, к которому должны прийти остальные;
- `partial_success` — подтверждение второй вырезки, повтор того же тела (включая другой порядок ключей и регистр кодов) → `200` без записей, три разных тела → `409 review_resolved`, автоматически сохранённая вырезка → `409 review_unavailable`;
- `inconsistent_total` — отказ с неизменным и с другим неверным итогом, затем успех для обеих вырезок;
- `partial_missing_quantity` — отказ формата, отказ арифметики, затем ввод количества и цены.

После каждого отказа сверяются вырезка, задание, счётчики девяти доменных таблиц и число чеков — без изменений. После успеха ответ `{image, job}` сверяется с `GET` вырезки и задания целиком. В конце каждого теста: чек, все строки, скидки, налоги по HTTP; закрытые реквизиты (номер чека) перенесены в БД из сохранённого распознавания; отметка `extra.recognition.confirmed` есть только у чеков, созданных подтверждением; все 13 прежних GET каталога и цен отвечают `200` в прежней форме (списки ключей, точные тела `prices` и `prices/summary` для строки со скидкой); ни одно тело ответа не содержит имён и значений закрытых полей.

### Настоящий HTTP

`manage.py runserver 127.0.0.1:18571 --noreload` + `manage.py recognition_worker --once --fake-scenario <сценарий>` + `curl.exe` с cookie, `Origin` и `X-CSRFToken`. Каждый сценарий — на своей чистой базе (`checkist_qa_muwthlvxb6_ps2`, `_it`, `_mq`): чеки fake одинаковы во всех сценариях, в общей базе второй сценарий привязался бы к уже сохранённым чекам как `reused`. Тела запросов и ответы лежали вне репозитория.

| Сценарий | Запросы подтверждения по порядку | Итог |
| --- | --- | --- |
| `partial_success` | `200`; повтор `200`; другое тело `409 review_resolved` | задание `succeeded`, version 21 → 22, retry `409 retry_not_allowed`; 46 ответов без закрытых данных |
| `inconsistent_total` | вырезка 1: `409 review_invalid`, `200`; вырезка 2: `409 review_invalid`, `200`; повтор `200`; другое тело `409 review_resolved` | version 21 → 22 → 23, `partial_succeeded` → `succeeded`; 55 ответов без закрытых данных |
| `partial_missing_quantity` | для каждой вырезки: `400 invalid_parameter`, `409 review_invalid`, `200`; повтор `200`; другое тело `409 review_resolved` | version 21 → 22 → 23; 57 ответов без закрытых данных |

В каждом прогоне: до подтверждения и после каждого отказа число чеков, товаров и магазинов не менялось; в конце 2 чека / 5 товаров / 2 магазина, строки, скидка и налоги как в разделе выше, 13 GET каталога и цен — все `200`, последняя оплаченная цена MILCH 1 L — `1.1900`. Сценарий `partial_success` повторён на текущем состоянии ветки, после последней правки `importer.py` прошлого этапа.

## Проверено и не прошло

Нет.

## Не проверено и почему

- Форма в браузере, клавиатура, вёрстка — автоматический обход UI запрещён; принимает человек по сценарию frontend.
- Запросы через Vite dev/preview proxy — это проверка клиента (frontend-задача этапа); здесь запросы шли напрямую на Django.
- Гонки (два подтверждения сразу, занятый импорт, активное задание) в этом файле не повторялись: их покрывает `api.tests.test_recognition_review_concurrency`, он прошёл в полном прогоне.
- Воркер в режиме постоянного опроса и подтверждение во время работающего задания (`409 job_active`, `409 review_busy`) вживую не проверялись: использован `--once`, задание к моменту подтверждения уже завершено.
- Настоящий Codex не вызывался — по условию задачи.
- `check_services` и `/api/health/` не запускались: Celery-контейнер не поднимался, подтверждение от него не зависит.

## Как повторить вручную

Полный QA environment со своим Compose-проектом, базой и портами, `DJANGO_DEBUG=1`, `ALLOW_LOCAL_RECOGNITION_API=1`, `RECEIPT_OCR_PROVIDER=fake`, отдельные `MEDIA_ROOT` и `RECEIPT_OCR_TEMP_ROOT`; затем `migrate --noinput`, `seed_recognition_demo`, `runserver 127.0.0.1:<порт> --noreload` — блок [QA: подтверждение неполного распознавания](../../docs/development.md#qa-подтверждение-неполного-распознавания-для-клиента). Для каждого сценария — чистая база.

```powershell
$B = 'http://127.0.0.1:18571'
$T = (curl.exe -s -c jar.txt "$B/api/recognition/csrf/" | ConvertFrom-Json).csrf_token
$H = @('-b', 'jar.txt', '-H', "X-CSRFToken: $T", '-H', "Origin: $B")
curl.exe -s @H -F "file=@$env:MEDIA_ROOT/demo/double.png" "$B/api/recognition/photos/"
./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py recognition_worker --once --fake-scenario inconsistent_total
curl.exe -s -b jar.txt "$B/api/recognition/receipt-images/?job=1"
# confirm.json — тело по контракту из normalized_result вырезки, вне репозитория
curl.exe -s @H -H 'Content-Type: application/json' -X POST --data-binary '@confirm.json' "$B/api/recognition/receipt-images/1/confirm/"
curl.exe -s -b jar.txt "$B/api/recognition/jobs/1/"
curl.exe -s -b jar.txt "$B/api/receipts/"
```

Ожидается: с итогом `123.45` — `409 review_invalid`; с итогом `4.42` — `200`, `image.status: "imported"`; тот же запрос ещё раз — `200` с тем же `receipt_id`. После проверки остановить свой Django и `docker compose -p <свой проект> down` без `-v`.
