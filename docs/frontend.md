# Frontend Checkist

## Каркас и навигация

`App.tsx` владеет оболочкой: шапкой «Каталог / Состояние сервисов», единственным `h1`, document title и содержимым текущего маршрута. При первом открытии и смене pathname фокус переходит на `h1#page-heading` (`tabIndex=-1`); изменение только query не забирает фокус из формы. Есть ссылка «К содержимому». Каталог не запрашивает health и не зависит от его результата. F5 подключает настоящие `CatalogPage`, `CategoryPage` (F3) и `ProductPage` (F4) вместо точек подключения F2; данные загружаются адаптерами F1, runtime-mocks и вымышленных цен в UI нет.

| URL | Экран и query |
| --- | --- |
| `/`, `/catalog` | Каталог; `q`, `generic`, `page` |
| `/catalog/categories/:id` | Категория; `q`, `generic`, `page` |
| `/catalog/products/:id` | Товар и история; `store`, `country`, `currency`, `date_from`, `date_to`, `page` |
| `/health` | Прежний технический health-экран |
| Неизвестный путь или неверный ID | «Страница не найдена», ссылка «В каталог» |

`/` — алиас каталога без принудительного redirect; build создаёт `/catalog`. Один завершающий слэш допустим. ID и page — положительные safe integers, небезопасные значения не округляются. Первая страница подразумевается и при build не записывается. Поиск trim, 2–100 Unicode code points; пустое значение означает отсутствие фильтра. Коды стран/валют приводятся к верхнему регистру, проверяется их синтаксис; существование в справочнике проверяет API. Даты — настоящие календарные `YYYY-MM-DD`, нижняя граница не позже верхней. Управляющие символы в известных параметрах запрещены. Неизвестные и чужие этому маршруту параметры игнорируются, повторённый параметр берётся по последнему значению. Кодирование выполняет `URLSearchParams`; строки не склеиваются в query вручную.

Некорректный известный query даёт экран «Некорректная ссылка» со сбросом параметров через replaceState; запрос данных в этом состоянии не запускается. Положительный page сохраняется даже без знания pages: `page_out_of_range` обрабатывает экран, получивший API-ответ, со ссылкой на первую страницу. Смена фильтров в F3/F4 должна явно устанавливать `page: 1`.

Используются History API и popstate без библиотек. `Link` рендерит обычный `<a href>` и перехватывает только основной клик без модификаторов: Enter поддерживается браузером, Ctrl/Cmd/Shift/Alt, другие кнопки мыши, target, download, фрагменты и внешние ссылки сохраняют нативное поведение. Back/Forward читают маршрут и фильтры из адреса. При переходе из каталога/категории в товар исходный URL хранится в history state; история фильтров товара сохраняет этот контекст, reload читает его заново. Контекст принимается только для корректного внутреннего URL списка. При прямом входе `returnTo` отсутствует: после загрузки F4 предлагает категорию товара. При возврате в исходный список App ждёт загрузки ссылки выбранного товара и возвращает ей фокус. Если пользователь уже перевёл фокус, ожидание отменяется; если товар исчез или список не загрузился, остаётся заголовок. Уход и изменение query отключают observer. Фактический фокус и прокрутку принимает человек.

Прямые URL и reload поддерживаются SPA fallback Vite dev/preview: сервер отдаёт `index.html` для этих путей. Это проверяется HTTP, отдельно от работы React в браузере. Production hosting, reverse proxy и их fallback не настроены и не подтверждаются.

### Структура и владельцы

| Область | Владелец и назначение |
| --- | --- |
| `src/App.tsx`, `App.css`, `main.tsx`, `index.html` | F2: shell и общие стили; F5 подключает feature-экраны в App |
| `src/navigation/` | F2: routes/query, controller с подставляемым History-окружением, browser hooks, Link и Node-тесты |
| `src/components/` | F2: RequestState, Pagination и их Node-проверки |
| `src/pages/` | F2: HealthPage и типы props экранов; прежние CatalogPlaceholder больше не подключены |
| `src/api/**`, `src/lib/format*` | F1: транспорт, runtime-схемы и форматирование; F2 их не меняет |
| `src/features/catalog/**` | F3: CatalogPage, CategoryPage, собственные состояния и CSS |
| `src/features/product/**` | F4: ProductPage, история, сводка, магазины, собственные состояния и CSS |
| `frontend/scripts/**`, `docs/frontend.md` | F5: HTTP/CLI-интеграция и отчёт; до F5 этим документом владеет F2 |

Экраны используют собственные CSS с префиксами. Общая визуальная система сохраняется: Segoe UI/system-ui, фон `#f5f7f2`, зелёный `#246044`, белые панели, max-width 920 px, breakpoint 540 px. Ссылки действий, кнопки, input/select имеют высоту от 44 px и focus-visible. Вертикальной прокруткой владеет страница; глобальный overflow не скрывает ошибки. Общие компоненты статичны, анимаций нет.

### Интерфейсы для F3/F4/F5

Все публичные функции и типы навигации экспортируются из `src/navigation/index.ts`:

```ts
type CatalogQuery = { q?: string; generic?: number; page: number }
type HistoryQuery = {
  store?: number; country?: string; currency?: string
  date_from?: string; date_to?: string; page: number
}
type NavigableRoute =
  | { kind: 'catalog'; query: CatalogQuery }
  | { kind: 'category'; categoryId: number; query: CatalogQuery }
  | { kind: 'product'; productId: number; query: HistoryQuery }
  | { kind: 'health' }
type Route = NavigableRoute
  | { kind: 'not-found'; path: string }
  | { kind: 'invalid-query'; path: string; fields: string[]; resetTo: string }
type NavigationTarget = string | NavigableRoute
type NavigateOptions = { replace?: boolean }
type NavigationSnapshot = { href: string; route: Route; returnTo?: string }

parseRoute(input: string | URL): Route
buildRoute(route: NavigableRoute): string
parseCatalogQuery(search: string | URLSearchParams): ParsedQuery<CatalogQuery>
parseHistoryQuery(search: string | URLSearchParams): ParsedQuery<HistoryQuery>
// ParsedQuery<T> = { query: T; invalidFields: string[] }
buildCatalogQuery(query: CatalogQuery): string
buildHistoryQuery(query: HistoryQuery): string
// buildQuery возвращает ведущий '?' или ''. Невалидный build бросает RangeError.
navigate(target: NavigationTarget, options?: NavigateOptions): void
useNavigation(): NavigationSnapshot
useRoute(): Route
```

