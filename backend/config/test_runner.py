"""Test runner: планы запросов в тестовой БД не зависят от фоновой очистки Postgres.

Тесты идут в режиме ``local_single`` независимо от окружения. Каталог тестовой БД
начинается пустым: строки справочных миграций каталога убираются (``drop_seeded_catalog``).
"""
from django.conf import settings
from django.db.models.signals import post_migrate
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


def drop_seeded_catalog(using, **kwargs):
    """Убирает категорию обслуживания миграции ``catalog.0003`` из только что созданной тестовой БД.

    Тесты каталога, статистики, демо и предположений ждут пустой каталог; нужная тесту
    категория создаётся тем же кодом миграции (``receipts.tests.test_service_charges``).
    Вызывается по ``post_migrate`` до клонирования баз ``--parallel``; рабочую БД не трогает.
    """
    from catalog.models import Category
    from receipts.service_charges import CATEGORY_NAME, PARENT_NAME

    roots = Category.objects.using(using).filter(name=PARENT_NAME, parent=None)
    Category.objects.using(using).filter(name=CATEGORY_NAME, parent__in=roots, children=None).delete()
    roots.filter(children=None).delete()


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

    Режим доступа — ``local_single`` при любом окружении, как Django ставит ``DEBUG=False``:
    прежние тесты ходят анонимным клиентом. Тесты режима ``accounts`` включают его сами
    через ``override_settings(CHECKIST_AUTH_MODE="accounts")``. Рабочие процессы
    ``--parallel`` под Windows этот метод не вызывают и берут режим из окружения.
    """

    def setup_test_environment(self, **kwargs):
        super().setup_test_environment(**kwargs)
        self._auth_mode = settings.CHECKIST_AUTH_MODE
        self._save_session = settings.SESSION_SAVE_EVERY_REQUEST
        settings.CHECKIST_AUTH_MODE = "local_single"
        # Follows the mode as settings.py does: local_single never touches the session.
        settings.SESSION_SAVE_EVERY_REQUEST = False

    def teardown_test_environment(self, **kwargs):
        settings.CHECKIST_AUTH_MODE = self._auth_mode
        settings.SESSION_SAVE_EVERY_REQUEST = self._save_session
        super().teardown_test_environment(**kwargs)

    def setup_databases(self, **kwargs):
        post_migrate.connect(drop_seeded_catalog, dispatch_uid="checkist-drop-seeded-catalog")
        try:
            old_config = super().setup_databases(**kwargs)
        finally:
            post_migrate.disconnect(dispatch_uid="checkist-drop-seeded-catalog")
        for connection, _old_name, _destroy in old_config:
            if connection.vendor == "postgresql":
                with connection.cursor() as cursor:
                    cursor.execute(DISABLE_AUTOVACUUM)
        return old_config
