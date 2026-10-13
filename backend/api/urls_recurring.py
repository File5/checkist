from django.urls import re_path

from .views.recognition import LocalNotFoundView
from .views.recurring import DecisionView, PaymentsView, PaymentView, SuggestionAcceptView, SuggestionDismissView

ID = r"(?P<pk>[1-9][0-9]{0,18})"

urlpatterns = [
    re_path(r"^recurring/$", PaymentsView.as_view(), name="recurring"),
    re_path(r"^recurring/suggestions/accept/$", SuggestionAcceptView.as_view(), name="recurring-suggestion-accept"),
    re_path(r"^recurring/suggestions/dismiss/$", SuggestionDismissView.as_view(), name="recurring-suggestion-dismiss"),
    re_path(rf"^recurring/{ID}/$", PaymentView.as_view(), name="recurring-payment"),
    re_path(rf"^recurring/{ID}/decision/$", DecisionView.as_view(), name="recurring-decision"),
    re_path(r"^recurring/(?:.*/)?$", LocalNotFoundView.as_view(), name="recurring-not-found"),
]
