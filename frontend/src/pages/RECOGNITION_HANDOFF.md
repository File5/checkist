# И1: каркас распознавания и чеков

Добавлены транспорт и runtime-схемы локального API, пять маршрутов, меню «Чеки»/«Обработка», proxy `/media` для Vite dev и preview. Новые страницы — **заглушки**, которые явно сообщают об этом. Загрузка, опрос заданий и показ чеков через UI появятся в И2/И3. Документ — реальный артефакт передачи интерфейсов и ручной проверки; скриншоты и визуальная приёмка не выполнялись.

## Интерфейсы для И2 и И3

Общие файлы остаются у И1; И2 заменяет `features/recognition/`, И3 — `features/receipts/`. Экспорты из обоих `index.tsx` сохранить. App импортирует именованные экспорты; он владеет единственным h1, заголовком вкладки, фокусом при смене pathname и восстановлением ссылки при возврате из detail в известный список. Локальными запросами, их отменой, пагинацией и локальным фокусом владеет feature; доступны существующие `RequestState`, `Pagination`, `Link`, `useLocalRequestFocus`.

| Экспорт страницы | Props из `pages/types.ts` | Маршрут |
| --- | --- | --- |
| `UploadPage()` | без props | `/receipts/upload` |
| `JobsPage(props: JobsPageProps)` | `{ query: JobsQuery }` | `/recognition/jobs` |
| `JobPage(props: JobPageProps)` | `{ jobId: number; returnTo?: string }` | `/recognition/jobs/{id}` |
| `ReceiptsPage(props: ReceiptsPageProps)` | `{ query: ReceiptsQuery }` | `/receipts` |
| `ReceiptPage(props: ReceiptPageProps)` | `{ receiptId: number; returnTo?: string }` | `/receipts/{id}` |

Все компоненты возвращают React JSX. При прямом входе `returnTo` отсутствует: fallback `/recognition/jobs` либо `/receipts`. Для известных переходов из списка в detail History state хранит только валидный URL соответствующего списка с фильтрами/страницей. После прямого входа в чек локальную пагинацию строк/скидок/налогов/изображений организует И3.

`navigation/index.ts` экспортирует `parseJobsQuery`, `buildJobsQuery`, `parseReceiptsQuery`, `buildReceiptsQuery`, `parseRoute`, `buildRoute`, `Link`, `navigate`, `useNavigation`.

```ts
type JobsQuery = {
  page: number; photo?: number; status?: JobStatus; page_size?: number
  ordering?: 'created_at' | '-created_at'
}
type ReceiptsQuery = {
  page: number; store?: number; product?: number; q?: string
  country?: string; currency?: string; operation?: 'sale' | 'refund'
  date_from?: string; date_to?: string; page_size?: number
  ordering?: 'purchased_at' | '-purchased_at'
}
```

Читаемые параметры: последний из повторённых; пустые отсутствуют; коды приводятся к uppercase; даты календарные и включительные; `page_size` 1..200. Неизвестные параметры игнорируются. Неправильный ID даёт not-found, неправильный фильтр — invalid-query с явным сбросом. Клиент намеренно ограничен безопасными integer ID (`Number.MAX_SAFE_INTEGER`), как прежняя навигация; серверный bigint выше этого диапазона не округляется.

## Функции API

Импорт функций/типов recognition из `api/recognition.ts`, receipts из `api/receipts.ts`; общий результат — `LocalApiResult<T>` из `api/types.ts`. Ниже `O = RequestOptions`, `R<T> = Promise<LocalApiResult<T>>`. Все `params` по умолчанию `{}`, `options` по умолчанию `{}`.

