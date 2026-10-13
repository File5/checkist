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

    ИИ семьи (``accounts.ai``): ``ai_enabled`` — фото и тексты семьи уходят внешней модели
    (у семей до ``0004`` — включено, у новых — выключено, меняет главный); ``ai_daily_limit`` —
    запросов к модели на семью за сутки (меняет администратор).
    """

    name = models.CharField(max_length=100)
    created_at = models.DateTimeField(auto_now_add=True)
    ai_enabled = models.BooleanField(default=False)
    ai_daily_limit = models.PositiveIntegerField(default=50)

    class Meta:
        verbose_name = "household"
        verbose_name_plural = "households"
        ordering = ("name", "id")

    def __str__(self):
        return self.name


class Membership(models.Model):
    """Член семьи: у пользователя не больше одной семьи (``user`` уникален).

    ``role`` — ``head`` (главный в семье: скрывает и показывает платежи) либо ``member``;
    главного назначает администратор, в семье он не больше чем один (частичное уникальное
    ограничение). Пользователь без семьи — сам себе главный (``accounts.access.is_head``).
    """

    class Role(models.TextChoices):
        HEAD = "head", "Главный в семье"
        MEMBER = "member", "Член семьи"

    user = models.OneToOneField(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="membership")
    household = models.ForeignKey(Household, on_delete=models.CASCADE, related_name="memberships")
    role = models.CharField(max_length=8, choices=Role.choices, default=Role.MEMBER)

    class Meta:
        verbose_name = "membership"
        verbose_name_plural = "memberships"
        constraints = [
            models.UniqueConstraint(fields=("household",), condition=models.Q(role="head"),
                                    name="accounts_membership_one_head"),
        ]

    def __str__(self):
        return f"{self.user} — {self.household}"


class Profile(models.Model):
    """Настройки пользователя; строка появляется при первом сохранении (``accounts.settings``).

    ``default_currency`` — основная валюта: значение по умолчанию формы траты, разбора
    «Трата словами» и лимитов, первый блок дашборда и статистики при нескольких валютах.
    """

    user = models.OneToOneField(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="profile")
    default_currency = models.ForeignKey("stores.Currency", null=True, blank=True, on_delete=models.SET_NULL,
                                         related_name="+")
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        verbose_name = "profile"
        verbose_name_plural = "profiles"

    def __str__(self):
        return str(self.user)


class Invite(models.Model):
    """Одноразовое приглашение (``accounts.family``): хранится только SHA-256 токена.

    ``join`` — в семью ``household`` (выдаёт главный, принимает вошедший без семьи);
    ``new_family`` — новая семья без ``household`` (выдаёт администратор сервера,
    ``is_staff``; принимающий заводит учётную запись и семью, где становится главным).
    Действует 7 дней; принятое (``used_at``) или отозванное (строка удалена) больше не работает.
    """

    class Kind(models.TextChoices):
        JOIN = "join", "В семью"
        NEW_FAMILY = "new_family", "Новая семья"

    kind = models.CharField(max_length=10, choices=Kind.choices, default=Kind.JOIN)
    household = models.ForeignKey(Household, null=True, blank=True, on_delete=models.CASCADE, related_name="invites")
    token_hash = models.CharField(max_length=64, unique=True)
    created_by = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, on_delete=models.SET_NULL, related_name="+")
    created_at = models.DateTimeField(auto_now_add=True)
    expires_at = models.DateTimeField()
    used_at = models.DateTimeField(null=True, blank=True)
    used_by = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL,
                                related_name="+")

    class Meta:
        verbose_name = "invite"
        verbose_name_plural = "invites"
        ordering = ("-created_at", "-id")
        constraints = [
            # Приглашение в семью — всегда с семьёй, в новую семью — всегда без неё.
            models.CheckConstraint(
                condition=models.Q(kind="join", household__isnull=False) | models.Q(kind="new_family", household__isnull=True),
                name="accounts_invite_kind_household"),
        ]

    def __str__(self):
        return f"{self.household or self.get_kind_display()} — {self.created_at:%Y-%m-%d}"


class AiUsage(models.Model):
    """Запросы семьи к модели за сутки (``accounts.ai.use_ai``); строка на семью и день.

    День — ``timezone.localdate()`` (``TIME_ZONE`` сервера, UTC): новые сутки — новая строка, счёт с нуля.
    """

    household = models.ForeignKey(Household, on_delete=models.CASCADE, related_name="ai_usage")
    day = models.DateField()
    count = models.PositiveIntegerField(default=0)

    class Meta:
        verbose_name = "AI usage"
        verbose_name_plural = "AI usage"
        constraints = [
            models.UniqueConstraint(fields=("household", "day"), name="accounts_aiusage_household_day_uniq"),
        ]

    def __str__(self):
        return f"{self.household} — {self.day}: {self.count}"
