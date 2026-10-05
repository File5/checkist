# И5: загрузка → обработка → чеки → товары

Реализованный клиент И1–И3 проверен с настоящим Django и fake host-worker через Vite dev и preview. Исправлены возвраты job ↔ receipt и receipt → product → receipt, единые подписи вырезок/замечаний, возврат к чеку при product not_found. Успешная вырезка с неблокирующими issues сохраняет успешный статус и заголовок «Замечания распознавания». На health-странице список будущих функций больше не включает реализованные фото/OCR/каталог (расширена существующая SSR-проверка). Backend-код, публичный контракт и зависимости не менялись.

Этот показ — фактический отчёт, данные и инструкция запуска. Скриншотов и визуальной приёмки нет: автоматический обход browser UI запрещён проектом. Человек открывает работающий клиент локально по инструкции ниже. Синтетические картинки генерирует seed_recognition_demo; реальные фото и секреты в показ не включены.

## Проверено и прошло

Windows/PowerShell; Python 3.13.9, Node 24.18.0, npm 11.16.0. Изолированные QA проекты/БД `checkist_qa_i5_dev_verified` и `checkist_qa_i5_preview`; запускались последовательно, PostgreSQL 25485, Redis 16415, Django 18085, Vite 15185. Свои venv, MEDIA и scratch; dev и чужие QA не затронуты.

| Команда | Exit | Результат |
| --- | --- | --- |
| `npm.cmd ci` в frontend | 0 | 188 packages, audit 0 vulnerabilities |
| `npm.cmd run lint` | 0 | Нет ошибок |
| `npm.cmd run test` | 0 | 897 tests / 32 files; 14 новых регрессий навигации и общих подписей |
| `npm.cmd run build` | 0 | TypeScript + Vite, 90 modules |
| `node --check frontend/scripts/check_recognition_proxy.mjs` | 0 | Синтаксис |
| `node frontend/scripts/check_recognition_proxy.mjs dev http://127.0.0.1:15185` | 0 | Настоящий HTTP, client schemas/polling, весь сценарий passed |
| `node frontend/scripts/check_recognition_proxy.mjs preview http://127.0.0.1:15185` | 0 | Тот же сценарий, 65 HTTP requests, passed |
| `./backend/.venv/Scripts/python.exe -X utf8 -m pip check` / `backend/manage.py check` | 0 | Dependencies OK / 0 issues |
| `docker compose -p checkist_qa_i5_dev_verified config --quiet` / `up -d --wait --wait-timeout 90 postgres redis` (также preview) | 0 | Healthy; ограниченные Windows TCP 25485/16415: OK |
| `./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py migrate --noinput` / `seed_recognition_demo` в обеих QA | 0 | 23 миграции и single/double PNG |
| `docker compose -p checkist_qa_i5_dev_verified down` / `docker compose -p checkist_qa_i5_preview down` | 0 | Свои процессы/контейнеры остановлены, тома/MEDIA сохранены |

HTTP путь: CSRF cookie + token + Origin клиента → double upload 202 → client polling → succeeded/2 crops → `/media` original/preview/crops `image/png` и исходные байты → Receipt/lines/discounts/taxes/Product через runtime guards → replay 200/reused → terminal 409 → queued cancel 200 → retry 202/active 409 → running cancel 202/cancel_requested → cancelled → retry single/one_receipt, прежний Receipt без новых товаров/строк → needs_review + normalized_result/issues → без CSRF 403, GIF 400/unsupported_format, усечённый PNG 400/invalid_image. Terminal polling прекращается. Node переносит cookie явно: это не проверка браузерной cookie policy.

## Проверено и не прошло

Ранний targeted Vitest: 10 failures из-за незавершённой замены словарей/заголовка; следующий — 1 failure: возврат при product not_found. Lint поймал unused import. Исправлены причины, итоговые проверки зелёные, тесты не отключались.

Первый CLI dev — exit 1 на дополнительном invalid_image assertion: текст с MIME image/png является неизвестным фактическим форматом и сервер корректно вернул unsupported_format. Вход заменён на усечённый настоящий PNG с сигнатурой; fresh dev/preview прошли с прежним ожиданием invalid_image. Неразрешённых дефектов в проверенном сценарии нет.

