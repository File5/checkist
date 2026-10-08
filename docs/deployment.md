# Развёртывание на сервере

> **Основной путь развёртывания — Docker: [deployment-docker.md](deployment-docker.md)** (всё в Docker Compose, обновление одной командой `deploy/docker/deploy.sh`). Вариант этого документа — без Docker, на systemd — **запасной**: его файлы (`deploy/Caddyfile`, `deploy/systemd/`, `deploy/checkist.env.example`) остаются в репозитории и проверяются тестом, но разворачивать сервер рекомендуется по Docker-инструкции. Разделы 8 (учётные записи) и 16 (правила отката миграций) действуют в обоих вариантах; в Docker-варианте команда `ck <команда>` этого документа записывается как `./deploy/docker/ck manage <команда>`.

**Статус (2026-10-08): инструкция составлена чтением кода и файлов `deploy/`. Развёртывание и сервер никем не проверялись.** Ни одна команда этого документа не выполнялась на сервере: ни установка пакетов, ни gunicorn, ни Caddy, ни systemd, ни `check --deploy`, ни вход Codex под пользователем службы, ни восстановление копии. Сервера, домена и сертификата на момент написания нет. Первое развёртывание — одновременно первая проверка этой инструкции; приёмка — по [deployment-acceptance.md](deployment-acceptance.md).

Что сверено с кодом ветки: имена переменных (`backend/config/settings.py`, `deploy/checkist.env.example`), пути и службы (`deploy/systemd/`, `deploy/Caddyfile`, `deploy/gunicorn.conf.py`), команды `backup` (`backend/health/backup.py`), `ownership check-rollback` (`backend/recognition/ownership.py`), `recognition_worker`, право `catalog.moderate_catalog`. Что взято из общего знания и помечено **не проверено**: имена пакетов и служб ОС, поведение Caddy и systemd, установка и вход Codex CLI на Linux.

