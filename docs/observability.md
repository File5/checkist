# Наблюдение: Grafana для Checkist (2026-10-13)

Три дашборда в папке «Checkist» на https://grafana.suslicketeam.com — по образцу Cave Boulder:

| Дашборд | uid | Источник | Что показывает |
|---|---|---|---|
| Checkist · Сервис | `checkist-service` | «Checkist · Prometheus» (+ Loki для ошибок push) | сайт и `/api/health/` снаружи, сертификат, CPU и память контейнеров, очереди воркера и время выполнения, отказы по кодам, воркер idle/busy/absent, ИИ по семьям, push, курс НБРК, объёмы, версия |
| Checkist · Траты | `checkist-spending` | «Checkist · Postgres» | траты по дням, по месяцам и корневым категориям, доход / потрачено / отложено, топ мест, способы оплаты, источники; переменные «Семья» (включая «Без семьи») и «Валюта» |
| Checkist · Ошибки | `checkist-errors` | Loki | 5xx и ошибки Django (`web`), воркера (`recognition`), Caddy (`proxy`), предупреждения push |

```
observ 159.195.27.33 (там же Checkist)
checkist-web:8000/metrics ◄─ сеть checkist-metrics ─ observ-prometheus: job checkist (Bearer METRICS_TOKEN), cluster="checkist"
https://checkist.suslicketeam.com/, /api/health/ ◄── blackbox-exporter: job checkist-pages
логи checkist-* ─┐
cAdvisor ────────┴─ checkist-alloy ─► suslicketeam-loki :3102 (логи) и observ-prometheus (remote_write)
checkist-pg:5432 ◄─ сеть checkist-grafana-db ─ suslicketeam-grafana «Checkist · Postgres», роль checkist_grafana
observ-prometheus ◄── checkist-prom-proxy (только cluster="checkist") ◄── Grafana «Checkist · Prometheus»
```

## Что где лежит

| Что | В репозитории | На сервере |
|---|---|---|
| `/metrics` Django | `backend/health/metrics.py` | контейнер `web`, токен `METRICS_TOKEN` в `/opt/checkist/.env.prod` |
| Две сети на двоих: `checkist-metrics` (web ↔ Prometheus), `checkist-grafana-db` (postgres ↔ Grafana) | `compose.observability.yaml`, `deploy/docker/ck`, `deploy/observability/prometheus.override.yml`, `deploy/grafana/docker-compose.override.yml` | `CHECKIST_OBSERVABILITY=1` в `.env.prod`; `docker-compose.override.yml` в `/opt/observability` и `/opt/suslicketeam-grafana` |
| Роль Postgres только на чтение | `manage.py grafana_reader` | роль `checkist_grafana`, пароль — `CHECKIST_PG_PASSWORD` в `/opt/suslicketeam-grafana/.env` |
| Job Prometheus и пробы | `deploy/observability/prometheus-checkist.yml` | конец `/opt/observability/prometheus/prometheus.yml` |
| Агент логов и контейнеров | `deploy/observability/alloy/` | контейнер `checkist-alloy` (проект `checkist-observability`) |
| Источники, прокси, папка | `deploy/grafana/datasources-checkist.yml`, `dashboards-checkist.yml`, `docker-compose.override.yml` | `/opt/suslicketeam-grafana/` |
| Дашборды | `deploy/grafana/build_dashboards.py` → `deploy/grafana/dashboards/*.json` | `/opt/suslicketeam-grafana/dashboards-checkist/` |

## Метрики `/metrics`

Считаются из базы при каждом опросе — шесть запросов при любом объёме данных, поэтому gunicorn не нужен
multiprocess-режим. **Без денег, названий и текстов:** только числа и время; метка `household` — id
семьи, `code` — код ошибки (`timeout`, `worker_lost`, …).

