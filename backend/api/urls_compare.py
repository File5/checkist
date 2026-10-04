from django.urls import path

from .views.compare import GenericComparisonView, ProductAlternativesView

urlpatterns = [
    path("products/<int:pk>/alternatives/", ProductAlternativesView.as_view(), name="api-product-alternatives"),
    path("generic-products/<int:pk>/comparison/", GenericComparisonView.as_view(), name="api-generic-comparison"),
]
