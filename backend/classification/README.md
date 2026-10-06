# classification: предположение обобщённого продукта с подтверждением (шаг С1)

Ядро без HTTP, очереди воркера и настоящей модели: таблицы, таксономия, проверка ответа, сервис операций, явный fake, исполнение пакета, команды, демо. Очередь, воркер, Codex и автозапуск из импорта — шаг С2; HTTP и эталонные JSON — шаг С3. Контракт — ответ задачи `task_mux37gz1hc` (К1); общие `docs/` обновляет С3.

Товар, созданный распознаванием, лежит в служебном «Не разобрано». Модель предполагает обобщённый продукт (существующий либо новый, с путём категории). Предположение применяется **сразу**: `Product.generic` меняется, а запись `ProductClassification` помнит прежнее и предложенное значение и ждёт человека. Человек подтверждает, выбирает другой существующий обобщённый продукт или отклоняет.

Правила, которые нельзя нарушать:

- автоматика меняет обобщённый продукт товара, только если сейчас это служебное «Не разобрано» — проверка при отборе (`candidates`) и ещё раз под блокировкой (`apply`);
- значение, выставленное человеком, не перезаписывается: запись закрывается как «заменено» (`superseded` / `changed`);
- отклонение возвращает товар в прежний обобщённый продукт, убирает созданное механизмом и опустевшее, и запоминает отказ (`ClassificationRejection`): тот же вариант этому товару больше не предлагается;
- сам «Не разобрано», его категория и категории существующих обобщённых продуктов не меняются.

## Модель (`models.py`, миграция `0001_initial`)

Таблицы `catalog`, `receipts`, `recognition`, `merges` не меняются. Внешние ключи на каталог — `SET_NULL` / `CASCADE`, без `PROTECT`: правке и удалению каталога они не мешают; рядом хранится числовой `*_ref` и снимок названия.

| Модель | Назначение |
| --- | --- |
| `ProductClassification` | Запись-предположение. `status`: `pending` / `confirmed` / `rejected` / `superseded`; `resolution`: `confirmed`, `other`, `rejected`, `cancelled`, `changed`, `merged`, `product_removed` (пусто, пока `pending`); `version` с 1, растёт при каждом изменении сервисом; `active_product` (one-to-one, `related_name="pending_classification"`) заполнен, только пока запись ожидает |
| `CreatedGenericProduct`, `CreatedCategory` | Журнал созданного механизмом: `state` `provisional` («новая») / `kept` / `removed` |
| `ClassificationRejection` | Память отказов: unique `(product, generic_key)`, ключ — `taxonomy.name_key` названия |
| `ClassificationRun` | Запуск: `status` `queued` / `running` / `succeeded` / `failed` / `cancelled`, `trigger` `manual` / `import` / `command`, `scope` `all` / `products`. Не больше одного `queued` и одного `running`; `run_token`, `heartbeat_at`, `lease_expires_at` заполнены только у `running`; `finished_at` — только у конечного статуса |
| `ClassificationAttempt` | Приватная попытка пакета: сырой ответ, текст неверного ответа. В API не отдаётся |

Перечисления: `ProductClassification.Status`, `.Resolution`, `ClassificationRun.Status`, `.Trigger`, `.Scope`.

Админка (`admin.py`) — только чтение: `ProductClassification`, `ClassificationRun`, `CreatedGenericProduct`, `CreatedCategory`. `ClassificationRejection` не зарегистрирована намеренно: она каскадно удаляется вместе с товаром, и регистрация «только чтение» запретила бы удалять такой товар в админке. `ClassificationAttempt` не зарегистрирована: в ней приватный ответ модели.

## Что вызывать из С2 и С3

### `classification.services`

Каждая изменяющая операция — одна транзакция: неблокирующий `IMPORT_LOCK` первым, затем (только при создании или удалении категории) неблокирующая блокировка дерева `CATEGORY_TREE_LOCK`, затем строки — записи по возрастанию id, товары по возрастанию id. «Занято» — `ClassificationBusy`, полный откат, без скрытого повтора. `transaction.atomic()` не `durable`, advisory-блокировка в пределах сессии повторно входима: `after_merge_confirmed` и `request_run(trigger="import")` вызываются из чужой транзакции.

