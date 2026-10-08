from rest_framework.renderers import JSONRenderer
from rest_framework.views import APIView

from accounts.access import SessionUserAuthentication, SignedIn


class ReadOnlyAPIView(APIView):
    """База эндпоинтов API чтения: только JSON, запись — ``405``.

    Доступ — ``accounts.access.SignedIn``: в режиме ``accounts`` нужен вход (аноним получает
    ``401 not_authenticated``), в ``local_single`` чтение открыто, как у health. Наследник
    определяет только ``get``.
    """

    authentication_classes = [SessionUserAuthentication]
    permission_classes = [SignedIn]
    renderer_classes = [JSONRenderer]
    http_method_names = ["get", "head", "options"]