`navigate` допускает только HTTP(S) этого origin, публикует snapshot сразу после push/replace (браузер сам не вызывает popstate), не добавляет дубликат текущего URL. `Link` — именованный export из navigation, default export из `navigation/Link.tsx`; props: `to: NavigationTarget`, `replace?: boolean`, остальные нативные props ссылки кроме href (включая onClick). `createNavigation(environment)` из `navigation/controller.ts` — тестируемый store с `navigate/getSnapshot/subscribe`; `NavigationEnvironment` предоставляет `getHref/getState/pushState/replaceState/listenPopState`. Импорт helpers в Node не требует window; browser hooks используются только в SPA.

`RequestState` — default export из `components/RequestState.tsx`; props — объединение:

```ts
{ kind: 'loading'; message?: string }
| { kind: 'error'; message?: string; onRetry: () => void; retryDisabled?: boolean }
| { kind: 'empty'; message: string; action?: ReactNode }
```

Loading резервирует min-height без фиксированной высоты. Все варианты используют `aria-live="polite"`, `aria-busy` true только при loading. Error по умолчанию показывает локальный безопасный текст и «Повторить»; message должен быть собственным переводом UI, серверные message/fields/исключения передавать запрещено. Пустое состояние допускает действие (обычно Link). Успешное содержимое рендерит владелец запроса; запросы, отмена, гонки и соответствующие блоки aria-busy остаются у feature-экрана.

`Pagination` — default export из `components/Pagination.tsx`; props:

```ts
{ page: number; pages: number; buildPageHref: (page: number) => NavigationTarget; label?: string }
```

`buildPageHref` меняет только page и сохраняет текущие фильтры. Default label — «Страницы результатов». Навигация — нативные ссылки, ровно одна имеет `aria-current="page"`; предыдущая/следующая скрываются на границах. При pages 0/1 либо некорректных счётчиках компонент не рендерит навигацию; выход за диапазон обрабатывает экран. На больших наборах остаются первая/последняя и окно около текущей страницы (до семи ссылок страниц), без создания тысяч элементов.

Ожидаемые props экранов экспортированы из `src/pages/types.ts`:

```ts
CatalogPageProps = { query: CatalogQuery }
CategoryPageProps = { categoryId: number; query: CatalogQuery }
ProductPageProps = { productId: number; query: HistoryQuery; returnTo?: string }
```

Feature-экраны рендерятся под общим h1, собственный h1/main/shell не создают; имена категории/товара используют h2. Они владеют формами и запросами, используют native label/input/select, самостоятельные inline-сообщения. Новых систем состояния, оверлеев, уведомлений или локализации не добавлено; UI русский, форматирование принадлежит F1. F3/F4 могут импортировать общие компоненты, навигацию и props без правок файлов F2.

## Каталог, карточка и история: подключение F5