| Подпись | Кому | Результат |
| --- | --- | --- |
| `candidates(*, product_ids=None, auto=False) -> QuerySet[Product]` | С2, С3 | Товары по возрастанию id: служебный обобщённый продукт, нет ожидающей записи, не поглощён ожидающим слиянием, не услуга и не залог. `auto=True` — ещё и ни одной записи в любом статусе |
| `request_run(*, trigger, product_ids=None) -> tuple[ClassificationRun \| None, bool]` | С2 (импорт), С3 (`POST runs/`) | Только строка очереди, модель не вызывается. `IMPORT_LOCK` берётся при `trigger != "import"` |
| `apply(run, response, *, source) -> ApplyResult` | С2 | Применить проверенный ответ. `run` может быть `None`. Увеличивает `applied_count` / `unknown_count` / `skipped_count` / `stats` / `version` запуска; `cursor` и статус — забота исполнителя |
| `reconcile() -> int` | С2 | Сверка всех ожидающих записей, число изменённых |
| `confirm(record_id, *, version, generic_id) -> ProductClassification` | С3 | `generic_id` равен предложенному — подтверждение, другой — «выбрать другой» |
| `reject(record_id, *, version) -> ProductClassification` | С3 | |
| `confirm_many(items: Sequence[tuple[int, int]]) -> list[ProductClassification]` | С3 | 1–100 пар `(id, version)`, всё или ничего, результат по возрастанию id |
| `cancel_pending() -> dict` | команда | `{"cancelled": [...], "superseded": [...], "runs_cancelled": [...], "removed_generics": n, "removed_categories": n}` |
| `after_merge_confirmed(*, target_id, absorbed_ids) -> None` | `merges` | Шаг после подтверждения слияния |
| `get_record(record_id) -> ProductClassification` | С3 | Либо `ClassificationNotFound`; `run` загружен, 1 запрос |
| `records(*, status=None, product=None, generic=None, run=None, ordering="generic") -> QuerySet` | С3 | `product` ищет по `product_ref` и `origin_product_ref`; `ordering`: `generic` (`suggested_generic_name`, `suggested_generic_ref`, `id`) либо `-id`; `run` загружен |
| `describe(records) -> list[RecordInfo]` | С3 | 7 запросов на страницу любого размера (меньше — только когда набор для запроса пуст) |
| `summary() -> Summary` | С3 | 3 запроса |
| `get_run(run_id) -> ClassificationRun`, `runs(*, status=None) -> QuerySet` | С3 | Порядок `-id` |

Данные:

- `Source(provider, model="", prompt_version="1", schema_version="1", classifier_version=1)`; `default_source(classifier=None)` — источник по классификатору либо по `RECEIPT_OCR_PROVIDER` / `RECEIPT_OCR_MODEL`.
- `ApplyResult(record_ids, applied, unknown, skipped: dict[str, int])` — `skipped` без `unknown`.
- `RecordInfo`: `record`, `product` (живой `Product` либо `None`; у решённой записи ищется по `product_ref`), `product_generic` (текущий `GenericProduct` либо `None`), `aliases` (до 10 `ProductAlias` с загруженным `merchant`, порядок `raw_name, id`), `merge_group_id` (id ожидающей группы, в которой товар поглощён), `suggested_generic` (живой либо `None`), `category_path` (`[(id, name, is_new)]` от корня; при удалённом обобщённом продукте — снимок с `is_new = False`), `generic_is_new`, `pending_count`, `can_act`.
- `Summary`: `pending_count`, `unclassified_count`, `run` (выполняющийся, иначе в очереди, иначе последний по id, иначе `None`).

Исключения наследуют `ClassificationError`, у каждого `code` — код контракта:

| Исключение | `code` | Данные |
| --- | --- | --- |
| `ClassificationNotFound` | `not_found` | — |
| `ClassificationBusy` | `classification_busy` | занят `IMPORT_LOCK` либо дерево категорий, либо SQLSTATE `55P03` / `57014` / `40P01` |
| `ClassificationResolved` | `classification_resolved` | `.record`; у `confirm_many` — `.record is None`, `.fields` |
| `ClassificationChanged` | `classification_changed` | `.record` с текущей `version`; у `confirm_many` — `.fields` |
| `ClassificationInvalidParameter` | `invalid_parameter` | `.fields`: `{параметр: причина}` |

