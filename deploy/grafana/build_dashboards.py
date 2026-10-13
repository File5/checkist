#!/usr/bin/env python3
"""Checkist dashboards for grafana.suslicketeam.com → deploy/grafana/dashboards/*.json.

    python3 deploy/grafana/build_dashboards.py

Generated, not hand-edited (as Cave Boulder does): panels and queries live here, the JSON is output, and
backend/health/tests/test_grafana_dashboards.py checks that the two agree. Datasources are provisioned
on the server by uid (docs/observability.md): checkist-prometheus (cluster="checkist"), checkist-postgres
(role checkist_grafana of `manage.py grafana_reader`), loki (logs {cluster="checkist"}).
"""
import json
import pathlib

OUT = pathlib.Path(__file__).parent / "dashboards"
PROM = {"type": "prometheus", "uid": "checkist-prometheus"}
PG = {"type": "grafana-postgresql-datasource", "uid": "checkist-postgres"}
LOKI = {"type": "loki", "uid": "loki"}
BLUE, ORANGE, GREEN, VIOLET, PINK, OCHRE, GREY = "#3987e5", "#d95926", "#199e70", "#9085e9", "#d55181", "#c98500", "#6e6e6a"
GOOD, WARN, BAD = "#0ca30c", "#fab219", "#d03b3b"


def steps(*pairs):
    return [{"color": color, "value": value} for value, color in pairs]


def promql(expr, legend="", instant=False, ref="A"):
    return {"refId": ref, "datasource": PROM, "expr": expr, "legendFormat": legend, "instant": instant,
            "range": not instant, "editorMode": "code"}


def logql(expr, legend="", instant=False, ref="A"):
    return {"refId": ref, "datasource": LOKI, "expr": expr, "legendFormat": legend,
            "queryType": "instant" if instant else "range", "editorMode": "code"}


def sql(raw, fmt="time_series", ref="A"):
    return {"refId": ref, "datasource": PG, "format": fmt, "rawQuery": True, "editorMode": "code", "rawSql": raw}


def panel(kind, title, targets, desc="", unit=None, field=None, options=None, overrides=()):
    defaults = {"color": {"mode": "palette-classic"}}
    if unit:
        defaults["unit"] = unit
    defaults.update(field or {})
    return {"type": kind, "title": title, "description": desc, "datasource": targets[0]["datasource"],
            "targets": targets, "fieldConfig": {"defaults": defaults, "overrides": list(overrides)},
            "options": options or {}}


def stat(title, target, desc="", unit=None, color=BLUE, thresholds=None, mappings=None, decimals=None, text="value"):
    field = {"color": {"mode": "fixed", "fixedColor": color}}
    if thresholds:
        field = {"color": {"mode": "thresholds"}, "thresholds": {"mode": "absolute", "steps": thresholds}}
    if mappings:
        field["mappings"] = mappings
    if decimals is not None:
        field["decimals"] = decimals
    return panel("stat", title, [target], desc, unit, field, {
        "reduceOptions": {"calcs": ["lastNotNull"], "fields": "", "values": False}, "colorMode": "value",
        "graphMode": "none", "textMode": text, "justifyMode": "center"})


def timeseries(title, targets, desc="", unit=None, stack=False, bars=False, overrides=()):
    field = {"custom": {"lineWidth": 2, "fillOpacity": 70 if bars else 10, "drawStyle": "bars" if bars else "line",
                        "showPoints": "never", "axisSoftMin": 0, "stacking": {"mode": "normal" if stack else "none"}}}
    return panel("timeseries", title, targets, desc, unit, field, {
        "legend": {"displayMode": "list", "placement": "bottom", "showLegend": True},
        "tooltip": {"mode": "multi", "sort": "desc"}}, overrides)


