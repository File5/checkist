# F6: main слит, каталог проверен на настоящем HTTP

Дата: 2026-10-04. Ветка `orca/task_mutxcp2r77`, исходный HEAD `0ccc3b2`. Выполнен разрешённый `git merge main` без конфликтов. Слитый main: `55b53af6c77c455d75dedf19cc17f85458838077`; SHA ветки сразу после слияния: **`913fceac80c0a5bd336036671f0ef008cee4af2c`**. В этой ветке находятся API чтения каталога и Django admin. [Контракт](../docs/api-contract.md) читается из этого же worktree.

Исправлена подпись поиска магазина: «Найти магазин по названию или городу». Настоящий `/api/stores/` ищет вывеску, название и город, поэтому обещание поиска по адресу было неверным. Уточнена существующая проверка разметки. Расхождений JSON с runtime-схемами, денежных форматов и параметров истории/сводки в выполненных запросах не обнаружено. Backend-код не исправлялся.

Обновлён [docs/frontend.md](../docs/frontend.md): API и Vite запускаются из текущей ветки, команды используют `backend/manage.py`; ограничения прежних F2/F5 отмечены как исторические. Добавлен [check_catalog_samples.mjs](scripts/check_catalog_samples.mjs): воспроизводимые HTTP-пробы через proxy на образцах и дополнениях F6 с проверкой статусов, JSON, настоящих runtime-схем и форматирования.

## Проверено и прошло

Windows / PowerShell, Python **3.13.9**, Node **24.18.0**, npm **11.16.0**, Docker **29.8.1**, Compose **5.5.1**. Postgres `17.11-alpine`, Redis `7.4.11-alpine`; Celery worker — Linux Docker/prefork. БД для HTTP и данных — **`checkist_qa`**, тестовая БД — **`test_checkist_qa`**, Compose — **`-p checkist_qa`**. Dev и локальный Postgres не использовались.

Перед запуском `git status --short` был пустым. `docker ps -a --format '{{.Names}} {{.Status}} {{.Labels}}'` — exit 0: контейнеров project `checkist_qa` не было; другие проекты не менялись. Проверка `Get-NetTCPConnection` с фильтром портов `25432,16379,18000,15173` — PowerShell exit 0, слушателей не найдено. `docker volume ls --filter label=com.docker.compose.project=checkist_qa` — exit 0: существовали два QA-тома; они сохранены и использованы без очистки. Каждый QA-процесс получил весь environment-блок из verification.md, воспроизведённый ниже.

Команды из корня, если отдельно не указан `frontend/`. У каждой native-команды проверялся её exit code, после ошибки зависимые шаги не продолжались.

