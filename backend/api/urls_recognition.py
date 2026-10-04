from django.urls import re_path

from .views.recognition import (
    CancelView, CsrfView, JobView, JobsView, LocalNotFoundView, PhotoView, PhotosView,
    ReceiptImageView, ReceiptImagesView, RetryView,
)

urlpatterns = [
    re_path(r"^recognition/csrf/$", CsrfView.as_view(), name="recognition-csrf"),
    re_path(r"^recognition/photos/$", PhotosView.as_view(), name="recognition-photos"),
    re_path(r"^recognition/photos/(?P<pk>[1-9][0-9]{0,18})/$", PhotoView.as_view(), name="recognition-photo"),
    re_path(r"^recognition/jobs/$", JobsView.as_view(), name="recognition-jobs"),
    re_path(r"^recognition/jobs/(?P<pk>[1-9][0-9]{0,18})/$", JobView.as_view(), name="recognition-job"),
    re_path(r"^recognition/jobs/(?P<pk>[1-9][0-9]{0,18})/cancel/$", CancelView.as_view(), name="recognition-cancel"),
    re_path(r"^recognition/jobs/(?P<pk>[1-9][0-9]{0,18})/retry/$", RetryView.as_view(), name="recognition-retry"),
    re_path(r"^recognition/receipt-images/$", ReceiptImagesView.as_view(), name="recognition-images"),
    re_path(r"^recognition/receipt-images/(?P<pk>[1-9][0-9]{0,18})/$", ReceiptImageView.as_view(), name="recognition-image"),
    re_path(r"^recognition/(?:.*/)?$", LocalNotFoundView.as_view(), name="recognition-not-found"),
]