```ts
type RequestOptions = { signal?: AbortSignal; baseUrl?: string }
type LocalApiResult<T> =
  | { kind: 'ok'; data: T }
  | { kind: 'error'; reason: LocalApiErrorReason; status?: number; fields?: string[] }
  | { kind: 'aborted' }

getRecognitionCsrf(options?: O): R<RecognitionCsrf>
clearRecognitionCsrf(options?: Pick<O, 'baseUrl'>): void
uploadPhoto(file: File, options?: O): R<PhotoUpload>
getPhotos(params?: PhotoParams, options?: O): R<Page<Photo>>
getPhoto(id: number, options?: O): R<Photo>
getJobs(params?: JobParams, options?: O): R<Page<Job>>
getJob(id: number, options?: O): R<JobDetail>
cancelJob(id: number, options?: O): R<JobDetail>
retryJob(id: number, options?: O): R<JobDetail>
getReceiptImages(params?: ReceiptImageParams, options?: O): R<Page<ReceiptImage>>
getReceiptImage(id: number, options?: O): R<ReceiptImageDetail>
getReceipts(params?: ReceiptParams, options?: O): R<Page<Receipt>>
getReceipt(id: number, options?: O): R<Receipt>
getReceiptLines(id: number, params?: ReceiptLineParams, options?: O): R<Page<Line>>
getReceiptDiscounts(id: number, params?: PageParams, options?: O): R<Page<Discount>>
getReceiptTaxes(id: number, params?: PageParams, options?: O): R<Page<Tax>>
```

Параметры:

- `PageParams`: `page?, page_size?`; `PhotoParams` дополнительно `ordering?: ±created_at`.
- `JobParams`: `PhotoParams` + `photo?, status?`.
- `ReceiptImageParams`: `PhotoParams` + `photo?, job?, receipt?` (AND).
- `ReceiptParams`: `PageParams` + `store?, product?, country?, currency?, operation?, date_from?, date_to?, q?, ordering?: ±purchased_at`.
- `ReceiptLineParams`: `PageParams` + `kind?: product|service|deposit|deposit_return`, `matching?: matched|unmatched`.

Новые GET и POST используют `credentials: same-origin`, `Accept: application/json`, `cache: no-store`. CSRF cookie выдаёт сервер; token хранится только в памяти модуля, отдельно по нормализованному API-префиксу. Первый POST получает CSRF автоматически; параллельные потребители делят handshake, отмена одного не отменяет остальных. Последний отменившийся потребитель останавливает handshake. Явный `getRecognitionCsrf` обновляет limits/executor и token. Multipart содержит ровно `file`; Content-Type и boundary выставляет fetch. Cancel/retry отправляют JSON `{}` и `X-CSRFToken`.

Таймаут каждого GET/CSRF/cancel/retry — 15 с; запроса загрузки — 60 с после handshake. Deadline включает fetch и чтение тела. GET принимает 200, мутации 200/202. AbortSignal и таймаут завершают ожидание даже при fetch/body, игнорирующих abort. После `csrf_failed` token сбрасывается; **автоматического повторного POST нет**. После таймаута upload/retry нельзя обещать, что сервер ничего не сохранил: опросить списки/detail и предложить пользователю осознанное действие. Нет Idempotency-Key.

Ошибки возвращают только reason/status и имена fields, без серверных текстов/значений. Помимо прежних ошибок: `csrf_failed`, `permission_denied`, `job_active`, `job_terminal`, `retry_not_allowed`, `upload_too_large`, `unsupported_media_type`, `unsupported_format`, `invalid_image`, `image_too_large`, `storage_unavailable`, `database_unavailable`, `method_not_allowed`, `not_acceptable`. HTTP/code должны соответствовать контракту; неправильное тело/пара даёт `invalid_response`. Старые `ApiResult`, `ApiFailure`, health/catalog и их credentials остаются прежними.

## Типы, схемы, изображения

`recognition-types.ts`: `ImageFormat`, `JobStatus`, `JobStage`, `ReceiptImageStatus`, `RecognitionCode`, `Executor`, `RecognitionLimits`, `RecognitionCsrf`, `Photo`, `JobProgress`, `JobActions`, `RecognitionError`, `RecognitionIssue`, `JobItem`, `Job`, `JobDetail`, `PhotoUpload`, `Bbox`, `QuadPoint`, `ProposedReceipt`, `NormalizedTaxRate`, `NormalizedLine`, `NormalizedDiscount`, `NormalizedTax`, `NormalizedResult`, `ReceiptImage`, `ReceiptImageDetail`, параметры выше. `jobStatuses` — общий readonly список для фильтров.