## Не проверено и почему

Browser UI/DOM-фокус, screen reader, адаптив/scroll, image events и cookies — принимает человек. Реальный Codex/полевое OCR в И5 не запускался; fake извлекает фиксированные DTO. Серверный реальный результат И4 описан в docs/verification.md; он не подтверждает UI. Полные backend suites/Celery/health stop/recovery, нагрузка, backup restore, production и наборы >50 изображений/скидок/налогов не повторялись: сервер не менялся. Скриншоты не снимались.

## Данные для просмотра

| URL | Сохранённый результат |
| --- | --- |
| `/recognition/jobs/1` | Double: succeeded, два чека |
| `/recognition/jobs/2` | Single: отмена в очереди |
| `/recognition/jobs/3` | Retry single: отмена на recognize |
| `/recognition/jobs/4` | Retry one_receipt: succeeded, прежний чек |
| `/recognition/jobs/5` | Синтетический review PNG: partial_succeeded, две needs_review |
| `/receipts` | Два чека TESTMARKT, 4,42/6,00 EUR; 6 строк (5 товарных/1 залог), 5 товаров |

Первый чек: MILCH 1 L, APFEL, PFAND, BROT; молоко оплачено 2,38 EUR после скидки 0,20; две налоговые группы 7/19%. Ссылки на товары и задания получайте из UI. Один чек имеет два разных фото; replay не создаёт дубликатов.

## Запуск сохранённой QA для человека

Из корня итогового worktree; `.env` из `.env.example` только если отсутствует; pinned Python/frontend dependencies по docs/development.md. В **каждом** терминале применить полный блок:

```powershell
$env:COMPOSE_PROJECT_NAME='checkist_qa_i5_dev_verified'
$env:POSTGRES_DB=$env:COMPOSE_PROJECT_NAME
$env:POSTGRES_USER='checkist'
$env:POSTGRES_PASSWORD='checkist_dev_only'
$env:POSTGRES_HOST='127.0.0.1'
$env:POSTGRES_PORT='25485'
$env:REDIS_PORT='16415'
$env:CELERY_BROKER_URL='redis://127.0.0.1:16415/0'
$env:CELERY_RESULT_BACKEND='redis://127.0.0.1:16415/1'
$env:DJANGO_CACHE_URL='redis://127.0.0.1:16415/2'
$env:VITE_API_BASE_URL='/api'
$env:DEV_API_PROXY_TARGET='http://127.0.0.1:18085'
$env:DJANGO_DEBUG='1'
$env:DJANGO_ALLOWED_HOSTS='127.0.0.1,localhost'
$env:ALLOW_LOCAL_RECOGNITION_API='1'
$env:DJANGO_CSRF_TRUSTED_ORIGINS='http://127.0.0.1:15185'
$env:MEDIA_ROOT=Join-Path $env:TEMP 'checkist-qa-i5-dev-verified-media'
$env:RECEIPT_OCR_TEMP_ROOT=Join-Path $env:TEMP 'checkist-qa-i5-dev-verified-scratch'
$env:RECEIPT_OCR_PROVIDER='fake'
```

Проверить свободные порты и что QA не занята. Терминал API, каждая команда отдельно; проверить exit и прекратить зависимые шаги при ошибке:

```powershell
docker compose -p $env:COMPOSE_PROJECT_NAME config --quiet
docker compose -p $env:COMPOSE_PROJECT_NAME up -d --wait --wait-timeout 90 postgres redis
@'
import socket
for port in (25485, 16415):
    with socket.create_connection(('127.0.0.1', port), timeout=2):
        print(f'{port}: TCP OK')
'@ | ./backend/.venv/Scripts/python.exe -X utf8 -
./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py migrate --noinput
./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py seed_recognition_demo
./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py runserver 127.0.0.1:18085 --noreload
```

Терминал клиента с тем же env: `Set-Location frontend`, `npm.cmd ci`, `npm.cmd run dev -- --port 15185`. Для preview: `npm.cmd run build`, `npm.cmd run preview -- --port 15185` вместо dev. Открыть `http://127.0.0.1:15185/receipts`. Локальный API доступен без пользователя только DEBUG + флаг + loopback; POST защищён CSRF, пользовательских владельцев/разграничения нет. MEDIA доступно при DEBUG.

