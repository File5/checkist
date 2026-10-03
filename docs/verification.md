# Проверки и приёмка

## Граница проверки

Реализован backend scaffold: health API, Postgres/Redis probes, Celery task/CLI, Compose и тесты. Контрактные тесты используют mocks; integration-tag tests работают с реальными Postgres и Redis; выполнение очереди и result backend проверяет отдельный `check_services`.

Планируются React/TypeScript/Vite SPA и продуктовые функции: база фото чеков, распознавание магазина/адреса и товаров/стоимостей, категории, статистический дашборд. OCR-провайдер и предметная модель не выбраны. Frontend-код и UI пока отсутствуют, поэтому frontend-проверки не выполнены.

Ни сборка образа, ни `check`, ни mocked API tests не доказывают реальную HTTP/клиентскую интеграцию. Визуальную и интерактивную приёмку выполняет человек; автоматический обход browser UI запрещён. HTTP, CLI и unit tests можно автоматизировать.

## Изолированная QA-среда

Все записи, миграции, отправки задач и отключения зависимостей выполняются в **`-p checkist_qa`**, не в dev/локальном Postgres. Для тестов нужны только технические таблицы Django, фото и seed users не требуются. Прежде чем использовать имя project, убедитесь, что QA не занята другим запуском. Не останавливайте чужие процессы.

PowerShell из корня репозитория; `.env` и venv должны быть подготовлены по [development.md](development.md). В **каждом** QA-терминале задайте:

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

Проверьте LISTEN на 25432, 16379, 18000 и будущем 15173 командой `Get-NetTCPConnection` из development.md, заменив список портов. При конфликте выберите свободные и согласованно измените все URL/CLI ports. Compose project изолирует контейнеры, сеть и тома; одни только разные Redis DB номера QA не изолируют. Настройки DB/user/password должны соответствовать уже инициализированному QA-тому.

```powershell
docker compose -p checkist_qa config --quiet
docker compose -p checkist_qa up -d --wait --wait-timeout 90 postgres redis
```

Выполните ограниченные Windows TCP-пробы из development.md **до** локальных действий с БД. Таймаут — основание отметить успешный host-путь непроверенным и перейти к независимым Linux-проверкам, а не повторять заведомо невозможный прогон. Exit code проверяйте после каждого шага; failed обязательный шаг сохраняйте в отчёте.

## Локальные Windows-команды

Если TCP доступен, порядок такой:

```powershell
./backend/.venv/Scripts/python.exe -X utf8 -m pip check
./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py check
./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py migrate --noinput
docker compose -p checkist_qa up -d --build --wait --wait-timeout 120 worker
./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py makemigrations --check --dry-run
./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py test health --exclude-tag=integration --verbosity=2
./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py test health --tag=integration --verbosity=2
./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py check_services
```

Ожидается exit 0, отсутствие новых миграций, 21 unit/contract test и 2 integration test, затем JSON с `celery_task.result={"message":"pong"}`. Числа соответствуют текущему коду и могут измениться вместе с тестами. Unit-команда не использует БД и может выполняться при TCP-отказе; integration-команда не должна заменяться skip/eager. Django runner создаёт и затем удаляет **`test_checkist_qa`**; Redis integration использует отдельный QA Redis DB 2 и уникальные временные ключи.

Unit/contract tests покрывают точный 200, комбинации 503, сохранение независимых checks, анонимность, игнорирование query/Authorization, 405, 406, безопасный 500 при DEBUG, отсутствие публикации task из health, параллельность probes, cleanup кеша, bounded publication retries и негативную env-валидацию. Это не сетевой замер времени отказа.

## Linux-проверки при недоступном host-пути

Они проверяют контейнерную сеть и **не подтверждают** работу локального Django на Windows. При healthy QA Postgres/Redis:

```powershell
docker compose -p checkist_qa up -d --build --wait --wait-timeout 120 worker
docker compose -p checkist_qa exec -T worker python -m pip check
docker compose -p checkist_qa exec -T worker python -X utf8 manage.py check
docker compose -p checkist_qa exec -T worker python -X utf8 manage.py migrate --noinput
docker compose -p checkist_qa exec -T worker python -X utf8 manage.py makemigrations --check --dry-run
docker compose -p checkist_qa exec -T worker python -X utf8 manage.py test health --tag=integration --verbosity=2
docker compose -p checkist_qa exec -T worker python -X utf8 manage.py check_services
docker compose -p checkist_qa exec -T worker celery -A config inspect ping --destination=checkist@worker --timeout=2
docker compose -p checkist_qa ps
```