def bargauge(title, target, desc="", unit=None, color=BLUE, thresholds=None):
    field = {"color": {"mode": "fixed", "fixedColor": color}, "min": 0}
    if thresholds:
        field.update({"color": {"mode": "thresholds"}, "thresholds": {"mode": "absolute", "steps": thresholds}})
    return panel("bargauge", title, [target], desc, unit, field, {
        "orientation": "horizontal", "displayMode": "basic", "showUnfilled": True, "valueMode": "text",
        "namePlacement": "left", "reduceOptions": {"calcs": ["lastNotNull"], "fields": "", "values": True}})


def piechart(title, target, desc="", unit=None):
    return panel("piechart", title, [target], desc, unit, options={
        "pieType": "donut", "displayLabels": ["percent"],
        "legend": {"displayMode": "table", "placement": "right", "values": ["value", "percent"], "showLegend": True},
        "reduceOptions": {"calcs": ["lastNotNull"], "fields": "", "values": True}, "tooltip": {"mode": "single"}})


def logs(title, expr, desc=""):
    return {"type": "logs", "title": title, "description": desc, "datasource": LOKI, "targets": [logql(expr)],
            "options": {"showTime": True, "wrapLogMessage": True, "sortOrder": "Descending", "enableLogDetails": True,
                        "dedupStrategy": "none", "prettifyLogMessage": False}}


def row(title):
    return {"type": "row", "title": title, "collapsed": False, "panels": []}


def dashboard(uid, title, layout, desc, variables=(), time_from="now-24h", refresh="1m"):
    x = y = row_h = 0
    panels = []
    for number, (item, w, h) in enumerate(layout, 1):
        if item["type"] == "row" or x + w > 24:
            x, y, row_h = 0, y + row_h, 0
        item["gridPos"] = {"x": x, "y": y, "w": w, "h": h}
        item["id"] = number
        x, row_h = x + w, max(row_h, h)
        if item["type"] == "row":
            x, y, row_h = 0, y + 1, 0
        panels.append(item)
    return {"uid": uid, "title": title, "description": desc, "tags": ["checkist"], "timezone": "Asia/Almaty",
            "editable": False, "graphTooltip": 1, "refresh": refresh, "schemaVersion": 41,
            "time": {"from": time_from, "to": "now"}, "templating": {"list": list(variables)}, "panels": panels,
            "links": [{"title": "Checkist", "type": "dashboards", "tags": ["checkist"], "asDropdown": False,
                       "includeVars": False, "keepTime": True}]}


