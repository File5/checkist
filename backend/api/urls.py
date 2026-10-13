from django.urls import include, re_path

from .views.fallback import NotFoundView

urlpatterns = [
    re_path(r"", include("api.urls_catalog")),
    re_path(r"", include("api.urls_prices")),
    re_path(r"", include("api.urls_compare")),
    re_path(r"", include("api.urls_recognition")),
    re_path(r"", include("api.urls_receipts")),
    re_path(r"", include("api.urls_product_merges")),
    re_path(r"", include("api.urls_product_classifications")),
    re_path(r"", include("api.urls_stats")),
    re_path(r"", include("api.urls_auth")),
    re_path(r"", include("api.urls_budget")),
    re_path(r"", include("api.urls_export")),
    re_path(r"", include("api.urls_family")),
    re_path(r"", include("api.urls_recurring")),
    re_path(r"", include("api.urls_store_merges")),
    re_path(r"", include("api.urls_statements")),
    re_path(r"", include("api.urls_incomes")),
    # Только пути с завершающим «/»: иначе APPEND_SLASH перестанет перенаправлять /api/health.
    re_path(r"^(?:.*/)?$", NotFoundView.as_view(), name="api-not-found"),
]
