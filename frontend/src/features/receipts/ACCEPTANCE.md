# И3: список чеков и подробный чек

Реализованы страницы `/receipts` и `/receipts/{id}` на локальном API. Список показывает магазин, адрес, дату, операцию, итог в валюте, число строк, несопоставленные товары и миниатюру. Поиск, включительный период, операция, сортировка и страница сохраняются в URL; по умолчанию новые покупки идут первыми. Фильтры магазина/товара/страны/валюты из входящей ссылки сохраняются при поиске и пагинации, полный сброс их удаляет.

В чеке пять независимых блоков: сведения, изображения, строки, скидки, налоги. Каждый имеет загрузку, ошибку и свой повтор. У дочерних списков отдельная пагинация; доступны все страницы изображений, включая фото из разных заданий. Ошибка шапки сохраняет строки и суммы без предположения о валюте. Строки показывают напечатанное название, вид, количество/единицу, цену, сумму, скидку, оплачено и ссылку на товар каталога либо «Товар не сопоставлен». Залог и скидка ссылаются на строку на текущей странице; для родителя вне страницы явно указан его ID. Переход к такому родителю выполняется через пагинацию строк.

Деньги остаются Decimal-строками; форматирование использует `lib/format`, дата/время — часовой пояс магазина. Пустой текст обозначен «Не распознано», нулевые суммы сохраняются. Изображения проходят `safeMediaUrl`, имеют alt, собственную заглушку и повтор при ошибке. Таблица находится в отдельной доступной с клавиатуры области горизонтальной прокрутки. Локальный фокус обслуживает `useLocalRequestFocus`; смена страницы/фильтра или уход со страницы отменяет запрос, поздние ответы игнорируются.

Изменения ограничены `frontend/src/features/receipts/`. Экспорты/props И1 сохранены, один h1 принадлежит App. API, backend, маршруты, зависимости и область И2 не изменены. В этой ветке страницы загрузки/обработки остаются каркасом И1 до интеграции И2; ссылки ведут на предусмотренные маршруты. Редактирования чеков через UI нет.

Это артефакт передачи настоящих результатов и ручной приёмки. Скриншоты и визуальная проверка браузера не выполнялись; автоматический обход UI запрещён проектом. Markdown не является макетом экрана.

## Проверено и прошло

Windows; Node `v24.18.0`, npm `11.16.0`. Frontend без БД:

| Команда из `frontend/` | Результат |
| --- | --- |
| `npm.cmd ci` | Exit 0, 188 пакетов, 0 vulnerabilities; предупреждение о поддержке закреплённого ESLint |
| `npm.cmd run lint` | Exit 0 |
| `npm.cmd run test` | Exit 0, 810 тестов / 27 файлов; 42 новых теста И3 |
| `npm.cmd run build` | Exit 0, TypeScript и Vite build |

Vitest/SSR читает эталонные JSON непосредственно из `backend/recognition/tests/fixtures/public/`. Проверены представление данных, несопоставленная строка, залог/возврат залога, скидки/налоги, пустые состояния, ошибки каждого блока, неизвестная валюта при отказе шапки, безопасные изображения, семантика/alt, URL-фильтры и ссылки пагинации. Контроллер запросов проверен на поздние ответы, abort, cleanup/StrictMode и независимый повтор; transport-тесты используют настоящие адаптеры с mocked fetch. Они не запускают React в браузере.

Дополнительно выполнен **настоящий HTTP-прогон Windows → Vite → Django → QA Postgres**, без mock-сервера. БД/Compose project `checkist_qa_i3`, Postgres `25483`, Redis `16413`, Django `18083`, Vite `15283`; dev и чужой QA не изменялись. Python 3.13, Django 5.2.17 и остальные закреплённые требования установлены в игнорируемый `.orca-attachments/i3-qa/venv`. Ниже `P` — фактически использованный `./.orca-attachments/i3-qa/venv/Scripts/python.exe -X utf8 -B`; перед каждой host-командой применён полный QA environment с перечисленными портами.