Ожидается exit 0 для каждой команды; зависимости без конфликтов, check без ошибок, migrations применены/уже актуальны, `No changes detected`, 2 integration tests passed, реальный pong через task/results и отдельный control pong. `ps` должен показывать три healthy services с QA host-портами. Docker build может использовать cache: это не новая установка с нуля, но `pip check` проверяет реально установленные зависимости образа.

## HTTP: позитивные и негативные сценарии

Этот раздел — **порядок последующей проверки**, не результаты выполненного HTTP-прогона. Требуется рабочий Windows → Docker TCP-путь. В отдельном терминале с полным QA environment:

```powershell
./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py runserver 127.0.0.1:18000
```

В другом QA-терминале:

```powershell
curl.exe -i --max-time 15 http://127.0.0.1:18000/api/health/
curl.exe -i --max-time 15 -X POST http://127.0.0.1:18000/api/health/
curl.exe -i --max-time 15 -H "Accept: text/html" http://127.0.0.1:18000/api/health/
```

Ожидается соответственно 200 со всеми checks `ok`, 405 `method_not_allowed`, 406 `not_acceptable`; JSON и `Cache-Control: no-store`. Curl exit 0 не подтверждает HTTP 200. Полный формат — [api-contract.md](api-contract.md). Не вызывайте исключения изменением backend-кода ради проверки 500: безопасный handler проверяют существующие contract tests.

Выключайте зависимости **по одной**, каждый раз возвращайте baseline 200 и успешный `check_services`. Фиксируйте status/body и измеренное время GET; цель не более 10 секунд. Превышение — failed проверка, ожидание не ослабляйте.

```powershell
docker compose -p checkist_qa stop worker
curl.exe -sS --max-time 15 -w '\nHTTP=%{http_code} seconds=%{time_total}\n' http://127.0.0.1:18000/api/health/
./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py check_services
docker compose -p checkist_qa up -d --wait --wait-timeout 90 worker
./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py check_services
curl.exe -i --max-time 15 http://127.0.0.1:18000/api/health/

docker compose -p checkist_qa stop postgres
curl.exe -sS --max-time 15 -w '\nHTTP=%{http_code} seconds=%{time_total}\n' http://127.0.0.1:18000/api/health/
docker compose -p checkist_qa up -d --wait --wait-timeout 90 postgres
./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py check_services
curl.exe -i --max-time 15 http://127.0.0.1:18000/api/health/

docker compose -p checkist_qa stop redis
curl.exe -sS --max-time 15 -w '\nHTTP=%{http_code} seconds=%{time_total}\n' http://127.0.0.1:18000/api/health/
docker compose -p checkist_qa up -d --wait --wait-timeout 90 redis
docker compose -p checkist_qa restart worker
docker compose -p checkist_qa up -d --wait --wait-timeout 90 worker
./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py check_services
curl.exe -i --max-time 15 http://127.0.0.1:18000/api/health/
```

| Состояние | Ожидаемый GET |
| --- | --- |
| Worker остановлен | 503, `celery.code=worker_unavailable`, БД/cache OK; `check_services` exit 1 |
| Postgres остановлен | 503, `database.code=database_unavailable`, остальные checks сохраняются |
| Redis остановлен | 503, `redis.code=redis_unavailable`, `celery.code=broker_unavailable`, БД OK |
| Зависимость восстановлена | 200, все checks OK; `check_services` exit 0 |

Перезапуск worker после Redis — явный шаг восстановления control-связи; исходный отказ остаётся в отчёте. Таймаут task не отменяет принятую задачу, но повтор служебного ping безопасен.

## Планируется: frontend и ручная UI-приёмка

После появления `frontend/` и `docs/frontend.md` используйте фактические scripts проекта через `npm.cmd`: установка по lock, lint, unit tests, build. Их успешное выполнение не заменяет HTTP через Vite proxy и ручную приёмку. QA proxy должен вести на `http://127.0.0.1:18000`, Vite использовать порт 15173. Проверьте `curl.exe -i --max-time 15 http://127.0.0.1:15173/api/health/`: тот же контракт, `/api` не удалён.