# ---------------------------------------------------------------------------
# 1. Сервис (Prometheus: /metrics, blackbox, cAdvisor of checkist-alloy; push errors from Loki)
# ---------------------------------------------------------------------------
def service():
    up = [{"type": "value", "options": {"1": {"text": "Работает", "color": GOOD}, "0": {"text": "Лежит", "color": BAD}}}]
    up_steps = steps((None, BAD), (1, GOOD))
    worker = [{"type": "value", "options": {
        "0": {"text": "Нет воркера", "color": BAD}, "1": {"text": "Ждёт", "color": GOOD}, "2": {"text": "Работает", "color": BLUE}}}]
    containers = 'name=~"checkist-.+"'
    layout = [
        (row("Доступность"), 24, 1),
        (stat("Сайт", promql('probe_success{check="site"}', instant=True), "Blackbox с observ каждые 30 с: https://checkist.suslicketeam.com/",
              thresholds=up_steps, mappings=up), 4, 4),
        (stat("/api/health/", promql('probe_success{check="health"}', instant=True), "База, Redis и Celery отвечают (200, не 503)",
              thresholds=up_steps, mappings=up), 4, 4),
        (stat("Метрики Django", promql('min(checkist_up) and on() min(up{job="checkist"})', instant=True),
              "Prometheus читает /metrics, и база ответила", thresholds=up_steps, mappings=up), 4, 4),
        (stat("Сертификат, дней", promql('min((probe_ssl_earliest_cert_expiry{cluster="checkist"} - time()) / 86400)', instant=True),
              decimals=0, thresholds=steps((None, BAD), (14, WARN), (30, GOOD))), 4, 4),
        (stat("Версия", promql("checkist_build_info", "{{commit}}", instant=True), "Коммит запущенного кода", color=VIOLET,
              text="name"), 4, 4),
        (stat("Воркер распознавания", promql('max(checkist_recognition_worker{state="idle"}) + 2 * max(checkist_recognition_worker{state="busy"})', instant=True),
              "recognition_worker: блокировка в pg_locks либо живая аренда задания", mappings=worker,
              thresholds=steps((None, BAD), (1, GOOD))), 4, 4),
        (bargauge("Доступность за период", promql('avg_over_time(probe_success{cluster="checkist"}[$__range])', "{{check}}", instant=True),
                  unit="percentunit", thresholds=steps((None, BAD), (0.99, WARN), (0.999, GOOD))), 8, 7),
        (timeseries("Время ответа", [promql('probe_duration_seconds{cluster="checkist"}', "{{check}}")], "Полный ответ, измерен с observ", "s"), 16, 7),
        (row("Контейнеры"), 24, 1),
        (timeseries("CPU", [promql(f"sum by (name) (rate(container_cpu_usage_seconds_total{{{containers}}}[5m]))", "{{name}}")],
                    "Ядра; cAdvisor агента checkist-alloy", "short"), 12, 8),
        (timeseries("Память", [promql(f"sum by (name) (container_memory_working_set_bytes{{{containers}}})", "{{name}}")],
                    "Рабочий набор", "bytes"), 12, 8),
        (row("Очереди воркера"), 24, 1),
        (timeseries("Ждут и выполняются", [promql("sum by (queue, status) (checkist_queue_items)", "{{queue}} · {{status}}")],
                    "Распознавание фото, «Трата словами», вопросы выписок, ИИ о тратах", stack=True), 12, 8),
        (timeseries("Самый старый в очереди", [promql("checkist_queue_oldest_queued_seconds", "{{queue}}")], unit="s"), 12, 8),
        (timeseries("Время выполнения за час", [promql('checkist_queue_duration_seconds{window="1h", quantile=~"0.5|0.9"}', "{{queue}} p{{quantile}}")],
                    "От начала до конца, квантили завершённых за последний час", "s"), 12, 8),
        (timeseries("Завершено за час", [promql('sum by (queue, status) (checkist_queue_finished{window="1h"})', "{{queue}} · {{status}}")],
                    stack=True, bars=True), 12, 8),
        (bargauge("Отказы за сутки по кодам", promql("checkist_queue_failures", "{{queue}} · {{code}}", instant=True),
                  "error_code упавших за 24 часа", color=ORANGE), 12, 7),
        (bargauge("Распознавание за сутки", promql('checkist_queue_finished{queue="recognition", window="24h"}', "{{status}}", instant=True),
                  "Задания фото по итогу", color=GREEN), 12, 7),
        (row("ИИ, push, курсы"), 24, 1),
        (bargauge("ИИ сегодня по семьям", promql("checkist_ai_requests_today", "семья {{household}}", instant=True),
                  "Запросы к модели за сутки UTC (accounts.AiUsage); предел — следующая панель", color=VIOLET), 8, 7),
        (bargauge("Доля суточного предела", promql("checkist_ai_requests_today / checkist_ai_daily_limit", "семья {{household}}", instant=True),
                  "1 — предел исчерпан, дальше 429 ai_quota", "percentunit", thresholds=steps((None, GOOD), (0.8, WARN), (1, BAD))), 8, 7),
        (stat("Курс НБРК, дней", promql("checkist_rates_age_days", instant=True), "Сколько дней назад последний курс; больше 3 — догрузка не работает",
              decimals=0, thresholds=steps((None, GOOD), (3, WARN), (7, BAD))), 4, 7),
        (stat("Push-устройства", promql("checkist_push_subscriptions", instant=True), color=BLUE), 4, 7),
        (stat("Push отправлено за сутки", promql("checkist_push_sent_24h", instant=True), color=GREEN), 6, 4),
        (stat("Push ждут отправки", promql("checkist_push_due", instant=True), "Срок наступил, а cron `push tick` не отправил",
              thresholds=steps((None, GOOD), (1, WARN), (10, BAD))), 6, 4),
        (stat("Push ждёт дольше всех", promql("checkist_push_due_oldest_seconds", instant=True), unit="s",
              thresholds=steps((None, GOOD), (900, WARN), (3600, BAD))), 6, 4),
        (stat("Ошибки push за сутки", logql('sum(count_over_time({cluster="checkist", service="push-tick"} |~ "^(WARNING|ERROR) push" [24h])) or vector(0)', instant=True),
              "Строки журнала cron `push tick` (docs/observability.md)", thresholds=steps((None, GOOD), (1, WARN), (20, BAD))), 6, 4),
        (row("Объём"), 24, 1),
        (stat("Траты с фото", promql('checkist_receipts{source="photo"}', instant=True), color=BLUE), 4, 4),
        (stat("Траты вручную", promql('checkist_receipts{source="manual"}', instant=True), "Включая выписки", color=ORANGE), 4, 4),
        (stat("Фото и PDF", promql("checkist_photos", instant=True), color=GREEN), 4, 4),
        (stat("Пользователи", promql("checkist_users", instant=True), "Активные учётные записи", color=VIOLET), 4, 4),
        (stat("Семьи", promql("checkist_households", instant=True), color=PINK), 4, 4),
        (stat("Новых трат за сутки", promql("sum(delta(checkist_receipts[24h]))", instant=True), "Изменение счётчика: удалённые вычитаются",
              color=OCHRE, decimals=0), 4, 4),
    ]
    return dashboard("checkist-service", "Checkist · Сервис", layout,
                     "Доступность снаружи, контейнеры, очереди воркера, ИИ, push, курсы и объёмы — без денег и названий")


