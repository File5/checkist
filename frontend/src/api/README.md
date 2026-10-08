# F1: контракт клиентских адаптеров для F3/F4/F5

Адаптеры читают схемы backend **`5e1adfa`**, сверенные через `git show 5e1adfa:docs/api-contract.md` и код `backend/api/{views/catalog.py,views/prices.py,common.py,pagination.py}`. Health остаётся отдельным адаптером с прежним контрактом. Каталог ещё не подключён к экранам этой ветки: результат F1 — типы, запросы, валидация, форматирование и unit-тесты.

Клиент слияния дублей товаров (Ф1) описан отдельно: [PRODUCT_MERGES.md](PRODUCT_MERGES.md).

Вход, сессия и поведение транспорта при `401` / `403` (К1-А) — в разделе [Сессия и транспорт](#сессия-и-транспорт-к1-а); он действует поверх текста F1 ниже.

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

`RequestOptions.baseUrl` — публичный префикс, default `import.meta.env.VITE_API_BASE_URL || '/api'`; завершающие/повторяющиеся слэши нормализуются как в health. `signal` принадлежит экрану. Общий deadline **15 секунд на fetch + чтение JSON**, timer/listener удаляются после завершения. Все запросы идут с `Accept: application/json`, `credentials: 'same-origin'` (cookie сессии своего origin; до К1-А открытые GET шли с `omit`; health — отдельный адаптер, он остаётся с `omit`), `cache: 'no-store'`. Последнее — клиентская настройка, серверный Cache-Control каталога не предполагается.

Для Node 24 CLI используйте импорты с `.ts` и явный `baseUrl`, например:

```js
import { getProducts } from './frontend/src/api/catalog.ts'
const result = await getProducts(
  { page: 1, page_size: 2 },
  { baseUrl: 'http://127.0.0.1:15173/api', signal: controller.signal },
)
```

## Сессия и транспорт (К1-А)

Серверный контракт — `backend/api/views/auth.py`, эталоны — `backend/api/tests/fixtures/auth/*.json` (тесты читают их напрямую, копий нет).

### Транспорт (`http.ts`, `auth-signal.ts`)

| Ответ сервера | Результат адаптера | Сигнал |
| --- | --- | --- |
| `401` + `{"error": {"code": "not_authenticated", "message"}}` | `{ kind: 'aborted' }` — экран не показывает ошибку | `unauthenticated`, ровно один на ответ |
| `401` с любым другим телом | `invalid_response` | нет |
| `403 permission_denied` у локального запроса | прежний `permission_denied` | `forbidden` |
| остальное | как раньше | нет |

`ApiErrorReason` и `LocalApiErrorReason` не расширены: исчерпывающие `switch` экранов не меняются. Запрос, который владелец уже отменил, сигнал не шлёт. Автоматических повторов нет.

```ts
// auth-signal.ts — без React и без импортов
type AuthSignal = 'unauthenticated' | 'forbidden'
onAuthSignal(listener: (signal: AuthSignal) => void): () => void   // возвращает отписку
reportAuthSignal(signal: AuthSignal): void                          // сбой слушателя не ломает запрос
```

`JsonRequest.emptyStatuses` — статусы успеха без тела (`204`): тело не читается, валидатор получает `null`. `sendJson` — тот же транспорт с собственным разбором отказа; им пользуется только `session.ts`.

### Адаптеры (`session.ts`, guard — `session-schema.ts`)

```ts
type Me = {
  mode: 'accounts' | 'local_single'
  user: { id: number; username: string; is_staff: boolean }
  permissions: { moderate_catalog: boolean }
  csrf_token: string            // не выводить и не хранить вне адаптеров
}
type AuthResult<T> = { kind: 'ok'; data: T } | AuthFailure | { kind: 'aborted' }
type AuthFailure = { kind: 'error'; reason: AuthFailureReason; status?: number
  fields?: string[]; retryAfter?: number; passwordIssues?: PasswordIssue[] }
type PasswordIssue = 'too_short' | 'too_common' | 'entirely_numeric' | 'too_similar'

getMe(options?): Promise<AuthResult<Me>>
login({ username, password }, options?): Promise<AuthResult<Me>>
logout(options?): Promise<AuthResult<null>>
changePassword({ current_password, new_password }, options?): Promise<AuthResult<Me>>
clearAuthCsrf(options?): void   // тестам и скриптам, которые сами меняют cookie
```

| Вызов | Запрос | Что различает клиент |
| --- | --- | --- |
| `getMe` | `GET me/` | `200` «Я»; `401 not_authenticated` → `reason: 'not_authenticated'` — это **гость**, сигнал не шлётся |
| `login` | `GET auth/csrf/` (если токена нет), затем `POST auth/login/` | `200` «Я»; `401 invalid_credentials` (сигнал не шлётся); `429 login_throttled` + `retryAfter` (секунды из тела, заголовок не читается); `400 invalid_parameter` с `fields` / `invalid_request`; `403 csrf_failed`; `404 not_found` в `local_single` |
| `logout` | `POST auth/logout/`, тело `{}` | `204` без тела → `data: null`; гостю тоже `204` |
| `changePassword` | `POST auth/password/` | `200` «Я» (эта сессия жива); `400 invalid_parameter`: `fields` — `current_password` либо `new_password`, для нового пароля `passwordIssues`; `429 login_throttled`; `401 not_authenticated` → `aborted` + сигнал `unauthenticated`, как у любого запроса посреди сеанса |

Прочие `reason`: `server`, `network`, `timeout`, `invalid_response` (в него попадает всё вне контракта: `429` без пригодного `retry_after`, неизвестный код причины пароля, `401` с чужим кодом). Серверные фразы и пароль в результат не попадают.

Токен CSRF этих POST живёт только в памяти модуля, отдельно для каждого `baseUrl`: до входа — из анонимного `GET auth/csrf/`, после входа и смены пароля — из ответа «Я». `403 csrf_failed` забывает токен; POST не повторяется, следующая явная попытка берёт новый. Успешные вход, выход и смена пароля сбрасывают и токен локального API (`clearRecognitionCsrf`): Django меняет его при входе. `src/api/local.ts` не менялся — после сброса `mutate` сам читает `recognition/csrf/` (в `accounts` он требует входа).

Для Node-скриптов адаптеры пригодны с явным `baseUrl`; cookie (`csrftoken`, `sessionid`) скрипт переносит сам.

### Хранилище (`../session/store.ts`, хук — `../session/index.ts`)

```ts
type Session =
  | { kind: 'loading' } | { kind: 'error' }
  | { kind: 'guest'; expired: boolean }
  | { kind: 'user'; mode: Me['mode']; user: Me['user']; permissions: Me['permissions'] }

getSession(): Session
subscribeSession(listener: () => void): () => void
loadSession(signal?: AbortSignal): Promise<void>   // GET /api/me/
applyMe(me: Me | null): void                        // «Я» из ответа входа или смены пароля; null — после выхода
canModerate(session: Session): boolean
permissionDeniedText(session: Session): string
useSession(): Session                               // только из index.ts
```

- `loadSession`: `200` → `user`; `401 not_authenticated` → `guest`; сбой первого чтения → `error`, повтор из `error` проходит через `loading`. Уже известная сессия (`user` / `guest`) перечитывается тихо: без `loading`, сбой чтения её не меняет. Из двух пересекающихся чтений применяется только последнее; ответ, запрошенный до `applyMe` или до конца сеанса, отбрасывается.
- `guest.expired` — сеанс закончился посреди работы (сигнал `unauthenticated` либо `401` при перечитывании пользователя); пометка держится до входа. После выхода — `expired: false`.
- Сигнал `forbidden` у пользователя `accounts` перечитывает «Я» (одно чтение на несколько отказов): так обнаруживается отозванное право. В `local_single`, у гостя и до первого чтения оба сигнала игнорируются.
- Снимок не пересоздаётся и подписчики не будятся, пока не изменились режим, пользователь или право. Токен CSRF в сессии не хранится.
- `applyMe`, конец сеанса и смена пользователя при чтении сбрасывают токен локального API; перечитывание того же пользователя — нет (иначе оборвался бы идущий POST).
- `canModerate` — право `permissions.moderate_catalog` (в `local_single` оно есть всегда); `is_staff` права не даёт.
- `permissionDeniedText`: пользователю `accounts` — «Нет права модератора каталога.», иначе прежний текст про `ALLOW_LOCAL_RECOGNITION_API=1`.
- `store.ts` не использует `window` и React; `resetSession` в нём — только для тестов. Хранилище рассчитано на браузер и Vitest: без `baseUrl` оно читает `import.meta.env`, Node-скриптам нужны адаптеры, а не оно.

### Отличия от плана А3 (раздел 2.1)

- `getMe` возвращает `AuthResult<Me>`, а не `ApiResult<Me>`: анониму в `accounts` сервер отвечает `401`, и гостя нужно отличить от сбоя.
- В «Я» нет `user: null` и `is_moderator`: право — `permissions.moderate_catalog`, поэтому в `Session` есть `permissions`.
- `logout` возвращает `AuthResult<null>` (сервер отвечает `204`), `applyMe` принимает `null` для выхода.
- В `AuthFailureReason` добавлены `not_authenticated` (только `getMe`) и `not_found` (`local_single`).

### Не проверено (К1-А)

Разработчик запускал только статические проверки: `npx.cmd tsc -b` и `npm.cmd run lint` — exit 0. Тесты и сборку не запускал. Для QA, в `frontend/`: `npm.cmd ci`, `npm.cmd run lint`, `npm.cmd run test`, `npm.cmd run build`. Настоящий HTTP входа (cookie `sessionid`, смена токена Django при входе, `204` через Vite proxy) проверяет скрипт подзадачи К1-Д; поведение в браузере — ручная приёмка.

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
| `formatPrice(value: Decimal \| null, currency: CurrencyCode, unit?: Unit \| null)` | Ровно 2 знака + код валюты + `/единица`, если указана; ненулевая цена, которая при 2 знаках дала бы `0,00`, — до 4 знаков без хвостовых нулей |
| `formatQuantity(value: Decimal \| null, unit?: Unit \| null)` | До 3 знаков + единица, если указана |
| `formatPercent(value: Decimal \| null)` | 2 знака + `%` |
| `formatIndex(value: Decimal \| null)` | Индекс цен: ровно 4 знака, без валюты и единицы |
| `formatUnit(unit: Unit \| null)` | `шт`, `г`, `кг`, `мл`, `л`, `м` |
| `formatPurchasedOn(value: ISODate \| null)` | `ДД.ММ.ГГГГ`, перестановка частей календарной даты без UTC-сдвига |
| `formatObservedAt(value: ISODateTime \| null, timezone?: string \| null)` | `Intl.DateTimeFormat('ru-RU')` в зоне магазина; при отсутствующей/неверной зоне — явно подписанный `UTC`; дата, время и подпись `UTC` склеены неразрывными пробелами |

Decimal обрабатывается строками/`BigInt`, без `Number` и денежных расчётов. Разделитель дроби — запятая, групп — неразрывный пробел U+00A0; он же стоит перед кодом валюты, единицей количества и знаком `%`, поэтому значение не разрывается внутри числа. Лишняя точность округляется для отображения ROUND_HALF_UP; исходная строка не меняется. Отрицательный ноль отображается как ноль.

Сервер отдаёт цену за единицу с 4 знаками (`"130.5882"`) — это запас точности, а не вид для показа. Правило вывода:

| Значение | Знаков | Пример |
|---|---|---|
| Сумма, итог, скидка, налог (`formatAmount`) | ровно 2 | `111.00` → `111,00 RUB` |
| Цена за единицу, мин. / макс. / средняя, «сумма на позицию» (`formatPrice`) | ровно 2 | `130.5882` → `130,59 RUB/л`; `111.0000` → `111,00 RUB`; `2.5000` → `2,50 EUR`; `9.99995` → `10,00 EUR` |
| Та же цена, если она не ноль, но при 2 знаках даёт `0,00` | до 4, хвостовые нули срезаются | `0.0049` → `0,0049 EUR/г`; `-0.0049` → `-0,0049 EUR/г`; `0.0050` → `0,01 EUR/г`; `0.0000` → `0,00 EUR/г` |
| Количество, фасовка (`formatQuantity`) | до 3, хвостовые нули срезаются | `0.294` → `0,294 кг`; `850.000` → `850 мл` |
| Проценты (`formatPercent`) | ровно 2 | `-3.81` → `-3,81 %` |
| Индекс цен (`formatIndex`) | ровно 4 | `1.2404` → `1,2404`; `1` → `1,0000` |
| Нет значения или строка не число | — | `null` → `—` |

Цена и сумма в одной строке таблицы получают одинаковое число знаков. Цена меньше 0,01 показывается точнее намеренно: «0,00» читалось бы как «бесплатно». Поля формы исправления вырезки (`features/recognition/review-state.ts`) этим правилом не пользуются — они показывают серверную строку как есть. Подписи осей графиков форматируются отдельно (`lib/charts`, экраны графиков).

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
