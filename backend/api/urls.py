from django.urls import include, re_path

from .views.fallback import NotFoundView

urlpatterns = [
    re_path(r"", include("api.urls_catalog")),
    re_path(r"", include("api.urls_prices")),
    re_path(r"", include("api.urls_compare")),
    # Только пути с завершающим «/»: иначе APPEND_SLASH перестанет перенаправлять /api/health.
    re_path(r"^(?:.*/)?$", NotFoundView.as_view(), name="api-not-found"),
]
