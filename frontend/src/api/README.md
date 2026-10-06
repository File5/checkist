# F1: контракт клиентских адаптеров для F3/F4/F5

Адаптеры читают схемы backend **`5e1adfa`**, сверенные через `git show 5e1adfa:docs/api-contract.md` и код `backend/api/{views/catalog.py,views/prices.py,common.py,pagination.py}`. Health остаётся отдельным адаптером с прежним контрактом. Каталог ещё не подключён к экранам этой ветки: результат F1 — типы, запросы, валидация, форматирование и unit-тесты.

Клиент слияния дублей товаров (Ф1) описан отдельно: [PRODUCT_MERGES.md](PRODUCT_MERGES.md).

## Функции и результаты

Все функции возвращают `Promise<ApiResult<T>>`. Типы импортируются из `types.ts`, функции — из соответствующего модуля. `params` и `options` необязательны и по умолчанию `{}`; ID — обязательный положительный безопасный `number`.

| Модуль | Сигнатура | `T` в результате |
| --- | --- | --- |
| `catalog.ts` | `getCategories(params?: CategoryParams, options?: RequestOptions)` | `Results<Category>` — плоское дерево `{results}` |
| `catalog.ts` | `getCategory(id: number, options?: RequestOptions)` | `CategoryDetail` — узел, `children`, `generic_products` |
| `catalog.ts` | `getGenericProducts(params?: GenericProductParams, options?: RequestOptions)` | `Page<GenericProduct>` |
| `catalog.ts` | `getGenericProduct(id: number, options?: RequestOptions)` | `GenericProduct` |
| `catalog.ts` | `getProducts(params?: ProductParams, options?: RequestOptions)` | `Page<Product>` |
| `catalog.ts` | `getProduct(id: number, options?: RequestOptions)` | `ProductDetail` |
| `prices.ts` | `getProductPrices(productId: number, params?: PriceParams, options?: RequestOptions)` | `PriceHistory` — `product` + `Page<PricePoint>` |
| `prices.ts` | `getProductPriceSummary(productId: number, params?: PriceSummaryParams, options?: RequestOptions)` | `PriceSummary` |
| `stores.ts` | `getStores(params?: StoreParams, options?: RequestOptions)` | `Page<StoreEntry>` |

```ts
type RequestOptions = { signal?: AbortSignal; baseUrl?: string }
type Results<T> = { results: T[] }
type Page<T> = Results<T> & {
  count: number; page: number; page_size: number; pages: number
}
type ApiResult<T> =
  | { kind: 'ok'; data: T }
  | { kind: 'aborted' }
  | {
      kind: 'error'
      reason: ApiErrorReason
      status?: number
      fields?: string[]
    }
```

`reason`: `invalid_parameter`, `invalid_request`, `range_too_large` (400); `not_found`, `page_out_of_range` (404); `server` (500 `internal_error`); `network`, `timeout`, `invalid_response`. Последний включает неверные JSON/схему/HTTP–тело и proxy 502/504. `fields` — **только имена** полей, не сообщения сервера. Серверные `message` и тексты `fields` проверяются и отбрасываются. Локально недопустимый ID возвращает `invalid_parameter` с именами полей без HTTP `status`; ответ сервера с небезопасным ID возвращает `invalid_response`.

Отмена — отдельный `kind: 'aborted'`. Экран не переводит её в состояние ошибки. Владелец экрана сохраняет проверку поколения запроса и сигнала перед изменением React state, в том числе после успешного ответа.

Пустая первая страница: `count: 0, page: 1, pages: 0, results: []`. `next`/`previous` нет. Для `page_out_of_range` экран предлагает первую страницу; адаптер сам не повторяет запрос. Дерево категорий уже упорядочено сервером; `parent_id` может указывать на цикл/отсутствующего родителя, поэтому для крошек/глубины используйте серверные `path` и `depth`.

## Параметры

Имена соответствуют query backend, без переименования. Пустые строки передаются как пустые значения, `undefined` пропускается; нормализацию поиска/валидацию диапазона выполняет backend. `URLSearchParams` кодирует UTF-8, `%`, `+`, `&`, `/`, `?`, `#`.

| Тип | Поля (все необязательные) |
| --- | --- |
| `PageParams` | `page: number`, `page_size: number` |
| `CategoryParams` | `q: string` |
| `GenericProductParams` | `PageParams` + `q: string`, `category: number` |
| `ProductParams` | `PageParams` + `q: string`, `category: number`, `generic: number`, `brand: number`, `country: CountryCode`, `has_prices: boolean`, `ordering: ProductOrdering` |
| `StoreParams` | `PageParams` + `q: string`, `country: CountryCode` |
| `PriceFilters` | `store: number`, `country: CountryCode`, `currency: CurrencyCode`, `date_from: ISODate`, `date_to: ISODate` |
| `PriceParams` | `PriceFilters` + `PageParams` + `ordering: 'observed_at' \| '-observed_at'` |
| `PriceSummaryParams` | `PriceFilters` + `group_by: PriceGroupBy`, `interval: PriceInterval`, `price: PriceMode` |