Для обработки нового фото: третий терминал того же env, `./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py recognition_worker --fake-scenario success2` для double; **one_receipt** для single. Не держать два OCR-worker. Fake-сценарий не зависит от текста фото.

Для нового **полного CLI** или пустых UI: отдельные новые project/DB/MEDIA/scratch, тот же блок и подготовка; список jobs/photos/receipts должен быть пуст. CLI сам запускает Vite/свои fake --once, отдельно Vite/worker не запускать. Dev и preview требуют отдельных fresh QA. Сохранённая БД выше предназначена для просмотра, CLI её отвергает до upload.

## Сценарий ручной приёмки

1. В новой пустой QA проверить пустые «Чеки»/«Обработка». С клавиатуры выбрать single/double, проверить warning/лимиты/preview/замену, загрузить. Без worker queued и неизвестная idle-доступность; с one_receipt/success2 — соответствующее число вырезок и чеков. Проверить reload/Back/Forward и конечный статус.
2. Открыть чек: магазин/адрес/локальную дату, итог/валюту, все строки/товары, залог, скидки и налоги; картинки и новую вкладку. Пройти job → receipt → product и вернуться «К чеку»/«К заданию», фильтры истории/reload, receipt → job и обратно. Из списка сохранить query/страницу и проверить возврат фокуса.
3. Повторить тот же файл: reused и прежние IDs/последний Job. Другое фото того же чека (single после double с one_receipt): тот же Receipt, два фото/jobs, без новых строк/товаров и перезаписи сумм.
4. Остановить свой worker, загрузить новый файл → queued → cancel → cancelled; retry создаёт новый job. Запустить pause_recognize, дождаться recognize → cancel_requested → cancelled; старое задание сохраняется, уже импортированные части остаются. Затем retry с one_receipt/success2. У succeeded действия недоступны.
5. Job 5 или новый partial_missing_quantity/inconsistent_total: crop, details нормализованного результата, неизвестные поля и причины needs_review; формы подтверждения нет. Успешные вырезки с issues показывают замечания и успешный статус.
6. GIF/HEIC, битый/пустой PNG, анимация, >20 MiB/>40 MP: понятные отказы. Offline/Slow network, остановка API, удаление CSRF cookie/выключенный flag, локальный retry; после сетевого отказа POST сначала проверить серверное задание. Блокировать один GET/картинку в DevTools: остальные блоки видны, есть локальный повтор. Проверить строку без товара, пустой поиск, неверные query/страницы/первая страница.
7. Tab/Enter/skip-link/details, visible focus и его возврат без перехвата чужого блока, screen reader/status/alt. 320/375/768/1280 px, zoom 200%, длинные тексты; все действия видны, таблица имеет собственный scroll. При уходе со страницы поздний ответ не заменяет новую; hidden tab и terminal polling. Reduced motion.
8. Реальный Codex: остановить fake; новый real QA или ещё не обработанное фото, succeeded fake не retryable. В worker env `RECEIPT_OCR_PROVIDER=codex_cli`, `RECEIPT_OCR_MODEL=gpt-6.1-sol`, `RECEIPT_OCR_CODEX_EXECUTABLE=Join-Path $env:LOCALAPPDATA 'Programs/OpenAI/Codex/bin/codex.exe'`, существующий host auth. Запустить recognition_worker, загрузить single/double через клиент, сверить crops/чеки/строки/товары/суммы и длительность; затем повтор. Разрешённые реальные фото вне git проверять по эталону, включая timezone/блики/поворот/нечитаемость; failed и worker exit 0 фиксировать раздельно.

Подробный сценарий и команды: `docs/verification.md`, раздел «Распознавание: сквозная проверка клиента И5». Старые F4/F6 admin и health сценарии остаются отдельными. В конце Ctrl+C **своих** API/Vite/worker и `docker compose -p $env:COMPOSE_PROJECT_NAME down`, тома не удалять. Deployment, merge и release не выполнялись.
