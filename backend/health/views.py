from concurrent.futures import ThreadPoolExecutor

from django.db import connections
from rest_framework.permissions import AllowAny
from rest_framework.renderers import JSONRenderer
from rest_framework.response import Response
from rest_framework.views import APIView

from . import probes


def run_probe(probe):
    try:
        return probe()
    finally:
        # Django request cleanup runs in the request thread; these connections
        # belong to short-lived probe threads and must be closed here.
        connections.close_all()


class HealthView(APIView):
    authentication_classes = []
    permission_classes = [AllowAny]
    renderer_classes = [JSONRenderer]

    def finalize_response(self, request, response, *args, **kwargs):
        response = super().finalize_response(request, response, *args, **kwargs)
        response["Cache-Control"] = "no-store"
        return response

    def get(self, request):
        probe_functions = {
            "database": probes.probe_database,
            "redis": probes.probe_redis,
            "celery": probes.probe_celery,
        }
        # Independent network timeouts (including DNS) must not accumulate.
        with ThreadPoolExecutor(max_workers=3) as executor:
            pending = {name: executor.submit(run_probe, probe) for name, probe in probe_functions.items()}
            checks = {name: future.result() for name, future in pending.items()}
        healthy = all(check["status"] == "ok" for check in checks.values())
        body = {"status": "ok" if healthy else "degraded", "checks": checks}
        if not healthy:
            body["error"] = {
                "code": "dependency_unavailable",
                "message": "Один или несколько сервисов недоступны.",
            }
        return Response(body, status=200 if healthy else 503)
