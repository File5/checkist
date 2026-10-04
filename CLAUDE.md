# Checkist

Перед работой прочитай [AGENTS.md](AGENTS.md) и нужные [architecture](docs/architecture.md), [data-model](docs/data-model.md), [api-contract](docs/api-contract.md), [development](docs/development.md), [verification](docs/verification.md). Сверяй с кодом, compose.yaml и .env.example.

Django/DRF + PostgreSQL, Redis/Celery для health, React/Vite SPA: health, каталог и цены подключены к API (docs/frontend.md). Stores/catalog/receipts и admin реализованы. Recognition: фото/MEDIA, PostgreSQL queue, host recognition_worker рядом с Codex CLI или явным fake, detect/crop/recognize/import, cancel/retry, локальный upload/jobs/receipts API со всеми строками. Новые магазины/товары создаются автоматически; SHA-256 replay и повторные фото не дублируют совместимые чеки/строки, заполненные значения не перезаписываются. Needs_review сохраняет результат и причины.

Новый API: DEBUG + ALLOW_LOCAL_RECOGNITION_API=1 + loopback, CSRF даже анониму. Без владельца/пользовательского доступа. Старые 13 GET/health сохраняют контракт. Vite пока только /api; media proxy — этап клиента. Native Codex .exe/auth на host, Celery не запускает OCR. API и worker используют одну DB/MEDIA, scratch отдельно.

Облегчённая v1 исключает ReceiptDraft/подтверждение, MutationRequest/Idempotency-Key, cleanup, POSIX watchdog, manual_locked и защиту stale admin POST от OCR. Не добавляй это без задачи. UI загрузки/чеков, ручные API правки, дашборд/курсы/production пока не реализованы.

Тесты/миграции/демо/модельные вызовы только QA, не dev. Полный env в verification.md; TemporaryDirectory для MEDIA/scratch и fake/mock в автотестах. Итог С6: 247 без БД / 846 integration, 9 e2e; реальный Codex synthetic smoke 102.738 с → needs_review, автоимпорт не состоялся. [Фактические результаты](docs/verification.md#фактические-результаты-с6).

UI принимает человек, browser automation запрещён. Соблюдай F4/F6 гарантии админки, UTF-8/LF, scope задачи, свою ветку/worktree; не меняй соседние worktrees. После проверок останови свои процессы/QA Compose, тома сохраняй. Отчёт: прошло / не прошло / не проверено и почему, точные команды/exit/results и ручные шаги. Публикация/merge/release только по явной задаче.