| Фактическая команда/проверка | Результат |
| --- | --- |
| `py -3.13 -X utf8 -m venv .orca-attachments/i3-qa/venv`; `./.orca-attachments/i3-qa/venv/Scripts/python.exe -X utf8 -m pip install -r backend/requirements.txt`; `P -m pip check` | Каждая exit 0, закреплённый набор установлен, no broken requirements |
| `docker compose -p checkist_qa_i3 config --quiet`; `docker compose -p checkist_qa_i3 up -d --wait --wait-timeout 90 postgres redis` | Exit 0, оба healthy на выделенных QA-портах |
| TCP `TcpClient.ConnectAsync('127.0.0.1', port).Wait(3000)` для 25483/16413 | Оба подключились; до действий с БД |
| `P backend/manage.py check`; `P backend/manage.py migrate --noinput`; `P backend/manage.py seed_recognition_demo` | Каждая exit 0: no issues, 23 существующие миграции применены в пустую QA-БД, созданы synthetic single.png/double.png |
| `P backend/manage.py runserver 127.0.0.1:18083 --noreload`; `npm.cmd run dev -- --host 127.0.0.1 --port 15283 --strictPort` | Оба обслужили настоящий HTTP, после прогона остановлены |
| `node .orca-attachments/i3-qa/upload.mjs`; `P backend/manage.py recognition_worker --fake-scenario success2 --once` | Upload через Vite: 202/queued, Job 1 succeeded; два чека без дублей |
| `node .orca-attachments/i3-qa/upload.mjs single.png`; `P backend/manage.py recognition_worker --fake-scenario one_receipt --once` | 202/queued, Job 2 succeeded; Receipt 1 переиспользован, число чеков осталось 2, две вырезки от двух фото/jobs |
| `P backend/manage.py shell -c "from django.conf import settings; from receipts.models import ReceiptLine; assert settings.DATABASES['default']['NAME'] == 'checkist_qa_i3'; lines = ReceiptLine.objects.filter(receipt__store__name='TESTMARKT', raw_name='APFEL'); assert lines.count() == 1; changed = lines.update(product=None); print('QA unmatched lines:', changed)"` | Exit 0, ровно одна синтетическая товарная строка отвязана для приёмки |
| `P backend/manage.py shell -c "from pathlib import Path; exec(Path('.orca-attachments/i3-qa/seed_pagination.py').read_text(encoding='utf-8'))"` | Exit 0, создан только QA Receipt 3: 51 строка, итог 51 EUR; залог в строке 51 к строке 1 |
| `node frontend/src/features/receipts/check-http.mjs http://127.0.0.1:15283 http://127.0.0.1:18083 3` (из корня) | Exit 0; 3 чека; для Receipt 1: 4 строки, 1 скидка, 2 налога, 2 изображения, 1 несопоставленный товар. Проверены поиск/даты/сортировка/страницы, пустой поиск и реальные 404 page_out_of_range, runtime-схемы, MEDIA HTTP 200/image/* и совпадение байтов proxy/Django, SSR из реальных ответов; Receipt 3: страницы 50+1 строк и ID родителя за пределами страницы |

`check-http.mjs` закоммичен и только читает API. Он требует синтетический набор `success2` из выделенной QA-БД; необязательный третий аргумент — ID чека с 51 строкой. Временные upload/seed-скрипты и MEDIA игнорируются; повторяемая подготовка описана ниже. HTTP/SSR не подтверждают браузерные события, cookies браузера, интерактивность или визуальный адаптив.

Уборка: Ctrl+C остановил runserver/Vite (exit 1 вследствие прерывания, npm подтверждён ответом Y). `docker compose -p checkist_qa_i3 down` — exit 0, только свои контейнеры/сеть удалены без удаления томов. `docker ps -a --filter label=com.docker.compose.project=checkist_qa_i3 --format '{{.Names}} {{.Status}}'` — exit 0, пусто; проверка `Get-NetTCPConnection -State Listen` не нашла слушателей на 25483/16413/18083/15283. Созданный для запуска `.env` удалён; MEDIA/QA venv и тома сохранены. `git diff --check` — exit 0.

## Проверено и не прошло

- Первый `npm.cmd run test` после добавления тестов: exit 1, 2 failure. `URLSearchParams` заменял непарный Unicode-суррогат в поиске до валидации: исправлена проверка исходной строки. Второй тест ошибочно предполагал порядок query-параметров: теперь проверяет все пары параметров следующей страницы через URL. Финальный прогон — 810/810, ожидания поведения сохранены.
- Диагностика системного Python `py -3.13 -X utf8 -B -c "import sys; import django; import rest_framework; import psycopg; print(sys.version); print(django.get_version())"`: exit 1, `ModuleNotFoundError: django`. Найденный внешний venv также не содержал Django/pip; он не менялся. Создан собственный QA venv с закреплёнными требованиями, последующие host-проверки прошли.
- Первая составная попытка QA-старта: PowerShell отказал в загрузке собственного `environment.ps1` из-за ExecutionPolicy; shell продолжил команды, Compose получил конфликт `127.0.0.1:6379 already allocated` (exit 1). Неуспешные контейнеры только `checkist_qa_i3` удалены через `down`, затем все переменные выставлены прямо в командах и повторный старт прошёл на 25483/16413. ExecutionPolicy, dev и чужие процессы не изменялись.

## Не проверено и почему

- Визуальный/интерактивный React, фокус, скролл, browser image onError и повтор, клавиатура, responsive/200% — принимает человек по сценарию ниже. SSR подтверждает HTML и контракт состояния, а не пользовательские события.
- Сквозной UI upload → polling/cancel → receipts требует И2. Здесь загрузка и FakeProvider проверены через реальный HTTP/CLI, а не через UI.
- Настоящий Codex, реальные фотографии, качество OCR, его auth/облачная сеть — вне frontend-задачи; использованы только синтетические фото и явный FakeProvider.
- Полные backend integration/health/Celery suites, production, нагрузка и rollback не повторялись: backend/схема/настройки не менялись, Celery для этого HTTP-сценария не требуется. Общие сценарии — в `docs/verification.md`.
- Успешная пагинация скидок/налогов/изображений при >50 записях проверена только на уровне общего контроллера/SSR; фактический QA-набор содержит 1/2/2 записи. Для ручной приёмки больших списков нужен расширенный синтетический QA-набор.

## Запуск и тестовые данные для человека

Подготовить `.env` и Python/Node по `docs/development.md`. В **каждом терминале из корня** сначала весь QA environment из `docs/verification.md`, затем заменить DB/порты и добавить overrides следующим блоком. Убедиться, что project/порты свободны; не останавливать чужую QA.

```powershell
$env:COMPOSE_PROJECT_NAME='checkist_qa_i3'
$env:POSTGRES_DB='checkist_qa_i3'
$env:POSTGRES_HOST='127.0.0.1'
$env:POSTGRES_PORT='25483'
$env:REDIS_PORT='16413'
$env:CELERY_BROKER_URL='redis://127.0.0.1:16413/0'
$env:CELERY_RESULT_BACKEND='redis://127.0.0.1:16413/1'
$env:DJANGO_CACHE_URL='redis://127.0.0.1:16413/2'
$env:VITE_API_BASE_URL='/api'
$env:DEV_API_PROXY_TARGET='http://127.0.0.1:18083'
$env:DJANGO_DEBUG='1'
$env:ALLOW_LOCAL_RECOGNITION_API='1'
$env:DJANGO_CSRF_TRUSTED_ORIGINS='http://127.0.0.1:15283'
$env:MEDIA_ROOT=Join-Path (Get-Location) '.orca-attachments/i3-qa/media'
$env:RECEIPT_OCR_TEMP_ROOT=Join-Path (Get-Location) '.orca-attachments/i3-qa/scratch'
$env:RECEIPT_OCR_PROVIDER='fake'
```

Пользователь/пароль БД — публичные локальные значения из `.env.example`; должны соответствовать собственному QA-тому. Доступ анонимный, только DEBUG + флаг API + loopback; superuser для этих экранов не нужен. Upload требует cookie/token CSRF даже для анонима. Auth Codex не менялась. Vite И1 уже проксирует и `/api`, и `/media`; старые фразы «proxy только /api» в общих docs требуют актуализации интегратором вне зоны И3.

```powershell
docker compose -p checkist_qa_i3 config --quiet
docker compose -p checkist_qa_i3 up -d --wait --wait-timeout 90 postgres redis
# После ограниченных TCP-проб 25483/16413:
./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py check
./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py migrate --noinput
./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py seed_recognition_demo
./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py runserver 127.0.0.1:18083 --noreload
# Другой терминал, тот же env; worker можно держать запущенным:
./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py recognition_worker --fake-scenario success2
# Третий терминал, env задан до смены каталога:
Set-Location frontend
npm.cmd ci
npm.cmd run dev -- --host 127.0.0.1 --port 15283 --strictPort
```

В текущем worktree вместо `backend/.venv` можно использовать подготовленный `.orca-attachments/i3-qa/venv`. QA-тома и MEDIA сохранены после прогона, процессы остановлены. При новой QA-среде сначала загрузить `MEDIA/demo/double.png` через И2 либо HTTP-сценарий из `docs/verification.md` («Распознавание: сквозная серверная проверка»): получить CSRF → multipart upload → job succeeded. Для второго фото остановить свой worker, выбрать `--fake-scenario one_receipt`, загрузить single.png; тот же чек получит ещё одну вырезку. Fake не распознаёт текст произвольного фото. Не отправлять реальные пользовательские фото.

Текущие данные: Receipt 1 — TESTMARKT, 04.10.2026 14:35 Europe/Berlin, итог 4.42 EUR, скидка 0.20 EUR, MILCH/APFEL/MINERALWASSER/PFAND, APFEL без товара, две вырезки/jobs 1 и 2. Receipt 2 — TESTSHOP, итог 6.00 EUR, две строки. Receipt 3 — 51 синтетическая строка, итог 51.00 EUR, без фото/скидок/налогов. IDs в новой QA-БД нужно брать из ответов.

Для воссоздания чека с пагинацией открыть `manage.py shell` **в QA environment**, вставить следующий код. Он идемпотентен для своей записи и не трогает распознанный чек:

```python
from datetime import timedelta
from decimal import Decimal as D
from django.conf import settings
from django.db import transaction
from receipts.models import Receipt, ReceiptLine
assert settings.DATABASES['default']['NAME'] == 'checkist_qa_i3'
with transaction.atomic():
    base = Receipt.objects.get(store__name='TESTMARKT', purchased_on='2026-10-04')
    demo, created = Receipt.objects.get_or_create(
        store=base.store, receipt_number='i3-qa-pagination',
        defaults=dict(currency=base.currency, operation='sale',
            purchased_at=base.purchased_at + timedelta(days=1),
            purchased_on=base.purchased_on + timedelta(days=1), total=D('51.00')),
    )
    if created:
        parent = None
        for position in range(1, 52):
            line = ReceiptLine.objects.create(receipt=demo, position=position,
                kind='deposit' if position == 51 else 'product',
                parent=parent if position == 51 else None,
                raw_name=f'I3 TEST LINE {position}', quantity=D('1.000'),
                unit='pcs', unit_price=D('1.0000'), amount=D('1.00'))
            if position == 1:
                parent = line
print(demo.id)
```

Команда `shell -c` для синтетического APFEL приведена в таблице прогона. Оба изменения выполняются только в QA. После них из корня повторить `node frontend/src/features/receipts/check-http.mjs http://127.0.0.1:15283 http://127.0.0.1:18083 <ID чека с 51 строкой>`.

## Ручная приёмка экранов

1. Открыть `http://127.0.0.1:15283/receipts`, затем обновить страницу. На пустой новой QA-БД проверить приглашение загрузить первое фото. После подготовки данных проверить магазин, дату, итог с валютой, число строк, миниатюру и пометку несопоставленного товара. «Загрузить фото»/«Обработка» ведут в соответствующие разделы; функциональность этих разделов принимает И2.
2. Ввести `MILCH`, период 04.10.2026–04.10.2026, применить: найден TESTMARKT. Проверить URL, обновление, Назад/Вперёд и поля формы. Выбрать старые первыми/возврат, проверить порядок/пустой результат; сбросить фильтры. Поиск из одного символа и обратный период дают подпись ошибки и фокус на неверное поле.
3. Открыть `/receipts?page_size=1`: пройти страницы, проверить сохранение фильтров. Открыть чек из отфильтрованного списка, затем «К чекам» и browser Back: исходная страница/поиск сохранены, фокус возвращается на выбранный чек. Прямой вход `/receipts/1` возвращает на `/receipts`.
4. В Receipt 1 сверить шапку, EUR, 14:35, скидку 0.20; две картинки/jobs. Открыть каждую вырезку в новой вкладке. MILCH показывает 2 шт, цену 1.29, сумму 2.58, скидку 0.20, оплачено 2.38; товар ведёт в `/catalog/products/{id}`. APFEL имеет «Товар не сопоставлен». PFAND связан с MINERALWASSER; переход по связи выделяет строку. Скидка Rabatt MILCH связана со своей строкой, налоги 7%/19% показаны отдельно.
5. Receipt 3: 50 строк на первой странице и строка 51 на второй. Проверить доступность «Предыдущая»/«Следующая», независимость остальных блоков, явный ID родителя залога вне текущей страницы; вернуться на страницу 1. У чека без фото/скидок/налогов видны самостоятельные пустые состояния.
6. В DevTools человека заблокировать по очереди ровно один endpoint (`/api/receipts/1/`, `/lines/`, `/discounts/`, `/taxes/`, `/api/recognition/receipt-images/?receipt=1`), повторно открыть чек. Остальные блоки остаются доступны; при отказе шапки валюту не выдумывать. Снять блокировку, нажать только локальный «Повторить» — остальные ресурсы повторно не запрашиваются. Отдельно заблокировать MEDIA: заглушка ошибки конкретного изображения не закрывает JSON-данные; снять блокировку и повторить загрузку изображения.
7. Slow network: применить разные фильтры/страницы и уйти в другой чек, не дожидаясь ответа. Поздние данные не возвращают старый список/чек. Offline → ошибки → Online → локальный повтор. Проверить отсутствие непроизвольного переноса фокуса при редактировании поля/переходе в соседний блок.
8. Только клавиатура: Tab/Shift+Tab, Enter на ссылках/кнопках, фокус на таблице и горизонтальная прокрутка стрелками. Виден фокус на действиях и результатах локального повтора. Проверить 320/375/540/920 px и масштаб 200%, длинные названия/адреса, перенос фильтров, доступность каталожных ссылок и pager. Внешняя страница не должна прокручиваться горизонтально; прокручивается область таблицы. Анимаций нет.
9. Дополнительно повторить относящиеся сценарии SPA из `docs/verification.md` («Ручная UI-приёмка человеком») и `docs/frontend.md` (локальный фокус R2). Админку при необходимости открывать напрямую на Django, её приёмка отдельная и не заменяет проверку этих экранов.

### Значения не рвутся, таблица строк (В2, 2026-10-08)

Правила — в `Receipts.css`, стражи текста правил — `receipts-css.test.ts`, разметка — `receipts-markup.test.tsx`. Стражи читают текст CSS и SSR-разметку; перенос на экране они не подтверждают — его смотрит человек. DevTools → режим устройства; ширины 360, 390, 560, 768, 1024, 1280, 1440 px, тёмная и светлая тема. Нужен чек с крупными суммами (на dev — чек в KZT, «189 490,00 KZT») и чек на 30 строк.

10. `/receipts`: «Итог» в карточке чека стоит одной строкой на всех ширинах; отдельно выставить 560 и 600 px — раньше здесь итог рвался. Дата покупки целая. В заголовке карточки «чек №N» не разделяется между «чек» и «№N» (название магазина перед ним переносится по словам). На широком экране факты карточки («Дата покупки», «Итог», «Строк», «Операция») встают в один ряд, на узком — в столбик; кнопка «Загрузить фото» остаётся залитой с белым текстом, в том числе при наведении и нажатии.
11. `/receipts/<чек KZT>` и чек на 30 строк, блок «Строки чека»: «Количество», «Цена», «Сумма», «Скидка», «Оплачено» — каждое значение одной строкой, заголовки колонок целые. Название строки переносится по словам и не распадается на буквы. На 1024, 1280 и 1440 px таблица помещается без прокрутки, вертикальной линии после первой колонки нет. На 360, 390 и 768 px таблица прокручивается только внутри своей рамки (пальцем, либо Tab на таблицу и стрелки), колонка с названием остаётся слева на непрозрачном фоне и отделена линией, числа уходят под неё, а не просвечивают; страница вбок не двигается — в консоли `document.documentElement.scrollWidth === document.documentElement.clientWidth` даёт `true`. Перейти по ссылке «Залог к Строка N…»: подсветка строки закрашивает и закреплённую ячейку.
12. Там же: «Фото №N · вырезка M» и «Задание №N» в блоке изображений, «Строка N · Товар» в таблице — слово не отрывается от числа; «Итог» и «Сумма скидок» в шапке, суммы в блоках «Скидки» и «Налоги» — одной строкой; «Дата и время покупки» и «Подтверждено вручную: …» целые.
13. Масштаб браузера 200 % на 1280 px: повторить шаг 11 — значения целые, прокрутка только внутри рамки таблицы.

Заголовок блока «Страница чека №N» тоже склеен (`numbered` в `ReceiptPage.tsx`, задача Д): «чека» и «№N» остаются на одной строке — смотреть на 360 px.

После приёмки остановить свои API/Vite/worker и выполнить `docker compose -p checkist_qa_i3 down` без `-v`; тома/MEDIA сохраняются. Не использовать глобальные stop/prune. Самостоятельных deployment, merge и release не было.