`ProductOrdering`: `name`, `-name`, `last_observed_at`, `-last_observed_at`. `PriceGroupBy`: `country`, `store`, `none`. `PriceInterval`: `none`, `day`, `week`, `month`. `PriceMode`: `paid`, `list`, `normalized`. `has_prices` сериализуется как `1`/`0`. История по умолчанию имеет серверный порядок `observed_at`; экран для новых записей сначала передаёт `-observed_at` явно. Размер страницы по умолчанию задаёт сервер: 50/max 200 для списков, 200/max 500 для истории.

`RequestOptions.baseUrl` — публичный префикс, default `import.meta.env.VITE_API_BASE_URL || '/api'`; завершающие/повторяющиеся слэши нормализуются как в health. `signal` принадлежит экрану. Общий deadline **15 секунд на fetch + чтение JSON**, timer/listener удаляются после завершения. Все запросы анонимные, с `Accept: application/json`, `credentials: 'omit'`, `cache: 'no-store'`. Последнее — клиентская настройка, серверный Cache-Control каталога не предполагается.

Для Node 24 CLI используйте импорты с `.ts` и явный `baseUrl`, например:

```js
import { getProducts } from './frontend/src/api/catalog.ts'
const result = await getProducts(
  { page: 1, page_size: 2 },
  { baseUrl: 'http://127.0.0.1:15173/api', signal: controller.signal },
)
```

## Экспортируемые типы данных

Полные поля находятся в `types.ts`; сохранены snake_case и nullable-поля фактического JSON. Результат — валидированное исходное тело без числового преобразования Decimal или удаления строк.

- Базовые: `Decimal`, `ISODate`, `ISODateTime`, `CountryCode`, `CurrencyCode` (строки), `Unit` (`pcs/g/kg/ml/l/m`), `BaseUnit` (`pcs/kg/l`), `NormalizedUnit` (`pcs/kg/l/m`). Валюта берётся из наблюдения, фактическая единица нормализации — из `normalized_unit`.
- Категории/каталог: `NamedObject`, `CategoryRef`, `Category`, `GenericRef`, `CategoryGeneric`, `CategoryDetail`, `GenericProduct`, `Product`, `ProductDetail`, `ProductAlias`, `JsonValue`.
- Магазины/последние цены: `StoreBrief`, `Store`, `StoreEntry`, `ProductStore`, `NormalizedPrice`, `LastProductPrice`, `ProductPrice`.
- История/сводка: `PriceProduct`, `PricePoint`, `PriceHistory`, `DatedPrice`, `PriceTotal`, `PriceBucket`, `PriceSummaryGroup`, `PriceSummary`.
- Управление запросами: `ApiErrorReason`, `ApiFailure`, `ApiResult<T>`, `RequestOptions`, `Results<T>`, `Page<T>` и перечисленные выше типы параметров/сортировок/режимов.

`PriceSummary` — discriminated union: `group_by: 'country'` даёт группы с `country`, `'store'` — с полным `store`, `'none'` — без этих полей. Только `price: 'normalized'` содержит обязательный `skipped_without_normalized`. `change_percent: null` означает отсутствие показателя. Группы разделены валютой и единицей; клиент не рассчитывает агрегаты по странице истории и не добавляет пропущенные интервалы.

`ProductDetail.attributes` — произвольный `JsonValue`, включая массив, scalar и null. Его нельзя считать фиксированной формой UI. `aliases` и `stores` в карточке ограничены backend 50 без признака усечения. Справочник `getStores` поддерживает поиск/пагинацию всех магазинов; фильтров товара и валюты у него нет. В `PricePoint.store` нет адреса/timezone: обогащайте по `store.id` из карточки/справочника с локальным состоянием отказа.

## Форматирование (`../lib/format.ts`)

Все функции возвращают `string`. `null` и некорректное входное значение дают `—`, ноль остаётся нулём.

| Сигнатура | Представление |
| --- | --- |
| `formatAmount(value: Decimal \| null, currency: CurrencyCode)` | 2 знака + явный код валюты |
| `formatPrice(value: Decimal \| null, currency: CurrencyCode, unit?: Unit \| null)` | До 4 знаков + код валюты + `/единица`, если указана |
| `formatQuantity(value: Decimal \| null, unit?: Unit \| null)` | До 3 знаков + единица, если указана |
| `formatPercent(value: Decimal \| null)` | 2 знака + `%` |
| `formatUnit(unit: Unit \| null)` | `шт`, `г`, `кг`, `мл`, `л`, `м` |
| `formatPurchasedOn(value: ISODate \| null)` | `ДД.ММ.ГГГГ`, перестановка частей календарной даты без UTC-сдвига |
| `formatObservedAt(value: ISODateTime \| null, timezone?: string \| null)` | `Intl.DateTimeFormat('ru-RU')` в зоне магазина; при отсутствующей/неверной зоне — явно подписанный `UTC` |

