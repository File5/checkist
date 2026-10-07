from django.urls import re_path

from .views.auth import CsrfView, LoginView, LogoutView, MeView, PasswordView

urlpatterns = [
    re_path(r"^auth/csrf/$", CsrfView.as_view(), name="auth-csrf"),
    re_path(r"^auth/login/$", LoginView.as_view(), name="auth-login"),
    re_path(r"^auth/logout/$", LogoutView.as_view(), name="auth-logout"),
    re_path(r"^auth/password/$", PasswordView.as_view(), name="auth-password"),
    re_path(r"^me/$", MeView.as_view(), name="me"),
]
