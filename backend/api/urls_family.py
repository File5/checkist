from django.urls import re_path

from .views.family import (
    AiView, FamilyInvitesView, FamilyInviteView, FamilyView, HeadView, InvitesView, InviteView, JoinView, LeaveView,
    MembersView, MemberView, NewFamilyCheckView, NewFamilyView,
)
from .views.recognition import LocalNotFoundView

urlpatterns = [
    re_path(r"^family/$", FamilyView.as_view(), name="family"),
    re_path(r"^family/members/$", MembersView.as_view(), name="family-members"),
    re_path(r"^family/members/(?P<username>[\w.@+-]{1,150})/$", MemberView.as_view(), name="family-member"),
    re_path(r"^family/head/$", HeadView.as_view(), name="family-head"),
    re_path(r"^family/leave/$", LeaveView.as_view(), name="family-leave"),
    re_path(r"^family/invites/$", InvitesView.as_view(), name="family-invites"),
    re_path(r"^family/invites/(?P<pk>[1-9][0-9]{0,18})/$", InviteView.as_view(), name="family-invite"),
    re_path(r"^family/join/$", JoinView.as_view(), name="family-join"),
    re_path(r"^family/ai/$", AiView.as_view(), name="family-ai"),
    re_path(r"^family/new-invites/$", FamilyInvitesView.as_view(), name="family-new-invites"),
    re_path(r"^family/new-invites/(?P<pk>[1-9][0-9]{0,18})/$", FamilyInviteView.as_view(), name="family-new-invite"),
    # Приглашение «новая семья» принимает гость: как вход, эти маршруты — под /api/auth/.
    re_path(r"^auth/new-family/$", NewFamilyView.as_view(), name="auth-new-family"),
    re_path(r"^auth/new-family/check/$", NewFamilyCheckView.as_view(), name="auth-new-family-check"),
    re_path(r"^family/(?:.*/)?$", LocalNotFoundView.as_view(), name="family-not-found"),
]
