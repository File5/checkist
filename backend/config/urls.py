from django.contrib import admin
from django.urls import include, path

admin.site.site_header = "Checkist — администрирование"
admin.site.site_title = "Checkist"
admin.site.index_title = "Данные чеков"

urlpatterns = [
    path("admin/", admin.site.urls),
    path("api/health/", include("health.urls")),
]
