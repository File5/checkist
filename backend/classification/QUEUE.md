# classification: очередь запусков и шаг воркера (шаг С2)

Предположение обобщённого продукта исполняет тот же host-воркер, что и распознавание (`manage.py recognition_worker`), рядом с тем же Codex CLI. Отдельного процесса, Celery-задачи и отдельной настройки провайдера нет. Ядро (модели, сервис, `runner.run_batch`, fake) описано в [README.md](README.md); здесь — очередь, чередование, статусы, запуск и измерение. Общие `docs/` по этому файлу дополняют шаги С3 и И1.

## Что откуда берётся

| Файл | Назначение |
| --- | --- |
| `classification/queue.py` | Переходы запуска: `claim_run`, `heartbeat`, `finish_batch`, `fail_run`, `release_run`, `recover_expired_runs` |
| `classification/worker.py` | `process_batch(run, *, classifier, is_stopped)` — один пакет захваченного запуска |
| `classification/codex.py` | `CodexClassifier`: файл промпта + строка `INPUT JSON:` + вход, один текстовый вызов Codex CLI |
| `classification/prompts/classification.txt` | Промпт версии 1, без подстановок |
| `recognition/providers/codex_cli.py` | `CodexCLIProvider.run_text(...)` — общий текстовый вызов: те же флаги, что у распознавания, без `-i <image>` |
| `recognition/management/commands/recognition_worker.py` | Второй вид работы в цикле воркера, флаг `--classification-fake-scenario` |
| `recognition/importer.py`, `recognition/review.py` | Автозапуск: `_request_product_classification(receipt)` после импорта и после подтверждения вырезки |

## Откуда берётся запуск

Запуск — строка `ClassificationRun` в статусе `queued`. Её создают:

- кнопка «Предложить категории» (`POST /api/product-classifications/runs/`, шаг С3) — `services.request_run(trigger="manual")`;
- импорт чека и подтверждение вырезки `needs_review` при `PRODUCT_CLASSIFICATION_AUTO_SUGGEST=1` — `services.request_run(trigger="import", product_ids=…)` для товаров строк `kind='product'` этого чека. Вызов идёт внутри транзакции импорта в отдельном savepoint, сразу после поиска дублей (`PRODUCT_MERGE_AUTO_DETECT`): поглощённые товары в запуск не попадают. Строка очереди фиксируется и откатывается вместе с чеком. Сбой постановки пишет в журнал только класс ошибки (`Product classification request after import failed: <Класс>`) и не влияет на чек, вырезку и задание; такие товары подберёт ручной запуск.

Команда `product_classifications suggest` очередь не использует: она создаёт запуск сразу `running` и выполняет все пакеты в своём процессе (README).

Импорт только пишет строку очереди. Модель спрашивает воркер — позже, в другом проходе цикла, после завершения задания распознавания. Исход запуска (успех, сбой провайдера, неверный ответ) не меняет ни чек, ни вырезку, ни статус и счётчики задания распознавания: он виден только в `ClassificationRun` (и в `GET /api/product-classifications/status/` шага С3).

Автозапуск берёт только товары без единой записи-предположения в любом статусе (`candidates(auto=True)`): отклонённые, заменённые и подтверждённые повторно не предлагаются ни новым чеком, ни повторным фото. Товар с содержательным обобщённым продуктом не кандидат вовсе.

## Чередование в цикле воркера

Один проход:

1. Проверка слота воркера; `recognition.queue.recover_expired_jobs()`; `classification.queue.recover_expired_runs()`.
2. `recognition.queue.claim_job()`. Есть задание распознавания — оно обрабатывается целиком, как раньше.
3. Иначе `classification.queue.claim_run()`. Есть запуск — выполняется **один пакет** (`PRODUCT_CLASSIFICATION_BATCH_SIZE` товаров, по умолчанию 25).
4. `--once` завершает работу после одной единицы — задания либо пакета (либо сразу, если очереди пусты). Иначе пауза 1 с.

Задание распознавания всегда раньше запуска. После пакета запуск возвращается в `queued` (остались товары) либо получает конечный статус, поэтому задание ждёт не дольше одного запроса к модели, а `running` означает ровно «сейчас выполняется пакет». Вывод воркера: `Job <id>: <status>` и `Classification run <id>: <status>`.

`executor.state` API распознавания отдаёт `busy` и во время пакета (запуск `running` с живой lease; сделано на шаге С1).

## Статусы запуска