# ---------------------------------------------------------------------------
# 2. Траты (Postgres, role checkist_grafana)
# ---------------------------------------------------------------------------
SCOPE = ("NOT r.hidden AND r.currency_id = '$currency' AND COALESCE(m.household_id, 0)::text IN ($household) "
         "AND $__timeFilter(r.purchased_on)")
RECEIPTS = "FROM receipts_receipt r LEFT JOIN accounts_membership m ON m.user_id = r.owner_id"
ROOTS = ("WITH RECURSIVE roots AS (SELECT id, name FROM catalog_category WHERE parent_id IS NULL "
         "UNION ALL SELECT c.id, roots.name FROM catalog_category c JOIN roots ON c.parent_id = roots.id) ")
LINES = ("FROM receipts_receiptline l JOIN receipts_receipt r ON r.id = l.receipt_id "
         "LEFT JOIN accounts_membership m ON m.user_id = r.owner_id "
         "LEFT JOIN catalog_product p ON p.id = l.product_id LEFT JOIN catalog_genericproduct g ON g.id = p.generic_id "
         "LEFT JOIN roots ON roots.id = COALESCE(l.category_id, g.category_id)")
INCOME = ("SELECT date_trunc('month', i.received_on) AS month, sum(i.amount) AS income FROM incomes_income i "
          "LEFT JOIN accounts_membership m ON m.user_id = i.owner_id WHERE i.currency_id = '$currency' "
          "AND COALESCE(m.household_id, 0)::text IN ($household) AND $__timeFilter(i.received_on) GROUP BY 1")
SPENT = f"SELECT date_trunc('month', r.purchased_on) AS month, sum(r.total) AS spent {RECEIPTS} WHERE {SCOPE} GROUP BY 1"
METHODS = {"": "Не указан", "kaspi_gold": "Kaspi Gold", "forte": "ForteBank", "cash": "Наличные", "crypto": "Криптовалюта",
           "card": "Другая карта"}


