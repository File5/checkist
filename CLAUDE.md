# Checkist

Перед работой обязательно прочитай [AGENTS.md](AGENTS.md) и относящиеся к задаче документы: [архитектуру](docs/architecture.md), [модель данных](docs/data-model.md), [API-контракт](docs/api-contract.md), [разработку](docs/development.md), [проверки](docs/verification.md). Правила и команды находятся там; сверяй их с кодом.

Реализованы серверный scaffold, React/TypeScript/Vite SPA для настоящего health API через proxy (клиент описан в [docs/frontend.md](docs/frontend.md)) и предметная модель данных чеков (приложения `stores`, `catalog`, `receipts` с миграциями и тестами) — см. [docs/data-model.md](docs/data-model.md); HTTP API и админки для неё нет. Распознавание чеков и дашборд планируются. Визуальную и интерактивную приёмку UI выполняет человек.
