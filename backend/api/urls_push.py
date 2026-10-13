from django.urls import re_path

from .views.push import PushTestView, PushView, SubscribeView, UnsubscribeView
from .views.recognition import LocalNotFoundView

urlpatterns = [
    re_path(r"^push/$", PushView.as_view(), name="push"),
    re_path(r"^push/subscribe/$", SubscribeView.as_view(), name="push-subscribe"),
    re_path(r"^push/unsubscribe/$", UnsubscribeView.as_view(), name="push-unsubscribe"),
    re_path(r"^push/test/$", PushTestView.as_view(), name="push-test"),
    re_path(r"^push/(?:.*/)?$", LocalNotFoundView.as_view(), name="push-not-found"),
]
