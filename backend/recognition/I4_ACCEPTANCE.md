# И4: автоматический импорт распознанных чеков

Читаемые чеки сохраняются в БД при отсутствующей operation и неоднозначных необязательных реквизитах. Продажа определяется без явных признаков возврата; неизвестные fiscal/касса/смена/товарные коды/налоговые детали пропускаются. Для дубликатов используются только уверенно прочитанные сильные ключи или точное совпадение магазин + момент + итог.

По согласованному уточнению сохранены инварианты Receipt/ReceiptLine. Перед needs_review применяются безопасные выводы: валюта из страны существующего магазина RU/KZ/DE, недостающее число строки из двух observed чисел, pcs для целого observed количества без признаков веса. Количество и цена не округляются. Исходный DTO не меняется, происхождение записывается в derived. Модели/миграции и публичные формы API/fixtures не изменены, frontend не менялся. В CLAUDE.md уже указаны подключённые каталог и цены; обновлены результаты проверки.

## Проверено и прошло

2026-10-05, Windows Python 3.13.9, Docker 29.8.1/Compose 5.5.1, native Codex 0.160.0, gpt-6.1-sol. Собственная новая QA: checkist_qa_i4_final, test_checkist_qa_i4_final, PostgreSQL 17.11 на 25475, Redis 7.4.11 на 16405, API на 18015. MEDIA/scratch раздельные, только синтетические demo. Полный environment из [verification.md](../../docs/verification.md#изолированная-qa-среда) с согласованной заменой этих DB/портов/URL.

Все команды ниже завершились с exit 0; `P` означает `./backend/.venv/Scripts/python.exe -X utf8` из корня worktree.

| Проверка / команда | Результат |
| --- | --- |
| `P backend/manage.py test catalog stores receipts health api recognition --exclude-tag=integration --noinput --verbosity=1` | **257 tests OK**, 11.426 с, без skips и БД |
| `P backend/manage.py test catalog stores receipts health api recognition --tag=integration --noinput --verbosity=1` | **866 tests OK**, 165.178 с, без skips; test DB удалена |
| `P -m pip check`; `P backend/manage.py check`; `P backend/manage.py makemigrations --check --dry-run` | No broken requirements, 0 issues, No changes detected |
| `P backend/manage.py migrate --noinput`; `P backend/manage.py seed_recognition_demo` | 23 миграции в пустую QA, созданы single/double |
| `docker compose -p checkist_qa_i4_final config --quiet`; `up -d --wait --wait-timeout 90 postgres redis`; `up -d --build --wait --wait-timeout 120 worker` | Отдельные healthy зависимости, TCP с Windows доступен |
| `P backend/manage.py check_services` | Настоящие SQL/Redis/Celery queue/result → pong |
| HTTP upload single + `RECEIPT_OCR_PROVIDER=codex_cli P backend/manage.py recognition_worker --once` | succeeded, imported=1, review=0; **78.748 с**, detect 9.439 с, recognize 68.170 с |
| HTTP upload double + та же команда worker | succeeded, imported=1, reused=1, review=0; **137.082 с**, detect 12.701 с, recognize 66.881/56.161 с |
| HTTP проверки single/double и повторов, ORM asserts | Итоги **4.42 / 6.00 EUR**, **2 чека / 6 строк / 5 товаров**; каждый товарный ряд связан с Product. Повтор возвращает HTTP 200 и прежние Photo/Job; первый чек double переиспользует Receipt single |

Полный suite включает 11 серверных e2e, воспроизведение наблюдения С6, prompt/schema/validator, негативные арифметические случаи, конфликты сильных ключей, сохранение уже заполненных значений, CSRF/loopback/privacy и постоянство числа запросов. Подробные команды и таблица всех причин — [окончательный отчёт](../../docs/verification.md#фактические-результаты-и4).

## Причина → блокирует / не блокирует

| Причина | Импорт |
| --- | --- |
| operation отсутствует | Не блокирует: sale без явного возврата, иначе refund; operation_defaulted |
| ambiguous/unreadable необязательные реквизиты и подсказки | Не блокируют: optional_omitted; сильный ключ только из observed |
| Нет сильного ключа | Не блокирует: точный магазин/время/итог связывает тот же чек, иначе новый |
| Отсутствует одно число строки при двух observed числах | Не блокирует при представимом выводе; количество/цена без округления, сумма до цента |
| Отсутствует единица штучной строки | Не блокирует при целой observed quantity без признаков веса; pcs |
| Отсутствует валюта у разрешённого существующего магазина RU/KZ/DE | Не блокирует: RUB/KZT/EUR, currency_inferred; напечатанная валюта имеет приоритет |
| Нет магазина/продавца, даты/точного времени, итога, строк или обязательных фактов после безопасных выводов | Блокирует: missing_required/ambiguous_value/invalid_value |
| country_unknown/currency_unknown/store_ambiguous/store_conflict, нет адреса новой точки | Блокируют: обязательная идентичность магазина не разрешена |
| timezone_unknown/timestamp_ambiguous/timestamp_conflict, противоречивые timestamps | Блокируют: точный момент не определён |
| Ноль quantity, отрицательная unit_price, разные знаки quantity/amount, положительный deposit_return, непредставимые значения модели | Блокируют: инварианты модели |
| identity_conflict разных уверенных сильных ключей | Блокирует; новый граф не создаётся |
| total_mismatch общей суммы больше 0.01 | Блокирует; учитываются скидки и прочитанный налог для prices_include_tax=False |
| Расхождение до 0.01, quantity×unit_price, receipt_invalid вторичной проверки | Не блокируют: сохраняются прочитанные числа и замечания |
| tax_mismatch/tax_rate_invalid/unconfirmed, неполные итоги налогов | Не блокируют сами по себе: детали пропускаются; необходимый для общей суммы налог может вызвать блокирующий total_mismatch |
| merchant_tax_id_invalid/merchant_conflict необязательного tax_id_type | Не блокируют: пропуск неверного ID/замечание без перезаписи |
| Непригодная скидка, parent/line_position, агрегаты скидок | Не блокируют сами по себе; пропуск/отвязка/пересчёт, затем проверка общего итога |
| product_ambiguous/conflict/package_invalid | Не блокируют чек; читаемая строка остаётся, product может быть NULL и требует проверки Receipt |
| receipt_conflict/receipt_structure_conflict/receipt_line_conflict повторного фото | Не блокируют связь; существующие несовместимые значения не перезаписываются |
| clipped читаемой вырезки | Не блокирует |
| Некорректная схема/геометрия, provider/storage/DB/import_failed | Технический failed; гарантии не смягчены |
| import_busy/cancel/fence lost | Управление очередью; новый граф при отмене/устаревшем владельце не сохраняется |

## Проверено и не прошло

До исправления уточнения два новых теста — `test_missing_currency_uses_country_of_existing_store_and_reuses_receipt` и `test_missing_line_quantity_is_derived_from_printed_price_and_amount` — завершились с exit 1: needs_review вместо linked/created. На окончательном коде они входят в успешные 866 tests. Первая вспомогательная TCP-проба Python через PowerShell `-c` получила SyntaxError (exit 1); передача через UTF-8 stdin исправлена, зависимые команды до исправления не выполнялись. Финальных отказов тестов или single/double нет.

## Не проверено и почему; сценарий для человека

Браузерный UI, Vite proxy, доступность и скриншоты не проверялись: проект оставляет эту приёмку человеку, клиент распознавания относится к И5. Показ — фактический markdown-отчёт, не макет и не подтверждение внешнего вида. Frontend не менялся, npm lint/test/build не запускались. Реальные пользовательские фото, нагрузка, backup restore и production не проверены.

Для просмотра сохранённых синтетических данных применить полный QA environment с указанными DB/портами, теми же MEDIA/scratch в `.orca-attachments/i4-final`, включёнными DEBUG/local API и loopback. Запустить `docker compose -p checkist_qa_i4_final up -d --wait postgres redis`, затем `P backend/manage.py runserver 127.0.0.1:18015 --noreload`. Получить `/api/recognition/jobs/1/` и `/2/`, `/api/receipts/1/` и `/2/`, дочерние `/lines/`; открыть source/crop по media URL непосредственно на Django и сравнить строки, товары и суммы. Повтор загрузки тех же файлов должен дать прежние IDs.

Для независимого настоящего OCR-прогона нужна новая пустая QA: seed single/double, HTTP CSRF/multipart upload, codex_cli worker --once; succeeded job не retryable. После интеграции И5 запустить QA Vite на 15188 с DEV_API_PROXY_TARGET=http://127.0.0.1:18015; вручную пройти single/double → статус → чек/товары → повтор и отмена. На fake partial_success (неизвестны quantity и unit_price) проверить needs_review и причины; на inconsistent_total — отказ общей суммы. Проверить клавиатуру, узкую ширину, refresh и media. [Полный сценарий](../../docs/verification.md#ручная-приёмка-ocr-человеком).

Свои host API и Compose остановлены, отсутствие своих процессов/контейнеров/слушателей подтверждено. Тома и синтетические MEDIA сохранены; секреты, private provider payload и реальные фото не коммитятся. Откат — revert кода/тестов/docs, импортированные записи остаются; миграций нет. Merge/deployment/release не выполнялись.
