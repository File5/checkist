# Checkist

Перед работой прочитай [AGENTS.md](AGENTS.md) и нужные [architecture](docs/architecture.md), [data-model](docs/data-model.md), [api-contract](docs/api-contract.md), [development](docs/development.md), [verification](docs/verification.md). Сверяй с кодом, compose.yaml и .env.example.

Django/DRF + PostgreSQL, Redis/Celery для health, React/Vite SPA: health, каталог, цены, загрузка фото/задания и чеки подключены к API (docs/frontend.md). Stores/catalog/receipts и admin реализованы. Recognition: фото/MEDIA, PostgreSQL queue, host recognition_worker рядом с Codex CLI или явным fake, detect/crop/recognize/import, cancel/retry, локальный upload/jobs/receipts API со всеми строками. Новые магазины/товары создаются автоматически; SHA-256 replay и повторные фото не дублируют совместимые чеки/строки, заполненные значения не перезаписываются. Needs_review сохраняет результат и причины.

Новый API: DEBUG + ALLOW_LOCAL_RECOGNITION_API=1 + loopback, CSRF даже анониму. Без владельца/пользовательского доступа. Старые 13 GET/health сохраняют контракт. Vite dev/preview: /api и /media на один Django; точный Origin клиента включить в DJANGO_CSRF_TRUSTED_ORIGINS. Native Codex .exe/auth на host, Celery не запускает OCR. API и worker используют одну DB/MEDIA, scratch отдельно.

Облегчённая v1 исключает ReceiptDraft/подтверждение, MutationRequest/Idempotency-Key, cleanup, POSIX watchdog, manual_locked и защиту stale admin POST от OCR. Не добавляй это без задачи. Ручные API правки, дашборд/курсы/production пока не реализованы. И5: 897 frontend tests и fake HTTP dev/preview; ручная приёмка и запуск — docs/verification.md, показ frontend/I5_ACCEPTANCE.md.

Тесты/миграции/демо/модельные вызовы только QA, не dev. Полный env в verification.md; TemporaryDirectory для MEDIA/scratch и fake/mock в автотестах. Итог И4 после уточнения: 257 без БД / 866 integration, 11 e2e; реальный Codex single/double → succeeded, 2 чека / 6 строк / 5 товаров, повтор без дублей. Исторический С6: 247/846, single 102.738 с → needs_review без автоимпорта. [Фактические результаты](docs/verification.md#фактические-результаты-с6).

UI принимает человек, browser automation запрещён. Соблюдай F4/F6 гарантии админки, UTF-8/LF, scope задачи, свою ветку/worktree; не меняй соседние worktrees. После проверок останови свои процессы/QA Compose, тома сохраняй. Отчёт: прошло / не прошло / не проверено и почему, точные команды/exit/results и ручные шаги. Публикация/merge/release только по явной задаче.
