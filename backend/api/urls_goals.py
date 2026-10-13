from django.urls import re_path

from .views.goals import ContributionsView, ContributionView, GoalsView, GoalView
from .views.recognition import LocalNotFoundView

ID = r"(?P<pk>[1-9][0-9]{0,18})"

urlpatterns = [
    re_path(r"^goals/$", GoalsView.as_view(), name="goals"),
    re_path(rf"^goals/{ID}/$", GoalView.as_view(), name="goal"),
    re_path(rf"^goals/{ID}/contributions/$", ContributionsView.as_view(), name="goal-contributions"),
    re_path(rf"^goals/{ID}/contributions/(?P<item>[1-9][0-9]{{0,18}})/$", ContributionView.as_view(), name="goal-contribution"),
    re_path(r"^goals/(?:.*/)?$", LocalNotFoundView.as_view(), name="goals-not-found"),
]