Человеку после интеграции открыть `http://127.0.0.1:15173`:

1. Первое открытие: loading → success, статусы БД, Redis, Celery видны текстом. Для loading можно замедлить сеть в DevTools.
2. Остановить QA worker; «Повторить» показывает частичный отказ Celery, сохраняя БД/Redis. Восстановить worker, повторить — success.
3. Остановить QA API через Ctrl+C; повтор даёт понятную network error. Вернуть API; повтор восстанавливает состояние без перезагрузки страницы.
4. Offline/throttling: ошибка/timeout, loading не зависает; после online повтор успешен, старый success не остаётся текущим.
5. Проверить Tab/Enter, видимый focus, текстовые статусы/aria-live и ширину около 375 px без обрезания/горизонтального scroll.
6. Страница честно отмечает scaffold и planned фото/OCR/категории/dashboard, не показывает вымышленные распознанные чеки как рабочие данные.

Это будущий сценарий, сейчас UI и скриншотов нет.

## Фактические результаты документационного этапа, 2026-10-03

Проверялся серверный каркас `b92e404`, слитый в базу этой ветки коммитом `c8e91bc`. Код backend/Compose/env не менялся. Все действия с зависимостями — QA `checkist_qa`, опубликованные порты 25432/16379; dev-данные не использовались.

### Проверено и прошло

| Фактическая команда | Результат |
| --- | --- |
| `py -3.13 --version`, `node --version`, `npm.cmd --version` | Exit 0: 3.13.9, v24.18.0, 11.16.0 |
| `docker --version`, `docker compose version`, `docker info --format 'Server={{.ServerVersion}} OS={{.OSType}}'` | Exit 0: 29.8.1, 5.5.1, Linux daemon |
| `Copy-Item .env.example .env`, `py -3.13 -m venv backend/.venv` | Локальные игнорируемые env/venv созданы |
| `./backend/.venv/Scripts/python.exe -X utf8 -m pip install -r backend/requirements.txt` | Exit 0, закреплённый набор установлен на Windows |
| `./backend/.venv/Scripts/python.exe -X utf8 -m pip check` | Exit 0, `No broken requirements found.` |
| `docker compose -p checkist_qa config --quiet` | Exit 0 |
| `docker compose -p checkist_qa up -d --wait --wait-timeout 90 postgres redis` | Exit 0, оба healthy |
| `./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py check` | Exit 0, 0 issues |
| `./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py test health --exclude-tag=integration --verbosity=2` | Exit 0, 21 tests OK; БД не использовалась |
| `docker compose -p checkist_qa up -d --build --wait --wait-timeout 120 worker` | Exit 0, образ собран с использованием cache, worker healthy |
| `docker compose -p checkist_qa exec -T worker python -m pip check` | Exit 0, Linux dependencies без конфликтов |
| `docker compose -p checkist_qa exec -T worker python -X utf8 manage.py check` | Exit 0, 0 issues |
| `docker compose -p checkist_qa exec -T worker python -X utf8 manage.py migrate --noinput` | Exit 0, `No migrations to apply` на существующем QA-тому |
| `docker compose -p checkist_qa exec -T worker python -X utf8 manage.py makemigrations --check --dry-run` | Exit 0, `No changes detected` |
| `docker compose -p checkist_qa exec -T worker python -X utf8 manage.py test health --tag=integration --verbosity=2` | Exit 0, 2 tests OK; `test_checkist_qa` создана, стандартные миграции применены, тестовая БД удалена |
| `docker compose -p checkist_qa exec -T worker python -X utf8 manage.py check_services` | Exit 0, SQL/cache OK, настоящая task вернула `{"message":"pong"}` через result backend |
| `docker compose -p checkist_qa exec -T worker celery -A config inspect ping --destination=checkist@worker --timeout=2` | Exit 0, `checkist@worker: OK`, `pong`, 1 node online |
| `docker compose -p checkist_qa ps` | Exit 0, три healthy services, QA host-порты |
| `docker rm -f checkist_qa-api`, `docker compose -p checkist_qa down` | Exit 0, временный API и основные QA-контейнеры/сеть удалены; тома сохранены |
| `docker ps -a --filter label=com.docker.compose.project=checkist_qa --format '{{.Names}} {{.Status}}'` после cleanup | Exit 0, пустой вывод; QA-контейнеров не осталось |
| Проверка документов через Python 3.13 stdin (`./backend/.venv/Scripts/python.exe -X utf8 -`) | UTF-8, маркировки реализовано/планируется, парность code fences и локальные ссылки корректны; все 15 env-имён описаны; изменены только 7 разрешённых документов, `docs/frontend.md` отсутствует |
| `git diff --exit-code -- backend compose.yaml .env.example` | Exit 0, серверные исходники и конфигурация неизменны |

