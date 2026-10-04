from config.exceptions import ObjectNotFound

from .base import ReadOnlyAPIView


class NotFoundView(ReadOnlyAPIView):
    """Неизвестный путь внутри ``/api/``: JSON ``404 not_found`` для любого метода."""

    http_method_names = ["get", "head", "options", "post", "put", "patch", "delete"]

    def get(self, request, *args, **kwargs):
        raise ObjectNotFound()

    options = post = put = patch = delete = get
