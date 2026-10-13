from django.apps import AppConfig


class PushConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "push"

    def ready(self):
        from django.contrib.auth.signals import user_logged_out

        user_logged_out.connect(_logged_out, dispatch_uid="push-logged-out")


def _logged_out(sender, request, user, **kwargs):
    """Выход на устройстве (API и админка) снимает его подписки: уведомления не приходят на вышедший телефон."""
    from .services import forget_session

    forget_session(getattr(getattr(request, "session", None), "session_key", None))