Причины `ClassificationInvalidParameter`: `{"generic_id": "unknown"}` (обобщённого продукта нет либо значение не целое положительное), `{"generic_id": "service_generic"}`, `{"items": "empty"}`, `{"items": "too_many"}`, `{"items.N.id": "duplicate"}` (N — позиция повторного id). `.fields` у `confirm_many`: `{"items.N": "resolved" | "changed"}` по всем отказавшим записям сразу; исключение — `ClassificationResolved`, если есть хотя бы одна `resolved`, иначе `ClassificationChanged`. Прочий отказ БД сервис не перехватывает — это `503 database_unavailable` на стороне представления.

Порядок проверок `confirm` / `reject`: запись существует → повтор → статус → сверка → `version` → параметр. Повтор без `Idempotency-Key`: `confirm` на записи `confirmed` с тем же `final_generic_ref` и `reject` на записи `rejected` возвращают запись без записи в БД при любой `version`.

**Сверка** (`_reconcile`) выполняется внутри каждой операции над записью и в начале `apply`, `request_run` (кроме `import`), `start_run`: товара нет — запись переходит к оставляемому товару подтверждённого слияния либо закрывается (`merged` / `product_removed`); обобщённый продукт товара сменили — `superseded` / `changed`; живые название, единица или путь категории отличаются от снимка — снимок обновляется. Эти исходы **фиксируются**, и только потом операция поднимает `ClassificationResolved` / `ClassificationChanged`. «Занято» и устаревшая `version` не сохраняют ничего. Чтение ничего не пишет: до сверки такая запись отдаётся `pending` с `can_act = False`.

Запуск без очереди (использует команда `suggest`; С2 может взять либо написать свои переходы в `queue.py`): `start_run(*, product_ids=None, limit=None, source=None) -> ClassificationRun | None` (сразу `running`; живая lease чужого запуска — `ClassificationBusy`, истёкшая — `failed` / `worker_lost`), `advance_run(run, consumed)` (курсор и продление lease), `finish_run(run, *, error_code="")`, `count_skipped(run, reason, count)`, `lease_until(now)` — `now + PRODUCT_CLASSIFICATION_TIMEOUT_SECONDS + 60 с`.

### Остальные модули

| Подпись | Назначение |
| --- | --- |
| `classification.taxonomy.name_key(text)`, `display_name(text)`, `SERVICE_KEY` | Ключ названия (NFKC, `casefold`, `ё` → `е`, все тире → `-`, пробелы) и отображаемое название. Ещё `SERVICE_NAME`, `is_valid_name`, `is_service_name` |
| `classification.context.build_request(product_ids) -> ClassificationRequest` | Вход модели, только чтение, 9 запросов при любом числе товаров (на один больше при продавце без вывески и ещё на один при превышении предела в 500 обобщённых продуктов). `request.product_ids` — товары документа по возрастанию id (исчезнувшие пропущены). Больше 120 000 байт — `InputTooLarge` (`code = "input_too_large"`); `fit_request(product_ids)` делит пакет пополам до соблюдения предела |
| `classification.validation.validate_response(data, *, product_ids) -> ClassificationResponse` | `data` — текст JSON либо разобранный объект. Неверный ответ целиком — `ClassificationOutputError` (`.path`, `.reason`, без значений входа). `drop_reason(suggestion)` — причина отброса одного пункта, известная без каталога: `unknown`, `service_target`, `name_invalid`, `category_invalid` |
| `classification.runner.run_batch(product_ids, *, classifier, run=None, context=None, dry_run=False) -> BatchResult` | Один пакет: повторная проверка кандидатов → вход → классификатор → проверка → `apply` |
| `classification.classifier.ProductClassifier`, `FakeClassifier`, `FAKE_SCENARIOS`, `get_classifier(*, scenario=None)` | Протокол, явный fake, фабрика |
| `classification.dto` | `ClassificationRequest(document, product_ids, sha256)` с `to_json()`; `Suggestion`; `ClassificationResponse(items)` с `to_dict()`; версии `PROMPT_VERSION`, `SCHEMA_VERSION`, `INPUT_VERSION` = `"1"`, `CLASSIFIER_VERSION` = `1` |

`BatchResult`: `request` (`None`, если кандидатов в пакете не осталось либо вход не поместился), `response`, `raw_payload` (`response.to_dict()`), `error_code`, `invalid_output_text` (до 65536 символов), `apply` (`ApplyResult | None`), `consumed`.

