# Ф1: клиент API слияния дублей товаров

Слой клиента для `/api/product-merges/` (контракт — `docs/api-contract.md`, раздел «локальный API слияния дублей товаров (С2)»; эталоны — `backend/merges/tests/fixtures/public/*.json`). Экранов, маршрутов и пометок здесь нет: их делает Ф2 и пользуется этим модулем, не меняя его.

## Функции (`product-merges.ts`)

Все возвращают `Promise<LocalApiResult<T>>`; `options?: RequestOptions` — `{ signal?, baseUrl? }`. Отмена — отдельный `kind: 'aborted'`, не ошибка. Общий срок запроса — 15 секунд.

| Функция | Запрос | `T` |
| --- | --- | --- |
| `getProductMerges(params?: MergeGroupParams, options?)` | GET `product-merges/` — `status`, `product`, `page`, `page_size` | `Page<MergeGroupBrief>` |
| `getProductMerge(id, options?)` | GET `product-merges/{id}/` | `MergeGroup` |
| `getProductMergeLines(id, params?: PageParams, options?)` | GET `product-merges/{id}/lines/` | `Page<MergeLine>` |
| `detectProductMerges(options?)` | POST `product-merges/detect/`, тело `{}` | `MergeDetectResult` |
| `confirmProductMerge(id, input: MergeConfirmInput, options?)` | POST `…/{id}/confirm/` | `MergeGroup` |
| `cancelProductMerge(id, options?)` | POST `…/{id}/cancel/`, тело `{}` | `MergeGroup` |
| `excludeProductMerge(id, input: MergeExcludeInput, options?)` | POST `…/{id}/exclude/` | `MergeGroup` |

- `MergeConfirmInput` — `{ version, target_product_id, name_product_id?, resolutions? }`; `resolutions` — `Partial<Record<MergeConflictField, number>>`: id записи, чьё значение спорного поля берётся. `MergeExcludeInput` — `{ version, product_id }`.
- Тело собирается только из документированных ключей: лишние ключи объекта не уходят на сервер; `name_product_id: undefined` и пустой `resolutions` не передаются. `null` в `name_product_id` отклоняется локально.
- Небезопасные и неположительные идентификаторы, `version` и значения `resolutions`, а также неизвестное спорное поле дают `invalid_parameter` с именами полей (`id`, `version`, `target_product_id`, `name_product_id`, `product_id`, `product`, `resolutions.<поле>`) **до** запроса токена и без обращения к серверу — у такого результата нет `status`.
- `version` и `target_product_id` экран берёт из последней прочитанной «Группы»; id записей с разными значениями — из `conflicts` группы, а не из ошибки.

## Типы (`product-merges-types.ts`, реэкспорт из `product-merges.ts`)

`MergeStatus` (`pending` / `confirmed` / `cancelled`, список — `mergeStatuses`), `MergeMemberRole`, `MergeMemberState`, `MergeConflictField` (список — `mergeConflictFields`), `MergeMemberBrief`, `MergeMember` (+ `aliases`), `MergeConflict`, `MergeActions`, `MergeGroupBrief` (список: `has_conflicts`, записи без `aliases`), `MergeGroup` («Группа»: `conflicts`), `MergeLine`, `MergeDetectResult`, `MergeGroupParams`, `MergeResolutions`, `MergeConfirmInput`, `MergeExcludeInput`.

Имена полей — как в JSON сервера; десятичные значения остаются строками. В записи группы нет `attributes`: конфликт по ним виден только в `conflicts`.

## Схемы (`product-merges-schema.ts`)

`isMergeGroup`, `isMergeGroupBrief`, `isMergeMember`, `isMergeMemberBrief`, `isMergeLine`, `isMergeDetectResult`; страницы — `page(...)` из `schema.ts`. Ответ, не прошедший схему, — `invalid_response`. Помимо формы полей проверяется согласованность, описанная контрактом: записи идут по возрастанию `product_id` без повторов; `target_product_id` — одна из записей; `resolved_at` пуст только у ожидающей группы; у завершённой группы нет действий, конфликтов и новых строк; `new_lines_count ≤ lines_count`; даты записи есть ровно тогда, когда `lines_count > 0`; конфликт называет не менее двух разных записей этой группы.

## Ошибки

`reason` результата `kind: 'error'` (тип `LocalApiErrorReason` в `types.ts`). Новые причины слияния — все HTTP 409, список `mergeErrorReasons`, тип `MergeErrorReason`, проверка `isMergeError(failure)`:

| `reason` | Когда | Что делать экрану |
| --- | --- | --- |
| `merge_conflict` | у записей разные значения поля либо результат совпал с посторонним товаром | `fields` — имена: спорное поле (`generic`, `brand`, …), `name` или `gtin`; ничего не сохранено |
| `merge_resolved` | группа уже подтверждена или отменена | перечитать группу |
| `merge_changed` | `version` устарела | перечитать группу и показать новый состав |
| `merge_busy` | идёт импорт чека или другое слияние | предложить повторить позже; сам клиент не повторяет |

Остальные причины прежние: `invalid_parameter` (с `fields`, в том числе `resolutions.<поле>`), `invalid_request`, `not_found`, `page_out_of_range`, `csrf_failed`, `permission_denied`, `method_not_allowed`, `not_acceptable`, `unsupported_media_type`, `database_unavailable`, `server`, `network`, `timeout`, `invalid_response`. `fields` — только имена; сообщения сервера в результат не попадают. Код слияния под другим HTTP-статусом и неизвестный код — `invalid_response`.

## Общий POST с CSRF (`local.ts`)

`mutate`, `getLocalJson`, `getRecognitionCsrf`, `clearRecognitionCsrf` вынесены из `recognition.ts` без изменения поведения; `recognition.ts` по-прежнему реэкспортирует три последние. Токен берётся из `GET recognition/csrf/`, хранится в памяти отдельно для каждого префикса API и общий для распознавания и слияния. Изменяющий запрос автоматически **не повторяется** ни при какой ошибке; `csrf_failed` сбрасывает токен, новый берётся при следующем явном вызове. После `network` / `timeout` действие могло выполниться — перед повтором нужно перечитать группу.

## Проверка настоящего HTTP без браузера

`node frontend/scripts/check_product_merges_proxy.mjs <origin Vite>` — настоящие адаптеры в Node 24 через работающий Vite dev или preview. **Меняет данные**: только свежая QA-база (`migrate`, `seed_product_merge_demo`, `product_merges detect`), один прогон на базу; на изменённой базе скрипт отказывается работать. Требует QA-окружение в процессе: `POSTGRES_DB=checkist_qa[_суффикс]`, loopback-порты не из dev, `VITE_API_BASE_URL=/api`, `DEV_API_PROXY_TARGET`, точный Origin Vite в `DJANGO_CSRF_TRUSTED_ORIGINS`. Запуск сервера — `docs/development.md`, «QA: слияние дублей для клиента».

Сценарий: Vite отдаёт SPA, а его `/api` совпадает с ответом Django; CSRF-cookie и токен; POST без токена — 403; список, страницы, фильтры `status` / `product`, 400 и 404; повтор `detect` без изменений; группа и её покупки; 404 поглощённого id в `/api/products/{id}/`; отмена группы и повтор; подтверждение другой группы, устаревшая `version`, чужой `target_product_id`, повтор, другой оставляемый и отмена после подтверждения; конфликт молока без `resolutions` (409) и с ними; исключение записи и повтор; итог 4 / 2 / 1.
