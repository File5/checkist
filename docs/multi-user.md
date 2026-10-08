# Разделение пользователей: проект решения

**Статус (2026-10-08): реализовано в коде; разработчиками не запускалось.** Этапы С1–С4, К1, П и И выполнены: владелец в чеках и фото, режимы `accounts` / `local_single`, вход, фильтрация по владельцу, право модератора каталога, проекция «своё / чужое» в ценах, клиент и файлы развёртывания есть в ветке. **Ни тесты, ни миграции, ни демо-команды, ни серверы, ни proxy-скрипты, ни экраны в браузере, ни развёртывание на сервере разработчики не запускали** — это делает QA и человек; команды и место для результатов — [verification.md](verification.md#разделение-пользователей-проверки-qa). Текущее поведение описывают [architecture.md](architecture.md), [data-model.md](data-model.md), [api-contract.md](api-contract.md#реализовано-пользователи-вход-и-доступ-по-владельцу), [frontend.md](frontend.md#вход-сессия-и-разделение-пользователей-к1) и [deployment.md](deployment.md); этот документ остаётся записью решения и его обоснования.

Как читать дальше. Раздел [«Реализация»](#реализация-что-сделано-и-чем-отличается-от-проекта) — что сделано и где код разошёлся с проектом; при расхождении прав код. Разделы «Что есть сейчас», «Целевая модель», «Изменения API-контракта и клиента», «Развёртывание» и «Этапы реализации» — **проект как он был написан до реализации** (чтение кода на `bfb6e3c`, 2026-10-07): ссылки вида «файл:строка» и слова «сейчас» в них относятся к тому состоянию, рабочие имена — к замыслу. Пометки в тексте проекта:

- **[код]** — проверено чтением кода до реализации, указаны файл и строки того состояния;
- **[предположение]** — вывод или предложение, не подтверждённое запуском;
- **не проверено** — сведение о стороннем сервисе, которое не удалось подтвердить по официальной документации.

Цель человека: у каждого пользователя свои чеки и позже своя статистика; цены на похожие товары в других магазинах и странах доступны всем (Молоко ↔ Milch) — каталог общий; что делать с подтверждениями товаров — «пока непонятно»; можно ли сделать вход «типа OAuth» (OpenAI, Google) без домена и без регистрации в Console провайдера.

После ответов человека (2026-10-07) известно и развёртывание: арендованный публичный сервер со своим доменом, не индексируемый и не рекламируемый; пользователи — друзья и знакомые, открытой регистрации нет. Поэтому выход в сеть и production-настройки — часть v1 (этап «П. Развёртывание»), а не отдельная будущая работа.

## Коротко: решение v1

- **Где работает.** Арендованный публичный сервер, свой домен, HTTPS; сервер не индексируется и не рекламируется. Основной режим — `accounts`: доступ определяет сессия, а не `DEBUG` и не адрес запроса. Режим `local_single` (DEBUG + loopback, без входа) остаётся режимом разработки и локальных проверок.
- **Кто пользуется.** Друзья и знакомые; учётные записи заводит администратор, открытой регистрации нет. Без входа доступен только `health`: каталог и цены закрыты.
- Владелец — FK на `settings.AUTH_USER_MODEL` с `PROTECT` — появляется только в `receipts.Receipt` и `recognition.SourcePhoto`. Строки, скидки, налоги, задания, вырезки и попытки наследуют владельца по связям. Магазины, каталог, написания, `merges` и `classification` остаются общими.
- `SourcePhoto.sha256` и три уровня дедупликации `Receipt` становятся уникальностью в пределах владельца. Одинаковый кассовый чек у двоих — две личные покупки.
- Цены общие для вошедших, но у чужого наблюдения скрыты (`null`) id чека, позиция, точное время, количество и скидка; добавляется признак `own`. Порога числа покупателей и личного отказа от публикации цен нет. Форма старых 13 GET сохраняется.
- Чеки, распознавание, статистика и MEDIA — по владельцу, чужой объект отвечает `404`. Мутации слияний и предположений категорий — по одному праву модератора (`403` без него); право выдаёт администратор, скорее всего нескольким людям. Модератор видит в группе слияния строки чужих чеков, но `receipt_id` — только у своих. Вырезку `needs_review` подтверждает её владелец.
- Существующие данные миграция отдаёт пользователю `local`. В `accounts` это обычная учётная запись: человек задаёт ей пароль (`manage.py changepassword local` либо админка) и входит. В `local_single` тот же пользователь — личность запроса без входа. Команды передачи владения нет; повторный импорт не требуется. Перед откатом миграции — команда-проверка.
- Вход v1: учётные записи `django.contrib.auth` (логин и пароль), сессионная cookie и уже работающий CSRF, штатный `auth.User`, без новых зависимостей для входа; защита от перебора пароля обязательна. Вход в админку и вход в приложение — одна cookie. Вход через Google — следующий шаг после v1: домен и HTTPS снимают прежнее препятствие.
- Пользователь не удаляется, а выключается; данные остаются. Оператор сервера видит чеки всех в админке. Лимитов на модельные вызовы нет.
- Развёртывание — этап v1: работа при `DEBUG=0`, HTTPS за обратным прокси, secure-cookie и HSTS, раздача собранного SPA и статики, MEDIA только через проверку владельца, запрет индексации, секреты через окружение, резервные копии, распознавание на сервере (открытый вопрос 1).
- `backend/recognition/resolution.py` не меняется.

## Реализация: что сделано и чем отличается от проекта

Сверено чтением кода ветки на 2026-10-08. Ничего из перечисленного запуском не подтверждено.

### Что сделано

| Этап | Что в коде | Где |
| --- | --- | --- |
| С1 | `Receipt.owner`, `SourcePhoto.owner` (FK на пользователя, `PROTECT`, NOT NULL); по три миграции на приложение; пользователь `local`; владелец в админке чека, помощниках тестов и трёх seed-демо; команда `ownership check-rollback` | `backend/receipts/ownership.py`, `receipts/migrations/0003–0005`, `recognition/migrations/0002–0004`, `recognition/ownership.py`, `recognition/management/commands/ownership.py` |
| С1 | Поля «кто» в журналах решений (nullable, `SET_NULL`) | `merges/migrations/0002_actor_fields.py`, `classification/migrations/0002_actor_fields.py` |
| С2 | Приём файла, дедупликация чека, импорт и подтверждение `needs_review` — в пределах владельца; вырезка привязывается только к чеку владельца своего фото | `recognition/storage.py`, `receipts/dedup.py`, `recognition/importer.py`, `recognition/review.py` |
| С3 | Режим `CHECKIST_AUTH_MODE`; единая точка правил доступа; право `catalog.moderate_catalog`; вход, выход, смена пароля, «кто я»; защита от перебора, общая с админкой; фильтрация чеков, распознавания и статистики; вью MEDIA; заполнение «кто решил» | `backend/accounts/` (`access.py`, `backends.py`, `throttle.py`, `media.py`, `models.py`), `api/views/auth.py`, `catalog/migrations/0002_alter_product_options.py` |
| С4 | Признак `own` и скрытые поля чужих наблюдений в точках цен; `stores.receipts_count` по своим чекам; `products.last_observed_at`; покупки группы слияния | `api/projection.py`, `api/views/prices.py`, `api/views/catalog.py`, `api/views/product_merges.py` |
| К1 | Вход как состояние оболочки, `/account`, обработка `401` и `403`, разделы модератора, «моя / чужая» покупка | [frontend.md](frontend.md#вход-сессия-и-разделение-пользователей-к1) |
| П | Серверные настройки, запрет индексации, адрес клиента за прокси, gunicorn, Caddy, systemd, резервные копии | `backend/config/settings.py`, `config/robots.py`, `config/proxy.py`, `deploy/`, `manage.py backup`, [deployment.md](deployment.md) |
| И | QA-демо двух учётных записей, proxy-скрипт двух сессий, ручная приёмка интерфейса и сервера | `manage.py seed_accounts_demo`, `frontend/scripts/check_accounts_proxy.mjs`, `frontend/src/features/auth/ACCEPTANCE.md`, [deployment-acceptance.md](deployment-acceptance.md) |

### Чем реализация отличается от проекта

| № | В проекте | В коде |
| --- | --- | --- |
| 1 | Право модератора — рабочее имя `catalog.moderate` | `catalog.moderate_catalog`, объявлено в `Meta.permissions` модели `Product`; миграция `catalog.0002` — только `AlterModelOptions`. В `local_single` право есть всегда |
| 2 | Счётчик перебора можно держать в кэше Redis | Таблица `accounts.LoginFailure` в PostgreSQL: вход не зависит от Redis. Не задержка, а отказ до конца окна: 5 неудач на пару «логин и адрес» и 50 на адрес за 900 с (`AUTH_LOGIN_FAILURE_LIMIT`, `AUTH_LOGIN_IP_FAILURE_LIMIT`, `AUTH_LOGIN_LOCK_SECONDS`) |
| 3 | Прежние тесты проходят «без изменения ожиданий» | Имена трёх ограничений чека новые (`receipts_receipt_owner_*`), прежние глобальные удалены; в тестах заменены строки имён. `SourcePhoto.sha256` перестал быть `unique`, уникальность — `rec_photo_owner_sha256_uniq` |
| 4 | Журналы «кто» целиком в этапе С3 | Схема — в С1 (`merges.0002`, `classification.0002`), заполнение — в С3: сервисы принимают необязательный `actor`, API передаёт пользователя запроса, команды и автоматика оставляют поле пустым |
| 5 | Проекция «своё / чужое» в `prices/`, `alternatives`, `comparison`, `products`, `stores` | Меняются только точки `products/{id}/prices/` (`own` и пять `null`), `products.last_observed_at` (`null`, если последнее наблюдение чужое) и `stores.receipts_count`. `alternatives`, `comparison`, `prices/summary/`, `prices/series/` не изменены: дата и магазин последней покупки в них отдаются, как раньше |
| 6 | Покупки группы слияния: свои строки полностью, у чужих `receipt_id` = `null` | Так — только для модератора. Не модератор получает лишь свои строки. Поля `own` в строке нет: чужая строка — та, у которой `receipt_id` равен `null` |
| 7 | Анонимны `health`, вход и выдача CSRF-токена | Токен до входа выдаёт новый `GET /api/auth/csrf/`; прежний `GET /api/recognition/csrf/` в `accounts` требует входа, форма ответа прежняя. Анонимен также запасной `404 not_found` неизвестного пути под `/api/` |
| 8 | Маршруты входа без оговорки о режиме | В `local_single` `login`, `logout` и `password` отвечают `404 not_found`; `GET /api/me/` отвечает `200` с пользователем `local` |
| 9 | Клиент: «экран входа» и возврат на исходный адрес | Вход — состояние оболочки на том же адресе, без параметра `next`. После слияния с редизайном (2026-10-08) есть и адрес `/login` — тот же экран без оболочки, после входа с него открывается каталог. Смена пароля и выход — `/account` |
| 10 | MEDIA: чужой файл и запрос без входа → `404` | Любой отказ — одинаковый пустой `404` `text/plain` с `Cache-Control: private, no-store`, не JSON. В `local_single` — прежнее правило: любой файл под `MEDIA_ROOT` при `DEBUG` |
| 11 | `ownership check-rollback` — рабочее имя | Команда живёт в приложении `recognition`, печатает JSON с группами и завершается кодом 1, если они есть |
| 12 | Сервер приложений и прокси — открытый вопрос 2 | gunicorn (`gthread`, `127.0.0.1:8000`) и Caddy, службы systemd без Docker; копии — `manage.py backup create / verify / restore` |
| 13 | Админка чека: обязательное поле `owner` и фильтр | При добавлении — начальное значение «текущий пользователь», при изменении поле только для чтения: смена владельца нарушила бы связь «вырезка — чек», команды передачи нет |
| 14 | Три миграции | Десять новых: по три в `receipts` и `recognition`, по одной в `merges`, `classification`, `catalog` и `accounts`. Всего собственных — 19 |
| 15 | В `accounts` доступ не зависит от `DEBUG`, адреса и `ALLOW_LOCAL_RECOGNITION_API` | Так и сделано: в `accounts` они не читаются; в `local_single` правило прежнее. Тесты идут в `local_single` (его ставит `config.test_runner.Runner`), тесты режима `accounts` включают его через `override_settings` |

Чего в v1 по-прежнему нет: входа через Google и других провайдеров, регистрации, сброса пароля по почте, удаления аккаунта, передачи владения, разграничения внутри админки, лимитов на модельные вызовы. Подробнее — [«Вне v1»](#вне-v1).

### Что не проверено

Всё поведение из таблиц выше описано по чтению кода. Не запускались: backend-тесты (в том числе новые наборы `accounts`, изоляции и проекции), `makemigrations --check --dry-run`, `sqlmigrate`, `migrate` на пустой базе и на копии dev-базы, откат миграций владельца, `seed_accounts_demo`, `check_accounts_proxy.mjs` и прежние proxy-скрипты, frontend-тесты, lint и build, `check --deploy`, вход в браузере, развёртывание на сервере. Команды для QA — [verification.md](verification.md#разделение-пользователей-проверки-qa); интерфейс принимает человек по [ACCEPTANCE.md](../frontend/src/features/auth/ACCEPTANCE.md), сервер — по [deployment-acceptance.md](deployment-acceptance.md).

## Вход «типа OAuth»: прямой ответ

**Google без Console невозможен.** Вход через Google — это OAuth-клиент, а он существует только внутри проекта Google Cloud: проект, экран согласия, client id и secret, список разрешённых redirect URI. **Домен при этом не нужен:** `http://localhost` и `http://127.0.0.1` разрешены явно, проверка приложения для входа (имя и почта) не требуется, настройка разовая.

**«Sign in with ChatGPT» у OpenAI существует, но доступен только отобранным коммерческим партнёрам** по заявке с компанией, доменом и политикой конфиденциальности — то есть требует ровно того, чего хотелось избежать. **Вход Codex CLI не годится в принципе:** он опознаёт владельца компьютера, а не того, кто открыл страницу.

**Без какой-либо регистрации у провайдера работают только два пути:** собственные учётные записи (логин и пароль Django, всё нужное уже подключено в проекте) и вход «на уровне сети» — например, Tailscale Serve сам сообщает приложению, кто пришёл.

Поэтому v1 — собственные учётные записи, а модель данных привязана только к `User`: Google, GitHub или сетевой заголовок добавляются позже без переделки данных.

**После решения о публичном сервере (решение 1).** У Checkist будет свой домен и HTTPS, поэтому прежнее препятствие для Google — отсутствие стабильного публичного адреса, на который можно вписать redirect URI, — снято. Регистрация в Console по-прежнему нужна: проект, экран согласия, клиент, redirect URI на домене. Режима Testing с вручную внесёнными пользователями (до 100) кругу «друзья и знакомые» должно хватить **[предположение]**. Вход через Google — первый шаг после v1; в v1 он не входит, чтобы не добавлять зависимость (`django-allauth`) и вторую ветку входа до того, как заработает разделение данных.

### Сравнение способов входа

| Вариант | Нужен домен | Регистрация у провайдера | Работает на localhost | Сложность | Риски |
| --- | --- | --- | --- | --- | --- |
| Логин и пароль (`django.contrib.auth`) | Нет | Нет | Да | Низкая | Сброс пароля без почты — только администратором; нужна защита от перебора |
| Приглашение-ссылка от администратора | Нет | Нет | Да | Низкая | Ссылку надо передать по надёжному каналу |
| Ссылка или код на e-mail | Нет | Нет, но нужен SMTP-ящик | Да | Средняя | Доставляемость писем, секрет SMTP |
| Passkeys / WebAuthn | Для LAN — да (HTTPS и имя хоста) | Нет | Только по имени `localhost`, не `127.0.0.1` | Средняя–высокая | Ключ привязан к имени хоста: смена адреса обнуляет вход |
| TOTP | Нет | Нет | Да | Средняя | Это второй фактор, а не способ входа |
| Google | Нет (вне localhost — HTTPS и публичный домен) | Да: проект, экран согласия, клиент | Да | Средняя | Режим Testing: до 100 пользователей, список вручную |
| GitHub OAuth App | Нет | Да, но без проверки | Да | Низкая–средняя | У домашних пользователей нет аккаунта GitHub |
| Microsoft (Entra) | Нет | Да: регистрация приложения в Entra | Да (`http://localhost`) | Средняя | Нужна учётная запись Azure/Entra; нужна ли платная подписка — не проверено |
| Яндекс ID | Не проверено для localhost | Да, без обязательной модерации | Не подтверждено документацией | Средняя | Без верификации сервиса — предупреждение пользователю |
| VK ID | Не проверено | Да | Не проверено | Не проверено | Официальная документация не открылась |
| Apple | Да, HTTPS | Да, платная программа разработчика | Нет | Высокая | Цена, домен |
| Telegram Login | По сообщениям разработчиков — да, публичный | Да: бот в BotFather | По сообщениям — нет | Средняя | Нет почты в данных пользователя |
| Sign in with ChatGPT (сайт) | Да | Да, заявка, отбор партнёров | Не проверено | — | Недоступно частному проекту |
| Вход Codex CLI | — | — | — | — | Не идентифицирует пользователя сайта |
| Keycloak / Authentik / Dex / Zitadel | Нет | Для Google — всё равно да | Да | Высокая | Лишний сервис ради того, что Django умеет сам |
| Auth0 / Clerk / Supabase / Firebase | Для production — обычно да | Dev-ключи только для разработки | Да | Средняя | Зависимость от облака; данные о пользователях у третьей стороны |
| Tailscale Serve (заголовки личности) | Нет (даёт имя `*.ts.net` и HTTPS) | Нет | Не нужен: это вариант для сети | Низкая–средняя | Всем нужен клиент Tailscale; доверие заголовку |
| Cloudflare Access (код на почту) | Да, домен в Cloudflare | Нет | Нет | Средняя | Трафик через Cloudflare |

### Подробности и источники

**Google.** Источники: [OAuth-клиенты](https://support.google.com/cloud/answer/15549257?hl=en), [аудитория приложения](https://support.google.com/cloud/answer/15549945?hl=en).

- Минимум в Console: проект → регистрация приложения в Google Auth Platform (название, почта поддержки, аудитория External) → клиент типа Web application → redirect URI.
- Redirect URI обязаны быть HTTPS, но «Localhost URIs (including localhost IP address URIs) are exempt from this rule»; хост не может быть IP-адресом, но «Localhost IP addresses are exempted».
- Адрес домашней сети не подойдёт: `http://192.168.x.x` — не HTTPS и «сырой» IP; имя вида `checkist.local` тоже — «Host TLDs must belong to the public suffix list». Вывод из этих правил: имя Tailscale `*.ts.net` с его сертификатом формально подходит — на практике не проверено.
- Режим Testing: до 100 тестовых пользователей, каждого вносят вручную; лимит на всё время жизни проекта. Авторизации истекают через 7 дней, кроме случая, когда запрашиваются только имя, почта и профиль. Сессию ведёт сам Django, поэтому семидневный срок Checkist не затрагивает.
- Production: области `openid`, `email`, `profile` не чувствительные, проверка областей не нужна — по [стороннему обзору](https://www.unipile.com/integrating-google-oauth-2-0-user-authentication-into-your-app/); с официальной страницей сверено только определение чувствительных областей. Проверка бренда требует подтверждённого домена, главной страницы и политики конфиденциальности — предположение, актуальные условия не перечитывались.
- Каждый redirect URI вписывается заранее, поэтому адрес, с которого открывают приложение, должен быть стабильным.

**OpenAI.** Источники: [quickstart](https://developers.openai.com/siwc/quickstart), [для сайтов](https://developers.openai.com/siwc/website), [запрос client id](https://developers.openai.com/siwc/request-client-id), [поток для open-source](https://developers.openai.com/siwc/token-sharing-open-source), [вход Codex](https://learn.chatgpt.com/docs/auth).

- «Sign in with ChatGPT» — OpenID Connect с PKCE, области `openid` / `profile` / `email`. Но: «currently available to selected commercial partners through a limited trial»; client id выдают по [форме интереса](https://openai.com/form/sign-in-with-chatgpt-interest/) с компанией, доменом, redirect URI и политикой конфиденциальности.
- Поток для open-source и локальных приложений регистрирует клиента динамически, с loopback-адресом возврата. Его назначение — тратить лимит подписки ChatGPT пользователя на запросы Responses API, а не служить входом. Можно ли использовать его только как идентификацию — **не проверено**, документация этого не обещает; loopback к тому же означает, что вход проходит на той же машине, где запущено приложение, то есть второму человеку в сети он не поможет. Этот поток может быть интересен для отдельного вопроса «чей лимит модели тратит распознавание» — это не вход.
- Вход Codex CLI хранит токены владельца учётной записи ОС в `~/.codex/auth.json` либо в хранилище ОС; документация требует обращаться с файлом «like a password». Он отвечает на вопрос «чей Codex на этом компьютере», все посетители получили бы одну личность; документированного способа получить из него личность для стороннего приложения нет; [AGENTS.md](../AGENTS.md) запрещает менять auth существующего host-пользователя.

**Другие провайдеры.**

- GitHub OAuth App: название, адрес, callback; без проверки и без домена, loopback разрешён, рекомендован `127.0.0.1`, порт может отличаться от зарегистрированного ([документация](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps)).
- Microsoft: `http://localhost` разрешён, порт при сравнении игнорируется; `http://127.0.0.1` добавляется только через манифест ([документация](https://learn.microsoft.com/en-us/entra/identity-platform/reply-url)).
- Яндекс ID: регистрация на `oauth.yandex.ru`, обязательной модерации нет ([документация](https://yandex.ru/dev/id/doc/ru/register-auth)); допустим ли `http://localhost` — не проверено.
- VK ID: официальная документация не открылась — не проверено.
- Apple: платная программа разработчика, Services ID, домен с HTTPS, localhost не принимается — по сторонним источникам и [форуму Apple](https://developer.apple.com/forums/thread/696055).
- Telegram: [официальная страница](https://core.telegram.org/widgets/login) описывает вход через OpenID Connect с PKCE; про localhost там ничего нет, по [сообщениям разработчиков](https://qna.habr.com/q/1402000) адрес должен быть публичным. Почты в данных нет.

**Без внешнего провайдера.**

- Логин и пароль: `django.contrib.auth`, сессии и валидаторы паролей уже включены (`backend/config/settings.py:92`, `:199`) **[код]**. Сброс пароля без почты делает администратор (админка либо `manage.py changepassword`).
- Приглашение: администратор создаёт пользователя и получает одноразовую подписанную ссылку с ограниченным сроком (в Django есть генератор токенов сброса пароля), человек сам задаёт пароль.
- Passkeys: нужен защищённый контекст (HTTPS либо `localhost`), идентификатор RP — доменное имя, не IP ([web.dev](https://web.dev/articles/webauthn-rp-id)). Vite слушает `127.0.0.1` (`frontend/vite.config.ts:27`) **[код]** — по этому адресу passkeys не заработают.

**Посредники.**

- Keycloak, Authentik, Dex, Zitadel от регистрации у Google не избавляют: в посредника вписывают те же client id и secret ([пример](https://blog.elest.io/setting-up-sign-in-with-google-using-keycloak/)).
- Auth0: developer keys — «strictly for testing» ([документация](https://auth0.com/docs/authenticate/identity-providers/social-identity-providers/devkeys)). Clerk: общие ключи только в development ([документация](https://clerk.com/docs/guides/configure/auth-strategies/social-connections/github)). Supabase Auth: для Google нужны свои client id и secret ([документация](https://supabase.com/docs/guides/auth/social-login/auth-google)). Firebase Auth: клиент Google создаётся автоматически, но проект Firebase — это проект Google Cloud (по сторонним источникам, официальная страница не открывалась). Цены облачных сервисов не проверялись.
- Tailscale Serve добавляет заголовки `Tailscale-User-Login` и `Tailscale-User-Name`, сам вырезает их из входящих запросов, для публичного Funnel не добавляет ([документация](https://tailscale.com/docs/features/tailscale-serve)). Лимит пользователей бесплатного тарифа не проверен.
- Cloudflare Access: вход кодом на почту без своего SMTP, приложению приходит подписанный `Cf-Access-Jwt-Assertion` ([код на почту](https://developers.cloudflare.com/cloudflare-one/identity/one-time-pin), [проверка токена](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/)). Нужен домен в Cloudflare — общее знание, не перепроверено.

### Сценарии развёртывания

| Сценарий | Что требует от входа | Разумный способ |
| --- | --- | --- |
| (а) Один компьютер | Различать людей за одним браузером либо не различать вовсе | Локальный режим как сейчас; если людей несколько — логин и пароль |
| (б) Домашняя сеть или туннель | Запросы уже не с loopback; по голому `http://192.168.x.x` не работают ни Google, ни passkeys | Логин и пароль с приглашениями; с Tailscale Serve — HTTPS и имя даром, можно доверять заголовку либо добавить Google на `*.ts.net` |
| **(в) Публичный сервер с доменом и HTTPS — выбран человеком** | Защита от перебора, secure cookies, сброс пароля | v1: логин и пароль, пользователей заводит и пароль сбрасывает администратор; production-настроек в проекте сейчас нет — их даёт этап «П. Развёртывание». После v1: Google через `django-allauth` |

Сценарии (а) и (б) в v1 не целевые: (а) остаётся как режим разработки `local_single`, (б) не делается.

Для выбранного (в) помимо входа меняются `DJANGO_ALLOWED_HOSTS` (по умолчанию `127.0.0.1,localhost`, `backend/config/settings.py:79–80`), проверка `DJANGO_CSRF_TRUSTED_ORIGINS` (принимает только loopback-хосты и требует порт, `settings.py:290–291`), раздача статики и MEDIA вне DEBUG (`config/urls.py:16–17`), а Vite dev и preview (привязаны к `127.0.0.1`, `frontend/vite.config.ts:27–28`) на сервере не используются **[код]**. Полный перечень — в разделе [«Развёртывание на публичном сервере»](#развёртывание-на-публичном-сервере).

## Что есть сейчас

> Раздел описывает состояние **до реализации** (`bfb6e3c`) — исходную точку проекта. Что изменилось — в разделе [«Реализация»](#реализация-что-сделано-и-чем-отличается-от-проекта).

Пользователя в данных и доступе нет: в не-тестовом коде `backend/` нет ни `request.user`, ни `get_user_model`, ни `AUTH_USER_MODEL`, ни FK на пользователя **[код]** (поиск по `backend/**/*.py` без `tests/`, перепроверено на `bfb6e3c`).

### Сущности

Класс: **личная** — принадлежит одному человеку; **общая** — одна на всех; **спорная** — общее решение, ссылающееся на личные данные.

`backend/stores/models.py`

| Модель | Уникальность | Класс | Замечание |
| --- | --- | --- | --- |
| `Country` (:7), `Currency` (:15), `TaxRate` (:23) | PK; `(country, kind, rate)` | общая | справочники, сид-данные |
| `Merchant` (:54) | `(country, tax_id)` при непустом `tax_id` | общая, с оговоркой | `legal_name` ИП — это ФИО; наружу не отдаётся (`docs/api-contract.md:117`) |
| `Store` (:82) | `(merchant, address_key)`; `(merchant, branch_code)` при непустом коде | общая, с оговоркой | создаётся из чека одного человека и сразу виден всем |

`backend/catalog/models.py`

| Модель | Уникальность | Класс | Замечание |
| --- | --- | --- | --- |
| `Category` (:8) | `(parent, name)` | общая | дерево одно на всех |
| `GenericProduct` (:29) | `Lower(name)` | общая | ось сравнения «Молоко ↔ Milch» |
| `Brand` (:47) | `Lower(name)` | общая | |
| `Product` (:60) | `gtin` при непустом; `(brand, name, package_quantity, package_unit)` | общая | один товар у разных людей — одна запись, иначе цены не сравнить |

`backend/receipts/models.py`

| Модель | Уникальность, индексы | Класс | Замечание |
| --- | --- | --- | --- |
| `Receipt` (:7) | три глобальных unique (:36–50): `fiscal_key`; `(store, purchased_on, shift_number, register_code, receipt_number)`; `(store, purchased_at, total)`; индекс `(store, purchased_at)` | **личная** | сюда нужен владелец |
| `ReceiptLine` (:60) | `(receipt, position)`; индексы `(product, receipt)`, `store_item_code` | личная (через чек) | одновременно источник общих цен |
| `ReceiptDiscount` (:139), `ReceiptTax` (:165) | `(receipt, position)`; `(receipt, tax_rate)` | личная (через чек) | |
| `ProductAlias` (:192) | `(merchant, name_key, store_item_code)` | общая | «написание у продавца → товар»; по ним сопоставляются строки (`recognition/resolution.py:266`, `resolve_product`) |

`backend/recognition/models.py`

| Модель | Уникальность, индексы | Класс | Замечание |
| --- | --- | --- | --- |
| `SourcePhoto` (:19) | `sha256` unique глобально (:23); индекс `(created_at, id)` | **личная** | нужен владелец и `(owner, sha256)` |
| `ProcessingJob` (:49) | один активный на фото (:83) | личная (через фото) | |
| `ReceiptImage` (:117) | `(job, position)` | личная (через задание) | `normalized_result` — полный текст чека |
| `RecognitionAttempt` (:166) | `(job, phase, image, ordinal)` | личная, служебная | сырые ответы модели, в API не отдаётся |

`backend/merges/models.py`

| Модель | Класс | Замечание |
| --- | --- | --- |
| `ProductMerge` (:5), `ProductMergeMember` (:40), `ProductMergeAlias` (:91) | общая | решение о каталоге |
| `ProductMergeLine` (:79) | **спорная** | журнал общего решения ссылается на личные строки чеков всех владельцев |
| `ProductMergeRejection` (:103) | общая | отказ одного человека запрещает пару всем |

`backend/classification/models.py`

| Модель | Класс | Замечание |
| --- | --- | --- |
| `ClassificationRun` (:5) | общая, служебная | не более одного `queued` и одного `running` на всю базу (:53–60); тратит модельные вызовы |
| `ClassificationAttempt` (:86) | общая, служебная | |
| `ProductClassification` (:117), `CreatedGenericProduct` (:220), `CreatedCategory` (:247) | общая | решение о каталоге и его журнал |
| `ClassificationRejection` (:274) | общая | отказ одного действует на всех |

Журналы решений не хранят, кто принял решение или поставил запуск **[код]**.

### Интерфейс и доступ

- `ReadOnlyAPIView` (`backend/api/views/base.py:6–16`): `authentication_classes = []`, `AllowAny`, только GET.
- `LocalAPIView` (`backend/api/views/recognition_base.py:106–111`): `authentication_classes = []`, `LocalRecognitionPermission`.
- `LocalRecognitionPermission` (`backend/recognition/auth.py:12–22`): `DEBUG`, `ALLOW_LOCAL_RECOGNITION_API` и loopback `REMOTE_ADDR`, иначе `permission_denied`; для небезопасных методов — `enforce_csrf` (:25–42).
- Глобально `DEFAULT_PERMISSION_CLASSES = IsAuthenticated` (`backend/config/settings.py:193–194`), но ни одна вью им не пользуется. `django.contrib.auth`, sessions и `AuthenticationMiddleware` подключены (`settings.py:90–112`) — нужны только админке.

| Группа | Маршруты | Вью | Доступ |
| --- | --- | --- | --- |
| health | `GET /api/health/` | `health/views.py:21` | `AllowAny` |
| 13 открытых GET, каталог | `countries`, `stores`, `brands`, `categories`, `categories/{id}`, `generic-products`, `generic-products/{id}`, `products`, `products/{id}` | `api/views/catalog.py` | открыто |
| 13 открытых GET, цены | `products/{id}/prices/`, `…/prices/summary/`, `products/{id}/alternatives/`, `generic-products/{id}/comparison/` | `api/views/prices.py:92`, `:193`; `api/views/compare.py:244`, `:257` | открыто |
| ряды цен | `GET products/{id}/prices/series/` | `api/views/price_series.py:123` | открыто |
| чеки | `GET receipts/`, `receipts/{id}/`, `…/lines/`, `…/discounts/`, `…/taxes/` | `api/views/receipts.py:16–79` | локальный |
| распознавание | `GET recognition/csrf/`; `GET, POST recognition/photos/`; `GET photos/{id}/`; `GET jobs/`, `jobs/{id}/`; `POST jobs/{id}/cancel/`, `retry/`; `GET receipt-images/`, `receipt-images/{id}/`; `POST receipt-images/{id}/confirm/` | `api/views/recognition.py:43–179`, `api/views/recognition_review.py:41` | локальный |
| слияния | `GET product-merges/`, `{id}/`, `{id}/lines/`; `POST detect/`, `{id}/confirm/`, `cancel/`, `exclude/` | `api/views/product_merges.py:127–200` | локальный |
| предположения | `GET product-classifications/`, `{id}/`, `status/`, `runs/`, `runs/{id}/`; `POST confirm/`, `{id}/confirm/`, `{id}/reject/`, `runs/` | `api/views/product_classifications.py:117–212` | локальный |
| статистика | `GET stats/spending/`, `stats/receipts/series/`, `stats/receipts/compare/` | `api/views/stats_spending.py:42`, `api/views/stats_receipts.py:36`, `:118` | локальный |
| MEDIA | `/media/...` | `config/urls.py:16–17`, `static()` только при `DEBUG` | без проверки |
| admin | `/admin/` | `config/urls.py:11` | вход staff |

Ни одна вью не фильтрует по пользователю: объект берётся `get_or_404(Model.objects.all(), pk)` (например `api/views/receipts.py:50`, `api/views/recognition.py:137`, `:179`) **[код]**.

**Что уже сейчас уходит из чеков в открытые GET [код]:**

- `products/{id}/prices/` — на каждую точку `observed_at` (момент покупки до секунды), `purchased_on`, `store`, `quantity`, `discount_amount`, `receipt_id`, `position` (`api/views/prices.py:73–90`);
- `alternatives`, `comparison`, `generic-products/{id}/` — последняя покупка: дата и магазин (`api/views/compare.py:182–187`, `api/views/catalog.py:261–268`);
- `products/{id}/` — `aliases` (написания с чеков по продавцам) и `stores` с числом наблюдений и датой последней покупки (`api/views/catalog.py:351–395`);
- `stores/` — `receipts_count` на магазин (`api/views/catalog.py:87`); `countries/` — пары «страна — валюта» из всех чеков (`:52`);
- `prices/series/` — только агрегаты по интервалам;
- слияния: `product-merges/{id}/lines/` — строки чеков всех владельцев с `receipt_id`, магазином, датой, количеством и суммой (`api/product_merge_serialization.py:80–96`, `merges/services.py:684`).

**Клиент.** Открытые GET идут с `credentials: 'omit'` (`frontend/src/api/http.ts:102`), локальные — с `same-origin` и `X-CSRFToken` из `recognition/csrf/` (`frontend/src/api/local.ts:10`, `:80–81`). Из кодов 403 клиент знает только `csrf_failed` и `permission_denied` (`http.ts:39`); экрана входа, понятия пользователя и обработки 401 нет **[код]**. Экраны: каталог и карточки (`/`, `/catalog`, …), чеки (`/receipts`, `/receipts/{id}`, `/receipts/upload`), задания (`/recognition/jobs`, `/recognition/jobs/{id}`), слияния (`/catalog/merges`, `/catalog/merges/{id}`), предположения (`/catalog/classification`), статистика (`/stats`, `/stats/receipts`), `/health` (`frontend/src/navigation/routes.ts`).

**Admin.** Правка: справочники, магазины, каталог, `Receipt` с inline, `ReceiptLine`, `ProductAlias` (`receipts/admin.py:396–478`). Только чтение: модели `merges` и `classification`. Модели `recognition` не зарегистрированы. Админка видит и правит чеки всех; разграничения внутри неё нет **[код]**.

### Где зашито допущение «пользователь один»

| № | Место | Что сейчас **[код]** | Что сломается при нескольких пользователях |
| --- | --- | --- | --- |
| 1 | Приём файла | `accept_upload` ищет фото по `sha256` глобально (`recognition/storage.py:103`, `:111`); `PhotosView.post` возвращает последнее задание этого фото с `reused: true` (`api/views/recognition.py:74–90`) | Б загрузил тот же файл, что А: получает фото, задание и вырезки А, своего чека не получает. Утечка и потеря |
| 2 | Дедупликация чеков | `find_duplicates` — три уровня по всей таблице (`receipts/dedup.py:78`); `_duplicate` выбирает кандидата (`recognition/importer.py:215`) | чек Б, совпавший с чеком А, привязывается к чеку А: вырезка Б получает `receipt_id` чужого чека, в статистике Б покупки нет |
| 3 | Дополнение найденного чека | `_update_graph` дозаполняет пустые поля существующего чека и возвращает `receipt_conflict` (`importer.py:326`) | фото Б меняет чек А; замечания сообщают Б о содержании чужого чека |
| 4 | Unique на `Receipt` | три глобальных ограничения (`receipts/models.py:36–50`); гонка обрабатывается как «чек уже есть» (`importer.py:486–509`, `recognition/review.py:671–676`) | второму владельцу сохранить такой же чек невозможно физически |
| 5 | Автосоздание магазинов | `resolve_store` создаёт `Merchant` / `Store` и дополняет ИНН и код филиала (`recognition/resolution.py:95`, `:66`) | любой пользователь пишет в общий справочник; ошибка распознавания одного даёт `store_ambiguous` другим. Приемлемо, но это решение |
| 6 | Автосоздание товаров | `resolve_product`: GTIN → написание → имя и упаковка, иначе новый товар в «Не разобрано» (`resolution.py:266`) | общий каталог пополняется из чеков всех — это и требуется для сравнения цен |
| 7 | Очередь распознавания | одно исполняемое задание на всю базу (`recognition/queue.py:93`), FIFO (:95–97) | 50 фото одного задерживают всех; корректность не страдает |
| 8 | Воркер | один на базу, блокировка `WORKER_LOCK` (`recognition_worker.py:46`), один вход в Codex | все модельные вызовы с одного аккаунта; владельца воркер берёт из `job.photo` |
| 9 | `IMPORT_LOCK` | один advisory-ключ на импорт, подтверждение, слияния и предположения (`importer.py:35`, `:469`; `review.py:642`; `merges/services.py:168`; `classification/services.py:214`) | больше отказов `review_busy` и отложенных импортов; корректность сохраняется |
| 10 | `executor.state` | читает блокировку и активные задания без владельца (`api/recognition_serialization.py:179`) | раскрывает только «кто-то распознаёт» — допустимо |
| 11 | MEDIA | пути `originals/{uuid}/…`, `prepared/…`, `crops/…` (`storage.py:108`); раздача `static()` при `DEBUG` без проверки (`config/urls.py:16–17`) | файл читает любой, знающий ссылку; при `DEBUG=0` MEDIA не отдаётся совсем |
| 12 | Списки распознавания | `photos_queryset()`, `jobs_queryset()`, `ReceiptImage.objects` без владельца (`api/views/recognition.py:62`, `:104`, `:168–179`) | все видят фото, задания и `normalized_result` чужих чеков; могут отменить, повторить и подтвердить чужое |
| 13 | Чеки | `receipts_queryset()` — все чеки (`api/recognition_serialization.py:360`) | чужие чеки целиком |
| 14 | Статистика | `stats_common.receipts()` = `Receipt.objects.filter(scope)` (`api/stats_common.py:69–71`) | суммы трат всех вместе. Точка исправления одна |
| 15 | Цены | `price_history()` — все строки-наблюдения; условие `observation_q` (`receipts/prices.py:29–39`) | по замыслу общие; утекают личные поля, см. выше |
| 16 | Слияние дублей | `_absorb` переносит `ReceiptLine.product` у строк всех чеков (`merges/services.py:306`) | решение одного меняет чеки и статистику остальных; экран группы показывает чужие покупки |
| 17 | Предположения | кандидаты — все товары «Не разобрано» (`classification/services.py:287`); один запуск в очереди на базу; автозапуск после импорта (`importer.py:111`) | категория, выбранная одним, действует на всех; запуск любого тратит общий модельный бюджет |
| 18 | Подтверждение `needs_review` | `confirm(image_id, body)` без владельца (`review.py:616`); магазин по id из общего списка (:352) | подтвердить можно чужую вырезку; чек создаётся без владельца |
| 19 | Management-команды | `recognition_worker`, `product_merges`, `product_classifications` работают по всей базе | для каталога верно; воркеру владелец нужен из задания |
| 20 | Seed-демо | `seed_stats_demo`, `seed_product_merge_demo`, `seed_product_classification_demo` создают чеки напрямую (`receipts/demo.py:401`, `merges/demo.py:196`, `classification/demo.py:139`) | с обязательным владельцем упадут; нужен владелец демо. `seed_recognition_demo` создаёт только файлы изображений в `MEDIA/demo`, записей не пишет — его владелец не касается |
| 21 | Тесты | прямые создания `Receipt` и `SourcePhoto` / `accept_upload` в тестах (по оценке подготовки — 23 и 16 мест; число не перепроверялось) | нужен владелец по умолчанию в общих помощниках тестов |
| 22 | Счётчики каталога | `stores/` `receipts_count`, пары «страна — валюта» (`api/views/catalog.py:87`, `:52`) | агрегаты по всем допустимы, но `receipts_count` маленького магазина выдаёт одного покупателя |

## Целевая модель

Весь раздел — **[предположение]**: проект, не подтверждённый запуском. Модель реализована; расхождения с кодом — в разделе [«Реализация»](#реализация-что-сделано-и-чем-отличается-от-проекта), запуском она по-прежнему не подтверждена.

### Владелец

- `Receipt.owner` и `SourcePhoto.owner` — FK на `settings.AUTH_USER_MODEL`, NOT NULL, `on_delete=PROTECT`.
- `ProcessingJob`, `ReceiptImage`, `RecognitionAttempt`, `ReceiptLine`, `ReceiptDiscount`, `ReceiptTax` — без своего поля: владелец через `photo__owner` либо `receipt__owner`.
- Инвариант: вырезка привязывается только к чеку того же владельца. Его даёт дедупликация в пределах владельца; дополнительно закрепить проверкой при сохранении результата импорта и в подтверждении `needs_review`.
- `PROTECT` — чтобы удаление пользователя в админке не стирало чеки каскадом. Удаление аккаунта с данными — отдельная явная процедура, вне v1: по решению 10 пользователь в v1 выключается (`is_active=False`), его чеки и цены остаются.
- Модель пользователя — штатный `auth.User`: миграции `auth` и `admin` уже применены, замена модели задним числом болезненна. Следствие: почта в нём не уникальна; связывание внешнего аккаунта «по почте» решается в задаче на провайдера. Внешний идентификатор провайдера никогда не используется как ключ владения.

### Ограничения и индексы

| Было | Станет |
| --- | --- |
| `SourcePhoto.sha256` unique | unique `(owner, sha256)` |
| `receipts_receipt_fiscal_key_uniq` (`fiscal_key`) | `(owner, fiscal_key)` при непустом ключе |
| `receipts_receipt_store_number_uniq` | `(owner, store, purchased_on, shift_number, register_code, receipt_number)` |
| `receipts_receipt_store_time_total_uniq` | `(owner, store, purchased_at, total)` |
| индекс `(store, purchased_at)` | остаётся для цен; добавить `(owner, purchased_on)` для списка чеков и статистики |
| индекс `rec_photo_created_idx` | добавить `(owner, created_at, id)` |

`rec_job_active_photo_uniq` (один активный на фото) остаётся верным: фото личное. Имена ограничений в `RECEIPT_UNIQUES` (`recognition/importer.py:36–39`) меняются вместе с ограничениями.

Логика: `find_duplicates(receipt_data, owner)`, `accept_upload(upload, owner)`, `_import_domain(..., owner)`; воркер берёт владельца из `job.photo`, подтверждение — из `image.photo`. Меняются `importer.py`, `storage.py`, `dedup.py`, `review.py`; `resolution.py` — нет: магазины и товары общие, владелец в их разрешение не входит.

### Что остаётся общим

`Country`, `Currency`, `TaxRate`, `Merchant`, `Store`, `Category`, `GenericProduct`, `Brand`, `Product`, `ProductAlias`, все модели `merges` и `classification`. В журналы решений добавляется необязательное «кто»: `ProductMerge.resolved_by`, `ProductClassification.resolved_by`, `ProductMergeRejection.created_by`, `ClassificationRejection.created_by`, `ClassificationRun.requested_by` — FK `SET_NULL`, null. На логику не влияет, даёт разбор «кто слил».

### Общие цены без раскрытия чужих чеков

Наблюдение цены уже определено: строка `kind=product`, `quantity > 0`, чек `operation=sale` (`receipts/prices.py:29–39`) **[код]**. Отдельная таблица наблюдений в v1 не заводится — проекция разделяется при чтении:

| Поле | Чужое наблюдение | Своё |
| --- | --- | --- |
| товар, магазин (`store_brief`: вывеска, страна, город), валюта | да | да |
| день покупки `purchased_on` | да | да |
| цена: `paid_unit_price`, `list_unit_price`, `normalized_price`, `normalized_unit`, `unit` | да | да |
| момент покупки `observed_at` | **`null`** (секунда и магазин = конкретный визит) | да |
| `quantity`, `discount_amount` | **`null`** | да |
| `receipt_id`, `position` | **`null`** | да |
| `own` | `false` | `true` |

Скрытые поля отдаются `null`, а не убираются — форма ответов 13 GET сохраняется. В режиме `local_single` все наблюдения свои, значения прежних полей не меняются. Набор скрытых полей принят человеком (решение 4); порога числа покупателей и личного отказа от публикации цен нет. Изменения контракта: поля становятся nullable и появляется поле `own`.

Отдельная таблица наблюдений дала бы независимость цен от чека, но требует синхронизации при каждом слиянии, отмене слияния и правке чека в админке — после v1.

Двойной учёт: один кассовый чек у двух владельцев даёт два наблюдения. На цену это не влияет, только на `count`; схлопывание по `fiscal_key` — после v1.

### Риски приватности

Пересмотрены с учётом публичного сервера и круга «друзья и знакомые».

- **Сервер в интернете.** Страница входа, `/admin/` и API доступны любому, кто узнал адрес. Запрет индексации адрес не прячет: это просьба к поисковикам, а домен находят и без них (например, по журналам выданных сертификатов — общее знание, не перепроверено). Данные защищает только вход (решение 8): все маршруты, кроме `health`, требуют сессии. Защита от перебора пароля обязательна и должна действовать и на вход в админку; валидаторы паролей уже включены (`backend/config/settings.py:199–204`) **[код]**.
- **Пользователи знают друг друга.** «Чужое» наблюдение — магазин, день и цена. При нескольких пользователях и редком магазине его легко приписать конкретному знакомому; скрытие id чека этого не лечит. Человек это принял (решение 4): пользуются только друзья, порога и личного отказа нет. Об этом надо сказать каждому при выдаче учётной записи.
- **Магазин как след.** Новый магазин появляется в `stores/` сразу после чужого чека. В v1 `receipts_count` считается по своим чекам.
- **Написания.** `aliases` показывают текст с чужих чеков по продавцу — сведения о товаре, не о человеке; риск низкий.
- **Юридическое название.** `Merchant.legal_name` ИП — ФИО; наружу не отдаётся, в админке видно.
- **Слияния и модераторы.** Модератор видит в группе слияния строки покупок всех владельцев (магазин, дата, количество, сумма) без `receipt_id` чужих — принято (решение 6). Модераторов, скорее всего, несколько (решение 5): каждый видит эти строки, а его решение меняет товары и категории в чеках и статистике всех. `resolved_by` в журналах сохраняет след.
- **Админка и оператор.** Staff видит все чеки и `raw_text` — принято (решение 11). Отсюда правило: `is_staff` получает только оператор сервера; модератору каталога он не нужен.
- **Хостинг и резервные копии.** Диск арендованного сервера и копии базы и MEDIA содержат фото чеков и полный текст чеков всех пользователей. Копии хранятся с той же защитой, что и сервер; доступ хостинг-провайдера к диску — остаточный риск, v1 его не снимает.
- **Последовательные id и ссылки на файлы.** Чужой объект отвечает `404` тем же телом, что несуществующий; файл MEDIA отдаётся только через проверку владельца, обратный прокси каталог MEDIA напрямую не раздаёт.
- **Модель.** Предположения категорий отправляют модели названия, бренды и вывески, без цен и чеков (`classification/context.py:1–4`) **[код]**; распознавание отправляет фото чека. На общем сервере это фото чеков всех пользователей, уходящие провайдеру модели под одним входом Codex (решение 7, открытый вопрос 1), — об этом тоже надо сказать пользователям.
- **Журналы.** Журнал обратного прокси хранит адреса и пути запросов всех пользователей; срок хранения выбирает оператор.
- **`health` без входа.** Раскрывает состояние сервисов, не данные.

## Подтверждения в общем каталоге

Подтверждение `needs_review` — не вопрос каталога: это личное действие над своей вырезкой, создаёт свой чек; доступ — владельцу вырезки. Побочно оно, как и импорт, пополняет общие магазины и товары.

Для слияний дублей и предположений категорий:

| Вариант | Плюсы | Минусы |
| --- | --- | --- |
| **А. Любой вошедший правит общий каталог** | ноль новых моделей; код уже так работает; каталог чистится силами всех | ошибка или вредительство одного меняет чеки и статистику всех (перенос строк); отказ одного навсегда запрещает пару или вариант; экран группы показывает чужие покупки; любой запускает модельные вызовы |
| **Б. Только модератор (право Django)** | безопасно и предсказуемо; объём — один класс права и скрытие экранов; автоматика по-прежнему применяет предварительно и ставит «требует подтверждения», обычный пользователь видит пометку | узкое место: пока модератор не разобрал, у всех товары в «предварительных» категориях; нужен хотя бы один модератор |
| **В. Личные переопределения поверх общего каталога** | никто никому не мешает | самый большой объём: новые модели, наложение в каждом запросе каталога, цен и статистики; сравнение цен всё равно требует одного общего отображения; противоречит «каталог общий» |
| **Г. Предлагают все, утверждает модератор** | пользователи помогают, каталог защищён | второй слой «предложение пользователя» поверх «предложения автомата»; два уровня статусов |

**Решение v1 — Б, сделанный правом, а не жёсткой ролью.** Одно право Django (рабочее имя `catalog.moderate`; точное имя и модель, на которой оно объявлено, выбирает реализация — объявление права даёт миграцию) проверяется на всех мутациях `product-merges` и `product-classifications` и на запуске поиска и предположений. По решению 5 право выдаёт администратор (в админке, пользователю либо группе), и получат его, скорее всего, несколько человек; суперпользователь имеет его без выдачи — так устроены права Django. В `local_single` право есть у личности запроса `local`. `resolved_by` в журналах сохраняет след. Чтение списков и записей остаётся всем вошедшим: оно нужно пометкам «требует подтверждения» в каталоге.

Покупки группы (`product-merges/{id}/lines/`): модератор видит строки всех владельцев, но `receipt_id` — только у своих (у чужих `null`); принято человеком (решение 6).

## Миграция существующих данных и откат

**[предположение]**; проверяется в QA на копии данных.

**Кому достаются нынешние данные (решение 9).** Миграция создаёт пользователя с фиксированным именем `local`, без пригодного пароля, и приписывает ему все `Receipt` и `SourcePhoto`. Причины: миграция обязана пройти на пустой и на тестовой базе, где настоящих пользователей нет; вариант «отдать первому суперпользователю» зависит от состояния базы и на пустой базе не определён.

**Роль `local` в двух режимах.**

- В `accounts` это обычная учётная запись. Войти под ней нельзя, пока человек не задаст пароль: `manage.py changepassword local` либо админка. После этого человек входит под `local` и видит все прежние чеки. Отдельной «служебной» природы у записи нет; имя — только историческое.
- В `local_single` это личность запроса без входа: пароль не используется, сессия для API не учитывается.

Противоречия нет: запись одна, режимы различаются только тем, как запрос её получает. Решения при подготовке, человек может изменить: `local` создаётся активным (`is_active=True`; без пригодного пароля вход всё равно невозможен), без `is_staff` и `is_superuser` — права администратора и модератора в `accounts` человек выдаёт ему сам, как любому пользователю.

**Команды передачи владения в v1 нет.** Прежний проект предлагал `ownership transfer --from local --to <user>`; раз человек входит под самой записью `local`, передавать нечего. Повторный импорт не требуется. Человек допускает и его: нынешние данные не ценны, поэтому, если перенос базы на сервер (открытый вопрос 4) окажется трудным, сервер начинает с пустой базы.

**Шаги.**

1. Миграция 1 (`receipts`, `recognition`): `owner` nullable и индексы. Обратима удалением колонки.
2. Миграция 2: `RunPython` — создать `local`, проставить `owner` там, где NULL. Обратное действие — noop.
3. Миграция 3: `owner` NOT NULL; добавить ограничения с владельцем, затем убрать старые — в таком порядке, чтобы не было окна без уникальности.
4. Файлы MEDIA не трогаются: владельца в путях нет.

**Откат** (`migrate receipts <prev>`, `migrate recognition <prev>`) восстанавливает глобальные ограничения и упадёт, если у двух владельцев есть одинаковый чек или фото, — а при нескольких пользователях это ожидаемое состояние (решение 3). Поэтому команда-проверка остаётся и без команды передачи: по образцу `cancel-pending` перед `migrate merges zero` нужна `ownership check-rollback` (рабочее имя), перечисляющая такие пары; откат допустим, только пока её вывод пуст. Откат также стирает сведения о владельце: после него все чеки снова общие, поэтому на сервере с несколькими пользователями он означает возврат к резервной копии, а не штатную операцию. Перед миграцией — `pg_dump` и копия MEDIA; тома не удалять.

**Совместимость.**

- **F4/F6.** Проверки formset админки работают с ключами `(receipt, position)` и `(receipt, tax_rate)` и блокировкой inline ([data-model.md](data-model.md#конкурентные-правки)); владелец в эти ключи не входит. В форму чека добавляется обязательное поле `owner` и фильтр списка по владельцу. Ожидание: тесты F4/F6 проходят без изменения логики, с владельцем в исходных данных — проверяется запуском в QA.
- **13 GET.** Форма ответов не меняется; в `local_single` значения прежние и вход не нужен. В `accounts` они требуют входа (решение 8); при нескольких владельцах — `null` в личных полях чужих наблюдений и `own`.
- **`recognition/resolution.py`** не меняется.
- **`merges`, `classification`.** Только добавление nullable-полей «кто» и, возможно, объявление права — данных не касается.
- Уже применённые миграции не переписываются.

## Изменения API-контракта и клиента

**[предположение]**. Имена новых маршрутов, кодов и настроек — рабочие; окончательные зафиксированы в [api-contract.md](api-contract.md#реализовано-пользователи-вход-и-доступ-по-владельцу).

### Режимы и определение пользователя запроса

Одна точка проверки доступа вместо `LocalRecognitionPermission` отвечает «кто пользователь» и «можно ли». Режим задаётся явной настройкой (рабочее имя `CHECKIST_AUTH_MODE`):

- **`accounts`** — основной режим, в нём работает публичный сервер. Пользователь берётся из сессии Django. Доступ не зависит ни от `DEBUG`, ни от адреса запроса, ни от `ALLOW_LOCAL_RECOGNITION_API`: loopback-исключения нет. Без входа — `401 not_authenticated` (новый код) в едином формате ошибок на всех маршрутах API, включая 13 GET каталога и цен и `prices/series/` (решение 8). Анонимными остаются только `health`, вход и выдача CSRF-токена.
- **`local_single`** — режим разработки и локальных проверок, не способ работы человека. Нынешнее правило: `DEBUG`, `ALLOW_LOCAL_RECOGNITION_API=1` и loopback, иначе `403 permission_denied`, как сейчас. Запрос получает пользователя `local` со всеми правами, включая модератора; сессия для API не учитывается; 13 GET анонимны. Поведение и ответы — как сегодня, поэтому существующие тесты и proxy-скрипты локального API проходят в нём без изменения ожиданий.

Решения при подготовке, человек может изменить:

- Без настройки действует `accounts`: забытая переменная на сервере закрывает данные, а не открывает. `.env.example` и QA-окружение задают `local_single` явно.
- `local_single` при `DEBUG=0` — ошибка запуска, а не молчаливый отказ. Причина: за обратным прокси на том же сервере `REMOTE_ADDR` каждого запроса — loopback (`backend/recognition/auth.py:15`) **[код]**, и сервер, по ошибке запущенный в `local_single` с `DEBUG=1`, отдал бы всё всем. Запрет на `DEBUG=0` и безопасное значение по умолчанию закрывают эту ошибку с двух сторон.

Почему явная настройка, а не «сессия, иначе локальный режим»: cookie не различают порты, сессия админки на `127.0.0.1:8000` и SPA на `127.0.0.1:5173` — одна `sessionid`. При неявном правиле вход в админку на машине разработчика молча переключал бы SPA с данных `local` на пустые данные администратора. В `accounts` это же свойство означает «вход в админку = вход в приложение» — человек это принял (решение 12), поведение покрывается тестом.

CSRF для небезопасных методов остаётся (`recognition/auth.py:25–42`), `recognition/csrf/` продолжает выдавать токен; точный `Origin` клиента — по-прежнему в `DJANGO_CSRF_TRUSTED_ORIGINS`, на сервере это `https://<домен>`.

### Вход

- Новые JSON-маршруты (рабочие имена): `POST /api/auth/login/`, `POST /api/auth/logout/`, `POST /api/auth/password/` (смена своего пароля), `GET /api/me/` (пользователь, режим, право модератора).
- Пользователей заводит администратор (админка либо `createsuperuser` / команда); открытой регистрации нет (решение 2). Первый пароль администратор передаёт человеку лично, тот меняет его после входа. Сброс забытого пароля — администратором: почты в v1 нет.
- Выход завершает сессию; смена пароля завершает остальные сессии пользователя (штатное поведение Django: хэш пароля входит в сессию). Неактивный пользователь не входит, его открытые сессии перестают действовать (решение 10).
- Сессионная cookie `HttpOnly`, `SameSite=Lax`; на сервере — ещё и `Secure`. JWT не нужен: SPA и API на одном origin (на сервере — за одним обратным прокси, в разработке — через Vite proxy).
- **Защита от перебора пароля обязательна**: сервер публичный. Задержка либо временная блокировка после нескольких неудач по паре «логин и адрес клиента»; способ выбирает реализация без новых зависимостей (счётчик можно держать в уже подключённом кэше Redis, `settings.py:156–166` **[код]**). Действует и на вход в админку — то есть ставится на уровне проверки пароля, а не одной вью. Отказ не сообщает, существует ли логин. Адрес клиента за прокси берётся из заголовка прокси, см. [развёртывание](#развёртывание-на-публичном-сервере).
- Вход через Google — после v1; модель данных от него не зависит.

### Что фильтруется по владельцу

| Эндпоинты | Изменение |
| --- | --- |
| `receipts/` и четыре вложенных | queryset по `owner`; чужой id → `404` |
| `recognition/photos/`, `jobs/`, `receipt-images/` и детали | по `photo__owner`; `POST photos/` ставит владельца; повтор файла — только среди своих фото |
| `jobs/{id}/cancel/`, `retry/`, `receipt-images/{id}/confirm/` | чужой объект → `404` |
| `stats/*` | `stats_common.receipts()` по `owner`; фильтр `store` — общий справочник |
| `product-merges/*`, `product-classifications/*` | чтение — вошедшим; мутации и запуск — по праву модератора, иначе `403 permission_denied` |
| `product-merges/{id}/lines/` | свои строки полностью, у чужих `receipt_id` = `null` |
| 13 GET и `prices/series/` | в `accounts` требуют входа (`401` без него); форма прежняя; личные поля чужих наблюдений `null`, признак `own`; `stores/` `receipts_count` — по своим чекам |
| `/media/…` | вместо `static()` — вью с проверкой владельца по пути (фото → `SourcePhoto`, вырезка → `ReceiptImage`); чужой файл и запрос без входа → `404`; работает при `DEBUG=0`; обратный прокси каталог MEDIA сам не раздаёт |
| `health` | без изменений, анонимно в обоих режимах |

**404 против 403.** На чужой объект — `404` тем же телом, что на несуществующий: id последовательные, ответ не должен подтверждать существование. Это согласуется с проектом: поглощённые слиянием товары уже отвечают `404`. Фильтры списков с чужим id (`?photo=`, `?receipt=`, `?job=`) дают пустой список, не ошибку. `403` — только «объект общий и виден, но действие требует права».

### Клиент

- В `accounts` входа требует всё приложение, кроме экрана входа и `/health`: каталог и карточки (`/`, `/catalog`, …), чеки, задания, статистика (решение 8). Гость, открывший любой адрес, попадает на вход и после него возвращается на исходный адрес.
- Требуют права модератора: `/catalog/merges`, `/catalog/merges/{id}`, `/catalog/classification`. Пометки «требует подтверждения» в каталоге видны всем вошедшим, ссылки на экраны и кнопки действий — только модератору.
- Новое: экран входа, выход и смена своего пароля; текущий пользователь и его права из `GET /api/me/`; обработка `401` в `frontend/src/api/http.ts` с переходом на вход и возвратом на исходный адрес; `credentials: 'same-origin'` для прежних открытых GET (сейчас `omit`, `http.ts:102`); сообщение о задержке либо блокировке входа; в истории цен — различие «моя покупка / чужая» и отсутствие ссылки на чек у чужих; схемы ответов с nullable-полями и `own`.
- В `local_single` экран входа не показывается, интерфейс прежний.
- Собранный SPA на сервере раздаёт обратный прокси, а не Vite; адреса приложения — пути того же домена, `VITE_API_BASE_URL=/api` остаётся (`.env.example:14`) **[код]**.

## Развёртывание на публичном сервере

**[предположение]**, кроме строк с пометкой **[код]**. Настройки, файлы служб и инструкция сделаны — [deployment.md](deployment.md); колонка «Сейчас» в таблице ниже — состояние до реализации. Сервера, домена и входа Codex на сервере на момент написания нет; **ничего из этого раздела не запускалось и не проверялось**. Решение 1: арендованный сервер, свой домен, публичный адрес, без индексации и рекламы.

### Что есть сейчас и что требуется

| Тема | Сейчас **[код]** | Требуется в v1 |
| --- | --- | --- |
| Работа при `DEBUG=0` | `DJANGO_DEBUG` по умолчанию `1` (`backend/config/settings.py:70–73`). Локальные API требуют `DEBUG`, флаг и loopback (`backend/recognition/auth.py:12–22`); `/media/` отдаётся только при `DEBUG` (`backend/config/urls.py:16–17`). При `DEBUG=0` запуск уже отказывает с dev-ключом (`settings.py:75–77`) | Сервер работает только с `DEBUG=0` в режиме `accounts`: доступ определяет сессия, а не `DEBUG` и не адрес. `manage.py check --deploy` — без предупреждений либо с перечисленными и объяснёнными |
| `ALLOWED_HOSTS` | Из `DJANGO_ALLOWED_HOSTS`, по умолчанию `127.0.0.1,localhost`, шаблоны запрещены (`settings.py:79–83`) | Домен сервера в окружении; код проверки менять не нужно |
| `DJANGO_CSRF_TRUSTED_ORIGINS` | Принимает только `127.0.0.1`, `localhost`, `::1` и требует порт (`settings.py:282–296`) | Принимать `https://<домен>` без порта для хостов из `ALLOWED_HOSTS`; правило для loopback остаётся разработке. Схема `http` для не-loopback не принимается |
| HTTPS и обратный прокси | Нет. `SecurityMiddleware` подключён (`settings.py:108`), но ни одной настройки `SECURE_*`, `SESSION_COOKIE_*`, `CSRF_COOKIE_*` в `settings.py` нет; Django запускают `runserver` на loopback (`docs/development.md:88`) | TLS завершает обратный прокси на том же сервере, Django слушает только loopback. Перенаправление `http → https`. `SESSION_COOKIE_SECURE`, `CSRF_COOKIE_SECURE`, HSTS (`SECURE_HSTS_SECONDS`; начать с малого срока, поднять после проверки). Доверие заголовку прокси о схеме (`SECURE_PROXY_SSL_HEADER`) включается настройкой окружения и только вместе с прокси, который этот заголовок перезаписывает |
| Сервер приложений | Нет: в `backend/requirements.in` нет WSGI/ASGI-сервера, `backend/Dockerfile:11` запускает только Celery; `runserver` для публичного сервера не предназначен | Нужен сервер приложений — **новая зависимость**, вынужденное исключение из «без новых зависимостей»; выбор — открытый вопрос 2 |
| SPA и статика | Vite dev и preview слушают `127.0.0.1` и проксируют `/api` и `/media` (`frontend/vite.config.ts:8–17`, `:27–28`); каталога `frontend/public` нет; `STATIC_ROOT` не задан, `STATIC_URL = "static/"` (`settings.py:209`) | `npm run build` → собранный SPA раздаёт прокси, с отдачей `index.html` на адреса приложения. `STATIC_ROOT` и `collectstatic` — статика админки, её тоже раздаёт прокси. `/api`, `/admin`, `/media` прокси передаёт Django без изменения пути. Vite на сервере не запускается |
| MEDIA | `static()` при `DEBUG`, без проверки (`config/urls.py:16–17`); префикс `/media/` фиксирован (`settings.py:250–254`) | Вью с проверкой владельца (этап С3), работает при `DEBUG=0`; прокси каталог MEDIA сам не раздаёт. Лимит тела запроса на прокси не меньше 20 МБ (`RECEIPT_IMAGE_MAX_BYTES`, `settings.py:279`), иначе загрузка фото оборвётся до Django |
| Вход | Экрана входа, защиты от перебора, смены пароля в API нет; вход есть только в админке | Защита от перебора (обязательна), смена пароля, выход — этап С3, раздел [«Вход»](#вход). Адрес клиента для счётчика берётся из заголовка прокси, и только когда доверие прокси включено настройкой: иначе все запросы приходят с loopback и блокировка одного закрывает вход всем |
| Запрет индексации | Нет ни `robots.txt`, ни заголовка | `robots.txt` с `User-agent: *` / `Disallow: /` и заголовок `X-Robots-Tag: noindex, nofollow` на **все** ответы: страницы, API, админку, MEDIA, статику, ошибки. Заголовок ставит и Django (middleware), и прокси для того, что он раздаёт сам. **Это просьба к поисковикам, а не защита**: данные защищает вход (решение 8) |
| Секреты и настройки | `.env` из корня читает `load_dotenv` (`settings.py:15`); значения разработки: ключ `dev-only-…`, пароль базы `checkist_dev_only` (`settings.py:74`, `:148`; `compose.yaml:7`; `.env.example`) | Всё через окружение сервера: свой `DJANGO_SECRET_KEY`, свой пароль базы, домен, режим, флаги. Файл окружения вне репозитория, читается только пользователем службы. `.env.example` получает закомментированный блок серверных настроек |
| Сеть | Postgres и Redis в Compose опубликованы только на loopback (`compose.yaml:9`, `:22`) | Так и остаётся; наружу открыты только 80/443 прокси и SSH |
| Резервные копии | Нет; есть только совет `pg_dump` перед миграцией | Инструкция и скрипт: `pg_dump` базы и архив MEDIA по расписанию, копия вне сервера, проверенное восстановление. Scratch распознавания не копируется. Где и как часто — открытый вопрос 5 |
| Фоновые сервисы | Compose: Postgres, Redis, Celery-воркер для `health` (`compose.yaml`) | То же на сервере; `health` анонимен и показывает состояние сервисов |
| Распознавание | Host-команда `recognition_worker` рядом с Codex CLI и входом существующего пользователя хоста; API и воркер делят одну базу и один MEDIA (`docs/architecture.md:5`, `:89`; `docs/development.md:110`; [AGENTS.md](../AGENTS.md)) | Отдельный риск, см. ниже; открытый вопрос 1 |

Итог реализации этапа — настройки, файлы конфигурации прокси и служб и инструкция `docs/deployment.md` (рабочее имя). Кто выполняет развёртывание на самом сервере — открытый вопрос 3.

### Риск: распознавание на сервере

Воркер распознавания не вызывает модель по API-ключу: он запускает Codex CLI под входом пользователя хоста и должен видеть ту же базу и тот же MEDIA, что и API **[код]** (ссылки в таблице выше). На домашнем компьютере это вход человека. На арендованном сервере такого входа нет, и вместе с распознаванием не работают предположения категорий: их исполняет тот же воркер.

| Вариант | Что нужно | Риски и неизвестное |
| --- | --- | --- |
| **А. Вход Codex на сервере** | Codex CLI на сервере, вход под отдельным пользователем ОС, `recognition_worker` — служба рядом с базой и MEDIA | Как выполнить вход на сервере без браузера — **не проверено**. Файл входа — секрет уровня пароля, лежит на публичном сервере. Лимит одной подписки тратят все пользователи (решение 7: лимитов нет); допускают ли это условия подписки — **не проверено**. Работа воркера с настоящим Codex на Linux-сервере в рамках этого документа **не проверялась**; POSIX watchdog исключён облегчённой v1 |
| **Б. Воркер на домашнем компьютере** | Сервер хранит базу и MEDIA, воркер дома: защищённый канал к Postgres сервера (сейчас он слушает только loopback) и общий доступ к MEDIA — воркер читает оригиналы и пишет подготовленные файлы и вырезки | Вход Codex остаётся дома и не попадает на сервер. Но MEDIA — обычный каталог, сетевого хранилища в проекте нет: нужна сетевая файловая система либо синхронизация, это отдельная работа. Запросы воркера рассчитаны на локальную базу (`statement_timeout` 2 с, `settings.py:152`; аренда задания 30 с, сигнал каждые 5 с) — поведение через интернет **не проверено**. Распознавание идёт, только пока домашний компьютер включён |
| **В. Сервер без распознавания** | Ничего | Загруженные фото остаются в очереди, `executor.state` — `absent`; чеки вносятся только через админку. Это состояние сервера до решения вопроса, а не цель |

**Значение по умолчанию — А**; до подтверждения входа Codex на сервере действует В, остальное приложение от этого не зависит. Вопрос вынесен человеку (открытый вопрос 1).

## Этапы реализации

Оценки — **оценки, не замер**: порядок величины в рабочих днях одного исполнителя, без QA-прогонов и без времени человека на сервер и приёмку. Сумма по этапам — 18–23 дня (до решений человека было 13–18: добавился этап развёртывания, вход получил защиту от перебора и смену пароля, клиент — закрытый каталог; команда передачи владения убрана). Самая ненадёжная оценка — этап П: она не включает вариант Б распознавания.

| Этап | Содержание | Зависит от | Оценка |
| --- | --- | --- | --- |
| **С1. Модель и миграция** | `owner` в `Receipt` и `SourcePhoto`; три миграции; пользователь `local`; ограничения с владельцем; помощники тестов и три seed-демо с чеками получают владельца; admin: поле и фильтр; команда `ownership check-rollback` | — | 2–3 дня |
| **С2. Импорт и дедупликация по владельцу** | `accept_upload`, `find_duplicates`, `_import_domain`, `_update_graph`, `review.confirm`; воркер берёт владельца из задания; проверка «вырезка и чек одного владельца» | С1 | 2–3 дня |
| **С3. Доступ и вход** | режимы `accounts` / `local_single` и точка проверки доступа; вход, выход, смена пароля, `GET /api/me/`; защита от перебора, включая админку; `401` на всё, кроме `health`; фильтрация чеков, распознавания, статистики; `404` на чужое; право модератора на слияния и предположения; `resolved_by`; вью MEDIA | С2 | 4–5 дней |
| **С4. Общие цены** | проекция «своё / чужое» в `prices/`, `alternatives`, `comparison`, `products`, `stores`, покупки группы слияния; признак `own` | С3 | 2 дня |
| **К1. Клиент** | вход, выход, смена пароля, `401`, вход обязателен для всего приложения, скрытие экранов модератора, «моя / чужая» в ценах, новые схемы ответов | С3, С4 | 3–4 дня |
| **П. Развёртывание** | настройки для `DEBUG=0` за прокси (CSRF-origin домена, secure-cookie, HSTS, доверие заголовку прокси); сервер приложений; конфигурация прокси: HTTPS, SPA, статика, передача `/api`, `/admin`, `/media`; `robots.txt` и `X-Robots-Tag`; службы Django и воркера; скрипт резервной копии; `docs/deployment.md`; распознавание на сервере по решению вопроса 1 | С3 (доступ по сессии, MEDIA); К1 — для собранного SPA; открытые вопросы 1–5 | 3–4 дня |
| **И. Итог** | документы (`data-model`, `api-contract`, `frontend`, `development`, `architecture`, `verification`, этот файл — статус), proxy-скрипт с двумя сессиями, документы ручной приёмки интерфейса и сервера | все | 2 дня |

Этапы С4 и серверная часть П после С3 независимы и могут идти параллельно.

### Критерии готовности и план проверок

Тесты, миграции, демо и proxy-скрипты запускает QA в окружении из [verification.md](verification.md) с `RECEIPT_OCR_PROVIDER=fake`, `PRODUCT_MERGE_AUTO_DETECT=0`, `PRODUCT_CLASSIFICATION_AUTO_SUGGEST=0`. На машине с `codex.exe` в PATH и выполненным входом запуск с `codex_cli` делает настоящий модельный запрос.

**С1.** Миграции применяются на пустой базе и на копии dev-базы; после них все чеки и фото у `local`; под `local` нельзя войти, пока не задан пароль, и можно после `changepassword`; откат проходит, пока `check-rollback` пуст, и отказывает при двух владельцах одного чека. Существующие наборы backend (на main после слияния статистики — 486 без БД / 1618 integration) зелёные без изменения ожиданий, только владелец в исходных данных; отдельно F4/F6 в `receipts`. `makemigrations --check --dry-run` чист.

**С2.** Сценарии изоляции:

- двое загрузили один и тот же файл → два фото, два задания, два чека, у второго `reused: false`;
- двое загрузили разные фото одного кассового чека (одинаковый `fiscal_key`) → два чека, никто не привязан к чужому;
- повторное фото своего чека → как сейчас: `reused` / `updated`, без дублей строк;
- гонка двух владельцев на одном чеке не даёт `IntegrityError` и `identity_conflict`;
- подтверждение `needs_review` создаёт чек владельца вырезки; найденный существующий чек — только свой.

**С3.** Матрица «эндпоинт × {аноним в `accounts`, владелец, другой пользователь, модератор, `local_single`}» по всем маршрутам таблицы интерфейса, включая 13 GET и `prices/series/`: ожидаемые `401` / `200` / `404` / `403`; та же матрица при `DEBUG=0`. Отдельно:

- списки не содержат чужого; фильтр с чужим id даёт пустую страницу;
- статистика двух пользователей на одной базе не складывается, эталоны `backend/api/tests/fixtures/stats/` для одного владельца не меняются;
- MEDIA чужого фото и запрос без входа → `404`, в том числе при `DEBUG=0`;
- `local_single` проходит существующие тесты локального API без изменений; `local_single` при `DEBUG=0` — отказ запуска; без настройки режима — `accounts`;
- вход, выход, «кто я», неверный пароль, неактивный пользователь, выключение пользователя при открытой сессии, смена пароля и завершение остальных сессий, CSRF на каждом небезопасном маршруте;
- перебор: после заданного числа неудач — задержка либо блокировка и в API, и в админке; ответ не различает «нет логина» и «неверный пароль»; удачный вход с другого адреса не блокируется чужими неудачами;
- общая cookie админки и SPA; число запросов не растёт (`assertNumQueries`).

**С4.** Эталоны 13 GET для одного владельца прежние (кроме добавленного `own`); для двух — у чужих наблюдений `null` в личных полях и `own: false`; агрегаты (`summary`, `series`, `comparison`) учитывают обоих. Перебор полей по эталонам: ни один ответ не содержит `receipt_id` чужого чека; у модератора в покупках группы слияния `receipt_id` только у своих строк.

**К1.** Существующие frontend-тесты (на main — 2741 / 72 файла) зелёные в `local_single`; новые — вход и выход, смена пароля, гость на любом адресе попадает на вход и возвращается, `401` в середине сеанса с возвратом на адрес, скрытие экранов без права, чужое наблюдение без ссылки на чек; `lint` и `build`. **Интерфейс принимает человек** по документу ручной приёмки: две учётные записи в двух браузерных профилях. Автоматизация браузера запрещена правилами проекта.

**П.** Две группы проверок.

- *В QA-окружении, без сервера (автотесты и команды):* запуск отказывает при `DEBUG=0` с dev-ключом и при `DEBUG=0` с `local_single`; `DJANGO_CSRF_TRUSTED_ORIGINS` принимает `https://<домен>` и отвергает `http` не-loopback, путь, шаблон; при включённых серверных настройках cookie сессии и CSRF имеют `Secure`, ответ несёт HSTS, заголовок прокси о схеме учитывается только при включённом доверии; `X-Robots-Tag` есть на ответах API, админки, MEDIA и на `401` / `404`; `robots.txt` отдаёт запрет; `manage.py check --deploy` — exit 0, предупреждения перечислены; `collectstatic` и `npm run build` — exit 0; скрипт резервной копии создаёт дамп и архив, восстановление в отдельную базу и каталог проходит.
- *На сервере (вручную, по `docs/deployment.md`; автотестами не закрывается):* сайт открывается по `https://<домен>`, `http` перенаправляет; в ответе есть HSTS и `X-Robots-Tag`, `/robots.txt` отдаёт запрет; cookie `Secure`; вход двух учётных записей с разных устройств, загрузка фото с телефона (20 МБ проходит через прокси); чужое фото по прямой ссылке — `404`; Postgres и Redis снаружи недоступны; после перезагрузки сервера службы поднимаются сами; резервная копия снята и восстановлена; после решения вопроса 1 — распознавание одного настоящего чека на сервере.

Что не проверено и не будет проверено автотестами: сам сервер, домен, сертификат, вход Codex на сервере, поведение поисковиков.

**И.** Существующие proxy-скрипты (`check_recognition_proxy.mjs`, `check_review_proxy.mjs`, `check_stats_proxy.mjs`, `check_product_merges_proxy.mjs`, `check_product_classifications_proxy.mjs`) в `local_single` без изменений; новый скрипт с двумя сессиями на изоляцию в `accounts` через Vite dev и preview. Отчёт — «прошло / не прошло / не проверено и почему» с командами и exit-кодами.

Остаётся человеку и автотестами не закрывается: вид и поведение экрана входа, cookie в браузере, вход с другого устройства, всё перечисленное в группе «на сервере».

## Решения человека (2026-10-07)

Человек ответил на все 12 вопросов прежнего раздела «Открытые вопросы человеку». Номера — прежние; на них ссылается остальной текст («решение N»). Это решения: реализация их не переспрашивает.

| № | Вопрос | Решение |
| --- | --- | --- |
| 1 | Сценарий развёртывания | Арендованный сервер, свой домен, публичный сервер; он не индексируется и не рекламируется в поисковиках |
| 2 | Кто пользователи | Друзья и знакомые; открытой регистрации нет |
| 3 | Один кассовый чек у двоих | Две личные покупки |
| 4 | Что видно из чужой покупки | Как рекомендовано: скрыты id чека, позиция, точное время, количество и скидка; порога и личного отказа нет — пользуются только друзья |
| 5 | Кто правит каталог | Право модератора каталога выдаёт администратор; скорее всего, его получат несколько человек |
| 6 | Покупки в группе слияния | Как по умолчанию: модератор видит строки чужих чеков, но `receipt_id` — только у своих |
| 7 | Лимит модели | Лимитов на модельные вызовы пока нет |
| 8 | Каталог и цены без входа | Закрыты: пользоваться могут только те, у кого есть аккаунт. `health` остаётся анонимным |
| 9 | Нынешние данные | Не ценны: человек всё равно будет импортировать много чеков и может импортировать эти повторно, если это значительно облегчит разработку; иначе — перенести их на аккаунт `local`, которому он сам задаст пароль и под которым войдёт |
| 10 | Удаление пользователя | Как по умолчанию: в v1 удаления нет, пользователь выключается, данные остаются |
| 11 | Оператор сервера видит чеки всех в админке | Допустимо |
| 12 | Вход в админку = вход в приложение (общая cookie) | Устраивает |

### Следствия, принятые при подготовке

- **По решению 9 выбран перенос на `local`**, а не повторный импорт: миграция с переносом нужна в любом случае (она обязана пройти на непустой базе), так что повторный импорт разработку не облегчает. Команда передачи владения убрана; команда-проверка перед откатом оставлена — без неё откат при нескольких пользователях небезопасен.
- **Вход v1 прежний:** логин и пароль `django.contrib.auth`, пользователей заводит администратор, сессионная cookie и CSRF, без новых зависимостей для входа. Вход через Google — следующий шаг после v1; публичный домен снимает прежнее препятствие.
- **Основной режим — `accounts`** на публичном сервере; `local_single` — режим разработки и локальных проверок.
- **Развёртывание — этап v1** («П»).
- По решению 7: один вход Codex на всех (где он находится — открытый вопрос 1); флаги автозапуска поиска дублей и предположений остаются настройками со значением по умолчанию `0`.

Помечено в тексте как «решение при подготовке, человек может изменить»: `local` создаётся активным и без прав администратора; без настройки режима действует `accounts`; `local_single` при `DEBUG=0` — ошибка запуска.

## Открытые вопросы

> Реализация пошла по значениям по умолчанию: вопрос 2 — gunicorn и Caddy, вопросы 1 и 3–5 — как в колонке «По умолчанию», порядок действий — в [deployment.md](deployment.md). Человек может ответить иначе; на сервере ничего из этого не проверено.

Только то, что появилось из-за решений человека. У каждого — значение по умолчанию: с ним пойдёт реализация, если человек не ответит иначе. Вопросы 1–3 нужны до начала этапа П, этапам С1–К1 они не мешают.

| № | Вопрос | По умолчанию |
| --- | --- | --- |
| 1 | **Распознавание на сервере:** вход Codex на сервере (вариант А) или воркер на домашнем компьютере с доступом к базе и MEDIA сервера (вариант Б)? См. [риск](#риск-распознавание-на-сервере) | Вариант А: Codex CLI и вход на сервере под отдельным пользователем ОС, воркер — служба там же. Пока вход на сервере не подтверждён — сервер работает без распознавания (вариант В). Ничего из этого не проверено |
| 2 | **Сервер приложений и обратный прокси:** какие? Сервер приложений — новая зависимость проекта | Linux; `gunicorn` как сервер приложений и Caddy как прокси с автоматическим сертификатом — **[предположение]**, не проверено; если на сервере уже стоит другой прокси, используется он |
| 3 | **Кто разворачивает на сервере** и проверяет на домене: человек по инструкции или исполнитель с выданным доступом? | Человек по `docs/deployment.md`; исполнителям и QA доступ к серверу не выдаётся, проверки на домене — ручной список этапа П |
| 4 | **Нынешние данные на сервере:** переносить домашнюю базу и MEDIA или начать с пустой базы? | Перенести дампом базы и копией MEDIA по инструкции, затем задать пароль `local`; если перенос не удастся — пустая база и повторный импорт (решение 9 это допускает) |
| 5 | **Резервные копии:** где хранить вне сервера и как часто снимать? | Ежедневно `pg_dump` и архив MEDIA на сервере, срок хранения 14 дней; вывоз копии с сервера — вручную человеком, пока он не назовёт хранилище |

## Вне v1

- Вход через Google — первый шаг после v1 (домен и HTTPS уже будут; нужны Console и `django-allauth`). Остальные внешние провайдеры, приглашение-ссылка, вход по почте, passkeys, TOTP, доверие заголовку Tailscale или Cloudflare Access, Sign in with ChatGPT.
- Открытая регистрация, сброс пароля по почте, удаление аккаунта с данными (решения 2 и 10).
- Команда передачи владения между пользователями (решение 9: не нужна).
- Развёртывание сверх одного сервера: автоматическая выкладка, мониторинг и оповещения, CDN, несколько серверов, раздача MEDIA прокси по внутреннему перенаправлению, домашняя сеть и туннели.
- Личные переопределения каталога (вариант В) и предложения пользователей с утверждением модератором (вариант Г).
- Отдельная таблица наблюдений цен; схлопывание одного кассового чека у двух владельцев в одно наблюдение; порог числа покупателей, огрубление даты, личный отказ от публикации цен (решение 4).
- Честная очередь распознавания по пользователям, лимиты на фото и запуски, раздельные лимиты модели (решение 7).
- Общие (семейные) чеки и совместный доступ к чужим чекам (решение 3).
- Разграничение внутри админки (решение 11).
- Всё, что уже исключено облегчённой v1 ([AGENTS.md](../AGENTS.md)): серверный черновик, `Idempotency-Key`, правка сохранённого чека через API, выбор товара каталога для строки и прочее.