def spending():
    money = "short"  # the currency is the variable above: Grafana units cannot follow it
    household = {"name": "household", "label": "Семья", "type": "query", "datasource": PG, "multi": True,
                 "includeAll": True, "refresh": 1, "sort": 1,
                 "query": "SELECT 'Без семьи' AS __text, '0' AS __value UNION ALL "
                          "SELECT name, id::text FROM accounts_household",
                 "current": {"text": "All", "value": "$__all"}}
    currency = {"name": "currency", "label": "Валюта", "type": "query", "datasource": PG, "refresh": 1, "sort": 1,
                "query": "SELECT DISTINCT currency_id FROM receipts_receipt WHERE NOT hidden",
                "current": {"text": "KZT", "value": "KZT"}}
    methods = " ".join(f"WHEN '{key}' THEN '{name}'" for key, name in METHODS.items())
    layout = [
        (stat("Потрачено", sql(f"SELECT COALESCE(sum(r.total), 0) {RECEIPTS} WHERE {SCOPE}", "table"),
              "Σ итогов трат в выбранной валюте; скрытые платежи не входят", money, color=ORANGE, decimals=0), 6, 4),
        (stat("Трат", sql(f"SELECT count(*) {RECEIPTS} WHERE {SCOPE}", "table"), color=BLUE), 6, 4),
        (stat("Доход", sql(f"SELECT COALESCE(sum(income), 0) FROM ({INCOME}) i", "table"), "Доходы, внесённые людьми", money,
              color=GREEN, decimals=0), 6, 4),
        (stat("Отложено", sql(f"SELECT (SELECT sum(income) FROM ({INCOME}) i) - COALESCE((SELECT sum(spent) FROM ({SPENT}) s), 0)",
                              "table"), "Доход минус потрачено; пусто — дохода нет", money,
              thresholds=steps((None, BAD), (0, GOOD)), decimals=0), 6, 4),
        (timeseries("Траты по дням", [sql(f"SELECT r.purchased_on::timestamp AS time, sum(r.total) AS \"Потрачено\" "
                                         f"{RECEIPTS} WHERE {SCOPE} GROUP BY 1 ORDER BY 1")], unit=money, bars=True), 24, 8),
        (timeseries("По месяцам и категориям", [sql(
            f"{ROOTS}SELECT date_trunc('month', r.purchased_on)::timestamp AS time, COALESCE(roots.name, 'Без категории') AS metric, "
            f"sum(l.amount - l.discount_amount) AS value {LINES} WHERE {SCOPE} GROUP BY 1, 2 ORDER BY 1")],
            "Строки чеков по корневой категории товара (у строки без товара — своя категория); скидка на весь чек не распределена",
            money, stack=True, bars=True), 16, 9),
        (piechart("Корневые категории", sql(
            f"{ROOTS}SELECT COALESCE(roots.name, 'Без категории') AS category, sum(l.amount - l.discount_amount) AS spent "
            f"{LINES} WHERE {SCOPE} GROUP BY 1 ORDER BY 2 DESC", "table"), unit=money), 8, 9),
        (timeseries("Доход, потрачено и отложено по месяцам", [sql(
            f"WITH i AS ({INCOME}), s AS ({SPENT}) SELECT COALESCE(i.month, s.month)::timestamp AS time, "
            "i.income AS \"Доход\", COALESCE(s.spent, 0) AS \"Потрачено\", i.income - COALESCE(s.spent, 0) AS \"Отложено\" "
            "FROM i FULL JOIN s ON s.month = i.month ORDER BY 1")], "Месяц без дохода — пропуск, а не ноль", money, bars=True), 24, 9),
        (bargauge("Топ мест", sql(
            "SELECT COALESCE(NULLIF(mm.brand_name, ''), NULLIF(st.name, ''), 'Магазин №' || st.id, 'Без места') AS place, "
            f"sum(r.total) AS spent {RECEIPTS} LEFT JOIN stores_store s0 ON s0.id = r.store_id "
            "LEFT JOIN stores_store st ON st.id = COALESCE(s0.merged_into_id, s0.id) LEFT JOIN stores_merchant mm ON mm.id = st.merchant_id "
            f"WHERE {SCOPE} GROUP BY 1 ORDER BY 2 DESC LIMIT 15", "table"), "Склеенные места — под главным", money, ORANGE), 12, 12),
        (piechart("Способы оплаты", sql(f"SELECT CASE r.payment_method {methods} ELSE r.payment_method END AS method, "
                                       f"sum(r.total) AS spent {RECEIPTS} WHERE {SCOPE} GROUP BY 1 ORDER BY 2 DESC", "table"),
                  unit=money), 12, 6),
        (piechart("Источники", sql(f"SELECT CASE WHEN r.source = 'photo' THEN 'Фото чека' ELSE 'Вручную и выписки' END "
                                  f"AS source, sum(r.total) AS spent {RECEIPTS} WHERE {SCOPE} GROUP BY 1", "table"),
                  "Receipt.source; выписку отличает только комментарий, а свободный текст Grafana не читает", money), 12, 6),
    ]
    return dashboard("checkist-spending", "Checkist · Траты", layout,
                     "Траты, доходы, места и способы оплаты семьи из базы; валюты не складываются — выберите валюту",
                     (household, currency), "now-180d", "5m")


