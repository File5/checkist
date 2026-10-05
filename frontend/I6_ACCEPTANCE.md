# И6: налоговые evidence и сгруппированные замечания

Слитая ветка проверена целиком: промпт v5 просит у модели подтверждения чтения ставок НДС и налоговых итогов, сервер отдаёт у каждого замечания вырезки `reason`, `severity` и `context`, клиент показывает замечания группами одним компонентом в задании и в чеке. На этом этапе добавлен сквозной серверный тест fake → импорт → HTTP и документация; серверный код, контракт, миграции, `frontend/src` и `frontend/scripts/check_recognition_proxy.mjs` не менялись.

Этот показ — фактический отчёт, данные и инструкция запуска. Скриншотов и визуальной приёмки нет: автоматический обход browser UI запрещён проектом, экраны открывает человек. Картинки синтетические, их создаёт `seed_recognition_demo`; fake не читает пиксели, сценарий выбирает оператор worker. Реальные фото, секреты и настоящий Codex не использовались.

## Проверено и прошло

Windows/PowerShell, Python 3.13.9, Node 24.18.0, 2026-10-06. Изолированные QA `checkist_qa_muvq_g` (тесты и HTTP-прогоны), `checkist_qa_muvq_g_dev` и `checkist_qa_muvq_g_preview` (proxy-скрипт), запускались последовательно: PostgreSQL 25483, Redis 16413, Django 18083, Vite 15183. Dev-база и dev-контейнеры не затронуты.

| Команда | Exit | Результат |
| --- | --- | --- |
| `backend/manage.py check` / `makemigrations --check --dry-run` / `migrate --noinput` | 0 | 0 issues / No changes detected / 23 миграции |
| `backend/manage.py test recognition api catalog receipts --exclude-tag=integration --verbosity=2` | 0 | 259 OK |
| `backend/manage.py test recognition api catalog receipts --tag=integration --noinput --verbosity=2` | 0 | 835 OK |
| `backend/manage.py test catalog stores receipts health api recognition --exclude-tag=integration --verbosity=2` | 0 | 299 OK |
| `backend/manage.py test catalog stores receipts health api recognition --tag=integration --noinput --verbosity=2` | 0 | 921 OK, включая 4 новых сквозных теста |
| `backend/manage.py check_services` при запущенном QA Celery-контейнере | 0 | `pong`, `/api/health/` 200 |
| `npm.cmd ci` / `npm.cmd run lint` в frontend | 0 | 188 packages, 0 vulnerabilities / нет ошибок |
| `npm.cmd run test` | 0 | 1036 tests / 33 files |
| `npm.cmd run build` | 0 | TypeScript + Vite, 92 modules |
| `node frontend/scripts/check_recognition_proxy.mjs dev http://127.0.0.1:15183` | 0 | passed, 62 HTTP requests, как раньше |
| `node frontend/scripts/check_recognition_proxy.mjs preview http://127.0.0.1:15183` | 0 | passed, 62 HTTP requests |
| `docker compose -p checkist_qa_muvq_g down` (также `_dev`, `_preview`) | 0 | Свои процессы и контейнеры остановлены, тома и MEDIA сохранены |

Все backend-команды запускались как `./backend/.venv/Scripts/python.exe -X utf8 …` из корня с полным QA env. Настоящий HTTP на сокете `runserver` + host `recognition_worker`, одна база, загрузка через `curl.exe` с CSRF cookie/token и Origin:

| Worker / файл | Итог по HTTP |
| --- | --- |
| `tax_evidence_missing` / `single.png` | 202; job 1 `succeeded`, проверки не требует; вырезка `imported`, 29 замечаний в list и detail, все `code=invalid_value`, `reason=optional_omitted`, `severity=warning`: 2 реквизита (`field="/"`, `receipt_metadata`), 25 ставок строк, 2 налоговых итога; чек 1 — 23.95 EUR, 25 строк без ставок, налоговых итогов 0; товаров 21 |
| `tax_evidence_present` / `double.png` | 202; job 2 `succeeded`; 2 замечания реквизитов; чек 2 — 25 строк со ставками (17 × 7.00, 8 × 19.00), 2 налоговых итога; чеков 2, товаров по-прежнему 21 |
| `inconsistent_total` / `single_rotated.png` | 202; job 3 `partial_succeeded`, требует проверки; две вырезки `needs_review`, у каждой `total_mismatch` с `severity=error` и одно `optional_omitted` с `severity=warning`; новых чеков нет |
| повтор `single.png` | 200, `reused=True`, прежний job 1; чек 1 не изменился |

