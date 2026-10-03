# Контракт API и Celery

## Реализовано: `GET /api/health/`

Публичный endpoint Django/DRF для состояния инфраструктуры. Канонический путь имеет завершающий `/`; клиенту следует использовать его напрямую. GET не требует body или query-параметров; неизвестные параметры, включая `format`, игнорируются. `AllowAny`, `authentication_classes=[]`: анонимный доступ без cookies/token; Authorization header не проверяется. CSRF для этого GET не требуется. Глобальная permission для будущих DRF views — `IsAuthenticated`, но пользовательский вход сейчас не реализован.

Ответы view: `Content-Type: application/json`, `Cache-Control: no-store`. Только JSONRenderer. HEAD и OPTIONS разрешены стандартным DRF-поведением; HEAD использует GET-проверки. Запись через endpoint не разрешена.

### HTTP 200

Возвращается только при трёх успешных проверках:

```json
{
  "status": "ok",
  "checks": {
    "database": {"status": "ok"},
    "redis": {"status": "ok"},
    "celery": {"status": "ok"}
  }
}
```

### HTTP 503

При известном отказе зависимости тело остаётся валидным health-ответом. Пример остановленного worker при доступном broker:

```json
{
  "status": "degraded",
  "checks": {
    "database": {"status": "ok"},
    "redis": {"status": "ok"},
    "celery": {"status": "error", "code": "worker_unavailable"}
  },
  "error": {
    "code": "dependency_unavailable",
    "message": "Один или несколько сервисов недоступны."
  }
}
```

`status` — `ok` или `degraded`; `checks` содержит ровно `database`, `redis`, `celery`. Успешный check — `{"status":"ok"}`, неуспешный — `{"status":"error","code":"…"}`. При 503 присутствует общий `error` выше, а успешные checks сохраняются. Probes выполняются параллельно и независимо: отказ БД не отменяет остальные проверки. Неожиданное исключение реализации даёт 500 вместо достоверного health-ответа.

| Check | Код ошибки | Реальное действие / причина |
| --- | --- | --- |
| `database` | `database_unavailable` | `SELECT 1` не выполнен или вернул неожиданный результат. |
| `redis` | `redis_unavailable` | Cache set/get/delete не выполнен, значение не совпало или cleanup не удался. |
| `celery` | `broker_unavailable` | Соединение или control-публикация через broker завершились сетевой ошибкой. |
| `celery` | `worker_unavailable` | Control ping не получил ни одного ответа `{"ok":"pong"}`. |

Cache использует DB 2, уникальный `health:<uuid>`, случайное значение, TTL 5 секунд и удаление в `finally`. Celery отправляет **control ping**, а не task: достаточно одного ответа worker, это не проверка каждого worker в кластере. При отказе общей Redis-инфраструктуры обычно одновременно ошибочны `redis` (`redis_unavailable`) и `celery` (`broker_unavailable`).

### Протокольные и внутренние ошибки

| HTTP | Условие | Тело |
| --- | --- | --- |
| 405 | POST/PUT/PATCH/DELETE при совместимом Accept | `{"error":{"code":"method_not_allowed","message":"Метод не поддерживается."}}` |
| 406 | Несовместимый Accept, например `text/html` | `{"error":{"code":"not_acceptable","message":"Доступен только JSON."}}` |
| 500 | Неожиданное исключение в DRF view | `{"error":{"code":"internal_error","message":"Внутренняя ошибка сервера."}}` |

Для 405 заголовок `Allow: GET, HEAD, OPTIONS`. Ошибки 405/406 не запускают probes. Ответ 500 безопасен и при `DEBUG=1`: не содержит exception text, DSN, паролей или traceback. Это контракт данного endpoint и DRF handler, а не универсальная схема middleware/404/всех будущих API.

### Таймауты

| Действие | Настройка в коде |
| --- | --- |
| Postgres подключение | `connect_timeout=2` секунды |
| SQL statement | `statement_timeout=2000` миллисекунд |
| Redis cache connect/socket | По 1 секунде, Redis Retry с нулём повторов |
| Celery broker connect/socket | По 1 секунде, `max_retries=0`; control-публикация также ограничивает retries |
| Celery HTTP probe reply | `inspect(timeout=1, limit=1)` |
| Docker worker healthcheck reply | `inspect --timeout=2`, отдельная проверка |

