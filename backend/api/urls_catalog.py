from django.urls import path

from .views import catalog

urlpatterns = [
    path("countries/", catalog.CountriesView.as_view(), name="api-countries"),
    path("stores/", catalog.StoresView.as_view(), name="api-stores"),
    path("brands/", catalog.BrandsView.as_view(), name="api-brands"),
    path("categories/", catalog.CategoriesView.as_view(), name="api-categories"),
    path("categories/<int:pk>/", catalog.CategoryView.as_view(), name="api-category"),
    path("generic-products/", catalog.GenericProductsView.as_view(), name="api-generic-products"),
    path("generic-products/<int:pk>/", catalog.GenericProductView.as_view(), name="api-generic-product"),
    path("products/", catalog.ProductsView.as_view(), name="api-products"),
    path("products/<int:pk>/", catalog.ProductView.as_view(), name="api-product"),
]
