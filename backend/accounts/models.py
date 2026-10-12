from django.conf import settings
from django.db import models


class LoginFailure(models.Model):
    """Счётчик неудачных входов одного ключа в текущем окне; пишет только ``accounts.throttle``.

    Ключ — адрес клиента (``a:<адрес>``) либо пара «адрес и логин» (``p:<адрес>:<sha256 логина>``):
    сам логин не хранится. Строки просроченных окон удаляются при следующей записи.
    """

    key = models.CharField(max_length=128, unique=True)
    failures = models.PositiveIntegerField()
    window_started_at = models.DateTimeField(db_index=True)

    class Meta:
        verbose_name = "login failure"
        verbose_name_plural = "login failures"

    def __str__(self):
        return self.key


class Household(models.Model):
    """Семья: её члены видят чеки, фото, задания, вырезки и статистику друг друга.

    Семью и членов заводит администратор в ``/admin/``. Правило доступа — только
    ``accounts.access.owner_q``; ``owner`` чека и фото по-прежнему значит «кто добавил».
    """

    name = models.CharField(max_length=100)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        verbose_name = "household"
        verbose_name_plural = "households"
        ordering = ("name", "id")

    def __str__(self):
        return self.name


class Membership(models.Model):
    """Член семьи: у пользователя не больше одной семьи (``user`` уникален)."""

    user = models.OneToOneField(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="membership")
    household = models.ForeignKey(Household, on_delete=models.CASCADE, related_name="memberships")

    class Meta:
        verbose_name = "membership"
        verbose_name_plural = "memberships"

    def __str__(self):
        return f"{self.user} — {self.household}"
