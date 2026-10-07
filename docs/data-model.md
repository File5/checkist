# Модель данных Checkist

Документ описывает код в `backend/catalog`, `backend/stores`, `backend/receipts`, `backend/recognition` по состоянию ветки. Источник истины — `models.py` и миграции этих приложений; при расхождении прав код, документ исправляется.

Реализованы модели, нормализация, дедупликация, проверка чека, история цен и распознавание через host-worker. Данные доступны через [API](api-contract.md): прежний каталог/цены и новый локальный upload/jobs/receipts. Ручной ввод и правка — [Django admin](#админка); API произвольного редактирования нет. Фото хранятся в MEDIA и связаны с чеками через `ReceiptImage`. Владельца-пользователя и серверных курсов валют нет.

## Приложения и таблицы

| Приложение | Назначение | Таблицы |
| --- | --- | --- |
| `stores` | Справочники и магазины | `stores_country`, `stores_currency`, `stores_taxrate`, `stores_merchant`, `stores_store` |
| `catalog` | Каталог товаров двух уровней | `catalog_category`, `catalog_genericproduct`, `catalog_brand`, `catalog_product` |
| `receipts` | Чеки и сопоставление названий | `receipts_receipt`, `receipts_receiptline`, `receipts_receiptdiscount`, `receipts_receipttax`, `receipts_productalias` |
| `recognition` | Фото, очередь, вырезки и попытки | `recognition_sourcephoto`, `recognition_processingjob`, `recognition_receiptimage`, `recognition_recognitionattempt` |
| `merges` | Предварительное слияние дублей товаров | `merges_productmerge`, `merges_productmergemember`, `merges_productmergeline`, `merges_productmergealias`, `merges_productmergerejection` |
| `classification` | Предположение обобщённого продукта и категории с подтверждением человеком | `classification_productclassification`, `classification_createdgenericproduct`, `classification_createdcategory`, `classification_classificationrejection`, `classification_classificationrun`, `classification_classificationattempt` |

`stores` и `catalog` друг от друга не зависят; `receipts` ссылается на оба. `catalog/units.py` принадлежит `catalog`, `receipts` его импортирует.

Общие правила предметной модели (особенности recognition — ниже):

- PK — `BigAutoField`; у `Country` и `Currency` PK — код ISO (`code`).
- Необязательные строки — `blank=True, default=""`, не `NULL`: на этом построены условные уникальные ограничения.
- Деньги — `Decimal(14, 2)`; цена за единицу — `(14, 4)`; количество — `(12, 3)`; ставка налога — `(5, 2)`. Валюты с тремя знаками после запятой (KWD, BHD) в `(14, 2)` не помещаются.
- `JSONField` — `default=dict, blank=True`, в Postgres это `jsonb`. Структуру JSON ни БД, ни код не проверяют.
- Ограничения с `nulls_distinct=False` требуют Postgres 15+; проект использует 17.11.

## `stores`

**`Country`** — `code` `CharField(2)` PK (ISO 3166-1 alpha-2), `name` `CharField(100)`.

**`Currency`** — `code` `CharField(3)` PK (ISO 4217), `name` `CharField(100)`.

**`TaxRate`** — ставка налога страны. Периоды действия не хранятся: ставка — значение, дату даёт чек. Буква налогового класса (`A`/`B`) сюда не входит, она зависит от магазина и хранится на строке чека.

| Поле | Тип | Примечание |
| --- | --- | --- |
| `country` | FK `Country`, `PROTECT` | |
| `kind` | `CharField(16)`: `vat` / `exempt` | `exempt` — «без НДС» |
| `rate` | `Decimal(5,2)`, null | `NULL` только при `exempt`; `0.00` — настоящая нулевая ставка |
| `name` | `CharField(64)` | «НДС 16%», «MwSt 7%», «Без НДС» |

- Unique `(country, kind, rate)`, `nulls_distinct=False` — `stores_taxrate_country_kind_rate_uniq`.
- Check `(kind='exempt' AND rate IS NULL) OR (kind='vat' AND rate IS NOT NULL AND rate >= 0)` — `stores_taxrate_kind_rate_check`.

**`Merchant`** — продавец, юрлицо. Отдельной таблицы сети нет, сеть — `brand_name`.

| Поле | Тип | Примечание |
| --- | --- | --- |
| `country` | FK `Country`, `PROTECT` | Страна регистрации, пространство имён налогового ID |
| `legal_name` | `CharField(255)` | |
| `brand_name` | `CharField(100)`, blank | Вывеска: «DNS», «Lidl» |
| `tax_id_type` | `CharField(16)`, blank: `inn` / `bin` / `vat_id` / `other` | |
| `tax_id` | `CharField(32)`, blank | Без пробелов; очистку делает вызывающий код |
| `extra` | JSON | См. [JSON-поля](#json-поля) |

- Unique `(country, tax_id)` при `tax_id != ''` — `stores_merchant_country_tax_id_uniq`. Пустой `tax_id` может повторяться; `tax_id_type` в ключ не входит.

**`Store`** — торговая точка; адрес встроен в магазин.

| Поле | Тип | Примечание |
| --- | --- | --- |
| `merchant` | FK `Merchant`, `PROTECT` | |
| `country` | FK `Country`, `PROTECT` | Страна точки |
| `name` | `CharField(255)`, blank | |
| `branch_code` | `CharField(32)`, blank | Номер филиала у продавца |
| `address_raw` | `TextField` | Адрес как на чеке, на основном языке |
| `address_i18n` | JSON | Варианты по языкам: `{"kk": "...", "ru": "..."}` |
| `address_key` | `CharField(255)` | Нормализованный адрес, см. ниже |
| `postal_code` | `CharField(16)`, blank | |
| `region`, `city` | `CharField(100)`, blank | |
| `street` | `CharField(255)`, blank | |
| `house` | `CharField(32)`, blank | |
| `timezone` | `CharField(64)` | IANA: `Asia/Almaty`, `Europe/Berlin`; существование пояса БД не проверяет |

- Unique `(merchant, address_key)` — `stores_store_merchant_address_key_uniq`: это и есть «магазин через адрес».
- Unique `(merchant, branch_code)` при `branch_code != ''` — `stores_store_merchant_branch_code_uniq`.

`address_key` считает `stores/normalize.py`:

- `normalize_address` — NFC, нижний регистр, всё кроме букв, цифр и комбинируемых знаков заменяется пробелом, пробелы схлопываются.
- `address_key(address_raw, address_i18n)` — если в `address_i18n` есть непустые варианты, берётся вариант с первым по алфавиту кодом языка, иначе `address_raw`; результат обрезается до 255 символов. Так двуязычный чек даёт один ключ, каким бы языком ни был заполнен `address_raw`.
- `Store.save()` заполняет ключ, **только если он пуст**. При правке адреса ключ не пересчитывается — он идентичность магазина. `bulk_create` и `QuerySet.update` метод `save()` не вызывают: там ключ передаёт вызывающий код, иначе в БД попадёт пустая строка.

Координат и геокодирования нет.

## `catalog`

**`Category`** — дерево смежным списком: `name` `CharField(100)`, `parent` FK на себя, null, `PROTECT`. Unique `(parent, name)`, `nulls_distinct=False` — `catalog_category_parent_name_uniq`. Циклы в дереве БД не запрещает.

**`GenericProduct`** — обобщённый продукт для сравнения («молоко»): `name` `CharField(100)`, `category` FK `Category` `PROTECT`, `base_unit` `CharField(8)`: `kg` / `l` / `pcs`. Unique по `Lower(name)` — `catalog_genericproduct_name_uniq`.

**`Brand`** — `name` `CharField(100)`, `manufacturer` `CharField(255)`, blank. Unique по `Lower(name)` — `catalog_brand_name_uniq`.

**`Product`** — конкретный товар производителя. Категория товара берётся только через `generic`.

| Поле | Тип | Примечание |
| --- | --- | --- |
| `generic` | FK `GenericProduct`, `PROTECT` | Обязателен |
| `brand` | FK `Brand`, null, `PROTECT` | |
| `name` | `CharField(255)` | Каноническое название |
| `model` | `CharField(64)`, blank | Артикул производителя |
| `gtin` | `CharField(14)`, blank | Штрихкод EAN/GTIN; формат и контрольный разряд не проверяются |
| `package_quantity` | `Decimal(12,3)`, null | Фасовка: `850`, `0.449` |
| `package_unit` | `CharField(8)`, choices `Unit`, blank | `ml`, `l`, `g` |
| `attributes` | JSON | `{"fat_percent": 2.5, "packaging": "пэт"}` |

- Unique `gtin` при `gtin != ''` — `catalog_product_gtin_uniq`.
- Unique `(brand, name, package_quantity, package_unit)`, `nulls_distinct=False` — `catalog_product_brand_name_package_uniq`. Сравнение `name` здесь чувствительно к регистру.
- Check: фасовка задана целиком или не задана — `catalog_product_package_both_or_none`; `package_quantity > 0` — `catalog_product_package_quantity_positive`.

**Единицы** (`catalog/units.py`): `Unit` — `pcs`, `g`, `kg`, `ml`, `l`, `m`; `BaseUnit` — `kg`, `l`, `pcs`. `to_base(quantity, unit)` возвращает `(Decimal, Unit)`: г → кг, мл → л, остальное без изменений (метр остаётся метром, хотя в `BaseUnit` его нет). `float` и `bool` отклоняются с `TypeError`, неизвестная единица — `ValueError`.

Значения `choices` (`kind`, `unit`, `base_unit`, `operation`, `tax_id_type`) проверяет только `full_clean()`; в БД check-ограничений на них нет, `save()` и `objects.create()` недопустимое значение пропустят.

## `receipts`

**`Receipt`**

| Поле | Тип | Примечание |
| --- | --- | --- |
| `store` | FK `stores.Store`, `PROTECT` | |
| `currency` | FK `stores.Currency`, `PROTECT` | |
| `operation` | `CharField(8)`: `sale` / `refund` | «ПРОДАЖА», «ПРИХОД» → `sale` |
| `purchased_at` | `DateTimeField` | Момент покупки, хранится в UTC |
| `purchased_on` | `DateField` | Локальная дата, как напечатана на чеке |
| `receipt_number` | `CharField(64)`, blank | Внутренний номер чека как напечатан: `5`, `475298/12` |
| `shift_number` | `CharField(16)`, blank | Смена |
| `register_code` | `CharField(64)`, blank | Номер кассы |
| `fiscal_key` | `CharField(160)`, blank | Канонический фискальный идентификатор |
| `fiscal` | JSON | Фискальные реквизиты, см. [JSON-поля](#json-поля) |
| `total` | `Decimal(14,2)` | Сумма к оплате; может быть отрицательной |
| `discount_total` | `Decimal(14,2)`, default 0 | Итоговая скидка как напечатана |
| `prices_include_tax` | `BooleanField`, default `True` | |
| `raw_text` | `TextField`, blank | Исходный текст чека |
| `extra` | JSON | Поле «прочее», см. [JSON-поля](#json-поля) |
| `created_at`, `updated_at` | `DateTimeField` | `auto_now_add` / `auto_now` |

- Три unique-ограничения — см. [дедупликацию](#дедупликация).
- Индекс `(store, purchased_at)` — `receipts_rcpt_store_at_idx`.
- Если время на чеке двойное (в шапке и в фискальном блоке), в `purchased_at` берётся время фискального блока. Это правило ввода, код его не применяет.
- `purchased_on`, `fiscal_key` и `discount_total` модель сама не вычисляет: их задаёт вызывающий код.

**`ReceiptLine`** — позиция чека. Скидка строкой не является.

| Поле | Тип | Примечание |
| --- | --- | --- |
| `receipt` | FK `Receipt`, `CASCADE` | |
| `position` | `PositiveSmallIntegerField` | Порядок на чеке, по соглашению с 1 |
| `kind` | `CharField(16)`: `product` / `service` / `deposit` / `deposit_return` | |
| `parent` | FK на себя, null, `CASCADE` | Только для `deposit`: товар, к которому относится залог |
| `raw_name` | `TextField` | Название как на чеке |
| `name_i18n` | JSON | `{"kk": "...", "ru": "..."}` |
| `store_item_code` | `CharField(64)`, blank | Код товара у магазина |
| `barcode` | `CharField(32)`, blank | Штрихкод с чека |
| `quantity` | `Decimal(12,3)` | `1.000`, `0.294`, `-4.000` |
| `unit` | `CharField(8)`, choices `Unit`, default `pcs` | |
| `unit_price` | `Decimal(14,4)` | Цена за единицу до скидки |
| `amount` | `Decimal(14,2)` | Сумма строки до скидки, со знаком |
| `discount_amount` | `Decimal(14,2)`, default 0 | Сумма скидок на строку |
| `tax_rate` | FK `stores.TaxRate`, null, `PROTECT` | |
| `tax_code` | `CharField(8)`, blank | Буква класса как на чеке |
| `tax_amount` | `Decimal(14,2)`, null | Налог по строке, если напечатан |
| `is_excise`, `is_marked` | `BooleanField`, default `False` | Подакцизный товар; маркировка |
| `product` | FK `catalog.Product`, null, `SET_NULL` | Пусто, пока товар не сопоставлен |
| `extra` | JSON | Прочие коды и пометки строки |

- Unique `(receipt, position)` — `receipts_receiptline_receipt_position_uniq`.
- Check: `unit_price >= 0`; `discount_amount >= 0`; `quantity != 0`; `quantity` и `amount` одного знака (записано как `(quantity >= 0 AND amount >= 0) OR (quantity <= 0 AND amount <= 0)`, нулевая сумма допустима); `kind = 'deposit_return'` ⇒ `amount <= 0`; `parent IS NULL OR kind = 'deposit'`.
- Индексы: `(product, receipt)` — `receipts_line_prod_rcpt_idx`; `store_item_code` — `receipts_line_item_code_idx`.
- БД не требует, чтобы у залога был `parent`, и не проверяет, что `parent` — строка того же чека.

**`ReceiptDiscount`** — скидка. Типа скидки нет, хранится название с чека.

| Поле | Тип | Примечание |
| --- | --- | --- |
| `receipt` | FK `Receipt`, `CASCADE` | |
| `line` | FK `ReceiptLine`, null, `CASCADE` | `NULL` — скидка на весь чек |
| `position` | `PositiveSmallIntegerField` | Порядок среди скидок чека |
| `name` | `CharField(255)` | «Preisvorteil», «Rabatt Snack» |
| `amount` | `Decimal(14,2)` | Положительное число |

- Unique `(receipt, position)`; check `amount > 0`.

**`ReceiptTax`** — итог по ставке на чек: `receipt` FK `CASCADE`, `tax_rate` FK `stores.TaxRate` `PROTECT`, `tax_code` `CharField(8)` blank, `net`, `tax`, `gross` — `Decimal(14,2)`.

- Unique `(receipt, tax_rate)`; check `gross = net + tax`. Если на чеке напечатаны не все три числа, недостающее считает вызывающий код. Значения могут быть отрицательными (возврат тары).

**`ProductAlias`** — сопоставление «название на чеке у продавца → товар»: `merchant` FK `stores.Merchant` `CASCADE`, `product` FK `catalog.Product` `CASCADE`, `name_key` `CharField(255)`, `store_item_code` `CharField(64)` blank, `raw_name` `TextField`.

- Unique `(merchant, name_key, store_item_code)`.
- `receipts.dedup.name_key(raw_name)` — NFC, нижний регистр, схлопнутые пробелы, до 255 символов. Пунктуация сохраняется: в названиях она значима («2,5%», «0.5л»).
- `receipts.dedup.find_alias(merchant, raw_name, store_item_code="")`: если код задан — ищет по `(merchant, store_item_code)` и среди найденных предпочитает точное совпадение `name_key`, иначе берёт первое по `pk`; без кода — по `(merchant, name_key)`, предпочитая сопоставление без кода.
- Сопоставление **не выполняется автоматически**: при сохранении строки `product` не заполняется, `find_alias` вызывает тот, кто создаёт строку.

## `recognition`: фотографии и очередь

Миграция `recognition.0001_initial` зависит от `receipts.0001_initial`. Старые модели и их миграции не менялись. PK четырёх моделей — BigAutoField; storage UUID не является HTTP ID. JSON provider-результатов валидируется схемами detect v1 / receipt v2, но прямой ORM может обойти эту проверку.

| Модель | Сохраняемые данные и связи |
| --- | --- |
| `SourcePhoto` | `storage_uuid` unique; `original_file`, nullable `upright_file`; unique lowercase SHA-256 исходных байтов; sniffed content_type/bytes; raw и upright width/height, EXIF orientation 1–8, preparation_version, created_at |
| `ProcessingJob` | photo PROTECT, retry_of SET_NULL; status/stage; detected/current_position и completed/imported/reused/review/failed/cancelled counters; version/run_token/claim_count; available/started/finished/deadline/heartbeat/lease/cancel timestamps; safe error_code |
| `ReceiptImage` | photo PROTECT, job CASCADE; position 1–10; file/hash/width/height; normalized bbox/quad/rotation/crop_transform/clipped; status/import_effect; Receipt SET_NULL; nullable normalized_result, issues list, outcome_snapshot, created_at |
| `RecognitionAttempt` | job CASCADE, nullable image CASCADE; phase detect/recognize, ordinal, run_token; provider/model/provider/CLI/prompt/schema versions; input_sha256; status, private raw_payload/invalid_output_text/error_code; started/finished |

Ограничения БД:

- Photo: bytes 1..20971520, оба размера положительны и площадь ≤40000000 (умножение bigint), JPEG/PNG/WebP; ориентация 1..8. SHA-256 и storage UUID unique.
- Job: не более одного active job/photo (`queued`, `running`, `cancel_requested`); допустимые status/stage; version ≥1; detected_count ≤10; current_position в диапазоне обнаруженного количества; каждый progress counter ≤detected_count (при NULL только 0). Сумма counters отдельно БД не проверяется, её ведёт queue service.
- Terminal Job требует finished_at и stage=finished; active — без finished_at. Только executing состояния имеют run_token/heartbeat/lease/started/deadline; queued/terminal не имеют token/heartbeat/lease. Cancel timestamp требуется только cancel_requested/cancelled.
- Image: unique `(job,position)`, position 1..10, положительные размеры ≤40 MP, допустимые status/import_effect, rotation −180..180. Принадлежность photo к job и геометрия проверяются `clean()`/storage, не FK-ограничением БД.
- Attempt: unique `(job,phase,image,ordinal)` с `nulls_distinct=False`; ordinal ≥1; detect без image, recognize с image; running без finished_at, завершённый с ним. Принадлежность image к job проверяет приложение.

Р3: bbox/quad заданы нормализованными координатами 0..1 полного фото после EXIF-transpose
(x вправо, y вниз). Quad — углы бумаги TL, TR, BR, BL относительно текста, по часовой
стрелке при любом повороте. Общий валидатор detect/crop требует строго выпуклый обход,
положительную площадь и охват всех углов bbox; пересечение, коллинеарность, повторные точки,
невыпуклость, обратный обход и выход за границы запрещены. Циклическое начало обхода
допускается и сохраняется: геометрия не устанавливает ориентацию текста и не сортирует
углы по x+y кадра. `rotation_degrees` — угол текста от вертикального положения чтения:
положительный по часовой стрелке, отрицательный против, −180..180 (270° записывается −90°;
оба представления 180° допустимы). Вырезка использует bbox + 1% размеров исходного фото
с каждой стороны, floor/ceil и ограничение границами. Quad остаётся в координатах исходного
фото; угол сохраняется у ReceiptImage и передаётся в recognize и его промпт. Вырезка
сохраняет наклон текста: выпрямления/перспективного преобразования нет. Модели, миграции и
формы HTTP не менялись; откат Р3 — revert кода, без преобразования данных.

Индексы: photo `(created_at,id)`; job `(status,available_at,id)` и `(status,lease_expires_at)`; image `(photo,id)` и `(receipt,id)`; attempt `(job,id)`, плюс FK/unique. Списки HTTP используют пагинацию и фиксированное число SQL, зафиксированное API-тестами. Импорт большого чека делает проверки/записи по строкам; throughput/N+1 на больших импортируемых графах не измерялся.

Job statuses: queued → running → succeeded / partial_succeeded / failed; running → cancel_requested → cancelled; queued → cancelled. Recovery истёкшего running lease возвращает queued с новым fence при остатке budget и claim_count <2, иначе failed; cancel_requested становится cancelled. HTTP retry разрешён из failed/partial_succeeded/cancelled, создаёт новый job на том же photo, прежние outcomes остаются. Единственный переход завершённого задания — partial_succeeded → succeeded после [подтверждения человеком](#подтверждение-вырезки-человеком) всех его вырезок.

Image statuses: pending/running → imported/reused/updated/needs_review/failed/cancelled. Import effect: none/created/linked/updated. Завершённый image outcome immutable для сервисов очереди; единственное исключение — [подтверждение человеком](#подтверждение-вырезки-человеком): needs_review → imported/reused/updated. `needs_review` сохраняет непригодное нормализованное наблюдение и причины без нового Receipt. Начиная с И4, успешный импорт тоже может иметь неблокирующие issues: неоднозначный товар оставляет product=NULL, но читаемый чек сохраняется как imported/reused/updated. API отдаёт safe projection normalized_result только для needs_review, без raw_text, fiscal, tax_id, provider notes или stderr; сырой payload attempt всегда приватен.

Повтор исходного файла определяется по SHA-256: API возвращает тот же Photo и последний Job, без новой обработки. Другие байты дают новый Photo. Import сначала ищет фискальный ключ, затем магазин/локальную дату/номер с кассой и сменой, затем точный store/purchased_at/total. Сильные ключи используют только status=observed; неоднозначные/неподтверждённые номера и фискальные поля считаются отсутствующими. Неполная тройка номер/касса/смена не участвует в unique номера: receipt_number остаётся пустым, исходное значение сохраняется в normalized_result. Без сильного ключа точное совпадение store/time/total связывает тот же чек, иначе создаёт новый. Конфликт двух уверенно прочитанных сильных ключей требует review. Найденный Receipt дополняется только пустыми реквизитами и product у ранее несопоставленных совместимых строк. Набор позиций, имена, суммы, количество и зависимости должны совпадать для дополнения; несовместимые части дают неблокирующие замечания без перезаписи сохранённых значений. При конфликте частичных fiscal новые fiscal-поля тоже не дополняются, чтобы не составить ключ из разных наблюдений. Заполненные поля Merchant/Store/Product не перезаписываются; исключения для дополнения пустой идентичности магазина описаны ниже. Новые товары получают служебные Category/GenericProduct, точные aliases/GTIN/name+package/brand переиспользуются без fuzzy matching.

Р2: отсутствие либо первое уверенное чтение ИНН не меняет известный Store. Помимо точного tax_id, разрешение учитывает известные точки с теми же страной регистрации продавца, страной точки, нормализованным точным названием продавца и совместимым названием магазина (два непустых названия должны совпасть), а также address_key либо кодом филиала. Один совместимый кандидат переиспользуется: пустой Merchant.tax_id дополняется, tax_id_type — только если тоже пуст; заполненный ИНН сохраняется при его отсутствии на другом фото. Пустой Store.branch_code дополняется при известной точке, чтобы следующее фото могло разрешить её только по коду. Записи дополнения блокируются и повторно читаются внутри транзакции импорта; отказ доменного импорта откатывает и дополнения. Разные непустые ИНН не объединяются: сохраняются отдельные Merchant/Store и внутреннее merchant_conflict в issues. Несколько совместимых Merchant/Store, ИНН уже у другого Merchant либо конфликт адреса и филиала дают store_ambiguous/needs_review без выбора по PK. Разные непустые коды филиала у одной найденной точки дают store_conflict/needs_review. Без известного совместимого совпадения действует прежнее создание/отказ, fuzzy matching отсутствует. Уже созданные дубликаты автоматически не объединяются.

Полнота отдельного postal_code не участвует в идентичности; заполненный индекс и исходное написание адреса сохраняются. Регистр, пунктуация и пробелы адреса в пределах прежнего address_key не создают новую точку; отсутствие кода филиала при том же ключе адреса тоже безопасно. Если изменился сам address_key и нет известного кода филиала, установить тождество нельзя: сохраняется прежнее поведение без угадывания адреса. При разрешённом Store повторное фото без сильного ключа связывается с прежним Receipt по store/time/total; существующие строки, товары, скидки и налоги не создаются заново. [Регрессии и приёмка Р2](verification.md#р2-полнота-инн-и-идентичность-магазина).

Страна берётся из observation store/merchant либо RUB→RU, KZT→KZ, EUR→DE. Валюта должна существовать. Если она не прочитана, но разрешён существующий Store, допускается RU→RUB, KZ→KZT, DE→EUR; напечатанная валюта имеет приоритет. Для новой/неразрешимой точки или страны вне этого перечня валюта не угадывается. Вывод отмечается currency_inferred и `/currency_code` в derived нового Receipt. Новый Store получает Europe/Moscow, Asia/Almaty или Europe/Berlin для этих стран (UTC для остальных); существующий timezone сохраняется. Без printed offset неоднозначный/несуществующий DST момент требует review. Такой default для всей RU не определяет фактический регион магазина: перед реальными фото оператор проверяет timezone.

И4: operation=null → sale при отсутствии явного возврата; напечатанный заголовок возврата или отрицательные количества товарных строк → refund. Возврат тары/сдача сами по себе не меняют sale. Вывод фиксируется в issues и Receipt.extra.recognition.derived, исходный DTO не переписывается. Неопределённый prices_include_tax использует default модели True с замечанием. Нечитаемые/неоднозначные необязательные реквизиты, коды, товарные подсказки и налоговые детали отбрасываются. Неполные или несогласованные итоги налогов не создают ReceiptTax; новую ставку создают только при observed kind/rate. Суммы скидок выводятся арифметически; количество, цена и единица обрабатываются по правилам И4 и Ф2+Ф3 ниже. Разница итога и суммы строк больше 0.01 блокирует импорт; округление до 0.01 даёт замечание. По Ф4 несогласованность quantity×unit_price и amount больше 0.01 тоже блокирует импорт (needs_review), даже при сходящемся общем итоге. Для prices_include_tax=False сверка включает прочитанный налог: потеря необходимого налога может вызвать блокирующее расхождение общей суммы.

Согласованное уточнение И4 сохраняет обязательные инварианты Receipt/ReceiptLine. Перед needs_review отсутствующее количество, цену или сумму строки можно вывести из двух других пригодных чисел: по уточнению Ф4 непустой операнд пригоден при status=observed либо отсутствии записи evidence для его пути. Явные ambiguous/unreadable блокируют и использование операнда, и восстановление отмеченного неизвестного числа; absent при непустом значении — противоречие. Отсутствующее значение с absent либо без evidence допускает вывод. Количество и цена должны точно укладываться в 3/4 знака модели; округление этих выводов и деление на ноль запрещены. Сумма строки округляется до 2 знаков ROUND_HALF_UP, включая знак возврата, и затем сверяется с итогом. Напечатанные значения не заменяются. Для целого пригодного либо арифметически выведенного количества и отсутствующей единицы применяется pcs, если нет признаков цены за вес/объём в названии самой строки; EUR/kg другого товара в общем raw_text этому не мешает. unreadable/ambiguous единица остаётся неразрешимой. Все выведенные pointers фиксируются в Receipt.extra.recognition.derived, исходный DTO сохраняется неизменным. Если обязательные данные после этих правил не восстановлены (магазин, дата/точное время, валюта, пригодные строки), результат остаётся needs_review. Модели и миграции receipts не меняются. Подробная таблица причин и фактическая проверка — [И4](verification.md#фактические-результаты-и4).

Ф2+Ф3: recognize observation v2 принимает печатные LF/CR/tab в адресе, названиях продавца/магазина/строк/скидок, товарных name/brand и компонентах адреса region/city/street/house. До проверки адрес склеивается через `, `, остальные перечисленные поля — через пробел; соседние пробелы и CRLF схлопываются. Другие управляющие символы и переносы в идентификаторах по-прежнему отклоняются. address_key использует прежнюю нормализацию букв/цифр/пробелов: многострочный адрес, вариант с запятой и однострочный вариант с пробелом разрешают тот же Store; правила Р2 не расширены. `Z`/`z` в utc_offset_printed и обоих timestamps.*.utc_offset канонизируются в `+00:00`; прочие форматы и смещения вне ±14:00 запрещены. Часы не сдвигаются: fiscal 17:01:56Z даёт purchased_at 17:01:56 UTC, независимо от локального header 18:59 в Europe/Berlin. Приоритет fiscal, правила DST и проверки локальной даты сохраняются. Промпт recognize версии 4 запрашивает канонический формат, сервер принимает прежние ответы. Канонизация не меняет переданный dict; сохранённый normalized_result содержит канонический DTO, raw_text сохраняет печатные переносы.

По принятому решению «без количества — один» строка product/deposit с пригодной неотрицательной amount (observed либо без записи evidence) и отсутствующими quantity и unit_price получает quantity=1.000, unit=pcs, unit_price=amount (4 знака). Для deposit_return с отрицательной amount — quantity=−1.000 и unit_price=abs(amount). Это умолчание применяется при absent либо отсутствии evidence для quantity/unit_price, если unit отсутствует либо уже pcs и в названии самой строки нет весовой/объёмной цены; kg/дробные количества, service, отрицательные product/deposit, нечитаемые/неоднозначные обязательные поля не угадываются. Без суммы и обоих операндов строка остаётся needs_review. Противоречивые напечатанные числа сохраняются в normalized_result и остаются needs_review; умолчание их не заменяет. Все новые выводы отмечаются в Receipt.extra.recognition.derived; quantity/unit/unit_price исходного DTO остаются null. Сумма строки остаётся до скидки, Preisvorteil/Rabatt — отдельные ReceiptDiscount; итог сверяется после вычитания скидок. Повтор совместимого наблюдения связывает прежний Receipt без новых строк/товаров/скидок/налогов. Старые terminal needs_review не перерабатываются автоматически: нужен штатный retry. Откат Ф2+Ф3 — revert кода/промпта/тестов/docs без миграций; созданные Receipt и канонизированные наблюдения остаются, старые отказы формата и отсутствующих значений возвращаются для новых обработок. Автоматического удаления/пересчёта уже импортированных данных нет.

Ф4: отсутствие числовых evidence-записей по строкам в реальном ответе модели не требует needs_review. Одно правило пригодности используется для amount-only умолчания, вывода pcs (в том числе 2 × 1.29 и −5 × 0.25) и арифметического вывода третьего числа. Ни prepare_observation, ни observation_issues не требуют observed для этих чисел; _preflight сохраняет явную неопределённость и конфликт количества/цены/суммы как блокирующие причины. Противоречие absent/unreadable с непустым числом/единицей отвергает валидатор схемы, а прямой DTO дополнительно проверяет _preflight. Политика сильных ключей и подтверждения налоговых ставок остаётся отдельной: требование observed для них сохраняется; неподтверждённые налоговые детали опускаются с optional_omitted, исходные A 7% / B 19% остаются в normalized_result и сами по себе не мешают импорту при prices_include_tax=True. JSON-форма, доступ, модели и миграции не меняются. Изменение исходов: sparse evidence теперь допускает импорт; явные ambiguous/unreadable неизвестных чисел не восстанавливаются арифметически, расхождение quantity×unit_price с amount больше 0.01 возвращает needs_review. Старые сохранённые исходы не пересчитываются: нужен штатный retry. Откат Ф4 — revert кода/тестов/docs без миграций; созданные Receipt и исходные DTO сохраняются, автоматического удаления или пересчёта нет.

Очередь/импорт: `queue.fenced_job` проверяет token/version/неистёкший lease/status под row lock. OCR проходит вне транзакции. Отдельная неблокирующая transaction advisory-блокировка сериализует OCR imports; один durable commit сохраняет domain graph и image outcome, последний crop — также terminal job. Блокирующая доменная ошибка откатывает новые магазины/товары/чек, сохраняя observation/issues вне savepoint. Неблокирующие issues не увеличивают Job.review_count и не превращают succeeded в partial_succeeded. Сам clipped не запрещает импорт читаемого результата; неправильная/перекрывающаяся геометрия по-прежнему не запускает смешанный OCR. Cancel, принятый до import, запрещает его; уже закоммиченные чеки отмена не удаляет. Старые ORM/admin/SQL writers не участвуют в OCR mutex, stale admin form не защищена от OCR-дополнений (упрощение v1). Старые terminal outcomes неизменны для воркера и очереди: для прежнего needs_review/partial_succeeded используется штатный retry либо [подтверждение человеком](#подтверждение-вырезки-человеком). Откат И4 — revert кода/тестов/docs, без миграций; уже импортированные данные и исходные DTO остаются, автоматического удаления нет.

MEDIA: original сохраняется без изменений; upright preview/crops — PNG без EXIF; пути UUID, staging вне MEDIA и atomic rename. Deletion ORM не удаляет файлы. Удаление Receipt оставляет images с receipt=NULL и историческим ID в outcome_snapshot (`receipt_deleted=true` в API); удаление Job каскадирует images/attempts, но сохраняет Receipt и файлы. Photo защищён, пока есть jobs/images. Ни cleanup-команды, ни retention-политики нет; crash между записью файла и DB commit может оставить orphan.

### Подтверждение вырезки человеком

Сервис `recognition/review.py` (`POST …/receipt-images/{id}/confirm/`, [контракт](api-contract.md#подтверждение-вырезки-needs_review-человеком)) — единственное исключение из двух правил выше: завершённый outcome вырезки `needs_review` меняется, а счётчики завершённого задания пересчитываются. Новых таблиц, колонок, статусов и миграций нет.

Что записывается при успехе, одной транзакцией:

| Где | Что |
| --- | --- |
| `ReceiptImage.status` / `receipt` / `import_effect` | `imported` / `reused` / `updated`, чек, `created` / `linked` / `updated` — те же значения, что у автоматического импорта |
| `ReceiptImage.issues` | только замечания подтверждения; их индексы относятся к массивам запроса |
| `ReceiptImage.outcome_snapshot` | `{"receipt_id": N, "confirmed": {"at": "…Z", "request_sha256": "…", "previous_issues": […], "result": {…}}}`: момент (UTC), SHA-256 нормализованного тела запроса, прежние причины проверки и исправленный DTO наблюдения целиком. Приватно: наружу идёт только `confirmed_at` |
| `ReceiptImage.normalized_result` | **не меняется** — остаётся исходным DTO провайдера |
| `Receipt.extra.recognition.confirmed` | `{"image_id": N, "at": "…Z"}` рядом с `derived` — только у чека, **созданного** подтверждением; существующий чек при привязке не меняется. Наружу не отдаётся |
| `ProcessingJob` | счётчики из `queue.refresh_progress`, `version + 1`; `partial_succeeded → succeeded`, если успешны все вырезки. `finished_at`, `error_code`, `stage` прежние; `failed` / `cancelled` статус сохраняют |

Исправленный DTO собирается так: основа — сохранённый `normalized_result`, если он проходит `validate_observation`, иначе пустой каркас без закрытых реквизитов; поверх — значения запроса. Закрытые реквизиты (номер чека, смена, касса, fiscal, ИНН и его тип, юридическое название, код филиала, `raw_text`) и их evidence переносятся как были; непоказанные свойства строки (код товара магазина, штрихкод, налог строки, акциз, маркировка, подсказка товара) наследуются по `source_position`. Evidence полей формы пересоздаются: непустое — `observed`, пустое — `absent`; поэтому подтверждённые человеком ставки и налоговые итоги проходят политику И6 без evidence провайдера. При смене вывески сбрасывается распознанное юридическое название, адреса — индекс/регион/город/улица/дом, страны — страна продавца, названия строки — подсказка названия товара. `timestamps` пересобираются из даты и времени запроса, `discount_total` и `discount_amount` выводятся из скидок. Если записей evidence оказалось бы больше 10000 (предел схемы; чек около 900 строк и больше), остаются только влияющие на импорт: сомнения провайдера, идентичность шапки и ставки налога. Дальше идут обычные `prepare_observation`, выводы значений и `importer._import_domain` — тот же код, что у OCR; выбранный человеком `store_id` заменяет `resolve_store` и `resolve_country` (`resolution.py` не меняется), пустые ИНН и код филиала такого магазина не дополняются.

Транзакция и блокировки: `pg_try_advisory_xact_lock(IMPORT_LOCK)` без ожидания → `SELECT … FOR UPDATE` задания, затем вырезки (порядок `fenced_job` / `save_image_result`, взаимных блокировок с воркером нет) → проверки состояния → импорт в savepoint → при `PRODUCT_MERGE_AUTO_DETECT=1` тот же поиск дублей в своём savepoint → запись вырезки и задания. Занятый мьютекс, ожидание блокировки дольше `statement_timeout` (SQLSTATE `55P03` / `57014` / `40P01`) и гонка unique-ограничений чека с внешней записью дают отказ `review_busy` с полным откатом и без повторной попытки — в отличие от воркера, который при гонке unique один раз перечитывает чек. Блокирующая причина импорта откатывает всю транзакцию, включая новые магазин, продавца, товары и написания (`review_invalid`). Подтверждение допустимо только при завершённом задании: воркер решает итог задания по вырезкам и сверяет его в `finish_job`.

Повтор определяется по `request_sha256`, отдельной таблицы запросов нет. Откат функции — revert кода, тестов и документов: созданные подтверждением чеки и ключ `confirmed` в JSON остаются, такие вырезки выглядят как обычные `imported` / `reused` / `updated`; автоматического возврата в `needs_review` нет, миграций для отката не требуется. Удаление подтверждённого чека в админке оставляет вырезку с `receipt = NULL` и историческим ID; повторное подтверждение ей недоступно. Устаревшая админская форма, сохранённая после подтверждения, по-прежнему не защищена (ограничение v1, как и для OCR-импорта); гарантии F4/F6 админки не затронуты.

### Откат recognition

Сначала остановить свой OCR-worker и запретить uploads; сделать `pg_dump` и отдельную копию всего MEDIA. В изолированной QA, после полного environment из verification.md:

```powershell
./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py migrate recognition zero --noinput
./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py migrate recognition --noinput
```

Первый шаг удаляет четыре recognition-таблицы и всю историю фото/jobs/images/attempts; Receipt/lines/catalog/stores и MEDIA остаются. Повторное применение создаёт пустые recognition-таблицы, связи и очередь не восстанавливаются автоматически. Восстановление требует согласованного DB dump + MEDIA backup и совместимой версии кода. Проверка с представительными товарами/строками есть в `RecognitionMigrationTests`, полный прогон С6 её выполняет; восстановление dump/MEDIA человеком не испытано. Полный откат предметной модели ниже теперь также снимает зависимую recognition-миграцию: заранее остановить uploads/worker и сохранить MEDIA.

## `merges`: слияние дублей товаров

Приложение `backend/merges/` (миграция `merges.0001_initial`, зависит от `catalog.0001_initial` и `receipts.0001_initial`; существующие таблицы не меняются). Отдельное приложение сохраняет правило «`catalog` не зависит от `receipts`». HTTP — [api-contract.md](api-contract.md#реализовано-локальный-api-слияния-дублей-товаров-с2), памятка сервиса — `backend/merges/README.md`.

| Модель | Поля | Ограничения |
| --- | --- | --- |
| `ProductMerge` | `status` (`pending` / `confirmed` / `cancelled`), `version` (с 1, растёт при изменении состава), `target_ref` — id оставляемого товара без FK, `detector_version`, `created_at`, `resolved_at` | check: `pending` ⇔ `resolved_at IS NULL`; индекс `(status, id)` |
| `ProductMergeMember` | `group` CASCADE; `product_ref` — id товара, хранится всегда; `active_product` OneToOne → `catalog.Product`, null, **PROTECT** — заполнено, только пока группа ожидает и запись в ней; `role` (`target` / `source`); `state` (`active` / `excluded`); `name`, `facts` — снимок названия и фактов | unique `(group, product_ref)`; unique `active_product`; unique `group` при `role='target' AND state='active'` |
| `ProductMergeLine` | `member` CASCADE, `line` → `ReceiptLine` CASCADE | unique `(member, line)` |
| `ProductMergeAlias` | `member` CASCADE, `alias` → `ProductAlias` CASCADE | unique `(member, alias)` |
| `ProductMergeRejection` | `product_low`, `product_high` → `Product` CASCADE, `group` SET_NULL, `created_at` | unique `(product_low, product_high)`; check `low < high` |

Состояния: `pending → confirmed` (подтверждение), `pending → cancelled` (отмена либо исключение, после которого осталось меньше двух записей), `pending → pending` (добавлена или исключена запись, `version + 1`). `confirmed` и `cancelled` конечны; отмены подтверждённого слияния нет.

- **Поиск** (`merges/detection.py`, версия детектора 1): пара — кандидат, если у товаров есть написание одного продавца, равны числовые подписи названий, расстояние Левенштейна между «сжатыми» названиями (NFKD, casefold, только буквы и цифры) не больше допуска (длина короткого ≥ 12 → 2; 6–11 → 1; < 6 → 0), нет противоречия GTIN / бренда / фасовки / модели и пара не отклонена. Товар без написаний кандидатом не бывает. Гарантии тождества нет — поэтому слияние предварительное.
- **Предварительное слияние** — одна транзакция: блокировка товаров по возрастанию id, запись в журнал строк и написаний каждой записи (включая оставляемую), затем `UPDATE product_id` строк и написаний поглощаемых товаров на оставляемый. У строки чека меняется только `product_id`. Тот же шаг подбирает «отбившиеся» ссылки, указавшие на поглощённый товар позже.
- **Видимость**: поглощённый товар — запись с `role='source'` и непустым `active_product`. `merges.visibility.visible(queryset)` / `visible_q(prefix)` убирают его из 13 GET каталога и цен одним `NOT EXISTS`, без нового запроса.
- **Отмена** возвращает журнальные ссылки, которые всё ещё указывают на оставляемый товар (правку человека в админке не перезаписывает); нежурнальную строку оставляемого отдаёт записи — единственному владельцу написания с тем же продавцом и ключом названия (и кодом, если он есть у строки); удаляет журнал группы и пишет все пары в `ProductMergeRejection`.
- **Подтверждение** переносит ссылки на выбранную оставляемую запись, проверяет, что на поглощённые товары ссылок не осталось, удаляет их, дополняет пустые факты оставляемого товара и сохраняет снимки записей. Журнал остаётся для ручного восстановления вместе с `pg_dump`.
- **Блокировки**: каждая изменяющая операция первой берёт ту же неблокирующую advisory-блокировку, что импорт чека (`recognition.importer.IMPORT_LOCK`); занятая блокировка либо ожидание строк дольше `statement_timeout` — `MergeBusy` с полным откатом.
- **Импорт**: написание уже перенесено на оставляемый товар, поэтому новая строка с известным написанием привязывается к нему сразу; новое написание при `PRODUCT_MERGE_AUTO_DETECT=1` попадает в группу шагом после импорта, иначе — следующим `detect`. `recognition/resolution.py` не менялся: resolver по-прежнему точный.
- **Админка**: новые модели — только чтение. Товар ожидающей группы удалить нельзя (`PROTECT`). F4/F6 не затронуты. Форма чека, открытая до операции слияния и сохранённая после, вернёт строке старый товар — защиты устаревших форм в v1 нет; до подтверждения это подберёт следующая операция.

### Откат merges

```powershell
./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py product_merges cancel-pending
./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py migrate merges zero --noinput
```

`migrate merges zero` удаляет журнал. Без первой команды ожидающие группы останутся слитыми без возможности восстановления. Подтверждённые слияния откатом не разъединяются — только восстановлением из `pg_dump`. HTTP-слой, видимость в 13 GET и шаг после импорта откатываются revert кода; до него выполните `cancel-pending`, иначе поглощённые товары снова появятся в каталоге без своих строк.

## `classification`: предположение обобщённого продукта

Приложение `backend/classification/` (миграция `classification.0001_initial`, зависит от `catalog.0001_initial` и `receipts.0001_initial`; существующие таблицы `catalog`, `receipts`, `recognition`, `merges` не меняются). От `merges.0001_initial` миграция намеренно **не** зависит: внешних ключей на `merges` нет, а с такой зависимостью `migrate merges zero` молча удалял бы и таблицы предположений вместе с ожидающими записями. HTTP — [api-contract.md](api-contract.md#реализовано-локальный-api-предположений-категорий-товаров), памятка сервиса с подписями функций — `backend/classification/README.md`.

Товар, созданный распознаванием, лежит в служебном обобщённом продукте «Не разобрано». Модель предполагает обобщённый продукт (существующий либо новый, с путём категории), и предположение применяется **сразу**: `Product.generic` меняется, запись помнит прежнее и предложенное значение и ждёт человека. Собственного поля категории у товара нет: категория — это категория его обобщённого продукта.

Внешние ключи на каталог — `SET_NULL` либо `CASCADE`, без `PROTECT`: правке и удалению каталога они не мешают. Рядом с каждым таким ключом хранится числовой `*_ref` и снимок названия, чтобы запись читалась после удаления объекта.

| Модель | Поля | Ограничения |
| --- | --- | --- |
| `ProductClassification` | `status` (`pending` / `confirmed` / `rejected` / `superseded`), `resolution` (`confirmed`, `other`, `rejected`, `cancelled`, `changed`, `merged`, `product_removed`; пусто, пока `pending`), `version` (с 1, растёт при каждом изменении сервисом); `product_ref` — id товара, хранится всегда; `active_product` OneToOne → `catalog.Product`, null, **SET_NULL** — заполнено, только пока запись ожидает; `origin_product_ref` — товар, от которого запись перешла к оставляемому товару слияния; снимки `product_name`, `product_facts` (`brand`, `package`); `previous_generic_ref` / `_name` / `_base_unit` — значение товара записи до предположения (у перешедшей записи — оставляемого товара до слияния); `suggested_generic` FK SET_NULL и `suggested_generic_ref` / `_name`, `suggested_base_unit`, `suggested_category_path` (`[{"id", "name"}]` от корня); `final_generic_ref` / `_name`, `final_base_unit`; `run` FK SET_NULL; источник: `provider`, `model`, `prompt_version`, `schema_version`, `classifier_version`; `confidence` (закрытое); `created_at`, `resolved_at` | check: `pending` ⇔ `resolved_at IS NULL` и пустое `resolution`; check: `active_product` заполнен только у `pending`; unique `active_product` — одна ожидающая запись на товар; индексы `(status, suggested_generic_name, suggested_generic_ref, id)`, `(product_ref, id)`, `(suggested_generic_ref, status)` |
| `CreatedGenericProduct` | Журнал «обобщённый продукт создан механизмом»: `generic` OneToOne SET_NULL, `generic_ref`, `name`, `base_unit`, `category_ref`, `state` (`provisional` — «новая», `kept` — принята, `removed` — удалена уборкой), `run`, `created_at`, `resolved_at` | check: `provisional` ⇔ `resolved_at IS NULL` |
| `CreatedCategory` | То же для категории: `category` OneToOne SET_NULL, `category_ref`, `name`, `parent_ref`, `state`, `run` | тот же check |
| `ClassificationRejection` | Память отказов: `product` CASCADE, `generic_key` (ключ названия `classification.taxonomy.name_key`), `generic_name`, `classification` SET_NULL | unique `(product, generic_key)` |
| `ClassificationRun` | Запуск «предположить для этих товаров»: `status` (`queued` / `running` / `succeeded` / `failed` / `cancelled`), `trigger` (`manual` / `import` / `command`), `scope` (`all` / `products`), `product_ids` (не больше `PRODUCT_CLASSIFICATION_RUN_LIMIT`), `cursor`, счётчики `requested_count` / `applied_count` / `unknown_count` / `skipped_count`, `remaining_count`, `stats` (закрытое: причина → число), `version`, `run_token`, `heartbeat_at`, `lease_expires_at`, `recoveries`, `error_code`, источник, `created_at`, `started_at`, `finished_at` | не больше одного `queued` и одного `running` (два условных unique); check: `run_token`, `heartbeat_at`, `lease_expires_at` заполнены только у `running`; check: `finished_at` — только у конечного статуса; индекс `(status, id)` |
| `ClassificationAttempt` | Закрытая попытка пакета: `run` CASCADE, `batch`, `ordinal`, `status`, `input_sha256`, `product_ids`, `raw_payload`, `invalid_output_text` (до 65536), `error_code`, `started_at`, `finished_at` | unique `(run, batch, ordinal)` |

Состояния записи: `pending → confirmed` (подтверждение либо выбор другого), `pending → rejected` (отклонение человеком либо `cancel-pending`), `pending → superseded` (сверка), `pending → pending` (сверка обновила снимок либо шаг слияния передал запись оставляемому товару, `version + 1`). Остальные конечны.

- **Отбор кандидатов** (`services.candidates`): обобщённый продукт товара — служебный «Не разобрано»; нет ожидающей записи; товар не поглощён ожидающим слиянием; это не услуга и не залог (строк чека нет либо есть хотя бы одна строка вида `product`). Автозапуск после импорта берёт только товары без единой записи в любом статусе: отклонённое и заменённое повторно предлагается только явным запуском.
- **Применение** (`services.apply`, вызывает только исполнитель запуска): под блокировкой каждый товар проверяется заново. Предложение существующего обобщённого продукта переводит товар в него; предложение нового создаёт недостающие категории пути (не глубже трёх уровней) и обобщённый продукт, записывая их в журнал как `provisional`. Совпадение названия определяется ключом: NFKC, `casefold`, `ё` → `е`, все тире → `-`, пробелы; существующая запись каталога побеждает, её название, категория и единица не меняются. У товара меняется только `generic`.
- **Правила, которые не нарушаются:** автоматика меняет обобщённый продукт товара, только если сейчас это «Не разобрано»; значение, выставленное человеком, не перезаписывается — запись закрывается как `superseded` / `changed`; отклонение и `cancel-pending` возвращают товар в прежний обобщённый продукт, только если предложенное значение выставил ему сам механизм — значение, которое было у товара до предположения, они не трогают; сам «Не разобрано», его категория и категории существующих обобщённых продуктов не меняются.
- **Подтверждение** товар не меняет; журнал предложенного обобщённого продукта и его созданных предков переходит в `kept`. **Выбор другого** переводит товар в выбранный существующий обобщённый продукт (не служебный) и пишет предложенный вариант в память отказов. **Отклонение** возвращает товар в прежний обобщённый продукт (если его уже нет — «Не разобрано» создаётся заново так же, как в `recognition/resolution.py`) и пишет память отказов: тот же вариант этому товару больше не предлагается.
- **Уборка** после выбора другого, отклонения и сверки: созданный механизмом обобщённый продукт, на который не ссылается ни один товар и ни одна ожидающая запись, удаляется (`removed`), затем так же опустевшие созданные категории вверх по пути. Созданное, которым пользуется товар без ожидающей записи на нём, становится обычным (`kept`). Записи каталога, не созданные механизмом, уборка не трогает.
- **Сверка** выполняется внутри каждой операции над записью: товара нет — запись закрывается (`merged`, если по журналу слияний найден оставляемый товар, иначе `product_removed`), к оставляемому товару сверка запись не переносит; обобщённый продукт товара сменили — `changed`; товар есть и несёт предложенное значение, но слитый с ним после создания записи дубль имел это значение сам (от человека либо подтверждённое) — `merged`, товар не трогается; живые название, единица или путь отличаются от снимка — снимок обновляется. Исход сверки сохраняется, и только потом операция отвечает отказом. Чтение ничего не пишет.
- **Слияние дублей**: `merges.services.confirm` после подтверждения группы вызывает `classification.services.after_merge_confirmed(target_id, absorbed_ids, target_generic_before)` в savepoint; `target_generic_before` — обобщённый продукт оставляемого товара до дополнения фактов (в журнале слияния его нет: снимок оставляемой записи пишется после дополнения). Ожидающая запись переходит к оставляемому товару, только если его значение получено из этого предположения: до слияния у оставляемого было служебное «Не разобрано», после слияния — предложенный обобщённый продукт, ни один поглощённый товар не имел этого значения сам (выставленного человеком либо подтверждённого) и у оставляемого нет своей ожидающей записи. Тогда меняются `product_ref`, `active_product`, снимок товара, `origin_product_ref`, `previous_generic_*` (прежнее значение оставляемого) и `version`. Иначе — у оставляемого своё содержательное значение до слияния (равное предложенному или нет), значение выбрано человеком при решении конфликта либо пришло от другого поглощённого товара — запись закрывается как `superseded` / `merged` с `final_*` = значение оставляемого, товар не трогается, пометки на нём нет. Это отступление от таблицы К1 §5.1, которая переносила запись при одном лишь равенстве значений: отклонение и `cancel-pending` уводили такой товар в «Не разобрано». Сбой шага пишет в журнал только класс ошибки и слияние не отменяет; первая же сверка такую запись **закрывает** и никогда не переносит — известное ограничение: оставляемый товар сохраняет полученное из слияния предположение без пометки. **Своя ожидающая запись оставляемого товара** после слияния проходит сверку: человек решил конфликт в пользу другого значения — `superseded` / `changed`; хотя бы один поглощённый товар имел предложенное значение сам (выставлено в админке, подтверждено либо выбрано человеком; не его собственное ожидающее предположение) — `superseded` / `merged` с `final_*` = это значение, товар не трогается, журнал созданного обобщённого продукта переходит в `kept`, память отказов не пишется: без предположения слияние дало бы оставляемому то же значение, и ни отклонение, ни `cancel-pending`, ни откат миграции его больше не снимают. Поглощённый в «Не разобрано» либо с тем же значением из своего ожидающего предположения запись не закрывает. Это второе отступление от К1 §5.1 (там своя запись закрывалась только при смене значения); правило выполняет сверка по журналу слияний (`ProductMergeMember.facts` поглощённых записей), поэтому от сбоя шага оно не зависит. Память отказов поглощённого товара удаляется вместе с ним. Подробно — [README приложения](../backend/classification/README.md#слияние-дублей-когда-запись-переходит-к-оставляемому-товару).
- **Блокировки**: каждая изменяющая операция — одна транзакция; первой берётся та же неблокирующая advisory-блокировка, что у импорта чека и слияния (`recognition.importer.IMPORT_LOCK`), затем, только при создании или удалении категории, неблокирующая блокировка дерева категорий админки (`catalog.admin.CATEGORY_TREE_LOCK`), затем строки по возрастанию id. Занятая блокировка либо ожидание строк дольше `statement_timeout` — `ClassificationBusy` с полным откатом, без скрытого повтора.
- **Старые 13 GET** не менялись: неподтверждённый товар сразу виден в предложенном обобщённом продукте и его категории, участвует в сравнении цен; что меняется в составе — [api-contract.md](api-contract.md#что-предположения-меняют-в-13-get-каталога-и-цен).
- **Очередь и воркер**: запуск из очереди исполняет `recognition_worker` по одному пакету между заданиями распознавания; переходы, lease, восстановление и автозапуск из импорта — [ниже](#очередь-запусков-classification). Команда `product_classifications suggest` исполняет свой запуск сама, минуя очередь.
- **Админка**: `ProductClassification`, `ClassificationRun`, `CreatedGenericProduct`, `CreatedCategory` — только чтение (добавление, правка и удаление запрещены, `run_token` скрыт). `ClassificationRejection` намеренно не зарегистрирована: она каскадно удаляется вместе с товаром, и регистрация «только чтение» запретила бы удалять такой товар. `ClassificationAttempt` не зарегистрирована: в ней закрытый ответ модели. Товар с ожидающей записью удалить в админке можно (`SET_NULL`); F4/F6 не затронуты. Правка обобщённого продукта товара в админке, пока запись ожидает, — законное решение человека: запись закроется как `changed` при следующей сверке. Защиты устаревших форм админки по-прежнему нет.

### Очередь запусков classification

Очередь — сами строки `ClassificationRun`; отдельной таблицы, миграции и Celery-задачи нет. Код: `classification/queue.py` (переходы), `classification/worker.py` (один пакет), `recognition/management/commands/recognition_worker.py` (цикл). Памятка шага — `backend/classification/QUEUE.md`, что видит клиент — [api-contract.md](api-contract.md#предположения-очередь-и-воркер).

Запуск `running` означает ровно «сейчас выполняется пакет»: после пакета он возвращается в `queued` (товары остались) либо получает конечный статус. `cursor` — сколько товаров `product_ids` прошло через пакеты.

| Переход | Когда | Функция |
| --- | --- | --- |
| `queued → running` | воркер взял запуск на один пакет: заполнены `run_token`, `heartbeat_at`, `lease_expires_at`; `started_at` — при первом захвате. Пока есть другой `running`, ничего не берётся | `queue.claim_run` |
| `running → queued` | пакет завершён, товары остались | `queue.finish_batch` |
| `running → queued` | остановка воркера во время пакета (`Ctrl+C`, потеря слота); `recoveries` не растёт | `queue.release_run` |
| `running → queued` | lease истекла, `recoveries < 2`; `recoveries + 1` | `queue.recover_expired_runs` |
| `running → succeeded` | обработан последний пакет | `queue.finish_batch` |
| `running → failed` | сбой провайдера после исчерпания попыток, неверный ответ, `input_too_large`; пакет, не продвинувший `cursor`, — `internal_error` | `queue.finish_batch` |
| `running → failed` / `worker_lost` | lease истекла при `recoveries = 2` | `queue.recover_expired_runs` |
| `running → failed` / `internal_error` | непредвиденная ошибка шага; воркер продолжает работу | `queue.fail_run` |
| `queued → cancelled` | команда `product_classifications cancel-pending` | `services.cancel_pending` |

Каждый переход увеличивает `version`; у конечного статуса заполняется `finished_at` и очищаются `run_token`, `heartbeat_at`, `lease_expires_at`. `error_code`: коды провайдера (`auth_required`, `network_unavailable`, `rate_limited`, `provider_unavailable`, `configuration_error`, `invalid_input`, `invalid_output`, `timeout`), `worker_lost`, `input_too_large`, `internal_error`.

- **Постановка** (`services.request_run`): `manual` — все кандидаты, под `IMPORT_LOCK`, после сверки ожидающих записей; активный запуск возвращается как есть, запуск очереди с `scope='products'` расширяется до `all`. `import` — только товары без единой записи в любом статусе, внутри транзакции импорта в отдельном savepoint (блокировку импорт уже держит): товары добавляются к запуску в очереди с `scope='products'` либо создают новый. У запуска, ждущего между пакетами, товары до `cursor` не трогаются: новые добавляются только за ним. Сверх `PRODUCT_CLASSIFICATION_RUN_LIMIT` — в `remaining_count`.
- **Один в очереди, один выполняется** — два условных unique. Импорт может поставить свой запуск, пока выполняется пакет другого; при возврате в очередь выполнявшийся запуск забирает его товары в хвост без повторов (`scope` становится `all`, если таким был поглощаемый), а не начавшаяся строка **удаляется**. Если в очереди ждёт уже начатый запуск, выполнявшийся закрывается как `failed`.
- **Lease**: `lease_expires_at = now + PRODUCT_CLASSIFICATION_TIMEOUT_SECONDS + 60 с` при захвате и в начале каждого запроса к модели (`queue.heartbeat` из `RunContext.on_stage`); потока heartbeat нет. Все переходы захваченного запуска проверяют `run_token`: запуск, который тем временем закрыли (`suggest` и `cancel-pending` закрывают запуск с истёкшей lease), даёт `RunLost` и остаётся как есть, применённое пакетом не откатывается.
- **Попытки**: каждая — строка `ClassificationAttempt` (`batch`, `ordinal`), не больше `RECEIPT_OCR_MAX_ATTEMPTS` на пакет; повторяются только сбои с признаком `retryable`, пауза 2–3 с. Модель вызывается вне транзакции. Попытка, оставшаяся `running`, закрывается переходом запуска: `worker_lost` при `Ctrl+C` и истёкшей lease, `cancelled` при потере слота, `internal_error` при непредвиденной ошибке.
- **Занятый каталог** при применении пакета (`IMPORT_LOCK` у импорта, слияния либо действия человека) повторяется три раза; затем товары пакета остаются без предположения (`stats.catalog_busy`, входят в `skipped_count`), запуск идёт дальше.
- **Восстановление**: после истёкшей lease тот же пакет выполняется заново; товары, которые потерянный захват успел применить, уже не кандидаты и учитываются как пропущенные (`stats.not_eligible`). Недоступная БД останавливает воркер, запуск остаётся `running` до истечения lease.
- **Изоляция от распознавания**: исход запуска не меняет чек, вырезку, статус и счётчики задания распознавания. Единственная связь — общий процесс воркера и `executor.state = "busy"` на время пакета.
- **Откат очереди и воркера** — revert кода, миграций шаг не добавлял. Перед ним остановить воркер и выполнить `product_classifications cancel-pending`: запуск в очереди отменяется, ожидающие записи возвращаются.

### Откат classification

```powershell
./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py product_classifications cancel-pending
./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py migrate classification zero --noinput
```

Перед первой командой остановите воркер: запуск, выполняющий пакет, даёт отказ «занято». `cancel-pending` возвращает каждый ожидающий товар в прежний обобщённый продукт, если его значение всё ещё предложенное (значение, которое человек успел сменить, остаётся); удаляет созданное механизмом и опустевшее; отменяет запуск в очереди; память отказов по этим записям не пишет. Каждая запись — своя транзакция: при «занято» команду достаточно повторить; повтор на базе без ожидающих ничего не меняет.

`migrate classification zero` удаляет шесть таблиц и каталог не трогает. После обеих команд каталог совпадает с видом до предположений, **кроме** подтверждённых классификаций и принятых вместе с ними категорий и обобщённых продуктов (они остаются обычными записями каталога без следа происхождения) и правок человека. Без `cancel-pending` ожидающие товары останутся в предложенных обобщённых продуктах без пометки и без возможности возврата — только восстановлением из `pg_dump`. Повторный `migrate` создаёт пустые таблицы: история, журнал созданного и память отказов не восстанавливаются. HTTP-слой, шаг после слияния, расширенный `executor.busy` и настройки откатываются revert кода; до него выполните `cancel-pending`.

**`migrate classification zero` без отката кода ломает локальный API и воркер.** Код продолжает читать удалённые таблицы: `executor` считается запросом к `classification_classificationrun`, воркер каждый проход восстанавливает lease запусков. Проверено в QA (2026-10-07, fake, настоящие маршруты на базе после `cancel-pending` и `migrate classification zero`):

| Что | Ответ при удалённых таблицах |
| --- | --- |
| старые 13 GET (`/api/countries/`, `/stores/`, `/brands/`, `/categories/`, `/categories/{id}/`, `/generic-products/`, `/generic-products/{id}/`, `/products/`, `/products/{id}/`, `/products/{id}/prices/`, `/prices/summary/`, `/alternatives/`, `/generic-products/{id}/comparison/`) | `200`, формат прежний |
| `/api/receipts/`, `/api/product-merges/`, `/api/recognition/photos/` (GET) | `200` |
| `/api/recognition/csrf/`, `/api/recognition/jobs/`, `/api/recognition/jobs/{id}/` — всё, что отдаёт `executor` | `500` |
| `/api/product-classifications/`, `/status/`, `/runs/` и остальные маршруты предположений | `500` |
| `manage.py recognition_worker` | печатает `Recognition worker ready.` и выходит с кодом 1 (`Recognition worker database is unavailable…`); задания распознавания не берутся |
| `product_classifications suggest` / `cancel-pending` / `reconcile` | код 1, `ProgrammingError` о несуществующей таблице |

Так как `500` отдаёт и `/api/recognition/csrf/`, клиент не получает CSRF-токен: загрузка фото, отмена, повтор, подтверждение вырезки и действия над дублями из интерфейса недоступны, хотя их таблицы целы. Чеки, каталог и история распознавания при этом не меняются. `/api/health/` эти таблицы не читает (в проверке Celery-воркер QA не запускался, поэтому health отвечал `503` и до, и после удаления таблиц).

Безопасный порядок отката:

1. Остановить `recognition_worker` и не принимать новые загрузки (остановить Django либо выставить `ALLOW_LOCAL_RECOGNITION_API=0`); дождаться, пока не останется запуска `running`.
2. `pg_dump` базы — подтверждённое и память отказов из таблиц `classification` иначе не восстановить.
3. `product_classifications cancel-pending`; повторять при отказе «занято», пока в выводе не станут пустыми `cancelled` и `runs_cancelled`.
4. `migrate classification zero`.
5. Сразу revert кода на состояние без `classification` (приложение, HTTP-слой, шаг воркера, запрос `executor`) и перезапуск Django и воркера. До этого шага сервер и воркер запускать нельзя.

Если таблицы удалены, а код вернуть сразу нельзя, работу восстанавливает `migrate` (создаёт пустые таблицы `classification`; проверено: те же маршруты снова `200`, воркер — код 0) с `PRODUCT_CLASSIFICATION_AUTO_SUGGEST=0`, чтобы импорт не ставил новых запусков. История и память отказов при этом пусты.

## JSON-поля

Отдельных колонок под эти данные нет; набор ключей не фиксирован и не проверяется. Ниже — ключи, которые использует код и образцы `backend/receipts/tests/samples.py`.

**`Receipt.fiscal`** — фискальные реквизиты, набор зависит от страны:

| Страна | Ключи | В `fiscal_key` входят |
| --- | --- | --- |
| RU | `fn`, `fd`, `fp`, `rn_kkt`, `zn_kkt` | `fn`, `fd` |
| KZ | `fp`, `rnm`, `znm`, `ofd`, `document` | `rnm`, `fp` |
| DE | `tse_transaction`, `register_serial`, `signature_counter`, `transaction_start`, `transaction_end`, `signature` | `register_serial`, `tse_transaction` |

Код читает из `fiscal` только ключи третьей колонки (`receipts.dedup.FISCAL_KEY_PARTS`); остальные хранятся как есть.

**`Receipt.extra`** — поле «прочее» произвольного формата. В образцах: `cashier`, `payment` (способ оплаты текстом), `header_time` (время из шапки, если оно расходится с фискальным), `check_site`.

**Данные оплаты картой отдельных полей не имеют.** Слип терминала, маска карты, RRN, код авторизации в схеме не представлены; при необходимости их можно положить в `Receipt.extra`. В образцах их нет.

**`Merchant.extra`** — свидетельство НДС, система налогообложения, название на втором языке (`vat_certificate`, `tax_system`, `legal_name_kk`, `full_name`).

**`ReceiptLine.extra`** — прочие пометки строки (в образцах `subject`: «ТОВАР», «ПОДАКЦИЗНЫЙ ТОВАР»). **`Product.attributes`** — характеристики товара (`fat_percent`, `packaging`, `capacity_tb`). **`Store.address_i18n`**, **`ReceiptLine.name_i18n`** — варианты текста по кодам языков.

В JSON и текстовых полях могут оказаться персональные данные (ФИО кассира, ФИО и ИНН предпринимателя). В репозитории — в коде, тестах и документации — используются только вымышленные.

## Дедупликация

Три уровня, каждый — частичное unique-ограничение на `receipts_receipt`:

| Уровень | Ограничение | Условие |
| --- | --- | --- |
| 1. Фискальный ключ | unique `fiscal_key` — `receipts_receipt_fiscal_key_uniq` | `fiscal_key != ''` |
| 2. Внутренний номер магазина | unique `(store, purchased_on, shift_number, register_code, receipt_number)` — `receipts_receipt_store_number_uniq` | `receipt_number != ''` |
| 3. Номера нет вовсе | unique `(store, purchased_at, total)` — `receipts_receipt_store_time_total_uniq` | `receipt_number = '' AND fiscal_key = ''` |

`receipts.dedup.build_fiscal_key(country_code, fiscal)` собирает ключ с префиксом схемы:

- RU: `ru:<ФН>:<ФД>` → `ru:7382440900170413:72473`
- KZ: `kz:<РНМ>:<ФП>` → `kz:601004679109:1443445223777`
- DE: `de:<серийный номер кассы>:<номер TSE-транзакции>` → `de:LDL-000-5597-85:427161`

Пробелы внутри реквизита удаляются. Если схемы для страны нет или реквизита не хватает, возвращается пустая строка, и чек дедуплицируется следующими уровнями. Ключ длиннее 160 символов — `ValueError`. Страна — страна магазина (`store.country`).

На уровне 2 номер уникален вместе со сменой и кассой: тот же номер в другой смене или в другой день допустим. Пустые смена и касса — тоже значения ключа.

**Чего БД не ловит:** один чек, введённый дважды с разным набором полей (один раз с фискальным ключом, другой — без него). Для этого до сохранения вызывается `receipts.dedup.find_duplicates(receipt_data)`. Она принимает словарь полей или объект `Receipt` и проверяет все три уровня независимо от того, какие поля заполнены у сохранённого чека:

- по `fiscal_key`; если ключа во вводе нет, но есть `fiscal`, ключ собирается по стране магазина;
- по `(store, purchased_on, receipt_number)`; смена и касса сравниваются, только если заданы во вводе, и пустое значение у сохранённого чека считается совпадением;
- по `(store, purchased_at, total)`.

Возвращается список кандидатов от сильного уровня к слабому, без повторов; сам чек из результата исключён. Функция ничего не запрещает — решение принимает вызывающий код.

## История цен

Отдельной таблицы наблюдений нет: цена выводится из строк чека, поэтому при правке чека синхронизировать нечего. `receipts.prices.price_history(*, product=None, generic=None, store=None, country=None, date_from=None, date_to=None)` возвращает `QuerySet[ReceiptLine]`, отсортированный по `(observed_at, receipt_id, position)`.

- В выборке только строки `kind='product'` с `quantity > 0` из чеков `operation='sale'`. Залог, возврат тары, услуги и чеки возврата не входят.
- Фильтры складываются по «И»; каждый принимает объект или ключ. `date_from` и `date_to` — границы локальной даты `purchased_on`, обе включительно.
- Несопоставленный товар ищется дальнейшим `.filter(receipt__store__merchant=..., raw_name=...)` либо по `store_item_code`.

| Аннотация | Значение |
| --- | --- |
| `observed_at` | `receipt.purchased_at` |
| `currency_code` | Код валюты чека |
| `list_unit_price` | `unit_price` — цена до скидки |
| `paid_unit_price` | `(amount - discount_amount) / quantity`, округлено до 4 знаков |
| `normalized_price` | Цена за базовую единицу, округлено до 4 знаков, либо `NULL` |
| `normalized_unit` | Единица `normalized_price`: `kg`, `l`, `pcs`, у фасовки в метрах — `m`; `NULL` ровно там, где `NULL` цена |

`normalized_price`:

- строка в `kg`, `g`, `l`, `ml` — оплаченная цена, приведённая к кг или л;
- штучная строка (`pcs`) с сопоставленным товаром, у которого задана фасовка, — оплаченная цена, делённая на фасовку в базовых единицах (`111.00` за `850 ml` → `130.5882` за литр);
- иначе `NULL`: штучная строка без товара или без фасовки, строка в метрах.

Нормализация считается от неокруглённой цены. Совпадение единицы фасовки с `GenericProduct.base_unit` в `price_history` не проверяется: товар с фасовкой в граммах даст цену за кг, даже если у обобщённого продукта `base_unit='l'`. Единицу сообщает `normalized_unit`; наблюдение **сравнимо**, когда она равна `base_unit` обобщённого продукта товара — условие `receipts.prices.comparable_q()`. Штучная строка товара без фасовки несравнима и при `base_unit='pcs'`: цена за штуку появляется только при фасовке `1 pcs`.

Поверх `price_history` в том же модуле есть функции для наборов товаров; их использует API чтения. Группа — «товар, страна магазина, валюта чека», цены разных валют в одну группу не попадают:

| Функция | Что возвращает | Запросов |
| --- | --- | --- |
| `observation_q(prefix="")` | Условие «строка — наблюдение цены» для запросов от `ReceiptLine` или, с префиксом, от другой модели | — |
| `price_groups(products, …)` | Список `PriceGroup`: число наблюдений, число сравнимых, мин / макс / средняя цена за базовую единицу по сравнимым | 1 |
| `last_prices(products, …, comparable_only=False)` | Последнее наблюдение каждой группы (`DISTINCT ON`) по порядку `(observed_at, receipt_id, position)` | 1 |
| `price_summary(products, …)` | `{product_id: [PriceGroup с last]}` | 2 |

Фильтры этих функций: `countries`, `currency`, `store`, `date_from`, `date_to`. Число запросов не зависит от числа товаров; среднее — простое, округлено до 4 знаков `ROUND_HALF_UP`.

`price_summary` пропускает группу, если между двумя запросами удалено её последнее наблюдение и группа больше не существует; у возвращённых групп `last` всегда заполнена. При оставшихся наблюдениях берётся последнее из них. Общего снимка для обоих запросов при `READ COMMITTED` нет: счётчики и агрегаты могут предшествовать последней цене. API сравнения также исключает предложения с исчезнувшим последним наблюдением; это не увеличивает число запросов.

Вычисляемая нормализованная цена может иметь 21 целую цифру: сумма `(14,2)` делится на количество от `0.001` и фасовку в базовых единицах от `0.000001`. Тип SQL-выражений ORM описан как `(25,4)`; Postgres считает в `numeric` без ограничения разрядности этих выражений. Общие Python-вычисления и округление в `receipts.decimal_math` используют локальный контекст 128 цифр: он покрывает цены, точное умножение на курс с 24 значащими цифрами, суммы и проценты. Поля моделей и схема БД не меняются.

Цены лежат в валюте чека. Выборка использует индекс `(product, receipt)`; замеров на больших объёмах нет.

## Статистика

Новых таблиц, полей, индексов и миграций статистика не добавляет: траты за период, походы, разложение изменения среднего чека и ряды цен считаются запросами по `receipts_receipt`, `receipts_receiptline`, каталогу и `merges` (только чтение). Расчёты — `receipts/spending.py` и `receipts/basket.py`, контракт — [api-contract.md](api-contract.md#реализовано-статистика-трат-походы-и-ряды-цен-серверная-часть).

- Период отбирается по `Receipt.purchased_on` — локальной дате магазина, обе границы включительно. Индекса по `purchased_on` нет (у чека есть `(store, purchased_at)`, у строки — `(product, receipt)`): на демо-базе из 466 чеков и 5604 строк самый медленный запрос статистики занял 132 мс ([замер](verification.md#статистика-серверная-часть-с5)). Если на настоящих данных запрос окажется дольше 500 мс, отдельной задачей добавляется `receipts.0002` с индексом `receipts_receipt(purchased_on)`; миграция обратима (`migrate receipts 0001`) и данных не меняет.
- Траты — `Σ (amount − discount_amount)` строк всех чеков, включая возвраты со знаком. Скидка на весь чек и налог сверх цен по строкам не распределяются и видны разницей `Σ Receipt.total − Σ строк`.
- Категория строки — `Product → GenericProduct → Category`. Импорт кладёт новые товары в служебные категорию и обобщённый продукт «Не разобрано»; пока человек в админке не сменит `Product.generic`, разбивка по категориям показывает их одним сектором, а похожих товаров для графика цен нет.
- Поход — чек `operation='sale'`; позиции — строки `kind='product'` с `quantity > 0`. Медиана — `percentile_cont(0.5)` Postgres по сумме в центах.
- Строка, которая ещё указывает на поглощённый слиянием товар, относится к оставляемому товару его ожидающей группы.
- Валюты не складываются: каждый расчёт делит данные по `Receipt.currency`.

Демо-данные только для `test_*` и `checkist_qa*` — команда `seed_stats_demo` (`receipts/demo.py`): три вымышленных продавца с налоговыми номерами `DEMOSTATS…`, 39 товаров, 466 чеков, 5604 строки, 151 скидка; повторный вызов ничего не меняет, удаления нет — база пересоздаётся.

## Что гарантирует БД, а что приложение

**БД (Postgres):**

- все unique и check из разделов выше, включая три уровня дедупликации;
- ссылочная целостность внешних ключей. Они созданы как `ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED`.

**Django ORM при удалении через ORM** (`on_delete`; в схеме БД этих правил нет, прямой SQL `DELETE` их не выполнит и упрётся во внешний ключ):

- `PROTECT`: нельзя удалить страну, валюту, ставку, продавца, магазин, категорию, обобщённый продукт или бренд, пока на них есть ссылки (`ProtectedError`);
- `CASCADE`: удаление чека удаляет строки, скидки и итоги по налогам; удаление строки — её залог и её скидки; удаление продавца или товара — их `ProductAlias`;
- `SET_NULL`: удаление товара оставляет строки чеков несопоставленными.

**Приложение** — `receipts.validation.validate_receipt(receipt) -> list[str]` для сохранённого чека. Пустой список — нарушений нет. Проверяется:

- `store.timezone` — существующий пояс, и `purchased_on` равна дате `purchased_at` в нём;
- `parent` строки и `line` скидки принадлежат тому же чеку;
- `line.discount_amount` равна сумме `ReceiptDiscount.amount` этой строки;
- `amount` ≈ `quantity × unit_price` с допуском 0,01;
- страна `tax_rate` строки и итога по ставке равна `store.country`;
- Σ `line.amount` − Σ `discount.amount` = `receipt.total`; при `prices_include_tax=False` к сумме добавляется Σ `ReceiptTax.tax`;
- Σ `ReceiptTax.gross` = `receipt.total`, если итоги по ставкам есть.

Сама функция возвращает предупреждения, `save()` её не вызывает и прямой ORM их не запрещает. Recognition importer вызывает её внутри транзакции: невалидный domain graph откатывает, наблюдение/причины сохраняет на ReceiptImage для review. Админка показывает отдельный блок предупреждений.

Приложение же отвечает за сборку `fiscal_key`, `address_key` (кроме случая `Store.save()` с пустым ключом) и `name_key`, за вызов `find_duplicates` и `find_alias`.

**Прямое сохранение ORM без recognition/admin не проверяет:** `receipt.discount_total` против суммы скидок; `store.country` против `merchant.country`; соответствие валюты стране; соответствие `fiscal_key` содержимому `fiscal`; значения `choices` вне `full_clean()`; содержимое JSON-полей; формат `gtin`, `tax_id`, `timezone` при сохранении. Форма админки закрывает часть этого списка — `choices`, существование `timezone`, сборку пустого `fiscal_key` — но только для ввода через админку; запись кодом по-прежнему ничем не проверяется.

## Админка

Стандартный Django admin на маршруте `/admin/` (`backend/config/urls.py`). Настройки — в `backend/stores/admin.py`, `backend/catalog/admin.py`, `backend/receipts/admin.py`; при расхождении прав код. Запуск и создание суперпользователя — в [development.md](development.md#админка), ручная приёмка — в [verification.md](verification.md#ручная-приёмка-админки-человеком).

Вход — активному пользователю с `is_staff`; что он может делать с каждой моделью, определяют стандартные права Django, суперпользователю доступно всё. Аноним и пользователь без `is_staff` перенаправляются на `/admin/login/`.

### Какие модели доступны

Зарегистрированы 12 моделей из 14. `ReceiptDiscount` и `ReceiptTax` своих страниц не имеют: они правятся только внутри чека.

| Модель | Список: фильтры и поиск | Особенности формы |
| --- | --- | --- |
| `Country`, `Currency` | Поиск по `code`, `name` | `code` при правке только для чтения: это первичный ключ, его изменение создало бы новую строку |
| `TaxRate` | Фильтры `country`, `kind`; поиск по `name`, коду страны | — |
| `Merchant` | Фильтры `country`, `tax_id_type`; поиск по `legal_name`, `brand_name`, `tax_id` | Пустое `extra` сохраняется как `{}` |
| `Store` | Фильтр `country`; поиск по названию, адресу, городу, коду филиала, названиям продавца | `merchant` — автодополнение; `address_key` только для чтения; пустое `address_i18n` сохраняется как `{}` |
| `Category` | Поиск по `name` | `parent` — автодополнение |
| `GenericProduct` | Фильтр `base_unit`; поиск по `name` | `category` — автодополнение |
| `Brand` | Поиск по `name`, `manufacturer` | — |
| `Product` | Фильтр `package_unit`; поиск по `name`, `gtin`, `model`, названию бренда | `generic`, `brand` — автодополнение; пустое `attributes` сохраняется как `{}` |
| `Receipt` | Фильтры `operation`, `currency`, страна магазина; иерархия дат по `purchased_on`; поиск по `receipt_number`, `fiscal_key`, названию и адресу магазина | `store` — автодополнение; три inline; `created_at`, `updated_at` и блок предупреждений только для чтения; пустые `fiscal`, `extra` сохраняются как `{}` |
| `ReceiptLine` | Фильтры `kind`, `unit`, `is_excise`, `is_marked`, «товар задан / не задан»; поиск по `raw_name`, `store_item_code`, `barcode` | Отдельно добавить нельзя (403) — строка создаётся только внутри чека; `receipt`, `product`, `tax_rate` — автодополнение, `parent` — ввод id; пустые `name_i18n`, `extra` сохраняются как `{}` |
| `ProductAlias` | Поиск по `raw_name`, `name_key`, `store_item_code`, названию товара | `merchant`, `product` — автодополнение; `name_key` только для чтения |

Inline внутри чека, все без пустых заготовок (`extra = 0`):

| Inline | Вид | Особенности |
| --- | --- | --- |
| `ReceiptLine` | Блоками (`StackedInline`), по `position` | `product`, `tax_rate` — автодополнение; `parent` предлагает только строки этого же чека |
| `ReceiptDiscount` | Таблицей, по `position` | `line` предлагает только строки этого же чека |
| `ReceiptTax` | Таблицей | `tax_rate` — автодополнение |

На странице добавления чека списки `parent` и `line` пусты: строк ещё нет. Залог и скидку на конкретную строку привязывают после первого сохранения чека.

В каждой админке явно заданы сортировка и `list_select_related`: число запросов списка не зависит от числа строк. `raw_text` чека в поиск не входит. Отдельный список строк чеков нужен для главной ручной операции — сопоставления строк с товарами: фильтр «товар не задан», затем выбор товара в строке.

### Вычисляемые поля

| Поле | Как заполняется в админке |
| --- | --- |
| `Store.address_key` | При добавлении считается из `address_raw` и `address_i18n` функцией `stores.normalize.address_key`. При правке адреса не пересчитывается — как и в `Store.save()`: ключ определяет идентичность магазина |
| `ProductAlias.name_key` | Всегда пересчитывается из `raw_name` функцией `receipts.dedup.name_key`, в том числе при правке; значение из запроса игнорируется |
| `Receipt.fiscal_key` | Поле доступно для ввода. Если оно пусто, а `fiscal` заполнен, форма собирает ключ через `build_fiscal_key(страна магазина, fiscal)`; введённое вручную значение сохраняется как есть. Если схемы для страны нет или реквизитов не хватает, ключ остаётся пустым |

### Проверки форм

Нарушение даёт ошибку формы на той же странице, а не HTTP 500:

- **Ограничения БД.** Unique и check полей, которые есть в форме, проверяет сам Django: три уровня дубликата чека, повтор `position` или ставки внутри чека, `gross = net + tax`, знаки и нули в строке, `amount > 0` у скидки, фасовка товара и остальные ограничения из разделов выше. Значения `choices` проверяются тоже.
- **Ключи inline (F6).** Formset дополнительно проверяет занятые в БД пары `(receipt, position)` у строк и скидок и `(receipt, tax_rate)` у итогов по налогу: inline-поле `receipt` Django исключает из проверки ограничений отдельной модели. Если другая запись занимает нужный ключ, в том числе отмеченная DELETE или переводимая на другой номер/ставку в этом POST, поле `position`/`tax_rate` получает `receipt_inline_unique`; ответ HTTP 200, весь POST без записей. Дубли между активными формами также отклоняются. Это правило действует для UPDATE и INSERT, включая замену удаляемой записи и номера каскадно удаляемых строк. Удаление/освобождение ключа сохраните отдельно; отвязки без конфликта ключей и каскады F4 разрешены по прежним правилам.
- **Магазин.** Дубликат `(merchant, address_key)` и адрес без букв и цифр (пустой ключ) — ошибка у поля `address_raw`. `timezone` должен быть существующим поясом IANA.
- **Категория.** Родителем не может быть сама категория или её потомок: БД циклы не запрещает. Проверка повторяется под транзакционной блокировкой всего дерева перед сохранением — см. [конкурентные правки](#конкурентные-правки).
- **Товар.** Пустое поле `attributes`, отсутствие этого поля в POST и JSON `null` нормализуются в `{}` при добавлении и правке. При правке это очищает прежние атрибуты. Валидный непустой JSON сохраняется как есть; некорректный JSON даёт ошибку поля `attributes`, без сохранения других правок товара. Структура JSON по-прежнему не проверяется.
- **Чек.** Дубликат по собранному `fiscal_key`; ключ длиннее 160 символов — ошибка у поля `fiscal`.
- **Строка чека.** `parent` должен быть строкой этого же чека и не самой строкой; `line` у скидки тоже должен принадлежать её чеку. В отдельной форме строки смена `receipt` запрещена, если на строку ссылаются залоги (`children`) или скидки (`discounts`): ошибка у поля `receipt`, код `receipt_has_dependents`, никакие правки не сохраняются. Сначала в исходном чеке удалите зависимые записи либо отвяжите у залогов `parent`, у скидок `line`, затем переносите. Сами связи автоматически не переносятся. Строку без зависимостей переносить можно при соблюдении остальных ограничений, в том числе свободного `position` в целевом чеке. При переносе самого залога его `parent` нужно очистить или заменить строкой целевого чека.
- **Сохранённые inline чека (F4).** Для строк, скидок и итогов по налогам проверяется актуальная принадлежность чеку, в том числе при отметке DELETE. Если запись уже перенесена в другой чек или удалена, весь POST возвращает HTTP 200 с общей ошибкой соответствующего набора inline «Запись уже перенесена в другой чек или удалена. Откройте чек заново.» (`receipt_inline_conflict`); при отсутствии id сообщение — «Запись чека уже удалена или изменена. Откройте чек заново.». Ни поля чека, ни его inline этим запросом не сохраняются; повтор устаревшего POST также отклоняется. Строка и её зависимости в другом чеке сохраняются.
- **DELETE и зависимые inline в одном сохранении (F4).** Правка или создание залога с `parent`, который удаляется прямо или каскадом, даёт ошибку `parent_deleted` у `parent`: «Родительская строка удаляется в этом сохранении. Отвяжите залог или удалите его вместе с ней.». Для изменяемой или новой скидки с удаляемым `line` — `line_deleted` у `line`: «Строка скидки удаляется в этом сохранении. Отвяжите скидку или удалите её вместе со строкой.». Ответ — HTTP 200, весь POST без сохранения. Можно в том же POST очистить или сменить `parent`/`line` на сохраняемую строку этого чека либо отметить зависимость на DELETE. Неизменённые зависимости удаляются каскадом; одинаковый нормализованный JSON `{}` у залога не считается содержательной правкой. Проверяется и каскад через несколько уровней `parent`.
- **Сопоставление.** Дубликат `(merchant, name_key, store_item_code)` — ошибка у поля `raw_name`.

**Предупреждения чека.** На странице сохранённого чека блок «Предупреждения проверки» показывает результат `validate_receipt` (см. [выше](#что-гарантирует-бд-а-что-приложение)). Это предупреждения: сохранению они не мешают. На странице добавления блок сообщает, что предупреждения появятся после сохранения.

**Удаление** идёт через ORM. Объект, на который есть ссылки с `PROTECT` (например, страна с продавцами), удалить нельзя — админка показывает отказ. Для `CASCADE` страница подтверждения перечисляет всё, что будет удалено: у чека — его строки, скидки и итоги по налогам. Inline DELETE выполняется при сохранении чека, без отдельной страницы подтверждения: действуют проверки F4 выше. Скидки сохраняются до удаления строк, а изменённые существующие строки — до DELETE: отвязанные или перепривязанные зависимости не попадают в прежний каскад. Сид-строки справочников без ссылок удалить можно; `migrate` их не вернёт.

### Конкурентные правки

**Строки чека и их связи (F1, `7aa388d`).** POST добавления/правки Django admin выполняется в `atomic`; формы используют `select_for_update()` для изменяемой строки и выбранного `parent` (в порядке PK), а форма скидки — для выбранного `line`. Блокировки удерживаются до завершения транзакции, включая сохранение inline. После ожидания формы читают актуальное состояние строки. Если создание залога/скидки завершилось первым, перенос получает ошибку `receipt_has_dependents`. Если перенос завершился первым, создание связи в прежнем чеке получает ошибку `parent`/`line`; для скидки код — `line_other_receipt`. Повторный отклонённый перенос ничего не меняет, удаление целевого чека после него не удаляет исходную строку и её связи. Обычное редактирование строки внутри исходного чека с зависимостями разрешено.

**Конкурентный inline DELETE (F4, `a686413`).** `ReceiptInlineFormSet.clean()` перечитывает все initial inline по PK без фильтра по чеку и блокирует их `select_for_update(nowait=True)` в порядке PK. Проверка работает для всех трёх inline, в том числе для DELETE, чьи ошибки отдельной формы стандартный Django formset игнорирует. Исчезновение записи или смена `receipt_id` относительно редактируемого чека вызывает общую ошибку formset `receipt_inline_conflict`, которую DELETE не обходит. Если POST A уже прочитал строку, а другой POST успел перенести её в B и создать там залог/скидку до блокировки первым запросом, A получает HTTP 200 с конфликтом; записи B остаются. То же верно для строки без зависимостей, перенесённой скидки/итога по налогу и уже удалённой строки. Успешные блокировки удерживаются до commit/rollback всего admin POST. Перенос скидки/итога по налогу проверен конкурентной ORM-записью: отдельного интерфейса переноса этих моделей в админке нет.

План DELETE строк учитывает каскад по `parent` и очищенные/заменённые связи из текущего POST; форма скидок проверяет этот план после успешной валидации formset строк. Ошибки `parent_deleted`/`line_deleted` не допускают повторного сохранения зависимости после каскадного удаления её родителя. Разрешённые отвязки/перепривязки существующих зависимостей сохраняются раньше DELETE; неизменённые зависимости остаются частью каскада. Это согласование inline одного чека, а не общий механизм разрешения конфликтов всех полей админки.

**Конфликт ключей inline (F6).** Проверка занятых позиций/ставок делает одну выборку ключей на каждый непустой formset, ограниченную запрошенными значениями; используются существующие составные unique-индексы. Она не резервирует отсутствующий ключ: другая транзакция, включая прямую ORM/SQL-запись, может занять его между `clean` и `save`. `ReceiptInlineFormSet.save()` обрабатывает только SQLSTATE `23505` с именами `receipts_receiptline_receipt_position_uniq`, `receipts_receiptdiscount_receipt_position_uniq`, `receipts_receipttax_receipt_tax_rate_uniq` для соответствующей модели. При таком конфликте внутренний savepoint `ReceiptAdmin._changeform_view()` откатывает весь POST: поля чека, уже сохранённые скидки/налоги/строки и удаления. Форма заново собирается из исходного POST с общей ошибкой нужного formset `receipt_inline_unique`, HTTP 200; повторного сохранения нет. Запись другой транзакции остаётся. Успешный POST сохраняется один раз; неуспешный не добавляет запись журнала админки.

**Совместимость:** HTTP API и права доступа прежние. Для HTML-форм правило уточнено и одинаково для трёх inline: создание замены на ключ записи, удаляемой в этом же POST, теперь также отклоняется, хотя стандартный DELETE-before-INSERT Django мог раньше успешно сохранить такую замену. Это сознательное ограничение в рамках F6; освобождение ключа и повторное использование требуют отдельных сохранений. Обычные свободные ключи, отвязки и каскады без конфликта не ограничены.

При незавершённой конкурентной вставке PostgreSQL может ждать освобождения unique-ключа. SQLSTATE `55P03`/`57014`/`40P01` во время сохранения inline также превращаются в `receipt_inline_busy` после полного отката POST. `statement_timeout=2000` мс не меняется; тесты проверяют реальный таймаут ожидания незавершённых вставок для всех трёх моделей. Гонки INSERT и UPDATE после валидации проверены отдельными соединениями с настоящим commit. Это обработка известных ошибок сохранения inline, а не безусловный перезапуск транзакции.

**Дерево категорий (F2, `c895168`).** `CategoryAdminForm.clean()` на write-соединении, выбранном Django router, вызывает PostgreSQL `pg_try_advisory_xact_lock(1129010004, 1)` (параметры передаются как два целых; `1129010004 = 0x434B5354`, namespace `CKST`, ресурс 1). Это одна блокировка на всё дерево в данной БД. Её берут формы добавления и правки, включая корневые категории с пустым `parent`; она удерживается до commit/rollback admin POST. Полей `list_editable` и собственных actions, меняющих `parent`, нет; удаление не добавляет рёбер, ссылочные родители защищены `PROTECT`.

При занятой блокировке второй запрос **не ждёт**: возвращает HTTP 200 с ошибкой поля `parent` «Категории сейчас изменяются другим запросом. Повторите сохранение.» (`category_tree_busy`) и ничего не сохраняет. После завершения первого запроса безопасную правку можно отправить повторно. Если первый запрос уже завершился между первичной проверкой поля и захватом блокировки вторым, второй повторно обходит актуальные `parent_id` под блокировкой: попытка замкнуть цикл получает `category_cycle`, остальные поля тоже не сохраняются. Например, из двух корней A/B сохранение A → B исключает последующее B → A.

`pg_try_advisory_xact_lock` выбран вместо ожидающей блокировки, чтобы конфликт категорий не упирался в установленный `statement_timeout=2000` мс. F4 не меняет этот таймаут: формы строк и выбранных `parent`/`line` по-прежнему могут ждать до него, а проверка initial inline в formset использует NOWAIT и при занятой записи сразу отказывает. Общий helper `lock_inline_objects()` оборачивает SQL блокировки в savepoint; `OperationalError` с PostgreSQL SQLSTATE `55P03` (блокировка недоступна), `57014` (отмена запроса, в том числе statement timeout) и `40P01` (deadlock) преобразуется в ошибку формы/formset `receipt_inline_busy`: «Строки чека сейчас изменяются другим запросом. Откройте чек заново и повторите сохранение.». Savepoint восстанавливает рабочее состояние внешней транзакции; ответ — HTTP 200, без сохранения POST, включая DELETE. Дождитесь завершения другого запроса и откройте чек заново перед повтором.

Обработаны известные ошибки SQL helper блокировок и описанные выше конфликты/ожидания при сохранении inline. Остальные SQL-запросы (поиск, проверка ограничений, сохранение самого чека), неизвестные SQLSTATE, другие IntegrityError и таймауты категорий вне advisory-вызова по-прежнему могут дать HTTP 500 с откатом транзакции; общего deadline POST и безусловного retry нет. Регрессии гонок выполняются через `TransactionTestCase` с отдельными настоящими Postgres-соединениями: короткое ожидание F1, неблокирующий отказ F2, конфликт принадлежности F4 и удержание блокировок чеков дольше штатных 2 с, занятие ключа после clean и ожидание unique F6. Регрессия настоящего check violation после clean подтверждает, что неизвестный IntegrityError не маскируется как конфликт unique.

Эти гарантии относятся к формам и formset админки. F4 защищает сохранение inline, включая их DELETE; отдельная страница удаления объекта и массовое удаление используют стандартный ORM-каскад, этот механизм formset к ним не применяется. Прямые ORM/SQL-записи не обязаны брать те же блокировки, БД не запрещает цикл категорий или принадлежность связанной строки другому чеку. Исправления не проверяют и не восстанавливают ранее повреждённые данные и не вводят разграничение чеков между пользователями.

### Ограничения админки

- **Только локальные dev и QA.** `STATIC_ROOT` и `collectstatic` не настроены, при `DJANGO_DEBUG=0` статика админки не отдаётся. Нет `SESSION_COOKIE_SECURE`, `CSRF_COOKIE_SECURE`, перенаправления на HTTPS, HSTS и защиты от подбора пароля. В production в таком виде админку выставлять нельзя.
- **Открывается напрямую на Django**, не через Vite: proxy передаёт только `/api`.
- **`purchased_at` вводится в UTC** (`TIME_ZONE = "UTC"`), а `purchased_on` — локальная дата магазина, как на чеке. Подсказки стоят у обоих полей; расхождение показывает блок предупреждений.
- **Перестановка `position` (F6).** Поменять номера двух строк или скидок одним сохранением нельзя: HTTP 200 с ошибкой `position`, весь POST без записей. Для 1↔2 выполните три отдельных сохранения: L1 → свободный 3; L2 → 1; L1 → 2. Перенести существующую строку/скидку или создать новую на номер удаляемой записи одним POST тоже нельзя: сначала сохраните удаление, затем новый номер. Для залога можно сначала отвязать `parent` одновременно с DELETE родителя, сохранив свободный прежний номер залога, затем перенумеровать его. Аналогично для итогов по налогу: освобождение занятой ставки и использование её другой записью сохраняются отдельно.
- **`statement_timeout=2000` мс.** Поиск идёт по `ILIKE`, списки считают строки; на больших таблицах запрос может превысить таймаут и дать HTTP 500. На больших объёмах не измерялось.
- **Страница чека** делает запросы на каждую позицию (автодополнение читает выбранные значения): число запросов растёт с числом строк чека.
- **Названия моделей и полей английские.** `verbose_name` у моделей нет, множественное число Django образует сам; там, где оно выходило неправильным, задано `verbose_name_plural`: `Categories`, `Countries`, `Currencies`, `Product aliases`, заголовок inline налогов на странице чека — `Receipt taxes`; интерфейс, подписи `choices`, заголовки сайта и сообщения форм — русские.
- **Пользователь админки — пропуск в будущие API.** В DRF действуют Session и Basic, глобальная permission — `IsAuthenticated`: сессия и пароль пользователя админки подойдут к любому будущему эндпоинту, если тот не задаст свои правила. Сейчас таких эндпоинтов нет, health аутентификацию отключает.
- **Персональные данные.** `extra`, `raw_text`, `fiscal` могут содержать данные с чека (кассир, ИНН); админка их показывает. Доступ — только `is_staff`; разграничения чеков между пользователями нет.
- **Миграций админка не добавляет**: `models.py` не менялся. Откат — revert кода `admin.py` и маршрута в `urls.py`; данные и схема при этом не затрагиваются. Пользователи и записи журнала действий остаются в таблицах `auth_*` и `django_admin_log`.

**Откат исправлений F1/F2/F4** — revert соответствующих коммитов `7aa388d`, `c895168`, `a686413` (код админок и их регрессионные тесты), без отката `urls.py` или миграций. F4 можно откатить отдельно: `git revert a686413` удалит его изменения `backend/receipts/admin.py` и `backend/receipts/tests/test_admin.py`; файлы моделей и settings он не менял. Данные, включая уже сохранённые `{}` у товаров, и журнал админки остаются на месте. Revert F4 возвращает риск удаления перенесённой строки с зависимостями другого чека, HTTP 500 при DELETE с правкой зависимостей и прежнюю обработку таймаутов блокировок. Revert F1/F2 возвращает риск рассинхронизации связей, ошибку пустых Attributes и гонку цикла. Откат не восстанавливает ранее утраченные данные — для этого требуется проверенный backup. В F3/F5 меняется только документация, её revert также не затрагивает данные и миграции; при откате кода описание и числа тестов нужно согласованно обновить. Эти команды — инструкция, фактический revert в итоговом прогоне не выполняется.

**Откат F6** — revert коммита задачи F6 (`git log --oneline --grep='F6'`), только кода/регрессий и согласованной документации. Модели, settings, миграции, данные и журнал действий не меняются; новые миграции не нужны. Откат возвращает риск HTTP 500 при DELETE+UPDATE, перестановке позиций/ставок и занятии unique-ключа после clean. Сохраняются ограничения и риски предыдущего состояния F4; ранее потерянные данные revert не восстанавливает.

## Миграции и откат

| Порядок | Миграция | Содержимое |
| --- | --- | --- |
| 1 | `catalog.0001_initial` | 4 таблицы каталога |
| 2 | `stores.0001_initial` | 5 таблиц справочников и магазинов |
| 3 | `stores.0002_seed_reference` | Сид-данные (`RunPython`) |
| 4 | `receipts.0001_initial` | 5 таблиц чеков; зависит от `catalog.0001` и `stores.0002` |
| 5 | `stores.0003_alter_country_options_alter_currency_options` | Только состояние: `verbose_name_plural` у `Country` и `Currency` |
| 6 | `receipts.0002_alter_receipttax_options` | Только состояние: `verbose_name_plural` у `ReceiptTax` |

Только новые таблицы; существующие технические таблицы Django не затрагиваются, расширения Postgres не нужны. Применение — `manage.py migrate --noinput`. У соединения `statement_timeout=2000` мс (`backend/config/settings.py`): на пустых таблицах миграции укладываются, тяжёлая data-миграция в будущем упрётся в него.

**Миграции названий** (`stores.0003`, `receipts.0002`) состоят только из `AlterModelOptions`: меняют состояние миграций, SQL не выполняют, схему и данные не затрагивают. Их откат так же ничего не меняет в базе и возвращает прежние названия только вместе с revert кода моделей:

```powershell
./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py migrate stores 0002_seed_reference --noinput
./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py migrate receipts 0001_initial --noinput
```

**Сид-данные** (`update_or_create`, повторное применение не дублирует): страны `KZ`, `RU`, `DE`; валюты `KZT`, `RUB`, `EUR`; ставки `DE 7%`, `DE 19%`, `KZ 16%`, `RU без НДС`. Остальные ставки создаются по мере появления на чеках. Категории и товары не сидируются.

**Откат** — строго в этом порядке:

```powershell
./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py migrate receipts zero --noinput
./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py migrate stores zero --noinput
./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py migrate catalog zero --noinput
```

> **Откат удаляет все данные чеков, магазинов и каталога без возможности восстановления.** Обратной миграции данных нет: таблицы удаляются. Перед откатом на ценных данных сделайте `pg_dump` и проверьте, что дамп восстанавливается. Единственный путь вернуть данные — восстановление из дампа.

Пример дампа для dev-проекта (для другой среды подставьте её project, пользователя и БД):

```powershell
docker compose -p checkist_dev exec -T postgres pg_dump -U checkist -d checkist_dev -Fc -f /tmp/checkist.dump
docker compose -p checkist_dev cp postgres:/tmp/checkist.dump ./checkist.dump
```

Файл дампа содержит данные чеков; в репозиторий его не добавляйте.

**`PROTECT` останавливает откат сид-миграции.** Обратная операция `stores.0002_seed_reference` удаляет только свои строки: три страны, три валюты, четыре ставки. Если на них есть ссылки — продавец или магазин в этой стране, другая ставка этой страны, — `migrate stores zero` завершается с `ProtectedError`, код возврата 1; транзакция откатывается, `stores.0002` остаётся применённой, данные не меняются. Это ожидаемое поведение, но из него следует порядок действий на непустой БД:

1. Сделать `pg_dump`.
2. **До** `migrate receipts zero` удалить через ORM всё, что ссылается на сид-строки, в порядке, который допускает `PROTECT`: чеки (`Receipt`), затем магазины (`Store`), затем продавцов (`Merchant`; их `ProductAlias` уйдут каскадом), затем ставки стран `KZ`, `RU`, `DE`, созданные не сидом.
3. Выполнить три команды отката.

Если сначала откатить `receipts`, а продавцы остались, удалить их через ORM текущего кода уже нельзя: каскад обращается к удалённой таблице `receipts_productalias` (`ProgrammingError`). Тогда остаётся удалить строки `stores_store` и `stores_merchant` прямым SQL либо вернуть схему командой `migrate` и начать с шага 2.

Повторное применение после полного отката — снова `migrate --noinput`: таблицы и сиды создаются заново, прежние данные не возвращаются.

## Известные ограничения

- **Нет курсов валют.** Цены лежат в валюте чека. API чтения пересчитывает цены только по курсам, переданным в запросе, и не хранит их; серверные курсы потребуют таблицы и источника данных.
- **Скидка на весь чек не распределяется по строкам** (`ReceiptDiscount.line IS NULL`) и в `paid_unit_price` и `normalized_price` не входит.
- **Локальный MEDIA.** Фото/вырезки хранятся на host filesystem; production storage, retention и cleanup не реализованы.
- **Нет владельца.** Пользователей в проекте нет, чеки ни к кому не привязаны и не разграничены.
- **Доступ локальный.** Прежние 13 GET открыты анонимно; новый API recognition/receipts требует DEBUG+флаг+loopback и CSRF для записи. Несопоставленные строки видны в новом `/api/receipts/{id}/lines/`, в API цен их нет. Произвольного HTTP редактирования нет; при внешнем развёртывании нужен другой контракт доступа.
- **Признак налога в ценах не выравнивается.** `Receipt.prices_include_tax` в истории цен и в API не учитывается: цены чеков с налогом и без него идут рядом как есть.
- OCR недетерминирован и может ошибаться; fake проверяет конвейер, не качество. Нет ReceiptDraft, MutationRequest/Idempotency-Key, manual_locked/отпечатка админской формы, отдельного WorkerSlot и POSIX watchdog. Причины сохраняются на ReceiptImage; UI ручного разрешения причин отсутствует.
- Валюты с тремя знаками после запятой не помещаются в `(14, 2)`.
- Сеть магазинов — только `Merchant.brand_name`; сопоставления названий не делятся между юрлицами одной сети.
- Периоды действия ставок налога, координаты магазина, тип скидки не хранятся.
- Образцы чеков в `backend/receipts/tests/samples.py` — тестовые данные, а не копии настоящих чеков: фото в репозитории нет, чеки Lidl синтетические, ФИО и ИНН физических лиц вымышлены. Подробности — в docstring модуля.
- Поведение на больших объёмах не измерялось: статистика замерена только на демо-базе (466 чеков, 5604 строки).

Команды проверки трёх приложений — в [verification.md](verification.md#модель-данных-catalog-stores-receipts).
