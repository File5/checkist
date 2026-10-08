from django.conf import settings
from django.db import transaction
from django.middleware.csrf import get_token
from rest_framework.exceptions import ParseError
from rest_framework.response import Response

from accounts.access import owner_q
from api.common import get_or_404
from api.pagination import paginate
from api.params import MAX_ID, Params
from api.recognition_serialization import (
    annotate_jobs, annotate_photos, executor_object, image_object, images_queryset, job_object, jobs_queryset,
    photo_object, photos_queryset,
)
from config.exceptions import InvalidParameter, InvalidRequest, ObjectNotFound, RecognitionApiError
from recognition.images import ImageError
from recognition.models import ProcessingJob, SourcePhoto
from recognition.queue import QueueError, create_job, create_retry, request_cancel
from recognition.statuses import ACTIVE_JOB_STATUSES, JobStatus
from recognition.storage import StorageError, accept_upload

from .recognition_base import BoundedMultiPartParser, EmptyObjectParser, LocalAPIView, request_owner


def path_id(value):
    if len(str(value)) > 19 or not 1 <= int(value) <= MAX_ID:
        raise ObjectNotFound()
    return int(value)


def list_controls(request):
    params = Params(request.query_params)
    page = params.page()
    ordering = params.choice("ordering", ("-created_at", "created_at"), default="-created_at")
    return params, page, (ordering, "-id" if ordering.startswith("-") else "id")


def job_response(jobs, job_id, *, status=200):
    """``jobs`` — ``jobs_queryset(request)``: a job of another user is ``404`` like a missing one."""
    job = get_or_404(jobs, job_id)
    items = list(job.images.order_by("position", "id"))
    return Response(job_object(job, executor_object(), items=items), status=status)


class CsrfView(LocalAPIView):
    def get(self, request):
        return Response({
            "csrf_token": get_token(request._request),
            "limits": {"formats": ["image/jpeg", "image/png", "image/webp"],
                       "max_bytes": settings.RECEIPT_IMAGE_MAX_BYTES,
                       "max_pixels": settings.RECEIPT_IMAGE_MAX_PIXELS,
                       "max_receipts": settings.RECEIPT_IMAGE_MAX_RECEIPTS},
            "executor": executor_object(),
        })


class PhotosView(LocalAPIView):
    http_method_names = ["get", "head", "options", "post"]
    parser_classes = [BoundedMultiPartParser]

    def get(self, request):
        params, page, ordering = list_controls(request)
        params.check()
        return Response(paginate(photos_queryset(request).order_by(*ordering), page, photo_object))

    def post(self, request):
        try:
            data = request.data
        except ParseError:
            raise InvalidRequest() from None
        if set(data) - {"file"} or set(request.FILES) - {"file"}:
            raise InvalidRequest()
        if len(request.FILES.getlist("file")) != 1 or len(data.getlist("file")) != 1:
            raise InvalidParameter({"file": ["Выберите один файл."]})
        try:
            photo, created = accept_upload(request.FILES["file"], owner=request_owner(request))
        except ImageError as exc:
            raise RecognitionApiError("upload_too_large" if exc.code == "file_too_large" else exc.code) from None
        except StorageError:
            raise RecognitionApiError("storage_unavailable") from None
        # S1 commits the immutable photo independently. Serialize latest-job
        # selection with retry/upload on the photo, including missing-job repair.
        with transaction.atomic():
            SourcePhoto.objects.select_for_update().get(pk=photo.pk)
            job = ProcessingJob.objects.filter(photo=photo).order_by("-created_at", "-id").first()
            if job is None:
                job, _ = create_job(photo)
        # accept_upload returned this photo for the owner of the request, and the job is
        # the photo's: both are read by key, like the rows locked above.
        photo = annotate_photos(SourcePhoto.objects.filter(pk=photo.pk)).get()
        response = job_response(annotate_jobs(ProcessingJob.objects.all()), job.pk, status=202 if created else 200)
        response.data = {"reused": not created, "photo": photo_object(photo), "job": response.data}
        response["Location"] = f"/api/recognition/jobs/{job.pk}/"
        return response


class PhotoView(LocalAPIView):
    def get(self, request, pk):
        return Response(photo_object(get_or_404(photos_queryset(request), path_id(pk))))


class JobsView(LocalAPIView):
    def get(self, request):
        params, page, ordering = list_controls(request)
        photo = params.integer("photo")
        status = params.choice("status", JobStatus.values)
        params.check()
        jobs = jobs_queryset(request)
        if photo is not None:
            jobs = jobs.filter(photo_id=photo)
        if status is not None:
            jobs = jobs.filter(status=status)
        executor = executor_object()
        return Response(paginate(jobs.order_by(*ordering), page, lambda job: job_object(job, executor)))


class JobView(LocalAPIView):
    def get(self, request, pk):
        return job_response(jobs_queryset(request), path_id(pk))


class JobMutationView(LocalAPIView):
    http_method_names = ["post", "options"]
    parser_classes = [EmptyObjectParser]

    def empty_body(self, request):
        if request.content_type != "application/json":
            from rest_framework.exceptions import UnsupportedMediaType
            raise UnsupportedMediaType(request.content_type)
        if request.data != {}:
            raise InvalidRequest()
        # DRF bypasses parsers for an empty body. {} is required, even then.
        if not request._request.META.get("CONTENT_LENGTH") or request._request.META["CONTENT_LENGTH"] == "0":
            raise InvalidRequest()

    def own_job(self, request, pk):
        # The same place as the existence check: another user's job answers as a missing one.
        return get_or_404(ProcessingJob.objects.filter(owner_q(request, "photo__")), path_id(pk))


class CancelView(JobMutationView):
    def post(self, request, pk):
        self.empty_body(request)
        job_id = self.own_job(request, pk).pk
        try:
            job = request_cancel(job_id)
        except QueueError as exc:
            if exc.code != "job_terminal":
                raise
            raise RecognitionApiError("job_terminal") from None
        return job_response(jobs_queryset(request), job.pk, status=200 if job.status == "cancelled" else 202)


class RetryView(JobMutationView):
    def post(self, request, pk):
        self.empty_body(request)
        previous = self.own_job(request, pk)
        with transaction.atomic():
            SourcePhoto.objects.select_for_update().get(pk=previous.photo_id)
            if ProcessingJob.objects.filter(photo_id=previous.photo_id, status__in=ACTIVE_JOB_STATUSES).exists():
                raise RecognitionApiError("job_active")
            try:
                job, created = create_retry(previous.pk)
            except QueueError as exc:
                if exc.code != "job_not_retryable":
                    raise
                raise RecognitionApiError("retry_not_allowed") from None
            if not created:
                raise RecognitionApiError("job_active")
        response = job_response(jobs_queryset(request), job.pk, status=202)
        response["Location"] = f"/api/recognition/jobs/{job.pk}/"
        return response


class ReceiptImagesView(LocalAPIView):
    def get(self, request):
        params, page, ordering = list_controls(request)
        filters = {name + "_id": params.integer(name) for name in ("photo", "job", "receipt")}
        params.check()
        images = images_queryset(request).filter(**{key: value for key, value in filters.items() if value is not None})
        return Response(paginate(images.order_by(*ordering), page, image_object))


class ReceiptImageView(LocalAPIView):
    def get(self, request, pk):
        return Response(image_object(get_or_404(images_queryset(request), path_id(pk)), detail=True))


class LocalNotFoundView(LocalAPIView):
    def get(self, request, *args, **kwargs):
        raise ObjectNotFound()

    def http_method_not_allowed(self, request, *args, **kwargs):
        raise ObjectNotFound()
