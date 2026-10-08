# Развёртывание в Docker

**Статус (2026-10-08): инструкция составлена чтением файлов деплоя. Стек целиком ни разу не поднимался — ни локально, ни на сервере.** Образы собраны, конфигурации проверены статически; запуск контейнеров, `deploy.sh` целиком, миграции и копии проверяет QA, а сертификат, адрес клиента и Codex проверяются только на настоящем сервере. Что именно прошло и что нет — [в последнем разделе](#13-что-проверено-а-что-нет). Первое развёртывание — одновременно первая проверка этой инструкции.

Это основной путь развёртывания. Вариант без Docker (systemd) — запасной, [deployment.md](deployment.md). Приёмка сервера после развёртывания — [deployment-acceptance.md](deployment-acceptance.md).

Источник истины — файлы: `Dockerfile`, `compose.prod.yaml`, `deploy/docker/Caddyfile`, `deploy/docker/checkist.env.example`, `deploy/docker/ck`, `deploy/docker/deploy.sh`. При расхождении с этим текстом правы они.

Во всех командах `<домен>`, `<адрес репозитория>`, `<метка>` и подобное — заполнители. Команды выполняются на сервере из каталога `/opt/checkist`, если не сказано иное.

## Оглавление

1. [Что куда ставится](#1-что-куда-ставится)
2. [Требования к серверу](#2-требования-к-серверу)
3. [Первое развёртывание](#3-первое-развёртывание)
4. [Обновление одной командой](#4-обновление-одной-командой)
5. [Откат](#5-откат)
6. [Резервные копии](#6-резервные-копии)
7. [Восстановление из копии](#7-восстановление-из-копии)
8. [Повседневные команды](#8-повседневные-команды)
9. [Распознавание: Codex в контейнере](#9-распознавание-codex-в-контейнере)
10. [Тома и чего нельзя делать](#10-тома-и-чего-нельзя-делать)
11. [HSTS: 3600 → 31536000 после приёмки](#11-hsts-3600--31536000-после-приёмки)
12. [Что не настроено](#12-что-не-настроено)
13. [Что проверено, а что нет](#13-что-проверено-а-что-нет)

## 1. Что куда ставится

**Всё — в Docker Compose. На сам сервер ставятся только Docker и git.**

| Вопрос | Ответ | Почему |
| --- | --- | --- |
| nginx | не нужен | его работу делает Caddy; nginx потребовал бы certbot и второй файл конфигурации |
| Caddy | в контейнере `proxy` | сам получает и продлевает сертификат; обновляется той же командой, что и приложение |
| gunicorn | в контейнере `web` | порт 8000 наружу не опубликован, к нему ходит только `proxy` по внутренней сети |
| Фронтенд, Node.js | собирается стадией образа (`node:24`), **на сервер Node не ставится** | собранный SPA и статика админки лежат внутри образа `proxy`: версия статики всегда равна версии кода |
| PostgreSQL, Redis | в Compose, данные в именованных томах | порты наружу не опубликованы |
| Celery | один worker в контейнере `celery` | нужен только проверке `celery` в `/api/health/`; расписаний и распознавания в нём нет |
| Распознавание с Codex | контейнер `recognition`, отдельный профиль Compose, **по умолчанию выключен** | включает человек после входа Codex; без него сайт работает, фото ждут в очереди |

```text
интернет ── 80/443 ──► proxy   Caddy: HTTPS, собранный SPA, статика админки
                         └─ /api  /admin  /media  /robots.txt ──► web   gunicorn :8000
                                                                   ├─ postgres   том postgres_data
                                                                   ├─ redis      том redis_data
                                                                   └─ том data → /var/lib/checkist (фото)
celery        тот же образ, что web; только для health
recognition   тот же образ + Codex CLI; профиль recognition, по умолчанию выключен
```

| Сервис | Образ | Что делает |
| --- | --- | --- |
| `postgres` | `postgres:17.11-alpine` | база |
| `redis` | `redis:7.4.11-alpine` | брокер Celery и кэш; данных приложения нет |
| `web` | `checkist-app` (собирается) | Django под gunicorn |
| `celery` | `checkist-app` | worker для проверки health |
| `proxy` | `checkist-proxy` (собирается) | Caddy + SPA + статика; единственный сервис с опубликованными портами |
| `recognition` | `checkist-recognition` (собирается) | `manage.py recognition_worker` рядом с Codex CLI 0.162.0 |

Загруженные фото отдаёт только Django: он знает, чей это файл. В контейнере `proxy` тома с фото нет вообще.

Две особенности образов, которые не видны из схемы:

- сборка фронтенда берёт в образ JSON из `backend/api/tests/fixtures/stats/`: их импортируют страницы `frontend/src/features/stats/*-preview/demo.tsx`, а `tsc -b` проверяет весь `src/`. Без них сборка падает;
- клиент PostgreSQL 17 (`pg_dump`, `pg_restore`, `createdb`, `psql` — нужны команде копий) ставится из Debian trixie, отдельный репозиторий PostgreSQL не подключается.

## 2. Требования к серверу

| Что | Требование | Почему |
| --- | --- | --- |
| ОС | Linux x86-64 либо arm64 с Docker Engine и плагином Compose; команды ниже — для Debian / Ubuntu | в `Dockerfile` закреплены сборки Codex для amd64 и arm64 |
| Память | от 2 ГБ, либо 1 ГБ + файл подкачки 2 ГБ | **образы собираются на самом сервере**: проверка типов и сборка фронтенда на 1 ГБ могут не пройти |
| Диск | с запасом: образы и кэш сборки, фото до 20 МБ каждое, копии базы и всех фото за 14 суток | копии лежат на том же диске, пока их не вывезли |
| Домен | запись `A` на адрес сервера, **без записи `AAAA`** | см. ниже |
| Порты | наружу открыты только 22, 80, 443 | 80 и 443 нужны Caddy и для получения сертификата |

**Почему без `AAAA`.** Защита от перебора пароля считает неудачи по адресу клиента, который Caddy передаёт в Django. По IPv4 Docker сохраняет настоящий адрес клиента. По IPv6 при обычной сети Compose запрос проходит через `docker-proxy`, и все клиенты получают один адрес шлюза: пять чужих ошибок закроют вход всем. Это ожидание по устройству Docker, на сервере **не проверено** — проверяется шагом приёмки про «Login failures» ([deployment-acceptance.md](deployment-acceptance.md#м-docker-вариант)).

**Без домена развернуть нельзя.** Вход требует HTTPS: `DJANGO_TRUST_PROXY=1` включает и перенаправление на https, и подсчёт адресов клиентов, по отдельности они не включаются.

**Docker и firewall.** Docker публикует порты напрямую в iptables, **в обход `ufw`**: правило `ufw deny` опубликованный порт не закроет. Поэтому в `compose.prod.yaml` порты публикует только `proxy`, и только 80 и 443. `ufw` защищает остальное (SSH и то, что вы поставите на сервер помимо Checkist).

## 3. Первое развёртывание

Шаги выполняются по порядку под обычным пользователем с `sudo`. Перед началом запись `A` уже должна указывать на сервер: Caddy запросит сертификат при первом запуске.

### Шаг 1. Firewall

```bash
sudo apt-get update
sudo apt-get install -y ufw git
sudo ufw default deny incoming
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
```

Убедитесь, что SSH-сессия не оборвалась, прежде чем закрывать терминал.

### Шаг 2. Файл подкачки (только если памяти меньше 2 ГБ)

```bash
sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

### Шаг 3. Docker

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker "$USER"
```

Выйдите из SSH и войдите снова — членство в группе применяется при входе. Проверка:

```bash
docker compose version
docker run --rm hello-world
```

Группа `docker` равна правам root на этом сервере: не добавляйте в неё посторонних. Скрипты ниже вызывают `docker` и `git` без `sudo`, поэтому репозиторий принадлежит тому же пользователю.

### Шаг 4. Код

```bash
sudo install -d -o "$USER" -g "$USER" /opt/checkist
git clone <адрес репозитория> /opt/checkist
cd /opt/checkist
```

Если репозиторий закрытый, серверу нужен доступ на чтение (например, deploy key только для чтения). Остаётся ветка по умолчанию: обновление делает `git pull` в ней.

### Шаг 5. Каталог копий

```bash
sudo install -d -o 10001 -g 10001 -m 0700 /var/backups/checkist
```

Приложение в контейнерах работает под пользователем с UID 10001. Каталог нужно создать **до первого запуска**: иначе Docker создаст его сам с владельцем root, и копии не запишутся.

### Шаг 6. Окружение `.env.prod`

```bash
cp deploy/docker/checkist.env.example .env.prod
chmod 600 .env.prod
sed -i 's/checkist\.example/<домен>/' .env.prod
sed -i "s/^DJANGO_SECRET_KEY=$/DJANGO_SECRET_KEY=$(openssl rand -hex 32)/" .env.prod
sed -i "s/^POSTGRES_PASSWORD=$/POSTGRES_PASSWORD=$(openssl rand -hex 32)/" .env.prod
```

Проверьте результат:

```bash
grep -nE '^(CHECKIST_SITE_ADDRESS|DJANGO_ALLOWED_HOSTS|DJANGO_CSRF_TRUSTED_ORIGINS)=' .env.prod
grep -cE '^(DJANGO_SECRET_KEY|POSTGRES_PASSWORD)=.{64}$' .env.prod
```

Ожидается: три строки с вашим доменом (в третьей — `https://<домен>`) и число `2`.

Обязательно заполнить — пять переменных, их заполнили команды выше:

| Переменная | Значение | Что будет, если не заполнить |
| --- | --- | --- |
| `CHECKIST_SITE_ADDRESS` | `<домен>` | Caddy не получит сертификат |
| `DJANGO_ALLOWED_HOSTS` | `<домен>` | Django ответит `400` на любой запрос |
| `DJANGO_CSRF_TRUSTED_ORIGINS` | `https://<домен>` | вход и любая запись отказывают |
| `DJANGO_SECRET_KEY` | `openssl rand -hex 32` | пустое значение — ничего не запускается |
| `POSTGRES_PASSWORD` | `openssl rand -hex 32` | пустое значение — любая команда Compose отказывает с именем переменной |

Правила файла:

- формат `ИМЯ=значение`, без кавычек, пробелов и `export`; в значениях только буквы, цифры и `_-./:,` — знак `$` и кавычки Compose прочитает по-своему;
- `.env.prod` в git не попадает (`.gitignore`) и в образы не попадает (`.dockerignore`). Сохраните его копию вне сервера: без `DJANGO_SECRET_KEY` восстановленный сервер сбросит все сессии, без пароля базы не запустится;
- **`POSTGRES_PASSWORD` действует только при первом создании тома базы.** Позже менять его в файле нельзя: база останется со старым паролем, и приложение к ней не подключится;
- остальные значения образца менять без причины не нужно. `RECEIPT_OCR_PROVIDER=fake` на сервере не ставить: он создаёт вымышленные чеки.

Необязательные строки (в образце закомментированы):

| Переменная | По умолчанию | Когда менять |
| --- | --- | --- |
| `CHECKIST_HTTP_BIND`, `CHECKIST_HTTPS_BIND` | `80`, `443` | только для локальной проверки, например `127.0.0.1:18080` |
| `CHECKIST_BACKUP_DIR` | `/var/backups/checkist` | другой каталог копий на сервере (владелец UID 10001, `0700`) |
| `COMPOSE_PROFILES` | нет | `recognition` — [раздел 9](#9-распознавание-codex-в-контейнере) |
| `COMPOSE_PROJECT_NAME` | `checkist` | **на сервере не менять**: имя — приставка томов, другое имя означает другой, пустой набор томов. QA задаёт своё имя именно этой переменной, а не флагом `-p`: скрипты вызывают `docker compose` сами |

Путь к файлу окружения можно сменить переменной оболочки `CHECKIST_ENV_FILE` (абсолютный либо от корня репозитория); на сервере это не нужно.

### Шаг 7 (необязательный). Перенос данных из dev

Пропустите шаг, если сервер начинается с пустой базы.

**Дома** (Windows, dev-окружение, PowerShell из корня репозитория). Остановите `recognition_worker` и загрузки, затем:

```powershell
$env:CHECKIST_PG_TOOLS_PREFIX='docker compose -p checkist_dev exec -T postgres'
./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py backup create --dir C:/checkist-copies
./backend/.venv/Scripts/python.exe -X utf8 backend/manage.py backup verify C:/checkist-copies/checkist-<метка>
scp -r C:/checkist-copies/checkist-<метка> <пользователь>@<домен>:
```

Копия — каталог `checkist-YYYYMMDDTHHMMSSZ` с `db.dump`, `media.tar.gz` и `manifest.json`.

**На сервере:**

```bash
sudo mv ~/checkist-<метка> /var/backups/checkist/
sudo chown -R 10001:10001 /var/backups/checkist/checkist-<метка>
cd /opt/checkist
./deploy/docker/ck manage backup verify /backups/checkist-<метка>
./deploy/docker/ck manage backup restore /backups/checkist-<метка> --database checkist_r1 --media-root /var/lib/checkist/media-r1
```

- Первая команда `ck manage` сама соберёт образ приложения (несколько минут) и запустит `postgres` и `redis`.
- Пути `/backups/…` и `/var/lib/checkist/…` — пути **внутри контейнера**: `/backups` — это `/var/backups/checkist` сервера, `/var/lib/checkist` — том `data`.
- `restore` отвечает JSON с `database`, `media_root`, `media_files`. Команда всегда создаёт **новую** базу и **новый** каталог и отказывает, если база с таким именем уже есть, каталог непуст либо имя совпадает с рабочим.

Переключите окружение на восстановленное:

```bash
sed -i -e 's/^POSTGRES_DB=.*/POSTGRES_DB=checkist_r1/' -e 's|^MEDIA_ROOT=.*|MEDIA_ROOT=/var/lib/checkist/media-r1|' .env.prod
```

Каталог фото обязан остаться внутри `/var/lib/checkist`: это том `data`, рядом с фото код создаёт временные каталоги и переносит файлы переименованием. Все перенесённые чеки и фото принадлежат пользователю `local`.

### Шаг 8. Запуск

```bash
./deploy/docker/deploy.sh --no-pull
```

Скрипт собирает образы (первый раз — несколько минут), применяет миграции, выполняет `check --deploy`, запускает сервисы, ждёт их готовности и спрашивает `/api/health/`. В конце печатает `deploy: done, version <коммит>` и таблицу сервисов. Копия на первом запуске пропускается: контейнера `web` ещё нет.

Проверка снаружи:

```bash
curl -s https://<домен>/api/health/
```

Ожидается `"status": "ok"` и три проверки `ok`. Сертификат Caddy получает в первые секунды после запуска; если ответа по HTTPS нет — `./deploy/docker/ck compose logs proxy` (обычные причины: запись `A` ещё не действует, закрыт порт 80 либо 443).

### Шаг 9. Первый пользователь

Открытой регистрации нет: учётные записи заводит оператор.

```bash
./deploy/docker/ck manage createsuperuser
```

Логин и пароль вводятся в терминале. Это оператор сервера: он входит в `https://<домен>/admin/` и в само приложение одной сессией и видит чеки всех пользователей в админке.

Если переносились данные (шаг 7), задайте пароль их владельцу — иначе под ним не войти:

```bash
./deploy/docker/ck manage changepassword local
```

Остальных пользователей оператор заводит в `https://<домен>/admin/` → «Пользователи» → «Добавить». Флаги «Статус персонала» и «Статус суперпользователя» не ставить: они открывают чеки всех. Право модератора общего каталога (`catalog.moderate_catalog`) выдаётся в карточке пользователя. Что сказать каждому при выдаче учётной записи и как выключить пользователя — [deployment.md, раздел 8](deployment.md#8-первичная-установка-учётные-записи), пункты 4–7: в Docker-варианте они те же, только вместо `ck <команда>` — `./deploy/docker/ck manage <команда>`.

### Шаг 10. Ежедневная копия и приёмка

1. Добавьте строку cron — [раздел 6](#6-резервные-копии).
2. Пройдите приёмку — [deployment-acceptance.md](deployment-acceptance.md), в том числе раздел «М. Docker-вариант».
3. После приёмки поднимите HSTS — [раздел 11](#11-hsts-3600--31536000-после-приёмки).
4. Распознавание, если оно нужно, — [раздел 9](#9-распознавание-codex-в-контейнере).

## 4. Обновление одной командой

```bash
cd /opt/checkist && ./deploy/docker/deploy.sh
```

Что делает скрипт. Любой неудавшийся шаг останавливает его, следующие не выполняются:

| № | Шаг | Сайт |
| --- | --- | --- |
| 1 | `git pull --ff-only`; если появились новые коммиты, прежний записывается в `.deploy-previous`; затем скрипт перезапускает сам себя уже новой версии | работает |
| 2 | проверка конфигурации: `docker compose config` | работает |
| 3 | сборка образов: `docker compose build` | работает на прежних контейнерах |
| 4 | остановка `recognition`, если он запущен (сигнал `SIGINT` — воркер возвращает задание в очередь) | работает |
| 5 | копия базы и фото: `backup create --dir /backups --keep-days 14` в работающем `web` | работает |
| 6 | остановка `web` и `celery` | **простой начался** |
| 7 | `manage.py migrate --noinput` | простой |
| 8 | `manage.py check --deploy` | простой |
| 9 | `docker compose up -d --wait --wait-timeout 300 --remove-orphans` — запуск и ожидание готовности всех сервисов | **простой закончился** |
| 10 | запрос `/api/health/` изнутри `web`, до минуты | работает |
| 11 | `docker image prune -f` — удаление образов без имени | работает |

- **Простой** — шаги 6–9. По расчёту это 10–30 секунд, **не измерено**. В это время Caddy отвечает `502`. Без простоя не сделано намеренно: прежний код не должен работать на новой схеме базы.
- **Сборка идёт до остановки**: если она упала (например, не хватило памяти), сайт продолжает работать на прежней версии, скрипт пишет `the running containers were not touched`.
- **Если упал шаг после остановки** — сайт лежит, скрипт печатает, что делать: исправить причину и выполнить `./deploy/docker/deploy.sh --no-pull` либо вернуться к прежнему коммиту ([раздел 5](#5-откат)).
- **Миграции** применяются всегда; когда новых нет, шаг ничего не меняет. Каждая миграция — одна транзакция, с ограничением 2 секунды на запрос.
- **Копия не снимается, если `web` существует, но остановлен:** скрипт останавливается и просит запустить его (`./deploy/docker/ck compose up -d --wait web`) либо повторить с `--no-backup`. Так обновление не пройдёт молча без копии.
- Шаг 11 удаляет образы без имени **всего сервера**, не только Checkist. Если на сервере есть другие проекты в Docker, учтите это.

Флаги:

| Флаг | Что делает |
| --- | --- |
| без флагов | обновление: `git pull` и все шаги |
| `--no-pull` | те же шаги для уже полученного кода: первый запуск, повтор после сбоя, применение правок `.env.prod` |
| `--ref <коммит>` | вместо `git pull` переключиться на указанный коммит (откат) |
| `--no-backup` | пропустить копию перед миграциями |

Если в новой версии изменился образец окружения (`git diff "$(cat .deploy-previous)" HEAD -- deploy/docker/checkist.env.example`), перенесите новые строки в `.env.prod` и выполните `./deploy/docker/deploy.sh --no-pull`.

## 5. Откат

### Без миграций

Если между версиями нет новых миграций — проверка (вывод пуст):

```bash
git diff --stat "$(cat .deploy-previous)" HEAD -- 'backend/*/migrations/'
```

— достаточно вернуть прежний коммит:

```bash
./deploy/docker/deploy.sh --ref "$(cat .deploy-previous)"
```

Скрипт переключает код, пересобирает образы и проходит те же шаги, что обновление.

После отката:

- **`HEAD` отсоединён** от ветки. Обычное обновление в этом состоянии откажет с `HEAD is detached`. Когда исправление появилось в репозитории, вернитесь на ветку и обновитесь:

  ```bash
  git switch - && ./deploy/docker/deploy.sh
  ```

  (`git switch -` возвращает на ветку, с которой ушёл откат; то же самое — `git switch <ветка>`.) Не переключайтесь на ветку раньше: до обновления код на диске должен совпадать с работающими образами.
- `.deploy-previous` теперь хранит коммит, с которого откатились, а не прежний.

### С миграциями

Если новая версия уже применила миграции, прежний код на новой схеме работать не должен. Надёжный путь — копия, которую скрипт снял на шаге 5 перед обновлением. **Данные, появившиеся после копии, будут потеряны.**

```bash
sudo ls /var/backups/checkist                      # найти копию, снятую перед обновлением
./deploy/docker/ck compose --profile recognition stop recognition web celery
./deploy/docker/ck manage backup restore /backups/checkist-<метка> --database checkist_r2 --media-root /var/lib/checkist/media-r2
sed -i -e 's/^POSTGRES_DB=.*/POSTGRES_DB=checkist_r2/' -e 's|^MEDIA_ROOT=.*|MEDIA_ROOT=/var/lib/checkist/media-r2|' .env.prod
./deploy/docker/deploy.sh --ref "$(cat .deploy-previous)" --no-backup
```

- Имена базы и каталога — новые при каждом восстановлении (`checkist_r2`, `media-r2`, затем `_r3` …).
- `--no-backup` здесь обязателен: `web` остановлен, и без флага скрипт откажется продолжать.
- Прежние база и каталог фото остаются на месте, пока вы их не удалите ([раздел 7](#7-восстановление-из-копии)).

Обратные миграции (`migrate <приложение> <номер>`) — только когда потеря данных после копии недопустима, и у каждой свои обязательные проверки. Правила — в [deployment.md, раздел 16](deployment.md#16-откат): перед `migrate merges zero` — `product_merges cancel-pending`, перед `migrate classification zero` — `product_classifications cancel-pending`, перед откатом разделения пользователей — `ownership check-rollback`. В Docker-варианте эти команды выполняются так:

```bash
./deploy/docker/ck manage ownership check-rollback; echo "exit $?"
./deploy/docker/ck manage product_merges cancel-pending
./deploy/docker/ck manage product_classifications cancel-pending
```

Версию кода до разделения пользователей на публичный сервер возвращать нельзя: у неё нет входа.

## 6. Резервные копии

**Что и куда.** Копия — каталог `checkist-YYYYMMDDTHHMMSSZ` (время UTC) в `/var/backups/checkist` на сервере (в контейнере `web` он виден как `/backups`):

- `db.dump` — база (`pg_dump -Fc --no-owner`);
- `media.tar.gz` — все загруженные фото и вырезки;
- `manifest.json` — размеры, sha256, число файлов. Каталог без него копией не считается.

Копии старше 14 суток удаляются после каждого успешного запуска; последняя успешная не удаляется никогда; сбой запуска прежние копии не трогает.

**Не копируются:** `.env.prod`, вход Codex (том `codex_home`), сертификаты Caddy (том `caddy_data` — Caddy получит их заново). `.env.prod` сохраните отдельно.

**Когда снимается.** Перед каждым обновлением — сама (`deploy.sh`). Ежедневно — строкой cron того пользователя, под которым вы работаете на сервере:

```bash
crontab -e
```

```cron
17 3 * * * /opt/checkist/deploy/docker/ck manage backup create --dir /backups --keep-days 14 >> "$HOME/checkist-backup.log" 2>&1
```

Время — по часам сервера. Мониторинга нет: о неудачной копии никто не сообщит, заглядывайте в `~/checkist-backup.log`.

**Копия вручную и проверка:**

```bash
./deploy/docker/ck manage backup create --dir /backups --keep-days 14
sudo ls /var/backups/checkist
./deploy/docker/ck manage backup verify /backups/checkist-<метка>
```

`verify` — exit 0 и JSON с `manifest`: размеры и sha256 сошлись, архив фото читается целиком.

**Вывоз с сервера — вручную, расписания нет.** Пока копии лежат только на сервере, потеря диска — потеря всего. Раз в неделю и перед обновлением забирайте последнюю копию на свою машину:

```bash
rsync -a --rsync-path='sudo rsync' <пользователь>@<домен>:/var/backups/checkist/checkist-<метка> ./
```

Копия содержит чеки и фото всех пользователей — храните её так же бережно, как сам сервер.

## 7. Восстановление из копии

Восстановление никогда не пишет в рабочую базу и рабочий каталог фото: оно создаёт новые, а сервер переключается на них правкой `.env.prod`. Прежнее состояние остаётся на месте, пока новое не проверено.

```bash
./deploy/docker/ck compose --profile recognition stop recognition web celery
./deploy/docker/ck manage backup restore /backups/checkist-<метка> --database checkist_r2 --media-root /var/lib/checkist/media-r2
sed -i -e 's/^POSTGRES_DB=.*/POSTGRES_DB=checkist_r2/' -e 's|^MEDIA_ROOT=.*|MEDIA_ROOT=/var/lib/checkist/media-r2|' .env.prod
./deploy/docker/deploy.sh --no-pull --no-backup
```

- `deploy.sh` применит миграции (если код новее копии) и запустит сервисы на восстановленных данных.
- Сбой посреди восстановления оставляет неполную новую базу, сообщение называет её. Удалите её и новый каталог командами ниже и повторите.
- Прежние базу и каталог удаляйте только после проверки восстановленного состояния. Имена — те, что стояли в `.env.prod` до правки:

  ```bash
  ./deploy/docker/ck compose exec postgres sh -c 'dropdb -U "$POSTGRES_USER" <прежняя база>'
  ./deploy/docker/ck compose exec web rm -r /var/lib/checkist/<прежний каталог фото>
  ```

  Обе команды необратимы — проверьте имена дважды.
- **На новом сервере:** шаги 1–6 первого развёртывания (с сохранённым `.env.prod` вместо нового; в нём верните `POSTGRES_DB=checkist` и `MEDIA_ROOT=/var/lib/checkist/media`), копию положите в `/var/backups/checkist/`, дальше — шаги 7–8.

## 8. Повседневные команды

`deploy/docker/ck` — обёртка, которая сама подставляет `compose.prod.yaml` и `.env.prod`. Её можно вызывать из любого каталога.

- `ck compose …` — это `docker compose -f compose.prod.yaml --env-file .env.prod …`;
- `ck manage …` — `python manage.py …` в одноразовом контейнере `web`; работает и без терминала (cron).

| Задача | Команда |
| --- | --- |
| Состояние сервисов | `./deploy/docker/ck compose ps` |
| Журнал сервиса, с продолжением | `./deploy/docker/ck compose logs -f web` (так же `proxy`, `celery`, `postgres`, `redis`, `recognition`) |
| Последние 200 строк | `./deploy/docker/ck compose logs --tail 200 web` |
| Перезапуск сервиса | `./deploy/docker/ck compose restart web` |
| Применить правку `.env.prod` | `./deploy/docker/deploy.sh --no-pull` |
| Команда Django | `./deploy/docker/ck manage <команда>` |
| Проверка настроек | `./deploy/docker/ck manage check --deploy` |
| Сброс пароля пользователя | `./deploy/docker/ck manage changepassword <логин>` |
| Остановить всё (тома остаются) | `./deploy/docker/ck compose --profile recognition stop` |
| Запустить снова | `./deploy/docker/ck compose up -d --wait` |
| Health изнутри, мимо Caddy | см. ниже |

```bash
./deploy/docker/ck compose exec web python -c "import os,urllib.request as u; r=u.Request('http://127.0.0.1:8000/api/health/', headers={'Host': os.environ['DJANGO_ALLOWED_HOSTS'].split(',')[0], 'X-Forwarded-Proto': 'https'}); print(u.urlopen(r, timeout=10).read().decode())"
```

Замечания:

- Журналы хранятся ограниченно: по 10 МБ в 5 файлах на сервис. Журнала доступа нет ни у Caddy, ни у gunicorn — в адресах запросов id чеков и товаров.
- `restart` перезапускает контейнер с прежними настройками. Правку `.env.prod` он **не** применяет — для этого `deploy.sh --no-pull`.
- `check --deploy` — exit 0 и ровно два предупреждения, оба намеренные: `security.W005` и `security.W021` (HSTS без `includeSubDomains` и `preload`). Любое другое — ошибка окружения.
- После перезагрузки сервера сервисы поднимаются сами (`restart: unless-stopped`), кроме остановленных вручную командой `stop`.
- Неверное значение переменной — отказ запуска с её именем: `ImproperlyConfigured: ИМЯ: …` в журнале `web`.

## 9. Распознавание: Codex в контейнере

Без этого раздела сайт работает: фото принимаются и ждут в очереди, в интерфейсе исполнитель показан отсутствующим.

**Каждое распознавание и каждое предположение категорий — настоящий модельный запрос под вашим входом Codex.** Лимитов на пользователя нет: всё, что загрузят пользователи, уходит провайдеру модели под одной учётной записью.

**Работа Codex CLI в контейнере не проверялась никак:** ни вход без браузера, ни его песочница внутри Docker, ни обновление токена со временем. Сбой здесь не затрагивает сайт — только распознавание.

1. Войдите. Вход хранится в томе `codex_home`, который смонтирован только в `recognition`:

   ```bash
   ./deploy/docker/ck compose run --rm recognition codex login --help
   ./deploy/docker/ck compose run --rm recognition codex login
   ```

   Первая команда соберёт образ `checkist-recognition`. На сервере нет браузера: способ входа без него выберите по справке первой команды. Запасной путь — войти в Codex на своей машине и переложить свой файл `auth.json` в том (выполняется на сервере, файл предварительно скопирован в текущий каталог):

   ```bash
   ./deploy/docker/ck compose run --rm -T recognition sh -c 'umask 077 && cat > /home/checkist/.codex/auth.json' < auth.json
   rm auth.json
   ```

2. Проверьте то же, что проверяет воркер при запуске:

   ```bash
   ./deploy/docker/ck compose run --rm recognition codex login status; echo "exit $?"
   ```

   Ожидается `exit 0`. **Дальше — только после этого**: без входа воркер завершается на стартовой проверке, а Docker перезапускает его по кругу.

3. Включите профиль и примените:

   ```bash
   sed -i 's/^# COMPOSE_PROFILES=recognition$/COMPOSE_PROFILES=recognition/' .env.prod
   ./deploy/docker/deploy.sh --no-pull
   ./deploy/docker/ck compose logs recognition
   ```

   В журнале — `Recognition worker ready.` Сообщения отказа: `Codex authentication is unavailable…` (нет входа), `Codex executable is unavailable…` (неверный путь), `Recognition MEDIA/staging/scratch storage is unavailable.` (права на тома), `Recognition worker is already running…` (второй экземпляр).

Выключить: закомментировать строку `COMPOSE_PROFILES=recognition` в `.env.prod`, затем `./deploy/docker/ck compose --profile recognition stop recognition`.

Файл входа — секрет уровня пароля. В копии он не входит; контейнеры `web`, `celery` и `proxy` его не видят.

Версия Codex CLI закреплена в `Dockerfile` (`CODEX_VERSION` и две контрольные суммы); сменить её — правка трёх значений вместе и обычное обновление.

## 10. Тома и чего нельзя делать

Все данные живут в именованных томах проекта `checkist` и в каталоге копий:

| Том | Где смонтирован | Что в нём | Потеря |
| --- | --- | --- | --- |
| `checkist_postgres_data` | `postgres` | база: чеки, каталог, пользователи | всё, кроме фото |
| `checkist_data` | `web`, `recognition` → `/var/lib/checkist` | загруженные фото и вырезки | все фото |
| `checkist_redis_data` | `redis` | очередь Celery и кэш | ничего ценного |
| `checkist_ocr_scratch` | `recognition` | временные файлы попыток модели | ничего ценного |
| `checkist_codex_home` | `recognition` | вход Codex | войти заново |
| `checkist_caddy_data`, `checkist_caddy_config` | `proxy` | сертификаты | Caddy получит заново; у центра сертификации есть лимит выдач в неделю |
| `/var/backups/checkist` (каталог сервера) | `web` → `/backups` | копии | все копии |

**Нельзя:**

- `docker compose down -v`, `docker volume rm`, `docker volume prune`, `docker system prune --volumes` — удаляют базу и фото безвозвратно. Скрипты `ck` и `deploy.sh` ни одной такой команды не вызывают;
- менять `COMPOSE_PROJECT_NAME` на сервере и переименовывать проект: сервисы поднимутся на новых пустых томах, как будто данных нет (прежние тома при этом целы);
- менять `POSTGRES_PASSWORD` после первого запуска;
- вызывать `docker compose` без `ck`: без `-f compose.prod.yaml` Compose возьмёт `compose.yaml` — файл разработки.

`./deploy/docker/ck compose down` (без `-v`) безопасен: удаляет контейнеры и сеть, тома остаются; следующий `deploy.sh --no-pull` поднимет всё обратно.

**Смена мажорной версии PostgreSQL** (17 → 18) обычным обновлением не делается: новый сервер не откроет том прежней версии. Нужны выгрузка и загрузка — снять копию прежней версией, поднять новую версию на новом томе и восстановить копию. Это отдельная задача; версия образа закреплена в `compose.prod.yaml`, вместе с ней меняется клиент в `Dockerfile` (`postgresql-client-17`).

## 11. HSTS: 3600 → 31536000 после приёмки

Браузер запоминает требование HTTPS на весь срок, и отменить его со стороны сервера нельзя. Поэтому сервер стартует с часа. Когда приёмка пройдена и сайт стабильно открывается по HTTPS:

```bash
sed -i 's/^DJANGO_HSTS_SECONDS=.*/DJANGO_HSTS_SECONDS=31536000/' .env.prod
./deploy/docker/deploy.sh --no-pull
curl -sI https://<домен>/ | grep -i strict-transport-security
curl -sI https://<домен>/api/health/ | grep -i strict-transport-security
```

Ожидается `max-age=31536000` в обоих ответах, по одному заголовку. Переменная одна на Django и Caddy: Caddyfile берёт то же значение. `includeSubDomains` и `preload` не добавлять.

## 12. Что не настроено

- Мониторинг и оповещения: о падении сервиса и о неудачной копии никто не сообщит.
- Автоматический вывоз копий и их шифрование.
- Сборка образов вне сервера (реестр образов): сейчас сервер собирает сам, отсюда требование к памяти.
- Обновление без простоя, несколько серверов, CDN.
- Лимиты на загрузки и модельные запросы по пользователям.
- Обновления ОС и Docker — забота оператора. Версии образов PostgreSQL, Redis, Caddy, Node, Python и Codex закреплены в файлах и меняются правкой в репозитории.

## 13. Что проверено, а что нет

Источник — отчёт разработчика, написавшего файлы деплоя (Windows, Docker 29.8.1), и сверка при написании этой инструкции. Ничего сверх перечисленного не запускалось.

**Проверено и прошло** (статика и сборка, без запуска контейнеров приложения):

- `docker compose -f compose.prod.yaml --env-file <файл> config --quiet` — exit 0, с `--profile recognition` — exit 0; образец с пустыми секретами — exit 1 с именем `POSTGRES_PASSWORD`, как задумано;
- `ck compose config --quiet` — exit 0; `ck` без файла окружения — exit 2 с подсказкой; `ps` и `stop` на проекте без контейнеров — exit 0;
- сборка пяти целей `Dockerfile` (`frontend-build`, `app`, `static`, `recognition`, `proxy`) — все exit 0. В образах: `pg_dump` / `pg_restore` / `createdb` / `psql` 17.11, gunicorn 26.2.0, пользователь UID 10001, каталоги данных с нужным владельцем; в `proxy` — `index.html`, `assets/`, `static/admin/css/base.css`; `codex` — исполняемый файл в `/usr/local/bin`;
- `caddy validate` для `localhost` и для домена — `Valid configuration`; `caddy fmt --diff` — без правок;
- `bash -n` для `ck` и `deploy.sh` — exit 0; бит исполнения у обоих, переводы строк LF;
- при написании инструкции: `config --services` и `config --volumes` — имена сервисов и томов совпали с текстом; `bash -n` обоих скриптов — exit 0.

**Не запускалось — проверяет QA:**

- тесты, в том числе `backend/health/tests/test_docker_deploy_files.py` (проверен только синтаксис файла);
- подъём стека: ни один контейнер приложения не запускался, проверки готовности сервисов (`healthcheck`) не исполнялись;
- `deploy.sh` целиком — ни первый запуск, ни обновление, ни `--ref`, ни сообщения об отказе;
- миграции в контейнере, `check --deploy`, `backup create` / `verify` / `restore` в контейнере, строка cron;
- `ck manage` (создание пользователя, смена пароля);
- длительность простоя и время сборки — в тексте это расчёт, а не замер;
- команды этой инструкции, которых нет в скриптах: `sed` по `.env.prod`, удаление прежней базы и каталога, health изнутри контейнера, применение HSTS, включение и выключение профиля, перенос `auth.json` в том.

**Проверяется только на настоящем сервере — человеком:**

- получение и продление сертификата;
- **настоящий адрес клиента в «Login failures»** (приёмка, раздел «М»). Если там адрес вида `172.x` — защита от перебора считает всех одним клиентом. Исправление — перевести `proxy` на `network_mode: host`. Это не правка одной строки: в режиме host контейнер не видит имя `web`, поэтому вместе с ним меняются адрес в `deploy/docker/Caddyfile` и публикация порта `web` на loopback, а статический тест сейчас такое запрещает. Нужна отдельная задача; до неё оставьте домен без `AAAA` и сообщите о результате шага;
- Codex CLI 0.162.0 в контейнере: вход без браузера, песочница `bubblewrap` под Docker, обновление токена в томе, первое настоящее распознавание;
- установка Docker и `ufw`, файл подкачки — команды шагов 1–3 взяты из общего знания, в рамках проекта не выполнялись;
- вся приёмка [deployment-acceptance.md](deployment-acceptance.md): браузер, два устройства, телефон, файл 20 МБ, перезагрузка сервера, вывоз копий.