`run_batch` при заданном `run` сам пишет `ClassificationAttempt` (номер пакета — следующий за последним у запуска, попытки с 1) и счётчики запуска; курсор и статус двигает вызывающий — на `result.consumed`. Сбой с признаком `retryable` повторяется до `RECEIPT_OCR_MAX_ATTEMPTS` с паузой 2–3 с; итоговый сбой — `error_code` (код провайдера либо `input_too_large`), ничего не применено. Занятый каталог повторяется три раза с паузами 0,2 и 0,4 с; после третьего отказа товары пакета остаются без предположения (`skipped: {"catalog_busy": n}`), запуск идёт дальше. `context` — `RunContext` воркера (отмена); срок одного запроса — `PRODUCT_CLASSIFICATION_TIMEOUT_SECONDS`. У запуска из импорта (`trigger="import"`, `scope="products"`) повторная проверка идёт с `auto=True`. `runner.execute(run, *, classifier)` выполняет все пакеты запуска `running` в текущем процессе.

Причины пропуска пункта в `run.stats` и `ApplyResult.skipped`: `unknown_generic`, `service_target`, `name_invalid`, `category_invalid`, `generic_ambiguous`, `category_ambiguous`, `rejected_before`, `not_eligible`, `catalog_conflict`, `catalog_busy`; в `stats` дополнительно `unknown`.

`get_classifier` выбирает по `RECEIPT_OCR_PROVIDER`: `fake` — `FakeClassifier` (сценарий из аргумента, иначе из переменной окружения `PRODUCT_CLASSIFICATION_FAKE_SCENARIO`, иначе `mixed`). Ветки `codex_cli` на шаге С1 нет: фабрика поднимает `ProviderError("configuration_error")` — её добавляет С2 (`classification.codex.CodexClassifier`). Сбой никогда не включает fake.

Сценарии `FakeClassifier(scenario="mixed", *, gate=None, entered=None)`: `mixed`, `existing`, `new_category`, `unknown`, `provider_error`, `auth_failure`, `invalid_output`, `foreign_product`, `missing_product`, `service_target`, `rejected_again`, `pause`. У неверного ответа `ProviderError.private_output` несёт текст ответа — он попадает в `BatchResult.invalid_output_text`.

### Что меняется вне приложения

- `merges/services.py`: `_notify_classification(target_id, absorbed_ids)` после `_resolve(group, Status.CONFIRMED)` в `confirm()`, в savepoint; сбой шага пишет в журнал только класс ошибки и слияние не отменяет. Если шаг не выполнился, запись остаётся `pending` без товара и переходит к наследнику либо закрывается первой же сверкой.
- `api/recognition_serialization.py`: `executor.state = "busy"` также при `ClassificationRun` в `running` с живой lease; проверка добавлена в тот же оператор, что читает `pg_locks`, число запросов прежнее; `last_seen_at` при этом — heartbeat выполняющегося задания распознавания либо `null`.
- `config/settings.py` и `.env.example`: `PRODUCT_CLASSIFICATION_AUTO_SUGGEST` (0), `PRODUCT_CLASSIFICATION_TIMEOUT_SECONDS` (180, 1..2400), `PRODUCT_CLASSIFICATION_BATCH_SIZE` (25, 1..50), `PRODUCT_CLASSIFICATION_RUN_LIMIT` (200, 1..1000). Флаг автозапуска на шаге С1 только читается настройками: вызов из импорта добавляет С2.

## Команды

```powershell
./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py product_classifications suggest [--dry-run] [--product ID ...] [--limit N] [--fake-scenario NAME]
./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py product_classifications cancel-pending
./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py product_classifications reconcile
./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py seed_product_classification_demo
```

`suggest` выполняет запуск прямо в процессе команды (`trigger="command"`, сразу `running`), все пакеты подряд; сбой запуска — ненулевой код выхода после печати JSON. `--dry-run` вызывает классификатор и печатает проверенные предположения, ничего не пишет: ни каталог, ни запуск, ни попытку. `--fake-scenario` требует `RECEIPT_OCR_PROVIDER=fake`. С настоящим Codex (после С2) команда делает модельный вызов — только в QA.

## Демо (только QA и тесты)

`seed_product_classification_demo` работает только на базах `test_*` и `checkist_qa[_суффикс]`; повтор ничего не меняет. Вымышленный продавец «Kategoriemarkt», 3 чека, 14 строк, 12 товаров, 13 написаний; в каталоге заранее «Продукты питания» → «Молочные продукты» и «Молоко» (`l`). Таблица `demo.MIXED` — одновременно ответы fake-сценария `mixed`.