| Команда | Exit | Наблюдаемый результат |
| --- | --- | --- |
| `git merge main` | 0 | Слияние без конфликтов, SHA выше |
| `py -3.13 --version`, `node --version`, `npm.cmd --version`, `docker --version`, `docker compose version` | 0 у каждой | Версии выше |
| `Copy-Item .env.example .env` | 0 (PowerShell) | Создан отсутствовавший локальный `.env`; файл игнорируется Git |
| `py -3.13 -m venv backend/.venv` | 0 | Собственный venv в worktree |
| `./backend/.venv/Scripts/python.exe -X utf8 -m pip install -r backend/requirements.txt` | 0 | Установлен закреплённый набор |
| `docker compose -p checkist_qa config --quiet` | 0 | Конфигурация валидна |
| `docker compose -p checkist_qa up -d --wait --wait-timeout 90 postgres redis` | 0 | Два healthy контейнера |
| Ограниченный socket-скрипт development.md через `./backend/.venv/Scripts/python.exe -X utf8 -` | 0 | **Оба** результата `127.0.0.1:25432: TCP OK`, `127.0.0.1:16379: TCP OK`; проверены сами результаты |
| `./backend/.venv/Scripts/python.exe -X utf8 -m pip check` | 0 | `No broken requirements found` |
| `./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py check` | 0 | `System check identified no issues (0 silenced)` |
| `./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py makemigrations --check --dry-run` | 0 | `No changes detected` |
| `./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py migrate --noinput` | 0 | `No migrations to apply`: QA-том уже содержал схему |
| `./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py test catalog stores receipts health api --exclude-tag=integration --verbosity=2` | 0 | **179 тестов OK**, без БД |
| `./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py test catalog stores receipts health api --tag=integration --verbosity=2` | 0 | **671 тест OK**, 122,639 с; runner создал и удалил `test_checkist_qa` |
| `docker compose -p checkist_qa up -d --build --wait --wait-timeout 120 worker` | 0 | Worker healthy; сборка использовала cache зависимостей |
| `./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py check_services` | 0 | БД/Redis `ok`, реальная задача и result backend: `{"message":"pong"}` |
| `./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py runserver 127.0.0.1:18000 --noreload` | Работал до остановки | API слушал 18000, запросы ниже реально выполнены |
| `npm.cmd run dev -- --port 15173` (в `frontend/`) | Работал до остановки | Vite ready, proxy на API 18000 |
| `node frontend/scripts/check_catalog_proxy.mjs healthy` | 0 | **25 сценариев**: direct API = proxy = настоящий адаптер; категории, generic, товары, карточка, история, сводка, магазины, поиск, фильтры, две страницы `page_size=1`, 400 и 404 |
| `node backend/scripts/check_health_proxy.mjs healthy` | 0 | 200 напрямую/через proxy, адаптер сохранил checks; 405 и 406 с точными телами |
| `node frontend/scripts/check_catalog_samples.mjs` | 0 | **18 HTTP-проб** через proxy: точные значения QA, две валюты, пустые состояния, runtime-схемы, форматирование, 400/404 |
| `npm.cmd ci` (финальный, в `frontend/`, после остановки Vite) | 0 | 188 пакетов, audit: 0 vulnerabilities; штатный deprecated warning ESLint |
| `npm.cmd run lint` (в `frontend/`) | 0 | ESLint без ошибок/предупреждений lint |
| `npm.cmd run test` (в `frontend/`) | 0 | **17 файлов, 472 теста**, включая уточнённую проверку подписи поиска |
| `npm.cmd run build` (в `frontend/`) | 0 | TypeScript и Vite, 52 модуля; сборка не подтверждает поведение React |
| `git diff --exit-code 5e1adfa -- backend/api` | 0 | Файлы API совпадают со снимком адаптеров |
| `git diff --exit-code HEAD -- backend compose.yaml .env.example docs/architecture.md docs/api-contract.md docs/data-model.md docs/development.md docs/verification.md` (до финального коммита) | 0 | Вне разрешённых frontend/docs изменений после merge нет |
| `git diff --check` | 0 | Нет whitespace-ошибок |
| `docker compose -p checkist_qa down` | 0 | Удалены только поднятые нами QA-контейнеры/сеть, **без `-v`** |

Runserver и Vite остановлены через Ctrl+C в своих сессиях (сессии вернули exit 1 при прерывании; это завершение серверов, не ошибка HTTP-проверки). После остановки `Get-NetTCPConnection` для четырёх QA-портов и `Get-CimInstance Win32_Process` для node/python/cmd этого worktree не нашли своих процессов/слушателей; PowerShell exit 0. `docker ps -a --filter label=com.docker.compose.project=checkist_qa` — exit 0, пусто. `docker volume ls --filter label=com.docker.compose.project=checkist_qa` — exit 0: оба тома остались.

### Данные, сохранённые для человека

До загрузки команда `manage.py shell -c` с `connection.settings_dict['NAME']`, counts и списками Product/Category/Store подтвердила БД `checkist_qa` и **0 чеков/товаров/категорий/магазинов**; exit 0. Поэтому образцы внесены **один раз**, через `save_samples()` внутри `transaction.atomic()`, затем в той же транзакции добавлены данные F6. Повторный seed не запускать.

| Сущность | ID и данные |
| --- | --- |
| RU-молоко с фасовкой 850 мл | Product **1**, категория **2**, Generic **1**; магазин **1**, 28.09.2026: `111.0000 RUB/шт`, `130.5882 RUB/л` |
| **Добавленная покупка этого же товара** | Receipt **9**, магазин Lidl **2**, DE, 02.10.2026: `1.2500 EUR/шт`, `1.4706 EUR/л`; номер `F6-QA-20261002`, итог `1.25`; `validate_receipt` вернул пустой список |
| DE-молоко без фасовки | Product **2**, магазин **2**; шесть покупок `1.05 → 1.09 EUR`, normalized = null |
| SSD KZ | Product **3**, магазин **3**, валюта KZT |
| **Добавленный товар без покупок** | Product **4**, «F6 QA — Молоко без покупок», Generic **1**, category **2**; prices/stores пусты, last_observed_at = null |
| **Добавленная пустая категория** | Category **4**, «F6 QA — Пустая категория»; products_total = 0 |

Всего **4 товара, 4 категории, 3 магазина, 9 чеков**. Всё — вымышленные образцы. Никаких пользователей/секретов/фото не добавлено. Значения двух валют проверены отдельными группами; сводка не складывает EUR и RUB.