Decimal обрабатывается строками/`BigInt`, без `Number` и денежных расчётов. Разделитель дроби — запятая, групп — неразрывный пробел U+00A0. Лишняя точность округляется для отображения ROUND_HALF_UP; исходная строка не меняется. Отрицательный ноль отображается как ноль. Например: `-130.5882 RUB/l` → `-130,5882 RUB/л`; `0.00 RUB` → `0,00 RUB`; `null` → `—`.

## Проверено и прошло

Среда: Windows, Node `v24.18.0`, npm `11.16.0`, Vitest `5.0.3`. БД не используется, fetch в автоматических проверках заменён mocks.

| Команда | Exit code | Фактический результат |
| --- | --- | --- |
| `npm.cmd ci` (в `frontend/`) | 0 | 188 пакетов, audit: 0 vulnerabilities; предупреждение о deprecated ESLint 9.39.5 из существующего lock |
| `npm.cmd run lint` | 0 | ESLint без ошибок/предупреждений |
| `npm.cmd run test` | 0 | **336 тестов**, 6 файлов, включая неизменённый `health.test.ts` |
| `npm.cmd run build` | 0 | TypeScript и Vite build прошли; экраны каталога этим не подтверждены |
| `node --input-type=module -` (из корня, inline smoke с mocked fetch) | 0 | Все 9 адаптеров импортированы/вызваны нативным Node с явным baseUrl; отдельно проверены формат цены и timezone |
| `git diff --check` | 0 | Нет ошибок whitespace |

Тесты охватывают схемы/nullable/массивы/пустые страницы, вложенные unsafe ID, точные signed Decimal, query encoding, ошибки 400/404/500, page_out_of_range, JSON/schema/proxy 502/504, сети/повтор, общий deadline fetch+body, abort/поздние ответы/cleanup. Форматирование проверено на больших числах, знаке/нуле, округлении, единицах, календарных датах, переходах через полночь/DST и неизвестной timezone.

## Проверено и не прошло

- Первый `npm.cmd run test` — exit 1: 2 failed / 332 passed. В новом тесте пустых страниц повторно использовался уже прочитанный `Response`; в ожидаемом числе был блок `010` вместо `001`. Исправлены тестовые данные/создание нового ответа; окончательный прогон — 336/336. Проверки и ожидания не отключались.
- Первый `node --input-type=module -` smoke — exit 1: PowerShell передал кириллическую букву `л` в ожидаемой строке через stdin как `?`. Все вызовы адаптеров до этого assertion завершились. Ожидание записано ASCII escape `\u043b`; повтор полного smoke — exit 0, исходники продукта не менялись из-за этого отказа.

## Не проверено и почему; ручная приёмка

Реальный HTTP каталога/цен/магазинов, QA БД и Vite proxy **не проверены**: backend `5e1adfa` ещё не слит в эту ветку, разрешённый F1 scope ограничен frontend-адаптерами. Сборка не подтверждает React-поведение; автоматический обход browser UI запрещён. Новых экранов в F1 нет, скриншоты и статические макеты не создавались. Этот markdown — реальный артефакт передачи интерфейсов для следующих этапов.

После интеграции backend и F2–F5 человек/интегратор выполняет:

1. Подготовить отдельную QA по `docs/verification.md` и подготовительному ответу `task_mutu93ml5l`: полный environment, Postgres 25432/Redis 16379, API 18000, Vite 15173. Использовать свободную QA и представительные вымышленные данные; не обращаться к dev. Запустить API каталога, в `frontend/` — `npm.cmd run dev -- --port 15173`.
2. Проверить реальным HTTP/CLI все перечисленные URL с явным baseUrl `http://127.0.0.1:15173/api`: пустые/непустые списки, две страницы, карточку, историю и summary, фильтры. Сверить HTTP/JSON, nullable и Decimal с API. CLI F5 ещё не реализован этой задачей.
3. В браузере пройти категории → товары → карточка → история. Сверить большие/отрицательные/нулевые Decimal, код валюты, фактическую единицу и `null`. Дата `purchased_on` должна оставаться календарной; момент около полуночи — в зоне точки; неизвестная зона — с подписью UTC.
4. Быстрая смена фильтров/уход не показывает ошибку отмены и не применяет старый ответ. Задержка fetch или body более 15 с — локальный timeout; Offline/Online — безопасная ошибка и новый запрос по повтору. 400 предлагает исправить ввод, page_out_of_range — первую страницу. Отказы истории/summary/справочника не удаляют успешную карточку.
5. После подключения экранов проверить клавиатуру/focus/labels, ширины 320/375/768/1280, zoom 200%, длинные тексты и локальную прокрутку таблицы по сценарию F2–F5. Это ручная приёмка, в F1 она не выполнялась.

После QA остановить только свои API/Vite процессы и выполнить `docker compose -p checkist_qa down` без `-v`. Merge/publish/deployment не выполнялись.