| Переход | Когда | Функция |
| --- | --- | --- |
| `queued → running` | воркер взял запуск на один пакет; `run_token`, `heartbeat_at`, `lease_expires_at` заполнены, `started_at` — при первом захвате | `claim_run` |
| `running → queued` | пакет завершён, товары остались | `finish_batch` |
| `running → queued` | остановка воркера во время пакета (`Ctrl+C`, потеря слота); `recoveries` не растёт | `release_run` |
| `running → queued` | lease истекла, `recoveries < 2`; `recoveries` растёт на 1 | `recover_expired_runs` |
| `running → succeeded` | обработан последний пакет; «не знаю» и пропущенные товары успеху не мешают | `finish_batch` |
| `running → failed` | сбой провайдера после исчерпания попыток; неверный ответ; `input_too_large` | `finish_batch` |
| `running → failed`, `worker_lost` | lease истекла при `recoveries = 2` | `recover_expired_runs` |
| `running → failed`, `internal_error` | непредвиденная ошибка шага; воркер продолжает работу | `fail_run` |
| `queued → cancelled` | команда `product_classifications cancel-pending` | `services.cancel_pending` |

Коды `error_code`: коды провайдера (`auth_required`, `network_unavailable`, `rate_limited`, `provider_unavailable`, `configuration_error`, `invalid_input`, `invalid_output`, `timeout`), `worker_lost`, `input_too_large`, `internal_error`. Пакеты, применённые до сбоя, остаются применёнными: `cursor` показывает, сколько товаров прошло через пакеты.

**Lease.** При захвате `lease_expires_at = now + PRODUCT_CLASSIFICATION_TIMEOUT_SECONDS + 60 с`. Отдельного потока heartbeat нет: lease продлевается в начале каждого запроса к модели (`queue.heartbeat` из `RunContext.on_stage`), поэтому пакет с повторной попыткой не теряет её. Все переходы захваченного запуска проверяют `run_token`: запуск, который тем временем закрыли (`suggest` и `cancel-pending` закрывают запуск с истёкшей lease), даёт `RunLost` и остаётся как есть.

**Попытки пакета.** Не больше `RECEIPT_OCR_MAX_ATTEMPTS` (по умолчанию 2); повторяются только сбои с признаком `retryable` (сеть, лимит, недоступность, срок), с паузой 2–3 с. `invalid_output` и `auth_required` не повторяются. Каждая попытка — строка `ClassificationAttempt` (приватно: сырой ответ, текст неверного ответа до 65536 символов). Занятый каталог (`IMPORT_LOCK` у импорта или слияния) повторяется три раза; затем товары пакета остаются без предположения (`stats.catalog_busy`), запуск идёт дальше.

**Остановка.** `Ctrl+C` во время пакета: попытка `failed` / `worker_lost`, запуск возвращается в `queued` без роста `recoveries`. Потеря слота воркера (сессия с advisory-блокировкой) останавливает запрос к модели (проверка не чаще раза в секунду), попытка `failed` / `cancelled`, запуск возвращается в `queued`, воркер завершается с ошибкой. Недоступная БД останавливает воркер, как и раньше; запуск остаётся `running` и восстанавливается после истечения lease.

**Восстановление.** После истёкшей lease тот же пакет выполняется заново. Товары, которые потерянный захват уже успел применить, перестали быть кандидатами и учитываются как пропущенные (`stats.not_eligible`), повторно не меняются.

**Один ожидающий запуск.** База допускает один `queued` и один `running`. Если импорт поставил свой запуск, пока выполнялся пакет, при возврате в очередь выполнявшийся запуск забирает его товары себе (в хвост, без повторов, сверх `PRODUCT_CLASSIFICATION_RUN_LIMIT` — в `remaining_count`), а не начавшаяся строка удаляется. `request_run` на запуске, ждущем между пакетами, не трогает товары до `cursor`: новые добавляются только за ним.

## Настройки

| Переменная | По умолчанию | Смысл |
| --- | --- | --- |
| `PRODUCT_CLASSIFICATION_AUTO_SUGGEST` | `0` | ставить запуск после импорта и после подтверждения вырезки |
| `PRODUCT_CLASSIFICATION_TIMEOUT_SECONDS` | `180` | срок одного запроса к модели; lease = срок + 60 с |
| `PRODUCT_CLASSIFICATION_BATCH_SIZE` | `25` | товаров в пакете |
| `PRODUCT_CLASSIFICATION_RUN_LIMIT` | `200` | товаров в запуске |
| `RECEIPT_OCR_PROVIDER`, `RECEIPT_OCR_MODEL`, `RECEIPT_OCR_CODEX_EXECUTABLE`, `RECEIPT_OCR_TEMP_ROOT`, `RECEIPT_OCR_MAX_ATTEMPTS` | существующие | провайдер, модель, исполняемый файл, каталог приватных файлов попытки и число попыток — общие с распознаванием |