`receipts-types.ts`: `ReceiptOperation`, `LineKind`, `MatchingStatus`, `TaxKind`, `TaxRate`, `Receipt`, `Line`, `Discount`, `Tax`, `ReceiptParams`, `ReceiptLineParams`. Общие `Decimal`, `Store`, `NamedObject`, `Page<T>`, `PageParams`, `RequestOptions`, `LocalApiResult<T>` — `types.ts`. Деньги, количество, цена и ставка остаются строками; ничего не преобразовывать в Number. Канонические суммы — 2 знака, цена — 4, количество — 3. Возвраты допускают отрицательные суммы, legacy position=0 допустима.

`recognition-schema.ts` и `receipts-schema.ts` экспортируют guards `is…` для всех объектов. Общий `page(guard)` проверяет пагинацию. Обязательные поля и вложенные типы проверяются; дополнительные поля разрешены как в прежних схемах. Job в списке не имеет обязательного `items`, JobDetail имеет; ReceiptImageDetail добавляет `quad`/`rotation_degrees`. `normalized_result` nullable и допустим только в needs_review; все непрочитанные поля внутри могут быть null. Неверная напечатанная дата/время в наблюдении может быть причиной review, поэтому эта строка сохраняется для показа, а канонические даты/UTC timestamp проверяются строго. `review` может пересекаться с imported/reused: сумму counters не превращать в процент.

Использовать `safeMediaUrl(value: unknown): string | null` из `lib/media.ts` для `src` и ссылок изображений. При null показать отсутствие изображения. Допускается только путь `/media/...`; схемы/host, `//host`, traversal, encoded separators/dots, backslash, query/hash, controls, неоднозначное percent-кодирование отвергаются. Media URL дополнительно проверяются схемами. Изображения не привязаны к `VITE_API_BASE_URL`.

`executor.available=false` не доказывает отсутствие idle-worker и не запрещает upload/retry. `actions` — подсказки текущего снимка; сервер может вернуть 409 при гонке. `ReceiptImage.normalized_result` — безопасное наблюдение, не черновик и не editable API. Needs_review может уже иметь `receipt_id`. Серверные normalized/provider сообщения не подставлять в UI без принятого безопасного словаря.

## Запуск и данные для человека

Для проверки только каркаса backend не нужен: из `frontend/` выполнить `npm.cmd ci`, `npm.cmd run dev -- --port 15173`, открыть `http://127.0.0.1:15173/receipts`. Новые страницы покажут заглушки.

Для полного backend-сценария следующего этапа сначала в **каждом** терминале применить весь QA environment из `docs/verification.md` (раздел «Изолированная QA-среда»: checkist_qa, Postgres 25432, Redis 16379, API 18000, Vite 15173). Не работать с dev-данными. Затем overrides/запуск из `docs/development.md`, раздел «Распознавание: запуск для клиента / QA: сервер, worker, демо»: DEBUG=1, ALLOW_LOCAL_RECOGNITION_API=1, loopback, точный Vite origin в DJANGO_CSRF_TRUSTED_ORIGINS, отдельные непересекающиеся QA MEDIA/scratch, provider=fake. API и worker используют одну БД/MEDIA. Выполнить проверки/TCP-пробы и migrate по этому документу; `seed_recognition_demo` создаст только синтетические single.png/double.png, не чеки или задания.

```powershell
# Из корня, после полного QA env/подготовки:
./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py seed_recognition_demo
./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py runserver 127.0.0.1:18000 --noreload
# Другой терминал с тем же env:
./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py recognition_worker --fake-scenario success2
# frontend/, с VITE_API_BASE_URL=/api и DEV_API_PROXY_TARGET=http://127.0.0.1:18000:
npm.cmd run dev -- --port 15173
```

Новый API анонимный, локальный; CSRF нужен для unsafe методов даже анониму. Авторизация Codex/состояние Celery не подтверждаются executor/health. Настоящий Codex, фотографии пользователя и секреты И1 не использовал. Исходные 16 public JSON fixtures — вымышленные backend HTTP-данные, не записи, загруженные И1 в БД.

## Ручная приёмка каркаса

