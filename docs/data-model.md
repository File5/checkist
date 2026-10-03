# Модель данных Checkist

Документ описывает код в `backend/catalog`, `backend/stores`, `backend/receipts` по состоянию ветки. Источник истины — `models.py` и миграции этих приложений; при расхождении прав код, документ исправляется.

Реализованы таблицы, ограничения БД, функции нормализации, дедупликации, проверки чека и истории цен, а также тесты. Для ручного ввода и правки подключён Django admin — см. [«Админка»](#админка). **HTTP API и распознавания нет**: данные создаются через админку или кодом (shell, тесты). Фото чека, владелец-пользователь и курсы валют не хранятся — см. [известные ограничения](#известные-ограничения).

## Приложения и таблицы

| Приложение | Назначение | Таблицы |
| --- | --- | --- |
| `stores` | Справочники и магазины | `stores_country`, `stores_currency`, `stores_taxrate`, `stores_merchant`, `stores_store` |
| `catalog` | Каталог товаров двух уровней | `catalog_category`, `catalog_genericproduct`, `catalog_brand`, `catalog_product` |
| `receipts` | Чеки и сопоставление названий | `receipts_receipt`, `receipts_receiptline`, `receipts_receiptdiscount`, `receipts_receipttax`, `receipts_productalias` |

`stores` и `catalog` друг от друга не зависят; `receipts` ссылается на оба. `catalog/units.py` принадлежит `catalog`, `receipts` его импортирует.

Общие правила:

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

`normalized_price`:

- строка в `kg`, `g`, `l`, `ml` — оплаченная цена, приведённая к кг или л;
- штучная строка (`pcs`) с сопоставленным товаром, у которого задана фасовка, — оплаченная цена, делённая на фасовку в базовых единицах (`111.00` за `850 ml` → `130.5882` за литр);
- иначе `NULL`: штучная строка без товара или без фасовки, строка в метрах.

Нормализация считается от неокруглённой цены. Совпадение единицы фасовки с `GenericProduct.base_unit` не проверяется: товар с фасовкой в граммах даст цену за кг, даже если у обобщённого продукта `base_unit='l'`.

Цены лежат в валюте чека. Выборка использует индекс `(product, receipt)`; замеров на больших объёмах нет.

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

Нарушения — **предупреждения, а не отказ в сохранении**: будущий источник данных — распознавание, и чек с ошибкой в одной цифре лучше сохранить, чем потерять. Функцию нужно вызывать явно, `save()` её не вызывает.

Приложение же отвечает за сборку `fiscal_key`, `address_key` (кроме случая `Store.save()` с пустым ключом) и `name_key`, за вызов `find_duplicates` и `find_alias`.

**Никем не проверяется:** `receipt.discount_total` против суммы скидок; `store.country` против `merchant.country`; соответствие валюты стране; соответствие `fiscal_key` содержимому `fiscal`; значения `choices` вне `full_clean()`; содержимое JSON-полей; формат `gtin`, `tax_id`, `timezone` при сохранении. Форма админки закрывает часть этого списка — `choices`, существование `timezone`, сборку пустого `fiscal_key` — но только для ввода через админку; запись кодом по-прежнему ничем не проверяется.

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
| `Product` | Фильтр `package_unit`; поиск по `name`, `gtin`, `model`, названию бренда | `generic`, `brand` — автодополнение |
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
- **Магазин.** Дубликат `(merchant, address_key)` и адрес без букв и цифр (пустой ключ) — ошибка у поля `address_raw`. `timezone` должен быть существующим поясом IANA.
- **Категория.** Родителем не может быть сама категория или её потомок: БД циклы не запрещает.
- **Чек.** Дубликат по собранному `fiscal_key`; ключ длиннее 160 символов — ошибка у поля `fiscal`.
- **Строка чека.** `parent` должен быть строкой этого же чека и не самой строкой; то же для `line` у скидки.
- **Сопоставление.** Дубликат `(merchant, name_key, store_item_code)` — ошибка у поля `raw_name`.

**Предупреждения чека.** На странице сохранённого чека блок «Предупреждения проверки» показывает результат `validate_receipt` (см. [выше](#что-гарантирует-бд-а-что-приложение)). Это предупреждения: сохранению они не мешают. На странице добавления блок сообщает, что предупреждения появятся после сохранения.

**Удаление** идёт через ORM. Объект, на который есть ссылки с `PROTECT` (например, страна с продавцами), удалить нельзя — админка показывает отказ. Для `CASCADE` страница подтверждения перечисляет всё, что будет удалено: у чека — его строки, скидки и итоги по налогам. Сид-строки справочников без ссылок удалить можно; `migrate` их не вернёт.

### Ограничения админки

- **Только локальные dev и QA.** `STATIC_ROOT` и `collectstatic` не настроены, при `DJANGO_DEBUG=0` статика админки не отдаётся. Нет `SESSION_COOKIE_SECURE`, `CSRF_COOKIE_SECURE`, перенаправления на HTTPS, HSTS и защиты от подбора пароля. В production в таком виде админку выставлять нельзя.
- **Открывается напрямую на Django**, не через Vite: proxy передаёт только `/api`.
- **`purchased_at` вводится в UTC** (`TIME_ZONE = "UTC"`), а `purchased_on` — локальная дата магазина, как на чеке. Подсказки стоят у обоих полей; расхождение показывает блок предупреждений.
- **Перестановка `position`.** Поменять номера двух строк одним сохранением нельзя: ограничение unique `(receipt, position)` даёт ошибку формы. Переставляйте через свободный номер: первой строке — свободный номер, сохранить, затем второй и первой — нужные.
- **`statement_timeout=2000` мс.** Поиск идёт по `ILIKE`, списки считают строки; на больших таблицах запрос может превысить таймаут и дать HTTP 500. На больших объёмах не измерялось.
- **Страница чека** делает запросы на каждую позицию (автодополнение читает выбранные значения): число запросов растёт с числом строк чека.
- **Названия моделей и полей английские.** `verbose_name` у моделей нет, множественное число Django образует сам — отсюда `Countrys` и `Currencys` в списке разделов; интерфейс, подписи `choices`, заголовки сайта и сообщения форм — русские.
- **Пользователь админки — пропуск в будущие API.** В DRF действуют Session и Basic, глобальная permission — `IsAuthenticated`: сессия и пароль пользователя админки подойдут к любому будущему эндпоинту, если тот не задаст свои правила. Сейчас таких эндпоинтов нет, health аутентификацию отключает.
- **Персональные данные.** `extra`, `raw_text`, `fiscal` могут содержать данные с чека (кассир, ИНН); админка их показывает. Доступ — только `is_staff`; разграничения чеков между пользователями нет.
- **Миграций админка не добавляет**: `models.py` не менялся. Откат — revert кода `admin.py` и маршрута в `urls.py`; данные и схема при этом не затрагиваются. Пользователи и записи журнала действий остаются в таблицах `auth_*` и `django_admin_log`.

## Миграции и откат

| Порядок | Миграция | Содержимое |
| --- | --- | --- |
| 1 | `catalog.0001_initial` | 4 таблицы каталога |
| 2 | `stores.0001_initial` | 5 таблиц справочников и магазинов |
| 3 | `stores.0002_seed_reference` | Сид-данные (`RunPython`) |
| 4 | `receipts.0001_initial` | 5 таблиц чеков; зависит от `catalog.0001` и `stores.0002` |

Только новые таблицы; существующие технические таблицы Django не затрагиваются, расширения Postgres не нужны. Применение — `manage.py migrate --noinput`. У соединения `statement_timeout=2000` мс (`backend/config/settings.py`): на пустых таблицах миграции укладываются, тяжёлая data-миграция в будущем упрётся в него.

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

- **Нет курсов валют.** Цены лежат в валюте чека; сравнение между странами в одной валюте потребует таблицы курсов и их источника.
- **Скидка на весь чек не распределяется по строкам** (`ReceiptDiscount.line IS NULL`) и в `paid_unit_price` и `normalized_price` не входит.
- **Нет фото чека.** Хранилище файлов не выбрано, `MEDIA_ROOT` не настроен.
- **Нет владельца.** Пользователей в проекте нет, чеки ни к кому не привязаны и не разграничены.
- **Нет HTTP API.** Бизнес-эндпоинтов нет: данные вводятся через [админку](#админка) или кодом — из `manage.py shell` и тестов. Ограничения самой админки перечислены в её разделе.
- Нет распознавания: `raw_text` и фискальные реквизиты заполняет вызывающий код.
- Валюты с тремя знаками после запятой не помещаются в `(14, 2)`.
- Сеть магазинов — только `Merchant.brand_name`; сопоставления названий не делятся между юрлицами одной сети.
- Периоды действия ставок налога, координаты магазина, тип скидки не хранятся.
- Образцы чеков в `backend/receipts/tests/samples.py` — тестовые данные, а не копии настоящих чеков: фото в репозитории нет, чеки Lidl синтетические, ФИО и ИНН физических лиц вымышлены. Подробности — в docstring модуля.
- Поведение на больших объёмах не измерялось.

Команды проверки трёх приложений — в [verification.md](verification.md#модель-данных-catalog-stores-receipts).
