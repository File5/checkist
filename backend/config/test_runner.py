"""Test runner: планы запросов в тестовой БД не зависят от фоновой очистки Postgres."""
from django.test.runner import DiscoverRunner

DISABLE_AUTOVACUUM = """
DO $$
DECLARE name text;
BEGIN
    FOR name IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
        EXECUTE format('ALTER TABLE public.%I SET (autovacuum_enabled = false)', name);
    END LOOP;
END $$
"""


class Runner(DiscoverRunner):
    """Отключает autovacuum на таблицах тестовой БД.

    ``TestCase`` держит свои строки в незакоммиченной транзакции. Autovacuum, пришедший
    в этот момент за мёртвыми строками прошлого теста, живых строк не видит и пишет в
    ``pg_class`` «строк нет» при непустых страницах. Планировщик после этого оценивает
    таблицу в одну строку и соединяет вложенными циклами: запрос по тысячам строк
    (демо статистики, границы рядов цен) выходит за ``statement_timeout``, и тест падает
    в зависимости от момента очистки. Без autovacuum статистика остаётся «не собрана» и
    оценки считаются от настоящего размера таблицы — одинаково в каждом прогоне.

    Рабочую БД это не затрагивает: параметр ставится только на таблицы созданной
    тестовой базы.
    """

    def setup_databases(self, **kwargs):
        old_config = super().setup_databases(**kwargs)
        for connection, _old_name, _destroy in old_config:
            if connection.vendor == "postgresql":
                with connection.cursor() as cursor:
                    cursor.execute(DISABLE_AUTOVACUUM)
        return old_config
