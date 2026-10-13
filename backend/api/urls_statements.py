from django.urls import re_path

from .views.recognition import LocalNotFoundView
from .views.statements import RuleView, RulesView, StatementGoalView, StatementSaveView, StatementView, StatementsView

urlpatterns = [
    re_path(r"^statements/$", StatementsView.as_view(), name="statements-list"),
    re_path(r"^statements/rules/$", RulesView.as_view(), name="statements-rules"),
    re_path(r"^statements/rules/(?P<pk>[1-9][0-9]{0,18})/$", RuleView.as_view(), name="statements-rule"),
    re_path(r"^statements/(?P<pk>[1-9][0-9]{0,18})/$", StatementView.as_view(), name="statements-detail"),
    re_path(r"^statements/(?P<pk>[1-9][0-9]{0,18})/save/$", StatementSaveView.as_view(), name="statements-save"),
    re_path(r"^statements/(?P<pk>[1-9][0-9]{0,18})/goal/$", StatementGoalView.as_view(), name="statements-goal"),
    re_path(r"^statements/(?:.*/)?$", LocalNotFoundView.as_view(), name="statements-not-found"),
]