Если томы сохранены, подготовка данных больше не нужна. В новой **пустой выделенной QA** можно повторить ровно выполненную подготовку после migrate и проверки пустоты; в PowerShell важна UTF-8 кодировка stdin:

```powershell
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
@'
from datetime import date
from decimal import Decimal
from django.db import connection, transaction
from catalog.models import Category, Product
from receipts.models import Receipt
from receipts.validation import validate_receipt
from api.tests.factories import save_samples, make_product, observe

assert connection.settings_dict["NAME"] == "checkist_qa"
assert not Receipt.objects.exists() and not Product.objects.exists()
with transaction.atomic():
    data = save_samples()
    line = observe(data.shop_milk, data.lidl_store, "EUR", date(2026, 10, 2), "1.25")
    line.receipt.receipt_number = "F6-QA-20261002"
    line.receipt.total = Decimal("1.25")
    line.receipt.save(update_fields=["receipt_number", "total"])
    assert not validate_receipt(line.receipt)
    unused = make_product(data.milk, "F6 QA — Молоко без покупок")
    empty = Category.objects.create(name="F6 QA — Пустая категория")
    print("RU milk", data.shop_milk.id, "Lidl", data.lidl_store.id)
    print("unused", unused.id, "empty category", empty.id)
'@ | ./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py shell -c "import sys; exec(sys.stdin.read())"
```

Команда исправленного фактического seed — тот же here-string с `shell -c "import sys; exec(sys.stdin.read())"`, exit 0, вывод IDs 1/2/9/4/4 и counts 4/4/9. Сначала она была выполнена без настройки `$OutputEncoding`; кириллица **только двух созданных нами названий** повредилась. Они исправлены в QA отдельным atomic shell-вызовом с UTF-8, проверкой `NAME == 'checkist_qa'`, префикса `F6 QA `, отсутствия покупок/товаров и `select_for_update()`; exit 0. Финальные HTTP-пробы подтвердили правильные названия. Повтор образцов для исправления не выполнялся.

## Проверено и не прошло

Все перечисленные промежуточные ошибки исправлены. Упавшие продуктовые тесты не отключались, существующие ожидания не ослаблялись. Обнаруженных дефектов backend в выполненных сценариях нет.

- Первый `<многострочный Python> | ./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py shell` — native exit **0**, но `InteractiveConsole` напечатал `SyntaxError: invalid syntax`: отсутствие пустой строки после блока `with`. Это **не успешная загрузка**, atomic-блок не исполнился. Исправлен способ запуска: `shell -c "import sys; exec(sys.stdin.read())"`; правильный seed exit 0.
- Первая разовая проба `@'…'@ | node --input-type=module -` — exit **1** на последнем 404: служебное ожидание ошибочно требовало «Объект не найден.» (и было испорчено ASCII stdin); реальный ответ — `{"error":{"code":"not_found","message":"Не найдено."}}`. Ошибка проверки, не backend. Итоговый файловый CLI сверяет точный действующий текст из `backend/config/exceptions.py`.
- Первый `node frontend/scripts/check_catalog_samples.mjs` — exit **1**: служебная проверка ожидала «Страница вне диапазона.», backend отдаёт «Страница за пределами диапазона.». Исправлено точное ожидание по `PageOutOfRange.message`; финальный прогон exit 0, проверки code/status/JSON сохранены.
- Первый повторный `npm.cmd ci` перед финальным прогоном — exit **-4048**, `EPERM unlink ...rolldown-binding.win32-x64-msvc.node`: работающий Vite удерживал native binding в Windows. Зависимые lint/test/build не запускались. Остановлены только свои Vite/API, установка и весь финальный набор заново прошли с exit 0. Воспроизведение: `npm ci` при работающем Vite из этих же node_modules.

## Не проверено и почему

- **React в браузере, визуальная/интерактивная/клавиатурная приёмка, фокус, screen reader, адаптив/zoom**: по правилам проверяет человек. Автоматического обхода UI и скриншотов нет. Этот markdown — фактический отчёт и сценарий, а не макет или подтверждение внешнего вида.
- **Более 50 товаров/наблюдений/магазинов**, длинные реальные тексты и производительность большого набора: текущие образцы малы. HTTP-пагинация доказана с `page_size=1`; у экранов размер 50, поэтому реальные кнопки второй страницы требуют расширить выделенную QA вымышленными записями. Данные/моки тестов не доказывают пользовательскую пагинацию.
- **Stop/recovery Postgres/Redis/worker/API**, отказ БД `500 internal_error`, независимость каталога от отказа Redis/worker: этот прогон проверял healthy. Общий транспорт не менялся. Воспроизведение — stop/recovery по verification.md на своей QA, после завершения чужих проверок; визуальный повтор по сценарию ниже.
- **Production hosting, deployment, push, merge в main, release, приёмка Django admin** не входят в F6. Слияние main выполнено только в своей task-ветке; системные настройки и Docker Desktop не менялись.

