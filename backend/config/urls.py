from django.urls import include, path

urlpatterns = [path("api/health/", include("health.urls"))]
