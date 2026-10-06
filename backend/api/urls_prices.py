from django.urls import path

from .views.price_series import ProductPriceSeriesView
from .views.prices import ProductPriceSummaryView, ProductPricesView

urlpatterns = [
    path("products/<int:pk>/prices/", ProductPricesView.as_view(), name="product-prices"),
    path("products/<int:pk>/prices/summary/", ProductPriceSummaryView.as_view(), name="product-price-summary"),
    path("products/<int:pk>/prices/series/", ProductPriceSeriesView.as_view(), name="product-price-series"),
]