### Как снова поднять стенд

В **каждом** PowerShell-терминале из корня применить весь QA-блок:

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

Проверить свободный project и порты, как в [verification.md](../docs/verification.md#изолированная-qa-среда). `.env`/venv уже подготовлены в этом worktree; при новой копии следовать development.md. В первом терминале:

```powershell
docker compose -p checkist_qa config --quiet
docker compose -p checkist_qa up -d --wait --wait-timeout 90 postgres redis
# Выполнить ограниченные TCP-пробы development.md до команд с БД.
./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py check
./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py migrate --noinput
# Образцы уже в томе: save_samples повторно НЕ выполнять.
docker compose -p checkist_qa up -d --build --wait --wait-timeout 120 worker
./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py check_services
./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py runserver 127.0.0.1:18000 --noreload
```

Во втором терминале с тем же QA-блоком:

```powershell
Set-Location frontend
npm.cmd ci
npm.cmd run dev -- --port 15173
```

В третьем, из корня с QA-блоком:

```powershell
node frontend/scripts/check_catalog_proxy.mjs healthy
node frontend/scripts/check_catalog_samples.mjs
node backend/scripts/check_health_proxy.mjs healthy
```

Каждый exit проверять отдельно. Серверы доступны человеку на `http://127.0.0.1:15173/catalog` и `/health`; прямой API — `http://127.0.0.1:18000/api/`. После приёмки остановить свои серверы, `docker compose -p checkist_qa down` **без `-v`**. Перед `npm ci` остановить Vite, чтобы освободить native binding.

### Ручная приёмка человеком

1. На `/catalog` пройти «Продукты питания» → «Молочные продукты» → RU-молоко Product 1. Проверить поиск по имени, generic, переход в карточку, историю и сводку. На карточке 1 проверить магазины «Елена» и Lidl и отдельные валюты RUB/EUR; история 02.10.2026 — `1,25 EUR/шт`, `1,4706 EUR/л`, 28.09.2026 — `111 RUB/шт`, `130,5882 RUB/л`. Свои действия сверять с JSON, а не текущими ценами магазинов.
2. Применить store=2, country=DE, currency=EUR и период 02.10.2026–02.10.2026: одна покупка, отдельная сводка за весь период. Поиск магазина `Lindau` находит Lidl; подпись не обещает адресный поиск. country=RU вместе с currency=EUR даёт пустой результат; сброс возвращает покупки. Неверный диапазон показывает ошибки полей.
3. Открыть `/catalog/products/4` — покупок нет; `/catalog/categories/4` — пустая категория. У Product 2 фасовка/нормализация отсутствуют. `/catalog/products/5` — товар не найден; `/catalog/products/1?page=999` — первая страница истории с сохранением фильтров. Валюты и null не превращаются в общую или нулевую цену.
4. Открыть товар из поиска, применить фильтры, выполнить reload, Back/Forward и «Назад к списку»: проверить восстановление query и фокуса. При прямом входе есть выход в категорию. Пагинацию HTTP `page_size=1` повторить CLI; пользовательские кнопки страниц отдельно проверить на QA-наборе >50 записей.
5. Через DevTools замедлить сеть, быстро поменять фильтры и уйти со страницы. Отдельно блокировать `prices/`, `prices/summary/`, `stores/`: успешная карточка/соседние секции сохраняются, локальный повтор работает после снятия блокировки. Offline → Online → повтор; задержка >15 секунд → timeout → повтор. Для loading проверять геометрию и доступность действий.
6. Клавиатура: «К содержимому», Tab/Shift+Tab, Enter на ссылках/поиске, Enter/Space на кнопках, native select; фокус при переходе/возврате и после ошибки. Screen reader: единственный h1, крошки, labels, ошибки, caption/th, локальные статусы. Проверить 320/375/768/1280 px, zoom 200%, длинные тексты, видимый фокус, локальный горизонтальный scroll таблицы, scroll страницы и reduced motion.
7. На `/health` проверить успех, загрузку, локальный повтор и частичный отказ по [ручному сценарию verification.md](../docs/verification.md#ручная-ui-приёмка-человеком). Дополнительные подробности — [ручная приёмка каталога](../docs/frontend.md#ручная-приёмка-каталога-человеком).
