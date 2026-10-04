from django.urls import path

from .views.prices import ProductPriceSummaryView, ProductPricesView

urlpatterns = [
    path("products/<int:pk>/prices/", ProductPricesView.as_view(), name="product-prices"),
    path("products/<int:pk>/prices/summary/", ProductPriceSummaryView.as_view(), name="product-price-summary"),
]
