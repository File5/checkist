# merges: слияние дублей товаров (шаг С1)

Приложение без HTTP: модели, поиск, сервис, команды, демо-данные. HTTP-слой, видимость в 13 GET и вызов из импортёра — шаг С2. Контракт — ответ задачи `task_muvqny7n3u`; общие `docs/` обновляет С2.

## Что вызывать из С2

Всё в `merges.services`. Изменяющая операция — одна транзакция: неблокирующий `IMPORT_LOCK`, строка группы, затем `Product` по возрастанию id. `transaction.atomic()` не `durable`, блокировка в пределах сессии повторно входима — `detect` можно звать из транзакции импортёра.

| Функция | Результат |
| --- | --- |
| `detect(*, dry_run=False, product_ids=None)` | `DetectResult(created, extended, group_ids, proposals, dry_run)`. `product_ids` — только пары с этими товарами (шаг после импорта). `dry_run` не пишет и блокировку не берёт |
| `confirm(group_id, *, version, target_product_id, name_product_id=None, resolutions=None)` | `ProductMerge` в `confirmed` |
| `cancel(group_id)` | `ProductMerge` в `cancelled` |
| `exclude(group_id, *, version, product_id)` | `ProductMerge` (`pending` либо `cancelled`) |
| `cancel_pending()` | список id отменённых групп, каждая — своя транзакция |
| `get_group(group_id)` | `ProductMerge` либо `MergeNotFound` |
| `groups(*, status=None, product=None)` | queryset, порядок `-id`; `product` — id товара в любой роли |
| `describe(groups, *, with_aliases=True)`, `describe_group(group)` | `GroupInfo` на каждую группу; не больше 6 запросов на всю страницу (5 без `aliases`) |
| `group_lines(group)` | queryset `ReceiptLine` с `origin_product_id`, порядок `purchased_at, receipt_id, position`, один запрос со связями чека |

`GroupInfo`: `group`, `members` (порядок `product_ref`), `conflicts` — `[(поле, [id товаров])]`, `lines_count`, `new_lines_count`, `can_confirm` / `can_cancel` / `can_exclude`. `MemberInfo`: `member` (`product_ref`, `role`, `state`), `product` (живой товар либо `None`), `exists`, `name`, `facts`, `classified`, `lines_count`, `first_purchased_on`, `last_purchased_on`, `aliases` — объекты `ProductAlias` с загруженным `merchant` (до 50).

`facts` — одна форма для живого товара и для снимка: `{"generic": {"id", "name", "base_unit"}, "brand": {"id", "name"} | null, "model", "gtin", "package": {"quantity": "10.000", "unit": "pcs"} | null, "attributes": {...}}`.

### Исключения

Все наследуют `MergeError`, у каждого `code` — код ошибки контракта.

| Исключение | `code` | Данные |
| --- | --- | --- |
| `MergeNotFound` | `not_found` | — |
| `MergeBusy` | `merge_busy` | занят `IMPORT_LOCK` либо SQLSTATE `55P03` / `57014` / `40P01` |
| `MergeResolved` | `merge_resolved` | `.group` |
| `MergeChanged` | `merge_changed` | `.group` с текущей `version` |
| `MergeConflict` | `merge_conflict` | `.fields`: `{поле: [id товаров]}`; при нарушении unique — `{"name": []}` либо `{"gtin": []}` |
| `MergeInvalidParameter` | `invalid_parameter` | `.fields`: `{параметр: причина}` |

Причины `MergeInvalidParameter`: `not_member` (`target_product_id`, `name_product_id`, `product_id`), `invalid_type` (`resolutions`), `not_conflict` и `not_candidate` (ключи `resolutions.<поле>`). Прочий отказ БД сервис не перехватывает — это `503 database_unavailable` на стороне представления.

### Видимость (`merges.visibility`)

- `visible(queryset)` — queryset `Product` без поглощённых, `NOT EXISTS`, без нового запроса.
- `visible_q(prefix="")` — то же условие как `Q` для счётчиков: `Count("products", filter=visible_q("products__"))`.
- `absorbed_product_ids()`, `is_absorbed(product_id)`.

Поглощённый товар — запись с `role='source'` и непустым `active_product`. Сервис держит `active_product` заполненным ровно пока группа ожидает и запись активна, поэтому условие не соединяется с таблицей групп.

## Уточнения к контракту

Формат контракта не менялся. Ниже — то, что контракт не определял, и как это решено.

1. **Журнал исключённой записи удаляется** вместе с её восстановлением; у исключённой записи `lines_count = 0`, `aliases = []`. После отмены группы журнала нет вовсе (так в контракте), у отменённой группы `lines_count = 0`.
2. **`lines_count` и `new_lines_count` группы.** Ожидающая: все строки оставляемого товара и те из них, что вне журнала. Подтверждённая: размер журнала и `0`. `group_lines` — соответственно.
3. **Исключение записи** восстанавливает всю группу и сливает оставшихся заново, поэтому строки, пришедшие за время ожидания, после исключения записаны в журнал: за владельцем своего написания, а без такого владельца — за оставляемой записью.
4. **Повтор `exclude` уже исключённой записи** отвечает текущей группой и тогда, когда это исключение отменило группу.
5. **`resolutions`** принимает только запись с непустым значением спорного поля; выбрать «оставить пустым» нельзя.
6. **Название из одних знаков** (сжатое название пусто) кандидатом не бывает.
7. **Расширение группы** оставляемую запись не меняет; снимок названия и фактов записи обновляется при подтверждении.
8. **Имя БД для демо** — `test_*` либо `checkist_qa` с необязательным `_суффиксом`, как у `seed_recognition_demo`.
9. **Конфликт молока в демо** создан намеренно: у «GQ EgSB H-Milch 1,5%» обобщённый продукт «Молоко», у «GO EgSB H-Milch 1,5%» — «H-Milch (демо)». Без него сценарий конфликта из плана проверок не воспроизвести.
10. **Автопоиск при импорте.** Флаг `PRODUCT_MERGE_AUTO_DETECT` добавлен в настройки; сам вызов — в С2.

## Запуск в QA

После полного блока окружения из `docs/verification.md`:

```powershell
./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py migrate --noinput
./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py seed_product_merge_demo
./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py product_merges detect --dry-run
./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py product_merges detect
```

`seed_product_merge_demo` создаёт двух вымышленных продавцов, 9 чеков, 42 строки и 35 товаров; повтор ничего не меняет; на БД с другим именем команда завершается ошибкой. `detect` создаёт 7 ожидающих групп, повтор — `created: 0, extended: 0`.

Откат: сначала `manage.py product_merges cancel-pending`, затем `migrate merges zero`. Без первой команды ожидающие группы останутся слитыми без журнала; подтверждённые слияния откатом не разъединяются — только восстановлением из `pg_dump`.