Probes запускаются параллельно, поэтому их обычные сетевые ожидания не суммируются последовательно. Общего жёсткого deadline HTTP-запроса в коде **нет**; DNS, отдельные операции и cleanup могут увеличить время. Цель при отказе — ответ не позднее 10 секунд. В Windows QA2-прогоне она выполнена: HTTP 503 при остановке worker — 1.057378 с (`worker_unavailable`), Postgres — 2.028070 с (`database_unavailable`), Redis — 2.063928 с (`redis_unavailable` + `broker_unavailable`). Это измерения конкретных сценариев, не общий deadline. Реализованный клиентский таймаут 15 секунд охватывает fetch и чтение тела; отмена запроса не отменяет серверные probes. Команды и результаты проверки через proxy — в [verification.md](verification.md#сквозная-проверка-клиента-через-vite-proxy).

### Разбор клиентом — реализованный SPA

1. Запрашивать `<VITE_API_BASE_URL>/health/` с нормализованными `/`, `Accept: application/json`, без credentials. Базовый относительный префикс — `/api`.
2. Прочитать JSON до общей обработки `response.ok`: HTTP 503 содержит полезные `checks`.
3. Проверить schema во время выполнения: три check-имени, допустимые status/code, соответствие HTTP и тела. TypeScript сам не валидирует сеть.
4. Для 200 требовать `status=ok`, все checks `ok`; для 503 — `status=degraded`, хотя бы один error и общий `dependency_unavailable`. Сохранить все checks для отображения частичного отказа.
5. Network error, abort/timeout, 500, неверный JSON/schema или несовместимая пара HTTP/body — отдельная ошибка клиента с возможностью повторить. Старый success и устаревший ответ не должны подменять новое состояние.

Адаптер `frontend/src/api/health.ts` реализует этот разбор; описание клиента — [frontend.md](frontend.md). Vite dev/preview используют same-origin proxy с сохранением `/api`. Произвольный внешний API origin и CORS не настроены. Не-JSON 502/504 от недоступного proxy upstream обрабатываются как ошибка соединения; схема Django 200/503/405/406/500 остаётся прежней.

## Реализовано: task и `check_services`

Зарегистрированная задача **`health.ping`**, без аргументов, возвращает ровно `{"message":"pong"}`. Она идемпотентна, не записывает бизнес-данные и не вызывает внешние сервисы.

`python -X utf8 manage.py check_services` (из `backend/`) делает SQL/cache probes, затем `ping.apply_async(connection=broker, retry=False, expires=10)` и `pending.get(timeout=5)` через настроенный Redis result backend. `task_always_eager=False`, JSON serializers, result TTL 60 секунд. Локальный вызов функции или inspect ping не доказывают выполнение этой цепочки.

При успехе stdout содержит JSON и команда завершается с exit 0:

```json
{"database":"ok","redis":"ok","celery_task":{"status":"ok","result":{"message":"pong"}}}
```

При отказе JSON всё равно выводится, затем `CommandError: Один или несколько сервисов недоступны.` и exit 1. `database`/`redis` — строка `ok` либо соответствующий безопасный код; `celery_task` — `{"status":"error","code":"celery_task_unavailable"}`, а при полученном неправильном результате — `unexpected_task_result`. Ошибка одного probe не отменяет другие проверки CLI. Неожиданные probe/task exceptions также скрываются за фиксированными кодами.

`get(timeout=5)` ограничивает ожидание результата, но не всю команду вместе с SQL/cache/connect. Истечение timeout не отменяет принятую task. Позднее выполнение безопасно для ping; для будущих пользовательских задач понадобится отдельное решение об идемпотентности. HTTP health не ставит task в очередь и не читает results DB 1.

## Планируется

API фото чеков, распознавания магазина/адреса и товаров/стоимостей, категорий и статистического дашборда ещё нет. OCR-провайдер, предметная модель, авторизация и контракты этих функций не выбраны. Endpoint публикации задач и получения их результатов по HTTP не входит в реализованный scaffold.
