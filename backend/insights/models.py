from django.conf import settings
from django.db import models
from django.db.models import Q


class InsightRequest(models.Model):
    """ИИ о тратах: разбор месяца (``review``) либо ответ на вопрос (``ask``) ждёт воркера.

    ``context`` — сводка, которую получила модель (``insights.context``): экран разбора показывает её
    цифры рядом с текстом модели, так что модель — не единственный источник сумм. Строку видит только
    владелец. Очередь и исполнение — ``insights.queue``; траты и каталог строка не меняет.
    """

    class Kind(models.TextChoices):
        REVIEW = "review"
        ASK = "ask"

    class Status(models.TextChoices):
        QUEUED = "queued"
        RUNNING = "running"
        SUCCEEDED = "succeeded"
        FAILED = "failed"

    owner = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="insight_requests")
    kind = models.CharField(max_length=8, choices=Kind.choices)
    # Первое число месяца: разбираемого либо того, в котором задан вопрос.
    month = models.DateField()
    question = models.CharField(max_length=300, blank=True, default="")
    context = models.JSONField()
    status = models.CharField(max_length=16, choices=Status.choices, default=Status.QUEUED)
    answer = models.JSONField(null=True, blank=True)
    error_code = models.CharField(max_length=32, blank=True, default="")
    run_token = models.UUIDField(null=True, blank=True)
    lease_expires_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    started_at = models.DateTimeField(null=True, blank=True)
    finished_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        indexes = [
            models.Index(fields=["status", "id"], name="insights_status_idx"),
            models.Index(fields=["owner", "kind", "month"], name="insights_owner_idx"),
        ]
        constraints = [
            models.CheckConstraint(condition=Q(kind__in=["review", "ask"]), name="insights_kind_check"),
            models.CheckConstraint(condition=Q(status__in=["queued", "running", "succeeded", "failed"]),
                                   name="insights_status_check"),
        ]

    def __str__(self):
        return f"{self.pk} {self.kind} {self.status}"
