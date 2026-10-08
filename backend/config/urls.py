from django.contrib import admin
from django.urls import include, path, re_path

from accounts import media

admin.site.site_header = "Checkist — администрирование"
admin.site.site_title = "Checkist"
admin.site.index_title = "Данные чеков"

urlpatterns = [
    path("admin/", admin.site.urls),
    path("api/health/", include("health.urls")),
    path("api/", include("api.urls")),
    # No DEBUG condition: the view itself decides by the auth mode and the owner of the photo.
    re_path(r"^media/(?P<path>.+)$", media.serve),
]