| Метрика | Метки | Что |
|---|---|---|
| `checkist_up` | — | 1 — база ответила в этом опросе, 0 — нет (остальных серий тогда нет) |
| `checkist_build_info` | `commit` | коммит checkout'а (`ck` передаёт `CHECKIST_COMMIT`) |
| `checkist_queue_items` | `queue`, `status` | незавершённые: `queued`, `running`, у распознавания ещё `cancel_requested` |
| `checkist_queue_oldest_queued_seconds` | `queue` | возраст самого старого `queued`, 0 — пусто |
| `checkist_queue_finished` | `queue`, `status`, `window` (`1h`/`24h`) | завершённые за окно по итогу |
| `checkist_queue_failures` | `queue`, `code`, `window="24h"` | `failed` за сутки по `error_code` |
| `checkist_queue_duration_seconds` | `queue`, `window`, `quantile` (0.5/0.9/0.99) | от `started_at` до `finished_at` у завершённых за окно |
| `checkist_recognition_worker` | `state` (`idle`/`busy`/`absent`) | 1 у текущего состояния (`executor.state` API) |
| `checkist_ai_requests_today`, `checkist_ai_enabled`, `checkist_ai_daily_limit` | `household` | `AiUsage` за сутки UTC, включатель и предел семьи (предела нет — серии нет) |
| `checkist_push_subscriptions`, `checkist_push_sent_24h`, `checkist_push_due`, `checkist_push_due_oldest_seconds` | — | устройства, отправлено за сутки, ждут после срока и сколько ждёт самое старое |
| `checkist_rates_last_day_timestamp_seconds`, `checkist_rates_age_days` | — | день последнего курса НБРК и его возраст |
| `checkist_receipts` | `source` (`photo`/`manual`) | траты (выписки — среди `manual`) |
| `checkist_photos`, `checkist_users`, `checkist_households` | — | фото и PDF, активные учётные записи, семьи |

`queue`: `recognition` (задания фото), `manual_parse` («Трата словами»), `statement_ask` (вопросы выписок),
`insight` (ИИ о тратах). Отказы `ai_quota` / `ai_disabled` нигде не хранятся и не считаются: исчерпание
видно как `checkist_ai_requests_today / checkist_ai_daily_limit` = 1. Ошибки отправки push в базе тоже не
хранятся — только строки `WARNING push.services: …` журнала `push tick` (шаг 7).

Доступ: `GET /metrics` с `Authorization: Bearer <METRICS_TOKEN>`, сравнение в постоянное время. Нет
токена в окружении, нет заголовка или токен другой — пустой `404`. Ответ даёт middleware второй строкой
`MIDDLEWARE` до проверки хоста и перенаправления на https (как `/robots.txt`): Prometheus ходит по имени
контейнера по http. Caddy снаружи на `/metrics*` отвечает `404`.

**Журнал контейнеров (2026-10-13).** Без `DEBUG` Django ни ответов 5xx, ни их трассировок не печатал, а
предупреждения кода шли без уровня. Теперь `LOGGING`: корень — `WARNING` и выше в stderr строкой
`LEVEL logger: сообщение`, `django.request` — только `ERROR` (5xx с трассировкой; 4xx не пишутся: путь
несёт id чеков). Агент склеивает трассировку с её строкой и ставит метку `level`.

## Решения

- **Сети — по одной на пару, общей нет.** `web` и `postgres` Checkist в общую сеть `observability` не
  входят: там контейнеры других проектов (туннель Cave, Loki, Alertmanager, обе Grafana, locust…).
  `checkist-metrics` (`docker network create --internal`) — только `web` (алиас `checkist-web`) и
  `observ-prometheus`; `checkist-grafana-db` — только `postgres` (алиас `checkist-pg`) и `suslicketeam-grafana`.
  Compose добавляет и имена сервисов `web` / `postgres`, но в сети из двух участников их видит только
  напарник; настройки обращаются по `checkist-web` / `checkist-pg`. Prometheus и Grafana входят в свою сеть
  постоянно — файлом `docker-compose.override.yml` своего каталога (`docker compose` без `-f` сливает его
  сам), основной `docker-compose.yml` не правится. Override Checkist — отдельный файл: на QA и локально
  этих сетей нет, и `compose up` не падает; `ck` добавляет `-f compose.observability.yaml`, только если в
  файле окружения есть строка `CHECKIST_OBSERVABILITY=1`; `deploy.sh` ходит через `ck` и получает его сам.
