# Frontend Checkist

## Каркас и навигация F2

`App.tsx` владеет оболочкой: шапкой «Каталог / Состояние сервисов», единственным `h1`, document title и содержимым текущего маршрута. При первом открытии и смене pathname фокус переходит на `h1#page-heading` (`tabIndex=-1`); изменение только query не забирает фокус из формы. Есть ссылка «К содержимому». Каталог не запрашивает health и не зависит от его результата. На этапе F2 каталог, категория и товар представлены явными заглушками подключения, без вымышленных товаров и цен. Готовые экраны F3/F4 подключает F5 правкой импортов и `pageContent()` только в `App.tsx`.

| URL | Экран и query |
| --- | --- |
| `/`, `/catalog` | Каталог; `q`, `generic`, `page` |
| `/catalog/categories/:id` | Категория; `q`, `generic`, `page` |
| `/catalog/products/:id` | Товар и история; `store`, `country`, `currency`, `date_from`, `date_to`, `page` |
| `/health` | Прежний технический health-экран |
| Неизвестный путь или неверный ID | «Страница не найдена», ссылка «В каталог» |

`/` — алиас каталога без принудительного redirect; build создаёт `/catalog`. Один завершающий слэш допустим. ID и page — положительные safe integers, небезопасные значения не округляются. Первая страница подразумевается и при build не записывается. Поиск trim, 2–100 Unicode code points; пустое значение означает отсутствие фильтра. Коды стран/валют приводятся к верхнему регистру, проверяется их синтаксис; существование в справочнике проверяет API. Даты — настоящие календарные `YYYY-MM-DD`, нижняя граница не позже верхней. Управляющие символы в известных параметрах запрещены. Неизвестные и чужие этому маршруту параметры игнорируются, повторённый параметр берётся по последнему значению. Кодирование выполняет `URLSearchParams`; строки не склеиваются в query вручную.

Некорректный известный query даёт экран «Некорректная ссылка» со сбросом параметров через replaceState; запрос данных в этом состоянии не запускается. Положительный page сохраняется даже без знания pages: `page_out_of_range` обрабатывает экран, получивший API-ответ, со ссылкой на первую страницу. Смена фильтров в F3/F4 должна явно устанавливать `page: 1`.

Используются History API и popstate без библиотек. `Link` рендерит обычный `<a href>` и перехватывает только основной клик без модификаторов: Enter поддерживается браузером, Ctrl/Cmd/Shift/Alt, другие кнопки мыши, target, download, фрагменты и внешние ссылки сохраняют нативное поведение. Back/Forward читают маршрут и фильтры из адреса. При переходе из каталога/категории в товар исходный URL хранится в history state; история фильтров товара сохраняет этот контекст, reload читает его заново. Контекст принимается только для корректного внутреннего URL списка. При прямом входе `returnTo` отсутствует: после загрузки F4 предлагает категорию товара. Позиция прокрутки и фокус выбранной строки при возврате требуют ручной приёмки; оболочка переносит фокус на заголовок при смене pathname.

Прямые URL и reload поддерживаются SPA fallback Vite dev/preview: сервер отдаёт `index.html` для этих путей. Это проверяется HTTP, отдельно от работы React в браузере. Production hosting, reverse proxy и их fallback не настроены и не подтверждаются.

### Структура и владельцы

| Область | Владелец и назначение |
| --- | --- |
| `src/App.tsx`, `App.css`, `main.tsx`, `index.html` | F2: shell и общие стили; F5 подключает feature-экраны в App |
| `src/navigation/` | F2: routes/query, controller с подставляемым History-окружением, browser hooks, Link и Node-тесты |
| `src/components/` | F2: RequestState, Pagination и их Node-проверки |
| `src/pages/` | F2: HealthPage, временные точки подключения, типы props экранов |
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

## Ручной сценарий F2: каркас и переходы

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
- RequestState error/loading и Pagination не выведены в каталог-заглушки ради демонстрации: их использование с настоящими запросами принимает человек после F3/F4/F5. Изменённые сейчас shell/заглушки/not-found/invalid-query/health доступны в локальном dev/preview.
- Production hosting/fallback, публикация и merge не выполнялись и не обещаются.
