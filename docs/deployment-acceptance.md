# Ручная приёмка сервера

**Статус (2026-10-08): список составлен чтением кода и `deploy/`. Сервер и развёртывание никем не проверялись; ни один шаг ниже не выполнялся.** Ожидаемые результаты выведены из кода и конфигурации, а не из наблюдения: расхождение на сервере — повод разобраться, а не обязательно дефект сервера. Приёмку выполняет человек после развёртывания по [deployment.md](deployment.md); автотестами она не закрывается.

Нужны: развёрнутый сервер, домен, оператор с `sudo`, две учётные записи без `is_staff` (ниже — `anna` и `boris`; имена любые), два устройства в разных сетях (например, компьютер и телефон в мобильной сети), у `anna` — хотя бы одно загруженное фото. `<домен>` — заполнитель. Команды `curl` выполняются с внешней машины, если не сказано «на сервере»; `ck` — помощник из [deployment.md](deployment.md#помощник-для-команд-django).

Сервер развёрнут в Docker ([deployment-docker.md](deployment-docker.md), основной путь) — шаги те же, но команды сервера другие: замены и дополнительный шаг — в разделе [«М. Docker-вариант»](#м-docker-вариант). Прочитайте его до начала.

Результат записывайте по каждому шагу: прошло / не прошло (что наблюдалось) / не проверено и почему. Автоматический обход интерфейса в браузере запрещён правилами проекта: шаги с браузером выполняет человек руками.

## А. HTTPS и заголовки

| № | Действие | Ожидается |
| --- | --- | --- |
| 1 | Открыть `https://<домен>/` в браузере | страница входа Checkist; сертификат действителен и выдан на домен, предупреждений нет |
| 2 | `curl -sI http://<домен>/` | `308` (перенаправление Caddy), `Location: https://<домен>/` |
| 3 | `curl -sI https://<домен>/` | `200`; `strict-transport-security: max-age=3600`; `x-robots-tag: noindex, nofollow`; `cache-control: no-cache`; заголовка `server` нет |
| 4 | `curl -sI https://<домен>/api/health/` | `200`; те же `strict-transport-security` и `x-robots-tag`, каждый по одному разу |
| 5 | `curl -s https://<домен>/api/health/` | `"status": "ok"`, проверки `database`, `redis`, `celery` — `ok` |
| 6 | `curl -sI https://<домен>/admin/login/` | `200`; `strict-transport-security`, `x-robots-tag` |
| 7 | `curl -sI https://<домен>/static/admin/css/base.css` | `200`; `x-robots-tag`; `content-type: text/css` |
| 8 | `curl -sI https://<домен>/no-such-page-xyz` | `200` и страница приложения (маршрут клиента); `x-robots-tag` |
| 9 | `curl -sI https://<домен>/assets/no-such-file.js` | `404`; `x-robots-tag` |
| 10 | `curl -s https://<домен>/robots.txt` | ровно две строки: `User-agent: *` и `Disallow: /` |
| 11 | `curl -sI https://<домен>/api/no-such-route/` | `404`; `x-robots-tag` |

## Б. Доступ без входа

| № | Действие | Ожидается |
| --- | --- | --- |
| 12 | `curl -s -o /dev/null -w '%{http_code}\n' https://<домен>/api/products/` | `401` |
| 13 | `curl -s https://<домен>/api/me/` | `401`, в теле `"code": "not_authenticated"` |
| 14 | `curl -s -o /dev/null -w '%{http_code}\n' https://<домен>/api/receipts/` | `401` |
| 15 | `curl -s -o /dev/null -w '%{http_code}\n' https://<домен>/api/stats/spending/` | `401` |
| 16 | `curl -sI https://<домен>/media/originals/00000000-0000-0000-0000-000000000000/x.jpg` | `404` с пустым телом; `cache-control: private, no-store`; `x-robots-tag` |
| 17 | `curl -sI https://<домен>/admin/` | `302` на `/admin/login/?next=/admin/` |

## В. Cookie

| № | Действие | Ожидается |
| --- | --- | --- |
| 18 | `curl -s -o /dev/null -D - https://<домен>/api/auth/csrf/` | `200`; `set-cookie: csrftoken=…` с `Secure` и `SameSite=Lax` |
| 19 | Войти в приложение под `anna`; в инструментах разработчика браузера открыть список cookie домена | `sessionid` — `Secure`, `HttpOnly`, `SameSite=Lax`; `csrftoken` — `Secure`, `SameSite=Lax` |
| 20 | Оператор входит в `https://<домен>/admin/`, затем открывает `https://<домен>/` в той же вкладке | приложение открыто под оператором без повторного входа (одна сессия на админку и приложение) |

## Г. Две учётные записи, два устройства

| № | Действие | Ожидается |
| --- | --- | --- |
| 21 | На компьютере войти под `anna`, на телефоне — под `boris` | оба вошли; каждый видит только свои чеки, задания и статистику |
| 22 | `anna` загружает фото чека; `boris` обновляет списки чеков и заданий | у `boris` фото, задания и чека `anna` нет |
| 23 | `anna` открывает своё фото в задании и копирует адрес изображения (`https://<домен>/media/originals/…`); `boris`, оставаясь вошедшим, открывает этот адрес | `anna` — изображение; `boris` — `404` |
| 24 | Тот же адрес открыть в окне без входа (приватное окно) | `404`, как в шаге 16 |
| 25 | `boris` открывает адрес чека `anna` — `https://<домен>/receipts/<id чека anna>` | «не найдено», содержимого чека нет |
| 26 | `boris` (без права модератора) открывает `https://<домен>/catalog/merges` и `https://<домен>/catalog/classification` | экраны модератора недоступны, кнопок действий нет |
| 27 | Оператор выдаёт `boris` право `catalog.moderate_catalog` в админке; `boris` обновляет страницу | экраны и действия модератора доступны |
| 28 | `anna` меняет пароль на странице `/account`; на втором устройстве, где она тоже была вошедшей, обновить страницу | на втором устройстве — снова экран входа; новый пароль подходит |
| 29 | Оператор снимает «Активный» у `boris`; `boris` обновляет страницу | экран входа; вход под `boris` отказывает, как при неверном пароле |

## Д. Загрузка с телефона

| № | Действие | Ожидается |
| --- | --- | --- |
| 30 | С телефона в мобильной сети загрузить фото чека размером близко к 20 МБ | загрузка принята, задание появилось в списке; отказа прокси (`413`) нет |
| 31 | Загрузить файл больше 20 МБ | понятный отказ приложения, задание не создано |

Клиент ждёт ответа на загрузку 60 с: при медленной сети (меньше примерно 2,7 Мбит/с на отдачу) 20 МБ не успеют. Запишите время и скорость, если загрузка оборвалась, — это не дефект сервера, а повод для отдельной задачи клиента.

## Е. Защита от перебора пароля

Счёт идёт по адресу клиента, который Caddy дописывает в `X-Forwarded-For`. Проверяется, что блокировка касается одного адреса, а не всех сразу, и что заголовок, присланный клиентом, её не обходит.

| № | Действие | Ожидается |
| --- | --- | --- |
| 32 | На компьютере 5 раз подряд войти под `anna` с неверным паролем | 5 отказов как при неверном логине или пароле |
| 33 | Шестая попытка там же, уже с **верным** паролем | отказ с сообщением о временной блокировке и сроком (до 900 с) |
| 34 | Сразу после этого на телефоне в мобильной сети (другой адрес) войти под `anna` с верным паролем | вход успешен: чужие неудачи с другого адреса не закрывают вход |
| 35 | С компьютера — запрос входа с поддельным заголовком (команда ниже) | `429`, `"code": "login_throttled"`, `retry_after` в теле и заголовок `Retry-After` — поддельный адрес не снял блокировку |
| 36 | На компьютере открыть `https://<домен>/admin/login/` и войти под оператором с **неверным** паролем 5 раз, затем с верным | после пятой неудачи вход в админку отказывает и с верным паролем — защита общая для приложения и админки |
| 37 | Подождать 15 минут, повторить вход с компьютера | вход успешен |

Команда шага 35 (пароль любой: заблокированная попытка пароль не проверяет):

```bash
TOKEN=$(curl -s -c jar https://<домен>/api/auth/csrf/ | sed 's/.*"csrf_token": *"\([^"]*\)".*/\1/')
curl -s -i -b jar -H 'Content-Type: application/json' -H "X-CSRFToken: $TOKEN" \
  -H 'Origin: https://<домен>' -H 'X-Forwarded-For: 203.0.113.7' \
  -d '{"username": "anna", "password": "x"}' https://<домен>/api/auth/login/
rm jar
```

Если шаг 34 отказывает блокировкой, а шаг 32 выполнялся с другого адреса — сервер считает всех одним адресом: проверьте `DJANGO_TRUST_PROXY=1` и что перед Django стоит именно Caddy из `deploy/Caddyfile`.

## Ж. Сеть

| № | Действие | Ожидается |
| --- | --- | --- |
| 38 | С внешней машины: `nc -vz -w 5 <домен> 5432`, то же для `6379` и `8000` | все три — отказ либо таймаут |
| 39 | На сервере: `sudo ss -tlnp` | на внешних адресах только `:22`, `:80`, `:443`; `5432`, `6379`, `8000` — только `127.0.0.1` / `[::1]` |
| 40 | На сервере: `curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8000/api/health/` | не `200` (`400` — хост не из `DJANGO_ALLOWED_HOSTS`): напрямую, мимо прокси, Django домен не обслуживает |

## З. Перезагрузка

| № | Действие | Ожидается |
| --- | --- | --- |
| 41 | `sudo reboot`; после загрузки `systemctl is-active caddy postgresql redis-server checkist-web checkist-celery checkist-backup.timer` | все `active` |
| 42 | `curl -s -o /dev/null -w '%{http_code}\n' https://<домен>/api/health/` | `200` |
| 43 | `systemctl --failed` | списка упавших служб нет |
| 44 | Вошедший до перезагрузки пользователь обновляет страницу | остаётся вошедшим (сессии хранятся в базе) |

## И. Резервная копия и восстановление

| № | Действие | Ожидается |
| --- | --- | --- |
| 45 | На следующий день после развёртывания: `systemctl list-timers checkist-backup.timer`, `sudo ls /var/backups/checkist` | таймер отработал; есть каталог `checkist-<метка времени>` с `db.dump`, `media.tar.gz`, `manifest.json` |
| 46 | `ck backup verify /var/backups/checkist/checkist-<метка времени>` | exit 0, JSON с `manifest` |
| 47 | Запомнить числа рабочего состояния: `sudo -u postgres psql -At -d <POSTGRES_DB> -c 'select count(*) from receipts_receipt' -c 'select count(*) from recognition_sourcephoto'` и `sudo find <MEDIA_ROOT> -type f \| wc -l` | три числа (сразу после снятия копии, пока никто не загружал) |
| 48 | `sudo install -d -o checkist -g checkist -m 0700 /var/lib/checkist/media-check`, затем `ck backup restore /var/backups/checkist/checkist-<метка времени> --database checkist_check --media-root /var/lib/checkist/media-check` | exit 0, JSON с `database`, `media_root`, `media_files` |
| 49 | Те же запросы к базе `checkist_check` и `sudo find /var/lib/checkist/media-check -type f \| wc -l` | числа чеков, фото и файлов совпали с шагом 47; `media_files` из шага 48 равно числу файлов |
| 50 | Повторить команду шага 48 без изменений | отказ: база уже существует либо каталог непуст; рабочие база и MEDIA не тронуты |
| 51 | Убрать проверочное: `sudo -u postgres dropdb checkist_check`, `sudo rm -r /var/lib/checkist/media-check` | рабочий сайт работает как прежде |
| 52 | Вывезти копию на свою машину командой из [deployment.md](deployment.md#14-резервные-копии) | каталог копии на своей машине, размеры файлов совпадают с `manifest.json` |

## К. Распознавание

Выполняется после включения службы `checkist-recognition` ([deployment.md](deployment.md#11-codex-и-служба-распознавания)). Шаг 55 — настоящий модельный запрос под входом Codex на сервере; на это нужно решение человека. Если служба не включена, отметьте раздел «не проверено: распознавание на сервере не включено» — остальная приёмка от него не зависит.

| № | Действие | Ожидается |
| --- | --- | --- |
| 53 | `sudo -u checkist -H <путь codex> login status; echo "exit $?"` | `exit 0` |
| 54 | `systemctl is-active checkist-recognition`; `journalctl -u checkist-recognition -e` | `active`; в журнале `Recognition worker ready.`; в приложении исполнитель показан доступным |
| 55 | `anna` загружает фото одного настоящего чека | задание доходит до конца, чек появляется у `anna` и не появляется у `boris` |
| 56 | Загрузить ещё одно фото и, пока задание выполняется, `sudo systemctl stop checkist-recognition`; `journalctl -u checkist-recognition -e` | в журнале `Recognition worker stopped; active work released.`; задание в приложении снова ждёт в очереди, а не висит «выполняется» |
| 57 | `sudo systemctl start checkist-recognition` | задание из шага 56 выполняется и завершается |
| 58 | `sudo systemd-run --pipe --wait -p User=checkist -p InaccessiblePaths=-/home/checkist/.codex ls /home/checkist/.codex` | ошибка доступа: так вход Codex закрыт от служб web, celery и backup |

## Л. После приёмки

| № | Действие | Ожидается |
| --- | --- | --- |
| 59 | Поднять HSTS по [deployment.md](deployment.md#12-hsts-3600--31536000-после-приёмки); `curl -sI https://<домен>/ \| grep -i strict` и то же для `/api/health/` | `max-age=31536000` в обоих ответах, по одному заголовку |
| 60 | Сохранить `/etc/checkist/checkist.env` в надёжном месте вне сервера | файл сохранён; в репозиторий и переписку не попал |
| 61 | Каждому пользователю сообщено, что видно остальным и оператору ([deployment.md](deployment.md#8-первичная-установка-учётные-записи), пункт 5) | сообщено |

## М. Docker-вариант

Для сервера, развёрнутого по [deployment-docker.md](deployment-docker.md). **Ни одна команда раздела не выполнялась:** ожидаемые результаты выведены из `compose.prod.yaml`, `Dockerfile` и скриптов `deploy/docker/`. Разделы А–Е выполняются без изменений. В остальных вместо `systemctl`, `journalctl` и функции `ck` используется скрипт `deploy/docker/ck`; команды — из каталога `/opt/checkist`.

Общие замены:

| В шагах выше | В Docker-варианте |
| --- | --- |
| `ck <команда>` | `./deploy/docker/ck manage <команда>` |
| `systemctl is-active <служба>` | `./deploy/docker/ck compose ps` — у сервиса состояние `running` и `healthy` |
| `journalctl -u checkist-<служба> -e` | `./deploy/docker/ck compose logs --tail 200 <сервис>` (`web`, `celery`, `proxy`, `recognition`) |
| `sudo systemctl stop` / `start checkist-recognition` | `./deploy/docker/ck compose stop recognition` / `./deploy/docker/ck compose up -d recognition` |
| путь копии `/var/backups/checkist/checkist-<метка>` в аргументах `backup` | `/backups/checkist-<метка>` — путь внутри контейнера; на сервере каталог тот же |
| `/etc/checkist/checkist.env` | `/opt/checkist/.env.prod` |

Шаги, которые выполняются иначе:

| № | Действие в Docker-варианте | Ожидается |
| --- | --- | --- |
| 39 | На сервере: `sudo ss -tlnp` | на внешних адресах только `:22`, `:80`, `:443`; портов `5432`, `6379`, `8000` в списке нет вообще — они не опубликованы |
| 40 | На сервере: `curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8000/api/health/` | `000` (соединение отклонено): мимо прокси Django с сервера недоступен |
| 41 | `sudo reboot`; после загрузки `systemctl is-active docker` и `./deploy/docker/ck compose ps` | `active`; `postgres`, `redis`, `web`, `celery`, `proxy` — `running` и `healthy` (и `recognition` — `running`, если профиль включён) |
| 43 | `./deploy/docker/ck compose ps --all` | сервисов в состоянии `exited` либо `restarting` нет |
| 45 | На следующий день после добавления строки cron: `tail ~/checkist-backup.log`, `sudo ls /var/backups/checkist` | в журнале JSON с `copy` без ошибок; есть каталог `checkist-<метка>` с `db.dump`, `media.tar.gz`, `manifest.json` |
| 46 | `./deploy/docker/ck manage backup verify /backups/checkist-<метка>` | exit 0, JSON с `manifest` |
| 47 | `./deploy/docker/ck compose exec postgres sh -c 'psql -At -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "select count(*) from receipts_receipt" -c "select count(*) from recognition_sourcephoto"'` и `./deploy/docker/ck compose exec web sh -c 'find "$MEDIA_ROOT" -type f \| wc -l'` | три числа |
| 48 | `./deploy/docker/ck manage backup restore /backups/checkist-<метка> --database checkist_check --media-root /var/lib/checkist/media-check` (каталог заранее не создаётся) | exit 0, JSON с `database`, `media_root`, `media_files` |
| 49 | Запрос шага 47 с `-d checkist_check` вместо `-d "$POSTGRES_DB"` и `./deploy/docker/ck compose exec web sh -c 'find /var/lib/checkist/media-check -type f \| wc -l'` | числа совпали с шагом 47; `media_files` равно числу файлов |
| 51 | `./deploy/docker/ck compose exec postgres sh -c 'dropdb -U "$POSTGRES_USER" checkist_check'`, `./deploy/docker/ck compose exec web rm -r /var/lib/checkist/media-check` | рабочий сайт работает как прежде |
| 52 | Вывезти копию командой из [deployment-docker.md](deployment-docker.md#6-резервные-копии) | каталог копии на своей машине |
| 53 | `./deploy/docker/ck compose run --rm recognition codex login status; echo "exit $?"` | `exit 0` |
| 54 | `./deploy/docker/ck compose ps recognition`; `./deploy/docker/ck compose logs --tail 50 recognition` | `running`; в журнале `Recognition worker ready.`; в приложении исполнитель показан доступным |
| 56 | Пока задание выполняется: `./deploy/docker/ck compose stop recognition`; затем журнал | `Recognition worker stopped; active work released.`; задание снова ждёт в очереди |
| 57 | `./deploy/docker/ck compose up -d recognition` | задание из шага 56 выполняется и завершается |
| 58 | `./deploy/docker/ck compose exec web ls -A /home/checkist/.codex` | пустой вывод: том со входом Codex смонтирован только в `recognition` |
| 59 | Поднять HSTS по [deployment-docker.md](deployment-docker.md#11-hsts-3600--31536000-после-приёмки) | `max-age=31536000` в обоих ответах, по одному заголовку |
| 60 | Сохранить `/opt/checkist/.env.prod` в надёжном месте вне сервера | файл сохранён; в репозиторий и переписку не попал |

Дополнительные шаги — только для Docker-варианта:

| № | Действие | Ожидается |
| --- | --- | --- |
| 62 | Сразу после шага 32 (пять неудачных входов с компьютера) оператор открывает `https://<домен>/admin/` → «Login failures» и читает столбец `key` | в ключах `a:<адрес>` и `p:<адрес>:…` стоит **внешний адрес компьютера** — тот же, что показывает компьютеру любой сервис «мой IP»; адреса вида `172.x`, `10.x`, `192.168.x` либо `127.0.0.1` там нет |
| 63 | То же после неудачного входа с телефона в мобильной сети | у записей телефона другой адрес, чем у компьютера |
| 64 | `dig +short AAAA <домен>` с любой машины | пустой вывод: записи `AAAA` у домена нет |
| 65 | На сервере: `cd /opt/checkist && ./deploy/docker/deploy.sh` при отсутствии новых коммитов | скрипт проходит все шаги, пишет `no new commits` и `deploy: done`; в `/var/backups/checkist` появилась новая копия; вошедший пользователь после обновления страницы остаётся вошедшим |

Шаг 62 — главный для этого варианта. Если в ключах адрес `172.x`, сервер считает всех клиентов одним адресом: шаг 34 тоже откажет, а пять чужих ошибок закроют вход всем. Что делать — [deployment-docker.md, раздел 13](deployment-docker.md#13-что-проверено-а-что-нет): это требует отдельной задачи, а не правки на сервере.

## Что этой приёмкой не закрывается

- Поведение поисковиков: `robots.txt` и `X-Robots-Tag` — просьба, проверить её исполнение нельзя.
- Автоматическое продление сертификата: видно только через срок его действия (`curl -vI https://<домен>/ 2>&1 | grep -i expire` — дата должна сдвигаться).
- Качество распознавания на разных чеках, нагрузка, долгая работа воркера и обновление входа Codex со временем.
- Вид и поведение экранов приложения — отдельная ручная приёмка интерфейса.