```powershell
$env:RECEIPT_OCR_PROVIDER = 'fake'
./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py seed_product_classification_demo
./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py product_classifications suggest --dry-run --fake-scenario mixed
./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py product_classifications suggest --fake-scenario mixed
./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py product_classifications cancel-pending
```

Ожидается на чистой базе: кандидатов 10; после `suggest` — `requested: 10, applied: 9, unknown: 1`, 9 ожидающих записей в 7 группах, создано 6 обобщённых продуктов и 4 категории; повтор — `requested: 1, applied: 0, unknown: 1`; `cancel-pending` — `removed_generics: 6, removed_categories: 4`, каталог совпадает с исходным (11 товаров в «Не разобрано»).

## Откат

1. Остановить воркер. `product_classifications cancel-pending`: каждый ожидающий товар возвращается в прежний обобщённый продукт, если его значение всё ещё предложенное (значение, которое человек успел сменить, остаётся); созданное механизмом и опустевшее удаляется; запуск в очереди отменяется; память отказов по этим записям не пишется. Каждая запись — своя транзакция: при «занято» команду достаточно повторить.
2. `migrate classification zero` удаляет шесть таблиц. Каталог не трогает.

После обеих команд каталог совпадает с видом до предположений, **кроме** подтверждённых классификаций и принятых вместе с ними категорий и обобщённых продуктов (они остаются обычными записями каталога без следа происхождения) и правок человека. Без `cancel-pending` ожидающие товары останутся в предложенных обобщённых продуктах без пометки и без возможности возврата — только из `pg_dump`. Повторный `migrate` создаёт пустые таблицы: история, журнал созданного и память отказов не восстанавливаются. Откат шага в слиянии, `executor.busy` и настроек — revert кода.

## Отклонения от контракта К1 и уточнения

Формат данных и подписи §12.3 не менялись; добавлено и уточнено:

1. `BatchResult.consumed` — добавленное поле: сколько id из переданных пакет закрыл (вход может быть урезан до предела размера). Без него исполнитель не знает, на сколько двигать курсор.
2. `run_batch` сам пишет попытки (`ClassificationAttempt`) и повторяет сбои `retryable` и «занято»: последовательность §7.3 «запись попытки → вызов → результат попытки» не делится на две функции с данной подписью.
3. Добавлены `start_run`, `advance_run`, `finish_run`, `count_skipped`, `lease_until`, `default_source`, `runner.execute`, `context.fit_request`, `validation.drop_reason`, `taxonomy.is_valid_name` / `is_service_name` — нужны команде `suggest` и применению; очередь С2 может использовать их либо свои переходы.
4. `request_run(trigger="import")` не выполняет сверку (§4.2 называет `request_run` целиком): по §4.6 импорт делает «только вставку в таблицу очереди» внутри своей транзакции. Сверка идёт в ручном запуске, в `apply` и в `start_run`.
5. Блокировка дерева категорий берётся в момент первой потребности (создание либо удаление категории), а не строго до строк. Она неблокирующая, поэтому взаимная блокировка невозможна, а отказ даёт тот же полный откат.
6. Занятое дерево категорий откатывает и исход сверки той же операции: правило «занято ничего не меняет» сильнее правила «исход сверки фиксируется».
7. Добавлена причина пропуска `catalog_busy` (три отказа «занято» при применении пакета) — в §6.4 такого кода нет, а §4.0 требует оставить товары пакета без предположения, не проваливая запуск.
8. Пункт про товар, который не является кандидатом, считается `not_eligible` даже при `decision: "unknown"`.
9. `summary().run` читается одним запросом с порядком «выполняющийся, в очереди, последний».
10. Ручной запуск при активных запусках возвращает запуск в очереди, а если его нет — выполняющийся (§4.6 говорит «он», не различая).
11. Миграция `0001_initial` зависит от `catalog.0001_initial` и `receipts.0001_initial`, но **не** от `merges.0001_initial` (§2 называет все три). Внешних ключей на `merges` нет, а с такой зависимостью `migrate merges zero` молча удалял бы и таблицы предположений вместе с ожидающими записями, без `cancel-pending`; существующий тест отката `merges` оставлял бы базу без этих таблиц.
