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