Сбой Codex никогда не включает fake: fake выбирается только `RECEIPT_OCR_PROVIDER=fake`. Сценарий fake — флаг воркера `--classification-fake-scenario`, иначе переменная окружения `PRODUCT_CLASSIFICATION_FAKE_SCENARIO`, иначе `mixed`. Флаг с `RECEIPT_OCR_PROVIDER=codex_cli` — ошибка запуска.

## Запуск воркера с fake (только QA)

Полный блок окружения QA — `docs/verification.md`; база `checkist_qa[_суффикс]`, отдельные `MEDIA_ROOT` и `RECEIPT_OCR_TEMP_ROOT`. Dev-базу не использовать.

```powershell
$env:RECEIPT_OCR_PROVIDER = 'fake'
$env:PRODUCT_MERGE_AUTO_DETECT = '0'
$env:PRODUCT_CLASSIFICATION_AUTO_SUGGEST = '0'
./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py migrate --noinput
./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py seed_product_classification_demo
# поставить запуск в очередь без HTTP (то же делает кнопка шага С3):
./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py shell -c "from classification import services; print(services.request_run(trigger='manual'))"
# один пакет и выход:
./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py recognition_worker --once --fake-scenario success2 --classification-fake-scenario mixed
# либо постоянный воркер (Ctrl+C — остановка):
./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py recognition_worker --fake-scenario success2 --classification-fake-scenario mixed
```

Ожидается на чистой базе с демо: `Recognition worker ready.`, затем `Classification run 1: succeeded`; в базе 9 ожидающих записей в 7 группах, 1 «не знаю», 6 созданных обобщённых продуктов и 4 категории (как у `suggest --fake-scenario mixed`). С `PRODUCT_CLASSIFICATION_BATCH_SIZE=4` три прохода `--once` дают `queued`, `queued`, `succeeded`. Возврат каталога — `product_classifications cancel-pending` при остановленном воркере.

Сценарии для негативной приёмки: `provider_error` (две попытки, запуск `failed` / `provider_unavailable`), `auth_failure` (`auth_required`, без повтора), `invalid_output`, `foreign_product`, `missing_product` (`invalid_output`, без повтора), `unknown` (успех без изменений), `service_target` (успех, все пункты отброшены), `existing`, `new_category`, `rejected_again`, `pause` (пакет длится до срока либо остановки — для проверки `busy` и `Ctrl+C`). Во всех сбойных сценариях каталог не меняется.

Автозапуск: тот же воркер с `$env:PRODUCT_CLASSIFICATION_AUTO_SUGGEST = '1'` (переменная нужна и процессу API: подтверждение вырезки ставит запуск из него). После обработки фото в `ClassificationRun` появляется `queued` с `trigger = import`; следующий проход воркера выполняет пакет.

## Как измерить время одного запроса к модели (QA, настоящий Codex)

С fake время не показательно. Измерение — только в QA, на демо-каталоге с вымышленными названиями, с нативным `codex.exe` и действующим входом (`codex login status`):

```powershell
$env:RECEIPT_OCR_PROVIDER = 'codex_cli'
./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py migrate --noinput
./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py seed_product_classification_demo
# 1. Один запрос без записи в базу (кроме чтения): чистое время запроса и проверки ответа.
Measure-Command { ./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py product_classifications suggest --dry-run | Out-Host }
# 2. Тот же запрос через очередь и воркер: один пакет, включая применение.
./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py shell -c "from classification import services; print(services.request_run(trigger='manual'))"
Measure-Command { ./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py recognition_worker --once | Out-Host }
# 3. Точное время запроса к модели по строкам попыток (без запуска Django и стартовой проверки Codex):
./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py shell -c "from classification.models import ClassificationAttempt as A; [print(a.run_id, a.batch, a.ordinal, a.status, a.error_code, len(a.product_ids), (a.finished_at - a.started_at).total_seconds()) for a in A.objects.order_by('pk')]"
```

`Measure-Command` включает запуск интерпретатора и стартовую проверку Codex воркером (`--version`, `exec --help`, `login status`); время самого запроса — разность `finished_at - started_at` строки `ClassificationAttempt` (у успешной попытки в неё входит и применение ответа). В отчёт: число товаров пакета, время, число предложенных, «не знаю» и отброшенных по причинам (`ClassificationRun.stats`), ошибка — если нет `codex.exe`, входа или сети. Демо-каталог — 10 кандидатов, один пакет; чтобы получить несколько пакетов, уменьшить `PRODUCT_CLASSIFICATION_BATCH_SIZE`.

## Откат

Шаг воркера, очередь и автозапуск — revert кода; миграций этот шаг не добавляет. Перед откатом остановить воркер; запуск в очереди и ожидающие записи убирает `product_classifications cancel-pending` (README, «Откат»).