### Проверено и не прошло

- Ограниченные Windows socket-пробы из development.md напечатали для обоих портов `TimeoutError: timed out`. Скрипт завершился с exit 0, но **TCP-проверка не прошла**.
- `./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py migrate --noinput` с QA environment: exit 1, `psycopg.errors.ConnectionTimeout: connection timeout expired`, затем `django.db.utils.OperationalError: connection timeout expired`.
- Для независимой HTTP-проверки попытались временно запустить Linux API: `docker compose -p checkist_qa run -d --name checkist_qa-api --no-deps -p 127.0.0.1:18000:8000 worker python -X utf8 manage.py runserver 0.0.0.0:8000 --noreload`. Старт вернул exit 0 и лог о запуске Django, но контейнер завершился с exit 137 (`OOMKilled=false`) до HTTP-пробы. Проба через `docker exec -i checkist_qa-api python -X utf8 - healthy` завершилась с exit 1: `container … is not running`; запрос до приложения не дошёл. Это не HTTP-результат. После `docker start checkist_qa-api` контейнер завершился с exit 1; основные QA-services к тому моменту также были остановлены. Причина остановки не установлена.
- Повторное `docker compose -p checkist_qa up -d --wait --wait-timeout 90 postgres redis worker` отклонено автоматической политикой исполнения: `blocked by policy`. Команда не выполнилась; обход политики не предпринимался. Cleanup затем прошёл.
- Первые две вспомогательные Python-проверки документов завершились с `AssertionError: README.md`: проверка текста зависела от encoding PowerShell stdin, а шаблон абсолютных путей ошибочно совпадал с `http://`. Исправлен проверяющий скрипт (ASCII/Unicode escapes и граница drive letter); окончательный статический аудит прошёл. Это ошибки вспомогательной проверки, не продуктовых тестов.

### Не проверено и почему

- Успешный Windows quickstart целиком, локальные integration tests, `makemigrations` и `check_services` с зависимостями, запуск API с доступной инфраструктурой: host TCP не работает. Не повторялись после воспроизведения. После исправления внешней причины выполнить блок локальных QA-команд выше.
- Реальные HTTP 200/503/405/406, отключения зависимостей, восстановление и цель ≤10 секунд: стабильный HTTP QA-прогон не состоялся; 200/503/405/406/500 проверены только mocked contract tests. Повторить HTTP/negative блок выше в доступной среде.
- Dev-команды без QA overrides: намеренно не запускались, чтобы не писать в dev-данные. Проверен QA-вариант Compose и Linux-команд; успешный dev quickstart не заявляется.
- Frontend install/lint/test/build/proxy, UI и скриншоты: `frontend/` ещё нет. После интеграции выполнить фактические scripts и ручной сценарий человеком.
- Фото чеков/OCR/категории/dashboard: планируемые функции вне реализованного scaffold.

## Завершение QA

Ctrl+C локальные QA-процессы, затем `docker compose -p checkist_qa down`. Если создавался описанный временный API, сначала `docker rm -f checkist_qa-api`. Это удаляет только выделенные QA-контейнеры; не используйте глобальные stop/prune. Не удаляйте тома автоматически. Закройте QA-терминалы, чтобы environment overrides не попали в последующий dev-запуск. Убедитесь, что фильтр QA в `docker ps -a` возвращает пустой вывод.

Отчёт всегда разделяет **«проверено и прошло / проверено и не прошло / не проверено и почему»**, включает команды, exit codes, ограничения и воспроизведение. Принятие результата не разрешает самостоятельно merge, публикацию или release.
