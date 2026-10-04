from rest_framework.permissions import AllowAny
from rest_framework.renderers import JSONRenderer
from rest_framework.views import APIView


class ReadOnlyAPIView(APIView):
    """База эндпоинтов API: анонимное чтение, только JSON, запись — ``405``.

    Глобальная ``IsAuthenticated`` остаётся для будущих API; здесь доступ открыт явно,
    как у health. Наследник определяет только ``get``.
    """

    authentication_classes = []
    permission_classes = [AllowAny]
    renderer_classes = [JSONRenderer]
    http_method_names = ["get", "head", "options"]