Ответы job и вырезки не содержат номера чека, подписи, fiscal-полей, серийного номера кассы, номера транзакции, юридического названия и `raw_text` — ни именами, ни значениями. Те же живые ответы прошли клиентские runtime guards и `groupIssues` в Node (без браузера): для чека 1 получились группы «Не прочитаны 2 реквизита», «НДС не использован в 25 строках», «Пропущены 2 налоговых итога»; для чека 2 — «Не прочитаны 2 реквизита»; для вырезок job 3 — «Причины проверки»: «Сумма строк не совпадает с итогом · Итого» и отдельно «Замечания распознавания»: «Необязательное поле не использовано · Налоги».

## Проверено и не прошло

Упавших проверок нет, расхождений сервера с контрактом не найдено.

Одно замечание к клиентской документации, код не затрагивает: `docs/frontend.md` (шаг 1 ручной приёмки) и статическое превью `frontend/recognition-issues-preview/index.html` показывают группы в порядке «НДС → налоговые итоги → реквизиты». Настоящий сервер отдаёт замечания реквизитов первыми, клиент упорядочивает группы по первому вхождению, поэтому в работающем приложении порядок такой: «Не прочитаны 2 реквизита», «НДС не использован в 25 строках», «Пропущены 2 налоговых итога». Тексты и состав групп совпадают. Контракт порядок между группами не задаёт; если нужен порядок из frontend.md, это решение для frontend-задачи.

## Не проверено и почему

- Browser UI обоих экранов: вид групп, раскрытие с клавиатуры, фокус, 320/768/1280 px, zoom 200 %, экранный диктор. Агенты браузер не открывали — принимает человек по сценарию ниже.
- Чтение реальной моделью с промптом v5: возвращает ли Codex налоговые evidence на настоящем чеке и не ухудшилось ли остальное чтение. Fake проверяет только контракт и импорт. Нужен отдельный явно разрешённый QA-прогон (`docs/verification.md`, шаг 10 ручной приёмки И5).
- Налоговые сценарии через Vite proxy не загружались: proxy проверен существующим скриптом на прежних сценариях, ответы налоговых сценариев получены напрямую с Django.
- Ответ старого сервера без новых ключей этой веткой не воспроизводится: клиентский fallback подтверждён только Vitest.
- Нагрузка, backup restore, deployment, ручные сценарии админки F4/F6 не повторялись.

## Данные для просмотра

Сохранённая QA `checkist_qa_muvq_g`; файлы — в `%TEMP%\checkist_qa_muvq_g-media\demo`.

| URL | Сохранённый результат |
| --- | --- |
| `/recognition/jobs/1` | `single.png`, `tax_evidence_missing`: завершено, одна вырезка, три группы замечаний |
| `/receipts/1` | TESTKAUF, 23,95 EUR, 25 строк без ставок НДС, налоговых итогов нет |
| `/recognition/jobs/2` | `double.png`, `tax_evidence_present`: завершено, одна группа замечаний |
| `/receipts/2` | TESTKAUF, 23,95 EUR, 25 строк со ставками, два налоговых итога |
| `/recognition/jobs/3` | `single_rotated.png`, `inconsistent_total`: две вырезки «Требует проверки» |

Товары: 17 × TESTARTIKEL 01–17 (7 %), 4 × TESTGETRAENK 01–04 (19 %), к каждому напитку залог PFAND. Оба чека — один магазин и те же 21 товар.

## Запуск сохранённой QA для человека

Из корня итогового worktree; `.env` из `.env.example`, только если отсутствует; зависимости — по `docs/development.md`. В **каждом** терминале применить весь блок:

```powershell
$env:COMPOSE_PROJECT_NAME='checkist_qa_muvq_g'
$env:POSTGRES_DB=$env:COMPOSE_PROJECT_NAME
$env:POSTGRES_USER='checkist'
$env:POSTGRES_PASSWORD='checkist_dev_only'
$env:POSTGRES_HOST='127.0.0.1'
$env:POSTGRES_PORT='25483'
$env:REDIS_PORT='16413'
$env:CELERY_BROKER_URL='redis://127.0.0.1:16413/0'
$env:CELERY_RESULT_BACKEND='redis://127.0.0.1:16413/1'
$env:DJANGO_CACHE_URL='redis://127.0.0.1:16413/2'
$env:VITE_API_BASE_URL='/api'
$env:DEV_API_PROXY_TARGET='http://127.0.0.1:18083'
$env:DJANGO_DEBUG='1'
$env:DJANGO_ALLOWED_HOSTS='127.0.0.1,localhost'
$env:ALLOW_LOCAL_RECOGNITION_API='1'
$env:DJANGO_CSRF_TRUSTED_ORIGINS='http://127.0.0.1:15183'
$env:MEDIA_ROOT=Join-Path $env:TEMP "$($env:COMPOSE_PROJECT_NAME)-media"
$env:RECEIPT_OCR_TEMP_ROOT=Join-Path $env:TEMP "$($env:COMPOSE_PROJECT_NAME)-scratch"
$env:RECEIPT_OCR_PROVIDER='fake'
```