# ---------------------------------------------------------------------------
# 3. Ошибки (Loki, labels of deploy/observability/alloy/config.alloy)
# ---------------------------------------------------------------------------
def errors():
    app = '{cluster="checkist"}'
    level = 'level=~"error|critical"'
    layout = [
        (stat("5xx Django", logql('sum(count_over_time({cluster="checkist", service="web"} |= "ERROR django.request:" [$__range])) or vector(0)', instant=True),
              "Ответы 5xx с трассировкой (django.request); 503 — /api/health/ без зависимостей",
              thresholds=steps((None, GOOD), (1, WARN), (20, BAD))), 6, 4),
        (stat("Ошибки web", logql(f'sum(count_over_time({{cluster="checkist", service="web", {level}}} [$__range])) or vector(0)', instant=True),
              thresholds=steps((None, GOOD), (1, WARN), (20, BAD))), 6, 4),
        (stat("Ошибки воркера", logql(f'sum(count_over_time({{cluster="checkist", service="recognition", {level}}} [$__range])) or vector(0)', instant=True),
              "recognition_worker: модель, разбор, выписки, ИИ — только тип ошибки", thresholds=steps((None, GOOD), (1, WARN), (20, BAD))), 6, 4),
        (stat("Ошибки Caddy", logql(f'sum(count_over_time({{cluster="checkist", service="proxy", {level}}} [$__range])) or vector(0)', instant=True),
              "Чаще всего 502: web недоступен", thresholds=steps((None, GOOD), (1, WARN), (20, BAD))), 6, 4),
        (timeseries("Ошибки по сервисам", [logql(f'sum by (service) (count_over_time({{cluster="checkist", {level}}} [$__auto]))', "{{service}}")],
                    bars=True, stack=True), 12, 8),
        (timeseries("Предупреждения по сервисам", [logql('sum by (service) (count_over_time({cluster="checkist", level=~"warn|warning"} [$__auto]))', "{{service}}")],
                    "Push, курсы, кэш и прочее, что код пишет как WARNING", bars=True, stack=True), 12, 8),
        (logs("Django (web): ошибки", f'{{cluster="checkist", service="web", {level}}}'), 24, 10),
        (logs("Воркер распознавания", f'{{cluster="checkist", service="recognition", level=~"warning|error|critical"}}'), 12, 10),
        (logs("Caddy", f'{{cluster="checkist", service="proxy", level=~"warn|error|fatal|panic"}}', "IP клиентов вырезаны агентом"), 12, 10),
        (logs("Push и прочие предупреждения", f'{app} |~ "^(WARNING|ERROR) (push|rates|metrics)"'), 24, 8),
    ]
    return dashboard("checkist-errors", "Checkist · Ошибки", layout,
                     "Ошибки и 5xx Django, воркера распознавания и Caddy из журналов контейнеров (Loki)", time_from="now-24h")


BUILDERS = (service, spending, errors)


def build():
    return {d["uid"]: d for d in (builder() for builder in BUILDERS)}


if __name__ == "__main__":
    OUT.mkdir(exist_ok=True)
    for uid, data in build().items():
        (OUT / f"{uid}.json").write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(uid, len(data["panels"]), "panels")