Решение и его причины — [multi-user.md](multi-user.md#развёртывание-на-публичном-сервере). Схема: один Linux-сервер, без Docker; Caddy принимает HTTPS и раздаёт собранный SPA и статику админки, Django работает под gunicorn на `127.0.0.1:8000`, PostgreSQL и Redis — пакеты ОС на loopback, распознавание — служба рядом с Codex CLI.

## Оглавление

1. [Требования](#1-требования)
2. [DNS и firewall](#2-dns-и-firewall)
3. [Пользователь ОС и каталоги](#3-пользователь-ос-и-каталоги)
4. [Код и зависимости](#4-код-и-зависимости)
5. [Окружение](#5-окружение)
6. [База и данные](#6-база-и-данные)
7. [Миграции, статика, проверка настроек, сборка SPA](#7-миграции-статика-проверка-настроек-сборка-spa)
8. [Первичная установка: учётные записи](#8-первичная-установка-учётные-записи)
9. [Службы](#9-службы)
10. [Caddy и домен](#10-caddy-и-домен)
11. [Codex и служба распознавания](#11-codex-и-служба-распознавания)
12. [HSTS: 3600 → 31536000 после приёмки](#12-hsts-3600--31536000-после-приёмки)
13. [Обновление версии](#13-обновление-версии)
14. [Резервные копии](#14-резервные-копии)
15. [Восстановление](#15-восстановление)
16. [Откат](#16-откат)
17. [Вариант: разворачивает ИИ по SSH](#17-вариант-разворачивает-ии-по-ssh)
18. [Что не настроено](#18-что-не-настроено)

Во всех командах `checkist.example` и `<домен>` — заполнитель: замените на настоящий домен. Команды с `sudo` выполняет оператор сервера.

## 1. Требования

| Что | Версия | Зачем | Замечание |
| --- | --- | --- | --- |
| Linux с systemd | Debian либо Ubuntu | units ссылаются на `postgresql.service` и `redis-server.service` | на другом дистрибутиве поправьте `After=` / `Wants=` в units; **не проверено** |
| Python | 3.13 с модулем `venv` | Django 5.2, зависимости из `backend/requirements.txt` | в Debian 13 — пакет ОС; на других версиях источник выбирает оператор; **не проверено** |
| PostgreSQL | 17, сервер и клиентские программы (`pg_dump`, `pg_restore`, `createdb`, `psql`) в `PATH` | база; команда `backup` запускает клиентские программы | версия клиента не ниже версии сервера, с которого снят дамп |
| Redis | 7.x | только `health`, Celery и кэш; данные приложения в нём не хранятся | пакет `redis-server` |
| Caddy | 2.x | HTTPS, сертификат, SPA, статика, передача `/api`, `/admin`, `/media`, `/robots.txt` | официальный пакет со службой `caddy` и `/etc/caddy/Caddyfile` |
| Node.js и npm | Node 24, npm 11 (`frontend/package.json`, `engines`) | только сборка SPA; в работе сервера не участвует | собрать можно и на другой машине, перенеся `frontend/dist` |
| Codex CLI | та, что принимает флаги запуска воркера (в QA использовалась 0.160.0 на Windows) | распознавание и предположения категорий | нужен только службе `checkist-recognition`; на Linux **не проверено** |
| git | любая | получение кода | |

Размер: фото до 20 МБ каждое (`RECEIPT_IMAGE_MAX_BYTES`), оригинал и подготовленные файлы хранятся в MEDIA; копии — 14 суток базы и MEDIA целиком. Диск планируйте с запасом не меньше 15 объёмов MEDIA.

## 2. DNS и firewall

1. Запись `A` (и `AAAA`, если у сервера есть IPv6) домена указывает на адрес сервера. Caddy получит сертификат сам при первом запуске — для этого порты 80 и 443 должны быть доступны из интернета, а запись уже действовать.
2. Наружу открыты только SSH, 80 и 443. Пример для `ufw` (**не проверено**):

   ```bash
   sudo ufw default deny incoming
   sudo ufw allow OpenSSH
   sudo ufw allow 80/tcp
   sudo ufw allow 443/tcp
   sudo ufw enable
   ```

3. PostgreSQL, Redis и gunicorn слушают только loopback. gunicorn — по `deploy/gunicorn.conf.py` (`bind = "127.0.0.1:8000"`). У PostgreSQL и Redis это значение по умолчанию пакетов Debian/Ubuntu (`listen_addresses = 'localhost'`, `bind 127.0.0.1 -::1`) — **не проверено**, убедитесь командой:

   ```bash
   sudo ss -tlnp
   ```

   Ожидается: на внешних адресах (`0.0.0.0`, `*`, `[::]`) — только `:22`, `:80`, `:443`; порты `5432`, `6379`, `8000` — только на `127.0.0.1` / `[::1]`.

Запрет индексации (`X-Robots-Tag`, `/robots.txt`) — просьба к поисковикам, а не защита: адрес домена виден, например, в журналах выданных сертификатов. Данные защищает только вход.

## 3. Пользователь ОС и каталоги

Один пользователь ОС `checkist` для всех служб, с домашним каталогом (в нём Codex хранит вход):

```bash
sudo useradd --system --create-home --home-dir /home/checkist --shell /bin/bash checkist
sudo install -d -o checkist -g checkist -m 0755 /opt/checkist /var/lib/checkist /var/lib/checkist/static
sudo install -d -o checkist -g checkist -m 0700 /var/lib/checkist/media /var/lib/checkist/ocr-scratch /var/backups/checkist
sudo install -d -o root -g checkist -m 0750 /etc/checkist
```

| Путь | Что | Доступ |
| --- | --- | --- |
| `/opt/checkist` | код, `backend/.venv`, `frontend/dist` | `checkist`; Caddy читает `frontend/dist` |
| `/etc/checkist/checkist.env` | окружение всех служб, секреты | `root:checkist`, `0640` |
| `/var/lib/checkist/media` | `MEDIA_ROOT`: фото и вырезки всех пользователей | `checkist`, `0700`; Caddy сюда не ходит |
| `/var/lib/checkist` | рядом с MEDIA код создаёт временные каталоги `.media-recognition-staging-*` | `checkist` должен писать в сам каталог (`ReadWritePaths` службы web) |
| `/var/lib/checkist/ocr-scratch` | `RECEIPT_OCR_TEMP_ROOT`: файлы попыток модели; в копии не входит | `checkist`, `0700` |
| `/var/lib/checkist/static` | `DJANGO_STATIC_ROOT`: статика админки | `checkist` пишет, Caddy читает |
| `/var/backups/checkist` | резервные копии: чеки и фото всех пользователей | `checkist`, `0700`; каталог должен существовать до запуска службы копий |
| `/home/checkist/.codex` | вход Codex — секрет уровня пароля | только `checkist`; службам web, celery и backup закрыт (`InaccessiblePaths`) |

Пути зашиты в `deploy/systemd/*.service`, `deploy/Caddyfile` и `deploy/checkist.env.example`. Меняете путь — меняйте во всех трёх местах.

## 4. Код и зависимости

```bash
sudo -u checkist -H git clone <адрес репозитория> /opt/checkist
sudo -u checkist -H bash -c 'cd /opt/checkist && git checkout <коммит или метка версии>'
sudo -u checkist -H python3.13 -m venv /opt/checkist/backend/.venv
sudo -u checkist -H /opt/checkist/backend/.venv/bin/pip install -r /opt/checkist/backend/requirements.txt
sudo -u checkist -H /opt/checkist/backend/.venv/bin/pip check
```

`requirements.txt` закрепляет полный набор, включая `gunicorn==26.2.0`. Файла `.env` в `/opt/checkist` на сервере быть не должно: единственный источник настроек — `/etc/checkist/checkist.env`.

## 5. Окружение

```bash
sudo install -o root -g checkist -m 0640 /opt/checkist/deploy/checkist.env.example /etc/checkist/checkist.env
sudo -e /etc/checkist/checkist.env
```

Формат — `EnvironmentFile` systemd: `ИМЯ=значение`, без кавычек, без `export`, без подстановки переменных. Тот же файл читает оболочка в помощнике `ck` (ниже), поэтому **значения — только из букв, цифр, `_`, `-`, `.`, `/`, `:`, `,`**: пробел, `#`, `$`, кавычки и `;` оболочка и systemd прочитают по-разному.

Заполнить обязательно:

| Переменная | Значение на сервере | Что делает |
| --- | --- | --- |
| `DJANGO_SECRET_KEY` | `python3 -c "import secrets; print(secrets.token_urlsafe(64))"` | пустой либо ключ разработки — службы не запустятся |
| `POSTGRES_PASSWORD` | свой пароль роли `checkist` (тот же алфавит) | пустой — службы не запустятся |
| `DJANGO_ALLOWED_HOSTS` | `<домен>` | только домен: без `127.0.0.1` и шаблонов |
| `DJANGO_CSRF_TRUSTED_ORIGINS` | `https://<домен>` | принимается только `https://` + хост из `DJANGO_ALLOWED_HOSTS`, без порта и пути |

Уже заданы в образце — проверьте, не меняя без причины:

| Переменная | Значение | Что делает |
| --- | --- | --- |
| `CHECKIST_AUTH_MODE` | `accounts` | вход обязателен; `local_single` вместе с `DJANGO_DEBUG=0` — отказ запуска |
| `DJANGO_DEBUG` | `0` | |
| `DJANGO_TRUST_PROXY` | `1` | Django верит `X-Forwarded-Proto` и `X-Forwarded-For` от Caddy, перенаправляет `http → https`; по адресу из `X-Forwarded-For` считается защита от перебора пароля |
| `DJANGO_SECURE_COOKIES` | `1` | `Secure` у cookie сессии и CSRF |
| `DJANGO_HSTS_SECONDS` | `3600` | равно `max-age` в Caddyfile; поднимается после приёмки ([раздел 12](#12-hsts-3600--31536000-после-приёмки)) |
| `DJANGO_STATIC_ROOT` | `/var/lib/checkist/static` | цель `collectstatic` |
| `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_HOST`, `POSTGRES_PORT` | `checkist`, `checkist`, `127.0.0.1`, `5432` | |
| `REDIS_PORT`, `CELERY_BROKER_URL`, `CELERY_RESULT_BACKEND`, `DJANGO_CACHE_URL` | `6379`, `redis://127.0.0.1:6379/0`, `/1`, `/2` | |
| `ALLOW_LOCAL_RECOGNITION_API` | `0` | локальный переключатель разработки; на сервере доступ даёт учётная запись |
| `PRODUCT_MERGE_AUTO_DETECT`, `PRODUCT_CLASSIFICATION_AUTO_SUGGEST` | `0` | автозапуск поиска дублей и предположений после импорта; включает оператор осознанно |
| `MEDIA_ROOT`, `RECEIPT_OCR_TEMP_ROOT` | `/var/lib/checkist/media`, `/var/lib/checkist/ocr-scratch` | абсолютные, не вложены друг в друга |
| `RECEIPT_OCR_PROVIDER` | `codex_cli` | `fake` на сервере не ставить: он создаёт вымышленные чеки |
| `RECEIPT_OCR_CODEX_EXECUTABLE` | `/usr/local/bin/codex` | абсолютный путь: systemd не знает `PATH` входа пользователя; поправьте под фактическую установку |

Необязательные, со значениями по умолчанию из кода: `AUTH_LOGIN_FAILURE_LIMIT` (5 неудач на пару «логин и адрес»), `AUTH_LOGIN_IP_FAILURE_LIMIT` (50 на адрес), `AUTH_LOGIN_LOCK_SECONDS` (900), `RECEIPT_OCR_MODEL` и таймауты `RECEIPT_OCR_*`, `PRODUCT_CLASSIFICATION_*`. `RECEIPT_OCR_CODEX_HOME` из окружения **не читается** — вход Codex берётся из домашнего каталога пользователя службы.

Неверное значение любой переменной — отказ запуска с её именем в сообщении (`ImproperlyConfigured: ИМЯ: …`).

### Помощник для команд Django

Команды `manage.py` на сервере выполняются под `checkist` с тем же окружением, что у служб. Определите в своей оболочке функцию и пользуйтесь ею дальше:

```bash
ck() {
  sudo -u checkist -H bash -c \
    'set -a; . /etc/checkist/checkist.env; set +a; cd /opt/checkist/backend && exec .venv/bin/python manage.py "$@"' \
    ck "$@"
}
```

`ck check` должна ответить `System check identified no issues`. Команды ниже записаны через `ck`.

## 6. База и данные

Роль и права одинаковы в обоих вариантах. `CREATEDB` нужно команде восстановления копии: она создаёт новую базу.

```bash
sudo -u postgres createuser --pwprompt --createdb checkist
```

Пароль — тот, что записан в `POSTGRES_PASSWORD`.

### Вариант А. Пустая база

```bash
sudo -u postgres createdb --owner checkist --template template0 --encoding UTF8 checkist
```

Дальше — [раздел 7](#7-миграции-статика-проверка-настроек-сборка-spa). Миграции создадут схему, справочники и пользователя `local` без чеков.

### Вариант Б. Перенос домашней базы и MEDIA

Копию снимает и восстанавливает одна и та же команда `manage.py backup`.

1. **Дома** (Windows, dev-окружение; PostgreSQL в контейнере, поэтому клиентские программы запускаются через префикс). Остановите `recognition_worker` и загрузки, затем:

   ```powershell
   $env:CHECKIST_PG_TOOLS_PREFIX='docker compose -p checkist_dev exec -T postgres'
   ./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py backup create --dir C:/checkist-copies
   ./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py backup verify C:/checkist-copies/checkist-<метка времени>
   ```

   Получится каталог `checkist-YYYYMMDDTHHMMSSZ` с `db.dump`, `media.tar.gz` и `manifest.json`. Каталог копий должен быть вне `MEDIA_ROOT`.

2. Перенесите каталог копии на сервер (`scp -r`) в `/var/backups/checkist/` и отдайте пользователю `checkist`:

   ```bash
   sudo chown -R checkist:checkist /var/backups/checkist/checkist-<метка времени>
   ck backup verify /var/backups/checkist/checkist-<метка времени>
   ```

3. Восстановите в **новую** базу и **новый пустой** каталог. Команда отказывает, если имя базы совпадает с `POSTGRES_DB` из окружения, если база уже существует, если каталог непуст либо пересекается с `MEDIA_ROOT`. Поэтому имена — отличные от записанных в окружении:

   ```bash
   sudo install -d -o checkist -g checkist -m 0700 /var/lib/checkist/media-r1
   ck backup restore /var/backups/checkist/checkist-<метка времени> --database checkist_r1 --media-root /var/lib/checkist/media-r1
   ```

   Ответ — JSON с `database`, `media_root`, `media_files`. Базу `checkist` при этом варианте создавать не нужно.

4. Переключите окружение на восстановленное: в `/etc/checkist/checkist.env` поставьте `POSTGRES_DB=checkist_r1` и `MEDIA_ROOT=/var/lib/checkist/media-r1`. Каталог MEDIA обязан остаться внутри `/var/lib/checkist`: на этот каталог выдано право записи службе web. Пустой `/var/lib/checkist/media` после этого не используется — удалите его.

5. Дальше — [раздел 7](#7-миграции-статика-проверка-настроек-сборка-spa): `migrate` доведёт схему до версии кода (дамп может быть снят более старой версией). Все прежние чеки и фото принадлежат пользователю `local`.

Если перенос не удался, решение проекта допускает вариант А и повторный импорт чеков.

## 7. Миграции, статика, проверка настроек, сборка SPA

```bash
ck migrate --noinput
ck collectstatic --noinput
ck check --deploy
```

- `migrate` идёт с `statement_timeout` 2 с на запрос (зашит в настройках базы). На пустой и на небольшой перенесённой базе этого достаточно по расчёту; на большой базе миграция с переносом владельца может упереться в срок — **не проверено**. Отказ миграции ничего не оставляет наполовину: каждая миграция — одна транзакция.
- `collectstatic` пишет статику админки в `DJANGO_STATIC_ROOT`.
- `check --deploy` — exit 0 и ровно два предупреждения, оба намеренные: `security.W005` (HSTS без `includeSubDomains`) и `security.W021` (без `preload`) — у домена могут быть чужие поддомены. Набор зафиксирован тестом `health.tests.test_deploy_settings.DeployCheckTests`; на сервере **не проверено**. Любое другое предупреждение — ошибка окружения: например, `security.W008` означает, что не включён `DJANGO_TRUST_PROXY`.

Сборка SPA (переменные задавать не нужно: `VITE_API_BASE_URL` по умолчанию `/api`, Vite на сервере не запускается):

```bash
sudo -u checkist -H bash -c 'cd /opt/checkist/frontend && npm ci && npm run build'
```

Результат — `/opt/checkist/frontend/dist/index.html` и `dist/assets/`.

## 8. Первичная установка: учётные записи

Открытой регистрации нет: учётные записи заводит оператор.

1. **Оператор сервера** — суперпользователь, единственный с `is_staff`:

   ```bash
   ck createsuperuser
   ```

   Он входит в `/admin/` и в приложение одной сессией, видит чеки всех пользователей в админке и имеет право модератора без выдачи.

2. **Пароль `local`** — только если переносились прежние данные (вариант Б): им владеет запись `local`, войти под ней нельзя, пока пароль не задан.

   ```bash
   ck changepassword local
   ```

   После этого `local` — обычная учётная запись без прав администратора. На пустой базе запись `local` тоже есть, но без пароля и без данных; пароль ей задавать не нужно.

3. **Учётные записи друзей** — в админке `https://<домен>/admin/` → «Пользователи» → «Добавить»: логин и первый пароль. Флаги «Статус персонала» и «Статус суперпользователя» **не ставить**: `is_staff` открывает чеки всех в админке и положен только оператору. Первый пароль передаётся человеку лично; он меняет его в приложении на странице `/account`.

4. **Право модератора каталога** — `catalog.moderate_catalog` («Can moderate the shared catalog»): подтверждение слияний дублей и предположений категорий, запуск поиска. Выдаётся в карточке пользователя в админке, блок «Права пользователя», либо через группу. Модератор видит в группе слияния строки покупок всех (магазин, дата, количество, сумма) без ссылки на чужой чек, а его решения меняют товары и категории в чеках всех — выдавайте тем, кому доверяете.

5. **Что сказать каждому** при выдаче учётной записи:
   - цена, магазин и день его покупки видны остальным пользователям; при небольшом круге это легко приписать человеку;
   - фото чеков уходят провайдеру модели под одним общим входом Codex;
   - оператор сервера видит все чеки;
   - забытый пароль сбрасывает только оператор (`ck changepassword <логин>` либо админка), почты нет.

6. **Выключение пользователя** — снять «Активный» в админке: вход и открытые сессии перестают действовать, данные остаются. Удалять пользователя с чеками нельзя (`PROTECT`).

7. **Блокировка входа.** После 5 неудач с одного адреса для одного логина (или 50 с адреса) вход отказывает до конца окна в 900 с, в приложении и в админке одинаково. Снять блокировку раньше нельзя — счётчики в админке («Login failures») только для чтения; подождите окончания окна.

## 9. Службы

```bash
sudo cp /opt/checkist/deploy/systemd/checkist-*.service /opt/checkist/deploy/systemd/checkist-backup.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now checkist-web checkist-celery checkist-backup.timer
```

| Служба | Что | Остановка |
| --- | --- | --- |
| `checkist-web` | gunicorn, `127.0.0.1:8000`, 2 процесса по 4 потока; журнала доступа нет (в путях — id чеков) | обычная |
| `checkist-celery` | нужен только проверке `celery` в `/api/health/`; распознавание не выполняет | обычная |
| `checkist-recognition` | `manage.py recognition_worker`: распознавание и предположения категорий | `SIGINT` — воркер возвращает задание в очередь; **включается отдельно**, [раздел 11](#11-codex-и-служба-распознавания) |
| `checkist-backup.timer` → `checkist-backup.service` | ежедневная копия | — |

Проверка без Caddy (Django перенаправляет `http → https` и принимает только домен, поэтому заголовки задаются явно):

```bash
systemctl is-active checkist-web checkist-celery checkist-backup.timer
curl -s -o /dev/null -w '%{http_code}\n' -H 'Host: <домен>' -H 'X-Forwarded-Proto: https' http://127.0.0.1:8000/api/health/
```

Ожидается `active` трижды и `200`. `503` — тело ответа называет недоступный сервис (`database`, `redis`, `celery`). Журналы: `journalctl -u checkist-web -e` (так же для остальных).

## 10. Caddy и домен

```bash
sudo cp /opt/checkist/deploy/Caddyfile /etc/caddy/Caddyfile
sudo sed -i 's/checkist\.example/<домен>/' /etc/caddy/Caddyfile
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

Что делает конфигурация:

- сертификат и перенаправление `http → https` — автоматически для адреса сайта с доменом;
- `/api/*`, `/admin`, `/admin/*`, `/media/*`, `/robots.txt` → Django; загруженные файлы Caddy с диска не читает никогда — чей файл, знает только Django;
- `/static/*` → `/var/lib/checkist/static`; `/assets/*` → собранный SPA с долгим кэшем; любой другой адрес → `index.html` (маршруты клиента);
- на каждом ответе `X-Robots-Tag: noindex, nofollow` и `Strict-Transport-Security: max-age=3600`;
- тело запроса — до 25 МБ (фото до 20 МБ и обёртка multipart);
- журнала доступа нет; `trusted_proxies` нет — Caddy перезаписывает `X-Forwarded-For` и `X-Forwarded-Proto`, присланные клиентом, на это опирается `DJANGO_TRUST_PROXY=1`.

Пользователь службы `caddy` должен читать `/opt/checkist/frontend/dist` и `/var/lib/checkist/static` (права `0755` из раздела 3). Если на сервере уже стоит другой прокси, перенесите в него те же правила; обязательно: прокси перезаписывает `X-Forwarded-Proto` и дописывает адрес клиента последним элементом `X-Forwarded-For`, каталог MEDIA не раздаёт.

После этого сайт открывается по `https://<домен>/`. Дальше — приёмка по [deployment-acceptance.md](deployment-acceptance.md).

## 11. Codex и служба распознавания

Сервер работает и без этой службы: фото принимаются и ждут в очереди, в интерфейсе исполнитель показан отсутствующим. **Служба `checkist-recognition` включается только после успешного `codex login status` под пользователем `checkist`** — иначе воркер завершается на стартовой проверке, а systemd перезапускает его каждые 10 с.

Работа Codex CLI службой на Linux **не проверялась** ни в каком виде: установка, вход без браузера, песочница `read-only` под systemd, обновление токена в `~/.codex`.

1. Установите Codex CLI по его документации так, чтобы исполняемый файл был доступен пользователю `checkist` по абсолютному пути, и запишите путь в `RECEIPT_OCR_CODEX_EXECUTABLE`.
2. Войдите под пользователем службы. Способ входа на машине без браузера — по документации Codex (`codex login --help`); **не проверено**:

   ```bash
   sudo -u checkist -H /usr/local/bin/codex login
   ```

3. Проверьте то же, что проверяет воркер при запуске:

   ```bash
   sudo -u checkist -H /usr/local/bin/codex --version
   sudo -u checkist -H /usr/local/bin/codex exec --help
   sudo -u checkist -H /usr/local/bin/codex login status; echo "exit $?"
   ```

   Ожидается: версия вида `X.Y.Z`; в справке `exec` есть флаги `--ignore-user-config`, `--ignore-rules`, `--ephemeral`, `--skip-git-repo-check`, `--output-schema`, `--json`, `--disable`; `login status` — `exit 0`.

4. Только после этого:

   ```bash
   sudo systemctl enable --now checkist-recognition
   journalctl -u checkist-recognition -e
   ```

   В журнале — `Recognition worker ready.` Сообщения отказа: `Codex authentication is unavailable…` (нет входа), `Codex executable is unavailable…` (неверный путь), `Recognition MEDIA/staging/scratch storage is unavailable.` (права на каталоги), `Recognition worker is already running…` (второй экземпляр).

Каждое распознавание — настоящий модельный запрос под этим входом; лимитов на пользователя нет. Файл входа в `/home/checkist/.codex` — секрет: в резервные копии приложения он не входит, службам web, celery и backup закрыт.

## 12. HSTS: 3600 → 31536000 после приёмки

Браузер запоминает требование HTTPS на весь срок, и отменить его со стороны сервера нельзя. Поэтому сервер стартует с часа. Когда приёмка пройдена и сертификат обновляется сам:

1. в `/etc/checkist/checkist.env`: `DJANGO_HSTS_SECONDS=31536000`;
2. в `/etc/caddy/Caddyfile`: `Strict-Transport-Security "max-age=31536000"` — значения должны совпадать;
3. применить и проверить:

   ```bash
   sudo systemctl restart checkist-web && sudo systemctl reload caddy
   curl -sI https://<домен>/ | grep -i strict-transport-security
   ```

`includeSubDomains` и `preload` не добавлять.

## 13. Обновление версии

```bash
sudo systemctl stop checkist-recognition          # воркер вернёт задание в очередь
sudo systemctl start checkist-backup.service      # копия перед обновлением; дождитесь завершения
systemctl status checkist-backup.service          # ожидается: завершилась с кодом 0
sudo systemctl stop checkist-web
sudo -u checkist -H bash -c 'cd /opt/checkist && git fetch && git checkout <новый коммит или метка>'
sudo -u checkist -H /opt/checkist/backend/.venv/bin/pip install -r /opt/checkist/backend/requirements.txt
ck migrate --noinput
ck collectstatic --noinput
ck check --deploy
sudo -u checkist -H bash -c 'cd /opt/checkist/frontend && npm ci && npm run build'
sudo systemctl start checkist-web
sudo systemctl restart checkist-celery
sudo systemctl start checkist-recognition         # только если служба была включена
```

- Запишите прежний коммит (`git -C /opt/checkist rev-parse HEAD`) до обновления — он нужен для отката.
- Если в новой версии изменились файлы `deploy/` (`git diff --stat <прежний>..<новый> -- deploy/`): заново скопируйте units и выполните `daemon-reload`, перенесите изменения в `/etc/caddy/Caddyfile` (сохранив домен и свой срок HSTS) и `reload caddy`, сверьте `/etc/checkist/checkist.env` с новым образцом.
- Во время остановки web сайт отвечает ошибкой прокси (502) — это ожидаемо; предупредите пользователей либо обновляйте ночью.
- После обновления — проверка `health` из раздела 9 и вход в приложение.

## 14. Резервные копии

Таймер `checkist-backup.timer` раз в сутки запускает `manage.py backup create --dir /var/backups/checkist --keep-days 14`; пропущенный из-за выключенного сервера запуск выполняется после загрузки.

- Копия — каталог `checkist-YYYYMMDDTHHMMSSZ` (время UTC): `db.dump` (`pg_dump -Fc --no-owner`), `media.tar.gz` (все файлы MEDIA; scratch и временные каталоги в неё не входят), `manifest.json` (размеры, sha256, число файлов). Каталог без `manifest.json` копией не считается.
- Завершённые копии старше 14 суток удаляются после успешного запуска; **последняя успешная не удаляется никогда**; сбой запуска прежние копии не трогает.
- Не копируются: `/etc/checkist/checkist.env`, вход Codex, конфигурация Caddy и units. Файл окружения сохраните отдельно в надёжном месте — без `DJANGO_SECRET_KEY` восстановленный сервер сбросит сессии, без пароля базы не запустится.

Проверка работы:

```bash
systemctl list-timers checkist-backup.timer
journalctl -u checkist-backup.service -e
sudo ls /var/backups/checkist
ck backup verify /var/backups/checkist/checkist-<метка времени>
```

Копия вручную — `sudo systemctl start checkist-backup.service`.

**Вывоз с сервера — вручную человеком**, расписания нет: пока копии лежат только на сервере, потеря диска — потеря всего. Раз в неделю (и перед обновлением) забирайте последнюю копию на свою машину, например:

```bash
rsync -a --rsync-path='sudo rsync' <оператор>@<домен>:/var/backups/checkist/checkist-<метка времени> ./
```

Копия содержит чеки и фото всех пользователей — храните её так же, как сам сервер.

## 15. Восстановление

Восстановление никогда не пишет в рабочую базу и рабочий MEDIA: оно создаёт новые, а сервер переключается на них правкой окружения. Так прежнее состояние остаётся на месте, пока новое не проверено.

```bash
sudo systemctl stop checkist-recognition checkist-web checkist-celery
sudo install -d -o checkist -g checkist -m 0700 /var/lib/checkist/media-r2
ck backup restore /var/backups/checkist/checkist-<метка времени> --database checkist_r2 --media-root /var/lib/checkist/media-r2
```

Затем в `/etc/checkist/checkist.env` — `POSTGRES_DB=checkist_r2`, `MEDIA_ROOT=/var/lib/checkist/media-r2`, и:

```bash
ck migrate --noinput        # если код новее копии
sudo systemctl start checkist-web checkist-celery checkist-recognition
```

- Имена базы и каталога — новые при каждом восстановлении; каталог MEDIA — внутри `/var/lib/checkist`.
- Сбой посреди восстановления оставляет неполную новую базу: сообщение об ошибке называет её; удалите (`sudo -u postgres dropdb checkist_r2`), очистите новый каталог и повторите.
- Прежние базу и каталог MEDIA удаляйте только после проверки восстановленного состояния (`sudo -u postgres dropdb <прежняя>`, `sudo rm -r <прежний каталог>`).
- На новом сервере сначала выполняются разделы 1–5 и создание роли из раздела 6, затем эти шаги; файл окружения — из сохранённого отдельно.

## 16. Откат

**Сначала — что возвращать.** После того как на сервере появились несколько пользователей, откат схемы — не штатная операция: он означает возврат к резервной копии.

### Откат кода без изменения схемы

Если между версиями нет новых миграций (`git diff --stat <прежний>..<новый> -- 'backend/*/migrations/'` пуст): шаги [раздела 13](#13-обновление-версии) с прежним коммитом, без `migrate`.

### Откат версии с миграциями

Надёжный путь — копия, снятая перед обновлением: верните прежний коммит и восстановите копию по [разделу 15](#15-восстановление). Данные, появившиеся после копии, будут потеряны.

Обратные миграции — только когда потеря данных недопустима, и каждая со своей проверкой: перед `migrate merges zero` — `ck product_merges cancel-pending`, перед `migrate classification zero` — `ck product_classifications cancel-pending` ([data-model.md](data-model.md)).

### Откат разделения пользователей

Версия кода до разделения пользователей не имеет входа: все её API открыты анонимно. **На публичный сервер её возвращать нельзя** — сначала закройте сайт (остановите Caddy либо закройте 80/443). Сам откат схемы возвращает глобальную уникальность чеков и фото и стирает сведения о владельце — все чеки снова общие.

Он проходит, только пока ни у каких двух владельцев нет одинакового чека или фото. Это проверяет команда (только читает):

```bash
ck ownership check-rollback; echo "exit $?"
```

- `exit 0` и `"conflicts": 0` — откат возможен;
- `exit 1` — в `groups` перечислены строки (`rule`, `model`, `constraint`, `rows` с `id` и `owner_id`), которые отвергнут прежние ограничения; откат упадёт целиком. При нескольких пользователях это ожидаемое состояние, а не ошибка: возвращайтесь к копии, снятой до появления второго владельца, либо не откатывайте схему.

При `exit 0`, остановив службы и сняв копию:

```bash
sudo systemctl stop checkist-recognition checkist-web checkist-celery
sudo systemctl start checkist-backup.service
ck ownership check-rollback
ck migrate recognition 0001_initial
ck migrate receipts 0002_alter_receipttax_options
```

Остальные миграции разделения пользователей данных о чеках не касаются: `merges 0002_actor_fields` и `classification 0002_actor_fields` (поля «кто решил»), `catalog 0002_alter_product_options` (объявление права), `accounts 0001_initial` (счётчики неудачных входов). Их обратный ход — `ck migrate merges 0001_initial`, `ck migrate classification 0001_initial`, `ck migrate catalog 0001_initial`, `ck migrate accounts zero`; **не проверено**. Пользователь `local` и остальные учётные записи после отката остаются. Команды выполняются кодом текущей версии — до возврата прежнего коммита.

## 17. Вариант: разворачивает ИИ по SSH

Решение проекта по умолчанию — разворачивает человек по этой инструкции. Если человек выдаёт доступ исполнителю-ИИ, тот выполняет **те же шаги в том же порядке** — отдельного пути нет.

- Доступ: отдельная учётная запись ОС с `sudo` и вход по ключу SSH, выданному на время работы и отозванному после; пароль и ключ не попадают в репозиторий, в переписку задач и в журналы.
- Остаются человеку и ИИ не передаются: вход Codex (`codex login` — личный вход человека, раздел 11, шаг 2), пароли суперпользователя, `local` и друзей (`createsuperuser`, `changepassword` — интерактивно, раздел 8), запись DNS, оплата сервера, хранение вывезенных копий.
- Секреты (`DJANGO_SECRET_KEY`, `POSTGRES_PASSWORD`) создаются на сервере и записываются сразу в `/etc/checkist/checkist.env`; в отчёт идут только имена переменных, не значения.
- Перед разрушающими действиями (`dropdb`, `rm -r`, обратные миграции, правка firewall, от которой зависит сам SSH) — подтверждение человека на каждое.
- Отчёт — по каждому шагу: команда, exit-код, наблюдаемый результат; три группы «прошло / не прошло / не проверено». Расхождение инструкции с действительностью исправляется в этом документе отдельной задачей, а не молча на сервере.
- Автоматический обход интерфейса в браузере запрещён правилами проекта: пункты приёмки, требующие браузера, телефона и второго устройства, выполняет человек.

## 18. Что не настроено

- Мониторинг и оповещения: о падении службы и о неудачной копии никто не сообщит — смотрите `systemctl --failed` и журнал копий.
- Автоматическая выкладка, несколько серверов, CDN.
- Автоматический вывоз копий и их шифрование.
- Ротация журналов сверх настроек journald; срок хранения выбирает оператор.
- Лимиты на загрузки и модельные запросы по пользователям.
- Раздельные пользователи ОС для web и воркера: сейчас вход Codex закрыт от web-процесса только ограничением `InaccessiblePaths` в unit.
- Обновления ОС, PostgreSQL, Redis, Caddy и Codex CLI — забота оператора.