- **Права по столбцам — ровно то, что читают 13 запросов «Трат».** `grafana_reader` даёт `SELECT` на
  столбцы 10 таблиц (`READABLE` в команде): у трат `id, owner_id, store_id, source, currency_id,
  purchased_on, total, payment_method, hidden`, у строк `receipt_id, product_id, category_id, amount,
  discount_amount`, категории `id, name, parent_id`, товар → обобщённый → категория (только id), места
  `id, name, merchant_id, merged_into_id` и `stores_merchant.brand_name`, доходы `owner_id, received_on,
  amount, currency_id`, семьи `id, name`, членство `user_id, household_id`. Без свободного текста (`note`
  трат и доходов, `raw_*`, `fiscal`), без адресов и юрлиц, без `auth_user` вообще (запросы его не читают),
  без сессий, приглашений и подписок. Совпадение в обе стороны сверяет тест: каждый выданный столбец
  встречается в SQL, и каждый запрос выполняется под ролью. «Выписка» в «Источниках» больше не выделяется —
  её узнаёт только комментарий; панель делит траты на «Фото чека» и «Вручную и выписки» (`source`), банки
  видны в «Способах оплаты». View не используются: view заблокировал бы будущую миграцию, меняющую
  прочитанный столбец. `ALTER DEFAULT PRIVILEGES` нет намеренно: новая таблица закрыта, пока её не добавят
  в `READABLE` и не запустят команду снова (без пароля — пароль прежний). Роль: `LOGIN`, без суперправ,
  5 соединений, `default_transaction_read_only`, `statement_timeout` 30 с.
- **Агент `checkist-alloy`** (Alloy v1.20.1, как `cave-alloy`): логи контейнеров проекта `checkist` с метками
  `cluster="checkist", job="docker", container, project, service, level` и cAdvisor. Свой cAdvisor нужен потому,
  что `monitoring-cadvisor` v0.50.0 этого сервера контейнеров не видит: Docker 29 хранит образы в containerd
  (`failed to identify the read-write layer ID`), а cAdvisor Alloy v1.20.1 — v0.60.5 с поддержкой containerd
  snapshotter. Caddy: строки healthcheck (`admin.api`) отброшены, IP вырезаны. Проверено локально
  (Alloy → Loki): только проект `checkist`, трассировка — одна запись, уровни, IP — `-`.

## Шаги на сервере

Выполнять по порядку под root на `netcup-observ`; у каждого шага — откат. Секреты генерируются на сервере
и не печатаются. Начало — общая метка копий:

```bash
ts="$(date +%Y%m%d-%H%M)"
```

### 0. Код

Ветку `feature/observability` влить в `main` и выложить обычным путём — только после шагов 1 и 2, чтобы
`deploy.sh` сразу пересоздал `web` и `postgres` с токеном и их сетями (`postgres` перезапускается в окне
простоя `deploy.sh`; без созданных сетей `up` откажет).

### 1. Две сети на двоих и Prometheus в своей

`--internal`: у сетей нет выхода наружу, это только связь пары (наружу каждый ходит своими сетями).
Prometheus входит в `checkist-metrics` сразу (`docker network connect`, без перезапуска) и постоянно —
файлом `docker-compose.override.yml` в `/opt/observability` (его сливает `docker compose` без `-f`).

```bash
docker network create --internal checkist-metrics
docker network create --internal checkist-grafana-db
cd /opt/observability
ls docker-compose.override.yml 2>/dev/null   # ждём пусто
cp /opt/checkist/deploy/observability/prometheus.override.yml docker-compose.override.yml
docker compose config --quiet
docker network connect checkist-metrics observ-prometheus
```

`docker compose config` проверяет слияние; пересоздавать Prometheus не нужно — при следующем `up` он
войдёт в ту же сеть уже из файла.

Откат (после отката шагов 2–4):

```bash
docker network disconnect checkist-metrics observ-prometheus
rm /opt/observability/docker-compose.override.yml
docker network rm checkist-metrics checkist-grafana-db
```

### 2. Переменные Checkist

```bash
cd /opt/checkist
cp .env.prod ".env.prod.bak-obs-$ts"
grep -c '^METRICS_TOKEN=\|^CHECKIST_OBSERVABILITY=' .env.prod   # ждём 0
printf 'METRICS_TOKEN=%s\nCHECKIST_OBSERVABILITY=1\n' "$(openssl rand -hex 32)" >> .env.prod
./deploy/docker/deploy.sh
```

Проверка:

```bash
docker inspect checkist-web-1 checkist-postgres-1 --format '{{.Name}} {{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}'
# ждём: web — checkist_default checkist-metrics; postgres — checkist_default checkist-grafana-db
docker network inspect checkist-metrics --format '{{range .Containers}}{{.Name}} {{end}}'      # checkist-web-1 observ-prometheus
token="$(sed -n 's/^METRICS_TOKEN=//p' /opt/checkist/.env.prod)"
docker exec observ-prometheus wget -qO- --header "Authorization: Bearer $token" http://checkist-web:8000/metrics | grep -E '^checkist_(up|recognition_worker)'
docker exec observ-prometheus wget -qO- http://checkist-web:8000/metrics; echo "exit=$?"   # 404 → exit=1
curl -s -o /dev/null -w '%{http_code}\n' https://checkist.suslicketeam.com/metrics          # 404
unset token
```

