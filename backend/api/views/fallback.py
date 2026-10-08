from rest_framework.permissions import AllowAny

from config.exceptions import ObjectNotFound

from .base import ReadOnlyAPIView


class NotFoundView(ReadOnlyAPIView):
    """Неизвестный путь внутри ``/api/``: JSON ``404 not_found`` для любого метода.

    Открыт и без входа: данных не раскрывает.
    """

    authentication_classes = []
    permission_classes = [AllowAny]
    http_method_names = ["get", "head", "options", "post", "put", "patch", "delete"]

    def get(self, request, *args, **kwargs):
        raise ObjectNotFound()

    options = post = put = patch = delete = get