Frontend рассчитан на backend-ветку `feature/run_musab3irq-sdelay-bekend-api-dlya-prosmotra-produkt`, снимок `5e1adfa`. Она **не слита** в текущую ветку: её backend сейчас обслуживает только health. Схемы и семантика API принадлежат [контракту backend](api-contract.md#реализовано-api-чтения-каталога-и-цен); до слияния читать его через `git show 5e1adfa:docs/api-contract.md`. Подготовительные источники: `orca-board task answer --task task_mutu93ml5l` (§1–3, §6) и `orca-board task answer --task task_muttmo9x5b` (§3–5; его старый API-план заменён первым ответом). Исторический абзац об API ниже сохранён для минимального пересечения с backend-правкой; состояние подключённого каталога описано здесь.

| Экран / владелец состояния | Данные и поведение |
| --- | --- |
| `features/catalog/CatalogPage` | Независимые загрузки дерева категорий и товаров. Поиск по всему каталогу, список последних покупок, серверная пагинация (default backend: 50 товаров) |
| `features/catalog/CategoryPage` | Крошки из серверного path, подкатегории, generic-фильтр, товары всей ветви, включая потомков. Новый query сбрасывает страницу; переходы страниц сохраняют фильтры |
| `features/product/ProductPage` | Данные конкретного Product, возврат в исходный список с query; прямой вход предлагает категорию. Detail, history, summary и магазины имеют отдельные запросы/ошибки/повторы |
| `PriceHistory` | Семантическая таблица, новые покупки сначала, 50 наблюдений на страницу, фильтры магазина/страны/валюты/локального периода. При смене только page и локальном повторе фокус получает стабильный заголовок истории; смена фильтров оставляет фокус в форме |
| `PriceSummary` | Серверные min/max/avg/первая/последняя цена/динамика по магазину, валюте и фактической единице, за весь выбранный период. Из страницы истории сводка не вычисляется |
| `StoreFilter` | Начальные магазины из карточки плюс отдельный справочник: поиск названия/города/адреса, страна и страницы по 50. Поиск справочника локален; применённые фильтры истории записаны в URL |

Используемые GET с завершающим `/`: `/api/categories/`, `/api/categories/{id}/`, `/api/products/`, `/api/products/{id}/`, `/api/products/{id}/prices/`, `/api/products/{id}/prices/summary/`, `/api/stores/`. CLI дополнительно проверяет `/api/generic-products/` и `/api/generic-products/{id}/`; UI получает варианты generic из категории. Описание полей, ошибок и лимитов — только в контракте backend. Экран альтернатив и конвертация валют в этот интерфейс не входят.

| Состояние | Что видит человек |
| --- | --- |
| Загрузка / повтор | Локальный loading и aria-busy; формы и доступные соседние секции сохраняются. Замена запроса/уход отменяют запрос, guard не принимает поздние ответы; deadline 15 секунд включает чтение тела |
| Успех | Реальные серверные названия, счётчики, строки Decimal и даты; пагинация и ссылка возврата |
| Пустые данные | Раздельные сообщения: нет категорий/товаров ветви, поиск без совпадений, товар без покупок, пустой фильтр истории/сводки/магазинов. Для фильтрованных результатов доступен сброс |
| Ошибка сети / timeout / неверный ответ / 500 | Безопасный русский текст и локальный повтор. Успешная карточка остаётся при отказе history/summary; отказ магазинов не блокирует историю и остальные фильтры |
| 400 / 404 | Исправление или сброс параметров; `page_out_of_range` предлагает первую страницу, отсутствующий товар/категория — выход в каталог. Известный некорректный query отсекает shell до запроса |
| Недоступное действие | При отказе справочника select магазина недоступен; выбранный магазин можно убрать. Кнопки страниц справочника отключены на границах; некорректная форма показывает связанные с полями сообщения |

### Границы данных

- Это **наблюдения покупок из чеков**, не текущие предложения магазина. Отображаются только сопоставленные товарные позиции продаж; возвраты, залог и услуги в историю не входят.
- Валюты и фактические единицы не смешиваются. Нормализованная цена подписана своей единицей; `comparable` означает совместимость единиц, не налоговой базы. Налоги неизвестны, скидка всего чека по товарам не распределена, средняя в сводке невзвешенная.
- Decimal остаются строками; UI не считает деньги через JS Number. `null` означает отсутствие данных, не нулевую цену. Интерфейс русский, десятичная запятая, явный код валюты; `purchased_on` — локальная календарная дата, момент без известного timezone подписан UTC.
- Карточка отдаёт до 50 магазинов и aliases без признака усечения. Поиск `/stores/` охватывает **все** магазины выбранной страны, включая точки без покупок товара; полного списка только магазинов товара API не предоставляет. Магазины не выводятся из текущей страницы истории. Адрес/timezone обогащаются по ID из карточки и справочника; без них остаётся краткая подпись.
- ID в JSON — JS-числа. Адаптер и навигация требуют положительный `Number.isSafeInteger`; ID выше `Number.MAX_SAFE_INTEGER` отвергаются, округлённые ссылки не создаются. Полный диапазон BigAutoField пока не поддержан.

### CLI настоящего HTTP без браузера

Из корня, Node 24, после полного QA environment, запуска API и Vite:

```powershell
node --check frontend/scripts/check_catalog_proxy.mjs
node frontend/scripts/check_catalog_proxy.mjs healthy
# Если выбран другой свободный Vite-порт:
node frontend/scripts/check_catalog_proxy.mjs healthy http://127.0.0.1:15174
```

Скрипт без новых зависимостей использует настоящий fetch и исходные адаптеры с **явным baseUrl** напрямую и через Vite. Сверяет HTTP, Content-Type, Allow, полный JSON и результат адаптера; не переносит health-требование Cache-Control на каталог. Проверяет категории/detail, generic, товары/detail, history/summary, магазины, поиск и фильтры, минимум две страницы `page_size=1` у товаров, наблюдений и магазинов, 400 (page_size/q/date_from) и 404 `page_out_of_range`/`not_found`. Все существующие ID получает из ответов; отсутствующий ID категории вычисляет из полного дерева. QA-набор должен содержать хотя бы два товара, две точки и один Product с двумя покупками; при нехватке данных скрипт завершается с объяснением. Во время сверки QA-данные не менять: общего снимка между HTTP-запросами нет.

Ошибки конфигурации, недоступный API/proxy, неожиданный статус/JSON или результат адаптера дают `Catalog check FAILED: …` и exit 1. Единственный режим — `healthy`; остановки Postgres/API проверяются отдельно человеком, успешный negative-test не равен успешному HTTP-прогону. Скрипт требует `POSTGRES_DB=checkist_qa`, `VITE_API_BASE_URL=/api` и разные HTTP loopback origins; `DEV_API_PROXY_TARGET` задаёт прямой адрес API.

## Health-экран

`frontend/` — клиентский каркас React 19, TypeScript и Vite. Страница на русском языке показывает состояние настоящего анонимного `GET /api/health/`: API, базы данных, Redis и Celery. Заглушек, пользовательского входа и бизнес-данных в приложении нет. Контракт принадлежит backend: [api-contract.md](api-contract.md).

Компонент `src/pages/HealthPage.tsx` владеет состоянием технической страницы и кнопкой повтора, `src/api/health.ts` — запросом и runtime-проверкой JSON. Перенос из App сохраняет state/effect, AbortController, generation guard, словари статусов и повтор. Навигация реализована локально, глобальное состояние, UI-библиотеки, внешние шрифты и изображения не используются.

| Состояние | Поведение страницы |
| --- | --- |
| Открытие / повтор | «Проверяем соединение…», четыре строки проверки, «Повторить» disabled |
| Валидный 200 | «Соединение установлено», API отвечает, три сервиса доступны |
| Валидный 503 | «Некоторые сервисы недоступны», API отвечает, все checks сохранены |
| Ошибка сети | Понятное сообщение о соединении, состояния зависимостей неизвестны, повтор доступен |
| Таймаут 15 секунд | Сообщение об истёкшем ожидании, повтор доступен |
| 500 / протокольная ошибка | Безопасное сообщение, повтор доступен |
| Невалидный JSON / схема / пара HTTP–тело | Сообщение о некорректном ответе, повтор доступен |

Коды отказов переводятся в тексты: `database_unavailable` — «База данных недоступна», `redis_unavailable` — «Кеш недоступен», `broker_unavailable` — «Очередь задач недоступна», `worker_unavailable` — «Обработчик задач не отвечает». Серверные сообщения и исключения напрямую в UI не выводятся.

Повтор сбрасывает предыдущий результат и делает новый реальный запрос. Во время запроса кнопка недоступна. Замена запроса и unmount отменяют предыдущий AbortController; проверка поколения запроса и сигнала предотвращает запись устаревшего результата, включая повторный запуск эффекта в StrictMode. Таймаут охватывает fetch и чтение тела, timer и внешний abort-listener удаляются при завершении. Отмена отличается от ошибки сети и таймаута.

Статусы выражены текстом, сводка использует `aria-live="polite"`. Кнопка имеет видимый клавиатурный фокус. CSS резервирует высоту сводки и строк при загрузке, предусматривает узкий экран и перенос длинных сообщений. Анимаций нет. Фактическая визуальная, клавиатурная и интерактивная приёмка остаётся за человеком.

## Планируется

- База данных фото чеков.
- Распознавание магазина и адреса, товаров и их стоимостей.
- Категории товаров.
- Дашборд со статистикой.

Эти функции на странице представлены только текстовым списком. OCR-провайдер и пользовательское разграничение не выбраны. Предметная модель данных чеков реализована и описана в [data-model.md](data-model.md), но HTTP API к ней нет, и страница её не использует.

## Версии и установка

Проверенная среда: Windows, Node **24.18.0**, npm **11.16.0**. Вызывать `npm.cmd`, без изменения ExecutionPolicy. Прямые версии закреплены в `package.json`, полный набор — в `package-lock.json`.

| Пакеты | Версия |
| --- | --- |
| react / react-dom | 19.3.0 |
| typescript | 5.9.3 |
| vite / @vitejs/plugin-react | 8.3.2 / 6.1.1 |
| eslint / @eslint/js | 9.39.5 |
| vitest | 5.0.3 |
| typescript-eslint | 8.71.0 |
| eslint-plugin-react-hooks / eslint-plugin-react-refresh | 7.1.1 / 0.5.7 |
| globals | 17.13.0 |
| @types/react / @types/react-dom / @types/node | 19.3.0 / 19.3.0 / 24.19.1 |

Из корня репозитория:

```powershell
Set-Location frontend
npm.cmd ci
npm.cmd run lint
npm.cmd run test
npm.cmd run build
```

Проверять `$LASTEXITCODE` после каждой команды; при ошибке не продолжать зависимые действия. `node_modules/`, `dist/` и TypeScript build info в `node_modules/.tmp/` игнорируются Git.

Предупреждение npm о deprecated-версии ESLint 9.39.5 и результаты установки и lint зафиксированы в [verification.md](verification.md).

## Scripts, адрес API и proxy

| Script | Команда / назначение |
| --- | --- |
| `dev` | `vite` — локальная разработка |
| `build` | `tsc -b && vite build` — проверка типов и сборка в `dist/` |
| `lint` | `eslint . --max-warnings=0` |
| `test` | `vitest run` — адаптер, Node environment, mocked fetch |
| `preview` | `vite preview` — локальный просмотр собранного приложения |

Vite читает единый корневой `.env` (`envDir` — корень репозитория), process environment имеет приоритет. Создать файл из `.env.example`, если его ещё нет; существующий не перезаписывать. Дополнительный `.env` внутри `frontend/` не требуется.

Адаптер берёт `import.meta.env.VITE_API_BASE_URL || "/api"`, убирает лишние завершающие и повторяющиеся слэши пути, добавляет `/health/`. Запрос передаёт `Accept: application/json`, `credentials: "omit"`, `cache: "no-store"`. По умолчанию браузер запрашивает `/api/health/` на своём origin.

Dev и preview слушают **127.0.0.1:5173**, `strictPort: true`: занятый порт приводит к ошибке, а не тихому выбору другого. В QA порт задаётся аргументом `--port 15173`. Proxy `/api` направляет запрос на `DEV_API_PROXY_TARGET` (default `http://127.0.0.1:8000`) **без переписывания пути**. Например, `http://127.0.0.1:15173/api/health/` → `http://127.0.0.1:18000/api/health/`.

`DEV_API_PROXY_TARGET` используется только Node-конфигурацией Vite. `envPrefix: []` выключает автоматическую передачу пользовательских env-переменных; через `define` передаётся только `VITE_API_BASE_URL`. Общий env-объект, DB-реквизиты и секреты не прокидываются в браузер. `VITE_API_BASE_URL` публичен и не должен содержать секреты. После изменения env перезапустить Vite; публичный адрес фиксируется при build, для preview после его изменения нужна новая сборка. Произвольный внешний origin/CORS не проверен; результаты и ограничения проверки — в [verification.md](verification.md).

При остановленном API Vite 8.3.2 возвращает пустой HTTP **502**, хотя браузер по-прежнему достигает самого Vite. Адаптер трактует не-JSON 502/504 как ошибку соединения. Валидный health 503 обрабатывается отдельно с сохранением checks.

Для просмотра сборки при работающем QA API и применённых QA overrides:

```powershell
Set-Location frontend
npm.cmd run build
npm.cmd run preview -- --port 15173
```

Предварительно остановить dev-сервер на этом порту. Preview — локальный инструмент приёмки; production reverse proxy, hosting и deployment не настроены.

## Запуск изолированной QA для ручной приёмки

Не использовать dev-данные и локальный Postgres. Подготовка backend — [development.md](development.md), изоляция и полные проверки — [verification.md](verification.md). Нужны Docker Desktop с Linux daemon и свободные QA-порты; системные настройки менять не требуется. Если Windows не достигает Docker-портов, выполнить ограниченную TCP-диагностику из development.md и не повторять зависимые команды до восстановления доступа.

В **каждом** QA PowerShell-терминале, находясь в корне репозитория, применить весь блок:

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

Убедиться, что `checkist_qa` не занята другим запуском и порты 25432, 16379, 18000, 15173 свободны. `.env` должен существовать, backend venv должен быть подготовлен:

```powershell
if (!(Test-Path .env)) { Copy-Item .env.example .env }
py -3.13 -X utf8 -m venv backend/.venv
./backend/.venv/Scripts/python.exe -X utf8 -m pip install -r backend/requirements.txt
docker compose -p checkist_qa config --quiet
docker compose -p checkist_qa up -d --wait --wait-timeout 90 postgres redis
```

Перед миграциями проверить TCP на 25432/16379 по verification.md. Только при успешном подключении:

```powershell
./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py check
./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py migrate --noinput
docker compose -p checkist_qa up -d --build --wait --wait-timeout 120 worker
./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py check_services
```

Каждый шаг должен завершиться с exit 0. Тестовые пользователи, фотографии и чеки не нужны: endpoint анонимный, достаточно стандартных технических таблиц Django. Доступа к бизнес-объектам этот каркас не предоставляет.

Терминал API (QA overrides применены):

```powershell
./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py runserver 127.0.0.1:18000 --noreload
```

Терминал frontend (с тем же QA-блоком):

```powershell
Set-Location frontend
npm.cmd ci
npm.cmd run dev -- --port 15173
```

Третий терминал из корня, также с QA overrides:

```powershell
curl.exe -i --max-time 15 http://127.0.0.1:15173/api/health/
docker compose -p checkist_qa stop worker
curl.exe -i --max-time 15 http://127.0.0.1:15173/api/health/
docker compose -p checkist_qa up -d --wait --wait-timeout 90 worker
curl.exe -i --max-time 15 http://127.0.0.1:15173/api/health/
```

Ожидается **200 → 503 → 200**; в 503 БД/Redis `ok`, Celery `worker_unavailable`. Curl exit 0 сам по себе не доказывает 200 — сверить HTTP и тело.

## Реальная проверка каталога до слияния backend

Это команды для **человека / следующего этапа**, в F5 они не выполнялись. Они соответствуют §3 ответа `task_mutu93ml5l`: QA API читает соседний worktree, Vite — наш frontend. Соседние файлы/ветку не менять, не устанавливать туда зависимости и не создавать там pycache. В каждом терминале применить весь QA environment выше; credentials задать процессом по выделенному QA-тому. При занятой `checkist_qa` согласовать отдельные project/БД/порты; CLI имеет guard именно `checkist_qa`, его не ослаблять и не выдавать за успешный прогон в другой БД.

Подготовить собственные venv/.env по development.md; существующий .env не перезаписывать. Нужна свободная **пустая выделенная** QA. Путь к backend-worktree задаёт человек (например, worktree `run_musab3irq`); сверить его HEAD с владельцем и снимком `5e1adfa`, зафиксировать оба SHA в отчёте. Из нашего корня:

```powershell
$backendWorktree = Read-Host "Абсолютный путь к backend worktree run_musab3irq"
git -C $backendWorktree rev-parse HEAD
$qaManage = Join-Path $backendWorktree "backend/manage.py"
docker compose -p checkist_qa config --quiet
docker compose -p checkist_qa up -d --wait --wait-timeout 90 postgres redis
# Теперь ограниченные TCP-пробы 25432/16379 по development.md.
# Только если они прошли:
./backend/.venv/Scripts/python.exe -B -X utf8 $qaManage check
./backend/.venv/Scripts/python.exe -B -X utf8 $qaManage migrate --noinput
./backend/.venv/Scripts/python.exe -B -X utf8 $qaManage shell -c "from django.db import transaction; from api.tests.factories import save_samples; transaction.atomic()(save_samples)()"
./backend/.venv/Scripts/python.exe -B -X utf8 $qaManage runserver 127.0.0.1:18000 --noreload
```

Exit каждого шага проверить отдельно; после ошибки зависимые шаги не выполнять. Загрузка `save_samples` транзакционная, **не идемпотентная**: выполнять один раз в пустой QA, повтор даёт дубликаты/IntegrityError. После backend merge заменить `$qaManage` на `backend/manage.py`. Не очищать чужие тома ради образцов. Базовый набор даёт три товара/магазина и шесть покупок Lidl, достаточных для CLI; расширенная ручная приёмка требует дополнительных данных.

Для расширенного сценария в этой же новой QA через ORM и существующие `api.tests.factories` добавить: пустую категорию, Product без покупок (`make_product`), вторую валюту (`second_currency`), наблюдение одного Product в другой точке (`observe`), несовместимую единицу (`unit_mismatch`) и длинные названия/адреса. ID получить из ORM/API. Один процесс транзакционной подготовки должен использовать один набор фабрик; не выдавать многократные отдельные shell-вызовы с повторяющимися factory-номерами за идемпотентный seed. Для >50 магазинов и UI-пагинации товаров/истории нужны представительные дополнительные записи; базовые образцы эти объёмы не подтверждают.

Во втором терминале (полный QA-блок, корень нашего worktree):

```powershell
Set-Location frontend
npm.cmd ci
npm.cmd run dev -- --port 15173
```

В третьем терминале (полный QA-блок, наш корень):

```powershell
node frontend/scripts/check_catalog_proxy.mjs healthy
curl.exe -i --max-time 15 "http://127.0.0.1:15173/api/products/?page_size=2"
```

Curl exit 0 не подтверждает HTTP 200: сверить статус и тело. Отдельные проверки отказов: остановка **своего** QA Postgres даёт catalog `500 internal_error`, остановка своего API — ошибку соединения либо не-JSON proxy-ответ; восстановить и повторить `healthy`. Catalog GET должен работать при недоступных Redis/worker. Для health-регрессии поднять QA worker из своего Compose, выполнить `check_services` и `node backend/scripts/check_health_proxy.mjs healthy`; worker/postgres/redis stop/recovery — строго по verification.md, по одному отказу. Скрипт health не менялся. Контрактные mocks и сборка не заменяют эти проверки.

После приёмки остановить **только свои** runserver/Vite, `docker compose -p checkist_qa down` без `-v` (или свой согласованный project), проверить отсутствие своих процессов/слушателей. Тома сохраняются. Системные настройки WSL и Docker Desktop агент не меняет.

## Ручная приёмка каталога человеком

Автоматический обход browser UI запрещён. Ниже сценарий §6 ответа `task_mutu93ml5l`, для доступного QA API и расширенных синтетических данных. Скриншоты и визуальные результаты в F5 не создавались. Настоящий интерфейс доступен человеку локально через команды выше; автономного макета с подставными данными нет.

1. На `http://127.0.0.1:15173/catalog` пройти дерево → категорию (включая родителя с товарами потомков) → список → Product → историю и сводку. Сверить значения с QA API, включая RU `130.5882 RUB/л` и DE `normalized=null`. Проверить поиск по имени/бренду/модели/GTIN, generic, страницы и сброс. В истории применить точку/страну/валюту/локальный период; сводка охватывает всё окно, а не страницу.
2. Скопировать URL категории и товара с query, открыть напрямую и reload. Back/Forward и «Назад к списку» восстанавливают `q`, `generic`, page; direct-entry товара имеет выход в категорию. Проверить неверный ID пути/неизвестный ID/неверный диапазон/page вне набора — безопасные разные сообщения и сброс/первая страница. При возврате проверить фокус выбранного товара после загрузки; с Slow network перевести фокус в форму до ответа и убедиться, что App его не перехватывает. Если товара больше нет, заголовок остаётся доступен.
3. Пустая категория, поиск без совпадений, Product без покупок, пустые фильтры истории/сводки/магазинов; отсутствующие бренд/фасовка/нормализация. Один Product в двух точках и валютах: точки не склеиваются, валюты/единицы/неизвестные налоги не становятся одной сравнимой ценой. Поиск магазинов не ограничен 50 точками карточки; точка без покупок даёт пустую историю.
4. DevTools Slow network: быстро менять query/фильтры и уходить со страницы; поздний ответ не подменяет новый. Отдельно заблокировать `prices/`, затем `prices/summary/`, затем `stores/`: карточка и другие доступные секции сохраняются, локальный повтор восстанавливает свою секцию. Offline → ошибка → Online → повтор. Задержка fetch или тела >15 секунд → timeout → снять задержку → повтор. Проверить доступность форм и недоступные действия.
5. Только клавиатурой: ссылка «К содержимому», Tab/Shift+Tab, Enter у ссылок/поиска, Enter/Space у кнопок, native selects, сброс/повтор, страницы, фокус при переходах и возврате. Screen reader читает единственный h1, крошки/labels/ошибки/таблицу/caption/th и локальные статусы без избыточных объявлений. Обновление query не забирает фокус из формы.
6. Ширины **320/375/768/1280 px**, **zoom 200%**, длинные названия/адреса/GTIN: действия видны, тексты переносятся, фокус различим, вертикальный scroll принадлежит странице, горизонтальный — подписанному контейнеру таблицы. Проверить геометрию loading и reduced motion. По завершении повторить health-сценарий ниже и из verification.md: успех, частичный отказ, сеть/timeout, повтор, клавиатура и узкий экран.

## Исторический ручной сценарий F2: каркас и переходы

В своём QA-терминале применить полный environment выше, выполнить в `frontend/` `npm.cmd ci`, затем `npm.cmd run dev -- --port 15173`. Для проверки preview сначала `npm.cmd run build`, остановить dev, затем `npm.cmd run preview -- --port 15173`. Ниже проверяется настоящий интерфейс; отдельного статического макета нет. У заглушек не требуется catalog API. Для успешных health-состояний нужен свой подготовленный QA backend/worker по инструкциям выше.

1. Открыть `/`, затем `/catalog?q=молоко&generic=2&page=3`: видны «Каталог продуктов» и явная заглушка следующего этапа. В Network не должно быть health-запроса. По ссылке «Состояние сервисов» открыть `/health`; Back возвращает query каталога, Forward — health. При переходах фокус на единственном h1, следующий Tab продолжает работу с содержимым.
2. Ввести прямые `/catalog/categories/42?q=milk&page=2` и `/catalog/products/42?store=1&country=DE&currency=EUR&date_from=2026-01-01&date_to=2026-10-04&page=2`; выполнить reload. На F2 это заглушки с ID, параметры остаются в адресе; карточка и запросы каталога появятся после F5. Повторить на preview. `/missing` и `/catalog/products/0` показывают «Страница не найдена», «В каталог» возвращает в каталог.
3. `/catalog/categories/42?page=0` и `/catalog/products/42?date_from=2026-02-29` показывают «Некорректная ссылка». «Сбросить параметры» сохраняет нужный маршрут, удаляет query и заменяет ошибочную запись History; Back не возвращает тот же ошибочный URL. Лишний `unknown=1` не ломает маршрут, `page=2&page=3` использует 3.
4. Проверить Tab/Shift+Tab, Enter на ссылках, видимый фокус и «К содержимому». Ctrl/Cmd-клик, Shift-клик и средняя кнопка оставляют нативные новые вкладки/окна. После подключения F3/F4 проверить input/select, сохранение фокуса при query-фильтрах, возврат из товара к исходному списку и keyboard/aria-current пагинации. До F5 эти формы и пагинация не выведены в заглушки; Node-проверки разметки не заменяют эту приёмку.
5. На 320/375/768/1280 px и zoom 200% проверить шапку, заголовки, кнопки и длинные сообщения: текст переносится, действия доступны, горизонтальная прокрутка не появляется у оболочки. Со screen reader проверить название страницы и live-сводку health. Reduced motion не должен добавлять движения.
6. На `/health` с замедленной сетью уйти в каталог до завершения запроса; поздний ответ не должен сменить страницу. Вернуться в health, повторить сценарий ниже (загрузка, частичный отказ, безопасная ошибка/повтор); без работающего API ожидается безопасная ошибка. Успех/отказы настоящих зависимостей принимаются только со своим QA backend.

После приёмки остановить созданный Vite/preview через Ctrl+C; если запускался свой QA backend/Compose, выполнить уборку по разделу health ниже. Не останавливать чужую QA.

## Ручной сценарий health-приёмки человеком

Открыть `http://127.0.0.1:15173/health`. Автоматический обход browser UI запрещён правилами проекта; результаты и ограничения ручной приёмки — в [verification.md](verification.md).

1. При первом открытии увидеть «Проверяем соединение…», недоступную кнопку повтора, затем «Соединение установлено» и все три успешных статуса. Чтобы рассмотреть загрузку, временно замедлить сеть в DevTools. Проверить, что блок не меняет высоту при смене состояния.
2. В третьем QA-терминале выполнить `docker compose -p checkist_qa stop worker`. Нажать «Повторить»: во время запроса кнопка disabled, затем «Некоторые сервисы недоступны», API отвечает, БД/Redis доступны, Celery — «Обработчик задач не отвечает». Выполнить `docker compose -p checkist_qa up -d --wait --wait-timeout 90 worker`, дождаться healthy, повторить — успех.
3. Остановить QA runserver через Ctrl+C, оставить Vite работающим. «Повторить» должно показать «Не удалось проверить соединение» и «Не удалось связаться с сервером…». Прежний успех и успешные статусы не должны остаться текущими. Вернуть API той же командой, нажать «Повторить» без reload — успех.
4. В DevTools включить Offline, повторить: безопасная ошибка и доступная кнопка. Вернуть Online, повторить — успех. Для таймаута задержать health-запрос дольше 15 секунд при доступном Vite: показать сообщение «Сервер не ответил за 15 секунд…», без вечной загрузки. Затем снять задержку и повторить.
5. Tab до «Повторить», проверить видимый фокус, Enter/Space запускают запрос. Убедиться, что при завершении можно продолжить клавиатурную работу. Со screen reader проверить объявление сводки при успехе/отказе.
6. На ширине около 375 px повторить успех, частичный отказ и ошибку сети: нет горизонтальной прокрутки, обрезанных сообщений или скрытой кнопки. Проверить масштаб 200%, длинные тексты и читаемость статусов без опоры только на цвет. При reduced motion интерфейс остаётся статичным.
7. Убедиться, что страница помечена как каркас, будущие функции показаны только списком, загрузка чеков и фиктивный дашборд отсутствуют.

После приёмки Ctrl+C остановить Vite/preview и runserver, выполнить `docker compose -p checkist_qa down` без `-v`, проверить отсутствие созданных процессов и QA-слушателей. Тома сохраняются; закрыть QA-терминалы, чтобы overrides не попали в dev.

## Границы автоматических проверок

Vitest проверяет API-адаптер с mocked fetch в Node, без jsdom/Playwright: 200, каждый документированный код отказа и их комбинации, сохранение checks при 503, 405/406/500, сеть/502/504, таймаут fetch и чтения тела, внешний abort, отмену до запроса и поздний ответ, cleanup, неправильный JSON, схему и несогласованную пару HTTP–тело. Это не тесты React-поведения или настоящих сервисов.

Реальная интеграция проверяется отдельно через HTTP/CLI; сборка подтверждает только типизацию и создание bundle. Результаты сквозной проверки через Vite proxy и ограничения — в [verification.md](verification.md). Ручную UI-приёмку, скриншоты, browser runtime и производственный запуск автоматические проверки не подтверждают.

Общие документы описывают реализованные frontend и backend. Frontend владеет `frontend/` и `docs/frontend.md`; backend — контрактом API, серверной инфраструктурой и общими документами. Сценарии и результаты сквозной проверки — в [verification.md](verification.md).

## Фактическая проверка F2, 2026-10-04

Windows, Node 24.18.0, npm 11.16.0; worktree F2. Только frontend/Node и HTTP Vite, БД и Compose не запускались. Для Vite применён весь QA environment из verification.md, API target `http://127.0.0.1:18000`, порт 15173. HTTP-проверки не обращались к API.

### Проверено и прошло

- В `frontend/`: `npm.cmd ci` — exit 0, 188 пакетов; npm сообщил deprecated warning закреплённого ESLint 9.39.5. Зависимости/lock не менялись.
- Финальные `npm.cmd run lint`, `npm.cmd run test`, `npm.cmd run build` — exit 0. Vitest: 6 файлов, 119 тестов; исходные health/mocked fetch плюс routes/query, in-memory History, правила клика ссылки, выбор страниц и server-render разметка общих компонентов. Сборка подтверждает TypeScript и bundle, server-render — только HTML/ARIA-контракт.
- `npm.cmd run dev -- --port 15173`, затем отдельно `npm.cmd run preview -- --port 15173`: оба сервера поднялись на нужном адресе. Для каждого Node HTTP fetch/assert ниже — exit 0: 9 путей × 2 GET, HTTP 200 text/html и тело root index.html. Это проверка SPA fallback и повторного GET, не браузерный reload/React runtime.
- `git diff --check` — exit 0. Статическая сверка блока HealthPage до JSX с исходным App — exit 0: state/effect/repeat/словари/отмена сохранены; изменены путь import и имя компонента.
- Оба Vite-процесса остановлены Ctrl+C с ответом Y на `Terminate batch job`; завершение npm exit 1 из-за намеренного прерывания. После остановки проверено отсутствие созданных процессов и слушателя 15173. QA-контейнеры не создавались, Compose down не запускался.

Воспроизведение HTTP-проверки из корня при работающем dev **или** preview:

```powershell
@'
import assert from 'node:assert/strict'
const origin = 'http://127.0.0.1:15173'
const paths = ['/', '/catalog', '/catalog?q=%D0%BC%D0%BE%D0%BB%D0%BE%D0%BA%D0%BE&generic=1&page=2', '/catalog/categories/42?q=milk&page=2', '/catalog/categories/42/', '/catalog/products/42?store=1&country=DE&currency=EUR&date_from=2026-01-01&date_to=2026-10-04&page=2', '/health', '/missing', '/catalog/products/0']
const base = await fetch(origin, {headers: {Accept: 'text/html'}})
assert.equal(base.status, 200)
const expected = await base.text()
assert.match(expected, /<div id="root"><\/div>/)
for (const path of paths) {
  for (let reload = 0; reload < 2; reload++) {
    const response = await fetch(origin + path, {headers: {Accept: 'text/html'}})
    assert.equal(response.status, 200, path)
    assert.match(response.headers.get('content-type'), /text\/html/)
    assert.equal(await response.text(), expected, path)
  }
  console.log('200 index.html, direct GET + reload: ' + path)
}
console.log('SPA fallback: 9 paths / 18 GETs passed; React/browser behavior not tested')
'@ | node --input-type=module -
```

### Проверено и не прошло

Промежуточные отказы устранены, ожидания тестов не ослаблялись:

- Первый `npm.cmd run build` — exit 1, `HealthPage.tsx:93 TS1005 ')' expected`: при переносе был неверно выделен JSX. Перенос исправлен, финальная сборка exit 0.
- Первый `npm.cmd run lint` — exit 1: та же ошибка разбора HealthPage и `no-control-regex` в routes.ts. Проверка управляющих символов переведена на codePointAt без отключения правила; финальный lint exit 0.
- `npm.cmd run test` после добавления проверки разметки — exit 1, 2 pagination-теста с `Element type is invalid ... got undefined`: на Windows импорт Pagination выбирал одноимённый по регистру helper `pagination.ts`. Helper переименован в `pagination-items.ts`, импорты исправлены; финальные 119 тестов прошли.
- Первый служебный аудит оставшихся node/cmd-процессов — exit 1 (`Frontend process remains`): аудит был запущен параллельно ещё работающим npm-проверкам. После их завершения последовательный аудит — exit 0, процессов worktree и слушателя 15173 нет.

### Не проверено и почему

- Browser runtime, реальные Back/Forward/reload, focus/keyboard/screen reader, адаптив/zoom и взаимодействие с кнопкой повтора — выполняет человек по сценариям выше. Автоматический обход UI не использовался; скриншотов нет. In-memory History и HTML через Node этого не подтверждают.
- Настоящие API каталога/цен отсутствуют в этой ветке (backend 5e1adfa не слит); F2 не реализует feature-экраны и не запускает соседний backend. HTTP/QA-данные и приёмка каталога — F5 после подключения F1/F3/F4. Health через настоящие QA-сервисы в F2 не прогонялся; его адаптерные tests и статическая сверка переноса прошли, ручной сценарий сохранён.
- В F2 RequestState error/loading и Pagination не выводились в каталог-заглушки ради демонстрации. В F5 они подключены настоящими feature-экранами; их поведение с настоящими запросами принимает человек по новому сценарию выше.
- Production hosting/fallback, публикация и merge не выполнялись и не обещаются.

## Фактическая проверка F5, 2026-10-04

Windows / PowerShell, Node **24.18.0**, npm **11.16.0**; свой frontend-worktree. БД, Docker/Compose, соседний backend и браузер не запускались. Проверки Node не обращались к dev/QA-БД. Изменены подключение в App, CLI, его Node-проверки подключения и этот документ. Минимальное исправление внутри F4 — только `PriceHistory.tsx`: стабильный фокус заголовка при пагинации/повторе вместо исчезающей ссылки/кнопки. Экраны каталога, адаптеры, схема backend, зависимости и lock не менялись.

### Проверено и прошло

| Команда | Exit | Фактический результат |
| --- | --- | --- |
| `npm.cmd ci` (в frontend/) | 0 | 188 пакетов, audit: 0 vulnerabilities; штатный deprecated warning ESLint 9.39.5 |
| `npm.cmd run lint` | 0 | ESLint без ошибок/предупреждений lint |
| `npm.cmd run test` | 0 | **17 файлов, 472 теста**; включая 6 новых Node server-markup проверок подключения App к реальным feature-компонентам |
| `npm.cmd run build` | 0 | TypeScript и Vite bundle, 52 модуля; это не проверка поведения React |
| `node --check frontend/scripts/check_catalog_proxy.mjs` (из корня) | 0 | Синтаксис CLI |
| `git diff --check` | 0 | Нет whitespace-ошибок |

Существующие tests покрывают адаптеры/mock fetch, форматирование, routes/query, in-memory History с Back/Forward/reload/returnTo, состояния и отмену запросов, server-render разметку. Новые App-тесты подтверждают подключённые секции, query, ссылку исходного списка, direct-entry, независимый health и отсечение invalid-query. Они **не запускают React в браузере и не подтверждают фокус**.

### Проверено и не прошло

`node frontend/scripts/check_catalog_proxy.mjs healthy http://127.0.0.1:52714`, с полным QA environment и `DEV_API_PROXY_TARGET=http://127.0.0.1:52713` — **exit 1**. Это намеренная negative-проверка: две временно выделенные loopback TCP-точки были закрыты перед запуском. Получено `Catalog check FAILED: GET http://127.0.0.1:52713/api/categories/: API/proxy unavailable or request timed out; start the QA API and Vite, then check their addresses`. Проверен понятный ненулевой отказ и импорт настоящих TypeScript-адаптеров в Node; это **не успешный каталог/HTTP/proxy-прогон**. Для повторения выбирать свои заведомо закрытые loopback-порты. Неожиданных отказов npm-проверок F5 не было.

### Не проверено и почему

- Настоящие категории/товары/detail/prices/summary/stores, две страницы и 400/404 через живой API/proxy **не проверены**: backend `5e1adfa` не слит, наш API таких маршрутов не имеет. Команды реального прогона до merge — раздел «Реальная проверка каталога до слияния backend». Наличие CLI и его negative-результат не закрывают интеграционную приёмку.
- QA-данные, Postgres `500 internal_error`, независимость каталога от Redis/worker, настоящий health stop/recovery не проверены: QA-сервисы не запускались. Воспроизведение — тот же раздел плюс verification.md; health-адаптерные tests прошли.
- Что **человеку проверить глазами и действиями**: основной путь и возврат с query/фокусом, прямые URL/Back/Forward/reload, загрузка/пустые/ошибочные/частичные состояния и повтор, Slow network/Offline/timeout/гонки, клавиатура и screen reader, переносы/таблица/scroll на 320/375/768/1280 px и zoom 200%, затем health-сценарий. Точные шаги — раздел «Ручная приёмка каталога человеком». Скриншотов, автоматического browser runtime и визуальной приёмки нет; показанный markdown — документация и сценарий, не макет или подтверждение внешнего вида.
- Production hosting, deployment, release и merge не выполнялись. Созданных серверных процессов/QA-контейнеров нет, поэтому останавливать их или делать Compose down в F5 не потребовалось.