Откат: `cp ".env.prod.bak-obs-$ts" .env.prod && ./deploy/docker/deploy.sh --no-pull` — без переменной `ck`
не берёт override, контейнеры пересоздаются без сетей пары, `/metrics` снова 404.

### 3. Роль Postgres для Grafana

```bash
cd /opt/checkist
umask 077
GRAFANA_DB_PASSWORD="$(openssl rand -hex 32)"; export GRAFANA_DB_PASSWORD
./deploy/docker/ck compose run --rm -T -e GRAFANA_DB_PASSWORD web python manage.py grafana_reader
cp /opt/suslicketeam-grafana/.env "/opt/suslicketeam-grafana/.env.bak-checkist-$ts"
printf 'CHECKIST_PG_PASSWORD=%s\n' "$GRAFANA_DB_PASSWORD" >> /opt/suslicketeam-grafana/.env
unset GRAFANA_DB_PASSWORD
```

Ожидается `checkist_grafana: created, SELECT on 10 tables.` Повтор после миграции, добавившей нужный
дашборду столбец, — та же команда без `-e` и без переменной: пароль остаётся прежним.

Откат:

```bash
./deploy/docker/ck compose exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "DROP OWNED BY checkist_grafana" -c "DROP ROLE checkist_grafana"'
cp "/opt/suslicketeam-grafana/.env.bak-checkist-$ts" /opt/suslicketeam-grafana/.env
```

### 4. Prometheus: job `checkist` и пробы

`prometheus.yml` смонтирован в контейнер отдельным файлом: дописывать `>>` (inode тот же), не `sed -i`.
Токен лежит в файле открытым текстом, как остальная конфигурация (файл читает `nobody` контейнера);
он даёт только эти счётчики.

```bash
cd /opt/observability/prometheus
tail -4 prometheus.yml            # последний раздел — scrape_configs (job locust)
cp prometheus.yml "prometheus.yml.bak-checkist-$ts"
token="$(sed -n 's/^METRICS_TOKEN=//p' /opt/checkist/.env.prod)"
sed "s/__METRICS_TOKEN__/$token/" /opt/checkist/deploy/observability/prometheus-checkist.yml >> prometheus.yml
unset token
docker exec observ-prometheus promtool check config /etc/prometheus/prometheus.yml
curl -fsS -X POST http://127.0.0.1:9090/-/reload && echo reloaded
```

Проверка (через минуту):

```bash
curl -s 'http://127.0.0.1:9090/api/v1/targets?scrapePool=checkist' | grep -o '"health":"[a-z]*"'        # up
curl -s 'http://127.0.0.1:9090/api/v1/targets?scrapePool=checkist-pages' | grep -o '"health":"[a-z]*"'  # up ×2
curl -s -G http://127.0.0.1:9090/api/v1/query --data-urlencode 'query=checkist_up' | grep -o '"value":\[[^]]*\]'
curl -s -G http://127.0.0.1:9090/api/v1/query --data-urlencode 'query=probe_success{cluster="checkist"}' | grep -o '"check":"[a-z]*"'
```

Откат: `cat "prometheus.yml.bak-checkist-$ts" > prometheus.yml && curl -fsS -X POST http://127.0.0.1:9090/-/reload`.

### 5. Grafana: источники, сеть, прокси, папка, дашборды

Дополнения к compose — файлом `docker-compose.override.yml`: `docker compose` без `-f` в этом каталоге
сливает его с `docker-compose.yml` сам (запускать там только так).

```bash
cd /opt/suslicketeam-grafana
ls docker-compose.override.yml 2>/dev/null   # ждём пусто
cp provisioning/datasources/datasources.yml "provisioning/datasources/datasources.yml.bak-checkist-$ts"
cp provisioning/dashboards/dashboards.yml "provisioning/dashboards/dashboards.yml.bak-checkist-$ts"
cat /opt/checkist/deploy/grafana/datasources-checkist.yml >> provisioning/datasources/datasources.yml
cat /opt/checkist/deploy/grafana/dashboards-checkist.yml >> provisioning/dashboards/dashboards.yml
install -d dashboards-checkist
cp /opt/checkist/deploy/grafana/dashboards/*.json dashboards-checkist/
cp /opt/checkist/deploy/grafana/docker-compose.override.yml docker-compose.override.yml
docker compose config --quiet && docker compose up -d
```