1. Проверить меню «Каталог», «Чеки», «Обработка», «Состояние сервисов»; выбранный раздел обозначен. Открыть напрямую и обновить все пять новых URL (например IDs 71/31); заглушки не должны выдавать вымышленные данные/статусы.
2. Перейти между новыми разделами клавиатурой, затем Назад/Вперёд. Проверить видимый фокус, h1 после смены pathname, skip link. В detail, открытом из отфильтрованного списка, ссылка возврата сохраняет параметры; при прямом входе ведёт на первую страницу списка.
3. Открыть `/receipts?product=0`, `/recognition/jobs?status=unknown&page=0`: понятная invalid-query с явным сбросом. ID 0/небезопасный integer/неизвестный маршрут: not-found.
4. На ширинах 320/540/920 px и при масштабе 200% проверить перенос всех четырёх пунктов меню, длинных текстов/ID, доступность действий без горизонтального переполнения. Существующий flex-wrap используется без новой анимации.
5. При запущенном QA Django загрузить синтетическую картинку по HTTP-сценарию `docs/verification.md`, получить настоящий original/preview/crop URL из ответа, открыть его через Vite и напрямую через API: один файл/Content-Type. И1 не добавляет экран показа картинки; отсутствие UI-функций соответствует заглушкам.
6. Повторить прежние SPA-сценарии из `docs/verification.md` («Ручная UI-приёмка человеком») и `docs/frontend.md` («Ручная приёмка каталога», «Клавиатурная приёмка локального фокуса R2», health). Админку открывать напрямую на 18000; её прежняя ручная приёмка отдельно по verification.md, исходники админки И1 не менялись.

После И2/И3: проверить double.png → queued/running/succeeded → два чека, replay тех же байтов, cancel/retry/409, terminal остановку опроса, needs_review/issues, unmatched строки, доступность MEDIA и ошибки сети/CSRF/лимитов. Сейчас этот UI-сценарий **не реализован**. После проверки остановить созданные процессы и свой QA Compose без `-v`.

## Проверки И1

Проверено и прошло в Windows, Node 24.18.0/npm 11.16.0, без БД:

| Команда (в `frontend/`) | Итог |
| --- | --- |
| `npm.cmd ci` | exit 0, 188 пакетов, 0 vulnerabilities; предупреждение о поддержке закреплённого ESLint, зависимости не менялись |
| `npm.cmd run lint` | exit 0 |
| `npm.cmd run test` | exit 0, **768 тестов / 24 файла** |
| `npm.cmd run build` | exit 0, tsc и Vite build прошли |

Из корня: `node (Join-Path $env:TEMP 'checkist-i1-proxy-task_muudsxnkc9.mjs') (Get-Location).Path` — exit 0; временный HTTP-script, описанный ниже, не является deliverable. `git diff --check` — exit 0. Для повторения proxy-проверки с настоящим Django использовать шаг 5 ручного сценария и QA environment выше.

Vitest проверяет transport с mocked fetch, все 16 backend public JSON непосредственно с диска, отрицательные схемы, таймаут/abort/CSRF, маршруты/History и SSR-подключение страниц. Lint проверяет исходники; tsc/Vite — сборку. Это не визуальная или интерактивная проверка браузера.

Дополнительно выполнен временный Node HTTP-прогон с настоящими Vite dev (15281) и preview (15282) и **fixture HTTP-server вместо Django**: `/media` Content-Type и байты, передача CSRF cookie/header, реальный multipart POST/202, GET через исходные адаптеры, SPA fallback для upload — прошли. Серверы закрыты в finally. Он проверяет proxy/транспорт и не доказывает реальную Django CSRF-проверку, браузерную отправку cookies, OCR или импорт.

Ранние проверки выявили и исправили: два теста повторно использовали прочитанный Response в mock; tsc потребовал Node types для чтения fixtures и выявил несовместимое расширение общего enum ошибок (теперь отдельный LocalApiResult); ESLint запретил control characters в regex (проверка заменена на codePoint); пять новых SSR-тестов предполагали другой порядок атрибутов ссылки (теперь проверяется ровно одна активная ссылка и её URL независимо от порядка атрибутов). Ожидания не ослаблялись. На финальном состоянии повторены необходимые проверки.

Не проверены: настоящий QA Django/DB/OCR/proxy-сценарий (backend venv отсутствует, UI пока заглушки), визуальное/клавиатурное runtime-поведение React (принимает человек, browser automation запрещена), реальное качество Codex. Новых изменений backend-контракта или зависимостей нет; расхождений docs/public fixtures/прочитанной сериализации для реализованных форм не обнаружено. Исторические описания «Vite только /api» в общих docs теперь требуют актуализации интегратором; эти документы вне зоны И1.