Проверить, что порты 25483, 16413, 18083 и 15183 свободны. Терминал API, каждая команда отдельно; при ошибке зависимые шаги не продолжать:

```powershell
docker compose -p $env:COMPOSE_PROJECT_NAME config --quiet
docker compose -p $env:COMPOSE_PROJECT_NAME up -d --wait --wait-timeout 90 postgres redis
./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py migrate --noinput
./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py seed_recognition_demo
./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py seed_recognition_demo --rotated
./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py runserver 127.0.0.1:18083 --noreload
```

Терминал клиента с тем же env: `Set-Location frontend`, `npm.cmd ci`, `npm.cmd run dev -- --port 15183`. Для preview: `npm.cmd run build`, затем `npm.cmd run preview -- --port 15183` вместо dev. Открыть `http://127.0.0.1:15183/recognition/jobs/1`.

Сохранённые данные лежат в томе Docker и в `%TEMP%` той машины, где шёл прогон. На другой машине или после очистки база будет пустой: тогда загрузить файлы заново. Третий терминал с тем же env, по одному worker за раз (Ctrl+C перед сменой сценария), для каждого сценария — ещё не загруженный файл из `MEDIA/demo`:

```powershell
./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py recognition_worker --fake-scenario tax_evidence_missing
```

| Сценарий worker | Файл |
| --- | --- |
| `tax_evidence_missing` | `single.png` |
| `tax_evidence_present` | `double.png` |
| `inconsistent_total` | `single_rotated.png` |

Локальный API открыт без пользователя только при DEBUG + флаге + loopback; POST защищён CSRF. `/api/health/` в этой среде отвечает 503, пока не запущен Celery-контейнер; на распознавание это не влияет.

## Сценарий ручной приёмки

1. **`tax_evidence_missing`** (job 1, чек 1). Задание «Завершено», вырезка «Чек сохранён». Под заголовком «Замечания распознавания» три свёрнутые группы: «Не прочитаны 2 реквизита», «НДС не использован в 25 строках», «Пропущены 2 налоговых итога». Заголовка «Причины проверки» и строк «Некорректное значение» нет. Раскрыть каждую группу: у НДС — пояснение и «Строки: 1, 2, …, 25»; у итогов — пояснение и «Налоговые итоги №: 1, 2»; у реквизитов — только пояснение «…Значения не показываются.», без номера чека, подписи и других значений. С клавиатуры: Tab доходит до каждого summary, фокус виден; Enter и Space раскрывают и сворачивают; фокус остаётся на summary, страница не прыгает. Перейти по «Открыть чек №1»: в блоке фото те же три группы с тем же поведением; у 25 строк нет ставки НДС, налоговых итогов нет, чек не помечен как требующий проверки.
2. **`tax_evidence_present`** (job 2, чек 2). В задании и в чеке одна группа «Не прочитаны 2 реквизита». У всех 25 строк есть ставка: 17 строк 7 %, 8 строк 19 %; два налоговых итога. В каталоге те же 21 товар, новых нет; чек 1 остался без ставок.
3. **needs_review** (job 3, `inconsistent_total`). Обе вырезки «Требует проверки». «Причины проверки» со строкой «Сумма строк не совпадает с итогом · Итого» видны сразу, без раскрытия, выше и отдельно от «Замечаний распознавания». Ниже по-прежнему блок «Распознанные данные для проверки»; формы подтверждения и редактирования нет; новых чеков нет.
4. **Адаптивность и доступность.** Ширина 320, 768 и 1280 px, zoom 200 %: заголовки групп и перечень из 25 строк переносятся, общей горизонтальной прокрутки нет, summary не обрезан; при 320 px карточки фото в чеке идут в одну колонку. Экранный диктор (NVDA или Narrator): «Причины проверки» и «Замечания распознавания» читаются как заголовки 4-го уровня, summary объявляется с состоянием «свёрнуто/развёрнуто», после раскрытия читаются пояснение и перечень, текст сервера `message` не звучит.
5. **Остановка.** Ctrl+C **своих** API, Vite и worker, затем `docker compose -p $env:COMPOSE_PROJECT_NAME down` без `-v`: тома и MEDIA сохраняются.

Подробные команды, HTTP-сценарий без браузера и полные результаты — `docs/verification.md`, раздел «И6: налоговые evidence и сгруппированные замечания». Сценарии И5, health и админки F4/F6 остаются отдельными. Deployment, merge и release не выполнялись.