`up -d` пересоздаёт `suslicketeam-grafana` (новая переменная, том и сеть `checkist-grafana-db`) и запускает
`checkist-prom-proxy` (только в сети `observability`).

Проверка:

```bash
docker network inspect checkist-grafana-db --format '{{range .Containers}}{{.Name}} {{end}}'   # checkist-postgres-1 suslicketeam-grafana
docker logs --tail 50 suslicketeam-grafana 2>&1 | grep -i -E 'error|checkist'
docker exec suslicketeam-grafana wget -qO- 'http://checkist-prom-proxy:8080/api/v1/query?query=checkist_up'
```

В Grafana: папка «Checkist», три дашборда; «Checkist · Траты» — выбрать валюту. Источники —
Connections → Data sources → «Checkist · Postgres» → Save & test.

Откат:

```bash
rm docker-compose.override.yml
cp "provisioning/datasources/datasources.yml.bak-checkist-$ts" provisioning/datasources/datasources.yml
cp "provisioning/dashboards/dashboards.yml.bak-checkist-$ts" provisioning/dashboards/dashboards.yml
rm -r dashboards-checkist
docker compose up -d --remove-orphans
```

### 6. Агент логов и контейнеров `checkist-alloy`

```bash
install -d -m 755 /var/log/checkist
docker compose -f /opt/checkist/deploy/observability/alloy/compose.yaml up -d
docker logs --tail 20 checkist-alloy   # уровень warn: пусто — хорошо
```

Проверка (через минуту):

```bash
curl -s http://127.0.0.1:3102/loki/api/v1/label/container/values | grep -o 'checkist-[a-z]*-1'
curl -s -G http://127.0.0.1:3102/loki/api/v1/query --data-urlencode 'query=sum by (service) (count_over_time({cluster="checkist"}[10m]))'
curl -s -G http://127.0.0.1:9090/api/v1/query --data-urlencode 'query=count by (name) (container_memory_working_set_bytes{cluster="checkist"})'
```

Если последний запрос пуст, cAdvisor и в Alloy не увидел контейнеров: панели CPU и памяти будут пустыми,
остальное работает; смотреть `docker logs checkist-alloy | grep -i cadvisor`.

Откат: `docker compose -f /opt/checkist/deploy/observability/alloy/compose.yaml down` (том `alloy-data`
остаётся; уже отправленные строки живут в Loki до `retention_period` 720 ч).

### 7. Ошибки push (по желанию)

`push tick` запускается cron через `compose exec`: его вывод идёт не в журнал контейнера, а в
`$HOME/checkist-push.log`. Чтобы агент его видел, перенаправить в `/var/log/checkist/push-tick.log`:

```bash
crontab -l > "/root/crontab.bak-checkist-$ts"
crontab -l | sed 's|>> "$HOME/checkist-push.log"|>> /var/log/checkist/push-tick.log|' | crontab -
crontab -l | grep 'push tick'
```

Откат: `crontab "/root/crontab.bak-checkist-$ts"`.

### 8. Итоговая проверка

- Prometheus: `checkist_up` = 1, `probe_success{cluster="checkist"}` = 1 у `site` и `health`.
- Grafana «Checkist · Сервис»: зелёные «Сайт», «/api/health/», «Метрики Django», воркер «Ждёт»/«Работает».
- «Checkist · Траты»: суммы при валюте KZT; скрытые платежи не входят.
- «Checkist · Ошибки»: строки есть после первой ошибки; проверить можно `curl -s https://checkist.suslicketeam.com/api/health/`
  при остановленном `celery` — `503` даёт строку `ERROR django.request: Service Unavailable` (не делать без нужды).

## Изменить дашборд

```bash
python3 deploy/grafana/build_dashboards.py
scp deploy/grafana/dashboards/*.json netcup-observ:/opt/suslicketeam-grafana/dashboards-checkist/
```

Grafana перечитывает папку каждые 30 с; правка в интерфейсе запрещена (`allowUiUpdates: false`).
Совпадение JSON с генератором сверяет `backend/health/tests/test_grafana_dashboards.py`.
