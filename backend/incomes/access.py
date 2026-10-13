"""Кто видит доходы — правило одной функцией ``visible_q``; категории — ``categories_q``.

Запись дохода видят тот, кто её внёс, и главный в семье; остальные члены семьи — только общий
доход семьи за месяц (``incomes.services.month_income``, по ``accounts.access.owner_q``). Тем же
правилом закрыты шаблоны регулярного дохода (``recurring``, по ``created_by``): сумма зарплаты
видна её автору и главному. Пользователь без семьи видит свои. В ``local_single`` — записи
пользователя ``local``.
"""
from django.db.models import Q

from accounts.access import LOCAL_SINGLE, is_head, mode
from budget.access import limits_q
from receipts.ownership import LOCAL_USERNAME


def visible_q(request, field="owner"):
    """visible_q(request, field="owner") -> Q; записи, которые видит запрос: свои, а главному — и всей семьи.

    ``field`` — поле пользователя-автора (``owner`` у дохода, ``created_by`` у шаблона). Один подзапрос.
    """
    if mode() == LOCAL_SINGLE:
        return Q(**{f"{field}__username": LOCAL_USERNAME})
    from accounts.models import Membership

    pk = request.user.pk
    headed = Membership.objects.filter(user_id=pk, role=Membership.Role.HEAD).values("household_id")
    return Q(**{f"{field}_id": pk}) | Q(**{f"{field}_id__in": Membership.objects.filter(
        household_id__in=headed).values("user_id")})


def sees_family(request):
    """sees_family(request) -> bool; ``visible_q`` запроса — все записи семьи (главный, человек без семьи, ``local_single``).

    Члену семьи ``visible_q`` отдаёт только его записи: разбивку дохода он видит по своим, общий доход — семьи.
    """
    return is_head(request)


def categories_q(request):
    """Категории доходов запроса: встроенные и свои (владелец как у лимита)."""
    return Q(household__isnull=True, user__isnull=True) | limits_q(request)
