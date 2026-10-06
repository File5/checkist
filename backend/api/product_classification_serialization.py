"""Public shapes of the product-classification API.

The raw model answer, the prompt, ``input_sha256``, ``run_token``, leases,
``confidence`` and the per-reason skip counters never leave here.
"""
from django.conf import settings

from api.common import brand_brief, generic_brief, package, quantity, utc_datetime
from api.recognition_serialization import executor_object
from api.views.catalog import alias_objects
from classification import services
from classification.models import ClassificationRun, ProductClassification

# Fixed texts of a failed run. The recognition texts speak about an image and do not fit here.
RUN_ERRORS = {
    "auth_required": "Требуется вход в сервис модели.",
    "network_unavailable": "Сеть сервиса модели недоступна.",
    "rate_limited": "Сервис модели временно ограничил запросы.",
    "provider_unavailable": "Сервис модели недоступен.",
    "configuration_error": "Настройки сервиса модели требуют проверки.",
    "invalid_input": "Запрос к модели не прошёл проверку.",
    "invalid_output": "Ответ модели не прошёл проверку.",
    "timeout": "Время ожидания ответа модели истекло.",
    "worker_lost": "Обработчик перестал отвечать.",
    "input_too_large": "Каталог слишком велик для одного запроса к модели.",
    "internal_error": "Запуск завершился ошибкой.",
}


def _snapshot_package(facts):
    value = facts.get("package")
    return value and {"quantity": quantity(value["quantity"]), "unit": value["unit"]}


def _product_object(info, aliases):
    record, product = info.record, info.product
    if product is None:
        # The product is gone: the snapshot taken when the suggestion was applied.
        facts = record.product_facts or {}
        return {
            "id": record.product_ref, "exists": False, "name": record.product_name, "brand": facts.get("brand"),
            "package": _snapshot_package(facts), "generic": None, "aliases": [], "merge_group_id": None,
        }
    return {
        "id": record.product_ref,
        "exists": True,
        "name": product.name,
        "brand": brand_brief(product.brand),
        "package": package(product),
        "generic": generic_brief(info.product_generic),
        "aliases": aliases,
        "merge_group_id": info.merge_group_id,
    }


def _record_object(info, aliases):
    record, generic = info.record, info.suggested_generic
    pending = record.status == ProductClassification.Status.PENDING
    path = [{"id": pk, "name": name, "is_new": is_new} for pk, name, is_new in info.category_path]
    return {
        "id": record.pk,
        "status": record.status,
        "resolution": record.resolution or None,
        "version": record.version,
        "created_at": utc_datetime(record.created_at),
        "resolved_at": utc_datetime(record.resolved_at),
        "product": _product_object(info, aliases),
        "previous_generic": {
            "id": record.previous_generic_ref, "name": record.previous_generic_name,
            "base_unit": record.previous_generic_base_unit,
        },
        "suggested": {
            "generic": {
                "id": record.suggested_generic_ref,
                "name": generic.name if generic else record.suggested_generic_name,
                "base_unit": generic.base_unit if generic else record.suggested_base_unit,
                "exists": generic is not None,
                "is_new": info.generic_is_new,
            },
            # The category of the generic product is the last step of the path.
            "category": {"id": path[-1]["id"], "name": path[-1]["name"], "path": path} if path else None,
            "pending_count": info.pending_count,
        },
        "final_generic": None if pending or record.final_generic_ref is None else {
            "id": record.final_generic_ref, "name": record.final_generic_name, "base_unit": record.final_base_unit,
        },
        "source": {
            "run_id": record.run_id,
            "trigger": record.run.trigger if record.run_id else None,
            "provider": record.provider,
            "model": record.model,
            "prompt_version": record.prompt_version,
            "schema_version": record.schema_version,
        },
        "actions": {"can_confirm": info.can_act, "can_choose": info.can_act, "can_reject": info.can_act},
    }


def record_objects(records):
    """«Запись» for each record of one page; the number of queries does not depend on the page size."""
    records = list(records)
    if not records:
        return []
    infos = services.describe(records)
    # One call for the whole page: stores of merchants without a sign are read once.
    flat = [(info.record.pk, alias) for info in infos for alias in info.aliases]
    aliases = {}
    for (record_id, _), value in zip(flat, alias_objects([alias for _, alias in flat])):
        aliases.setdefault(record_id, []).append(value)
    return [_record_object(info, aliases.get(info.record.pk, [])) for info in infos]


def record_object(record):
    return record_objects([record])[0]


def run_object(run):
    """«Запуск»; ``stats``, the product ids, the token and the lease stay private."""
    error = None
    if run.status == ClassificationRun.Status.FAILED:
        code = run.error_code if run.error_code in RUN_ERRORS else "internal_error"
        error = {"code": code, "message": RUN_ERRORS[code]}
    return {
        "id": run.pk,
        "status": run.status,
        "trigger": run.trigger,
        "scope": run.scope,
        "version": run.version,
        "created_at": utc_datetime(run.created_at),
        "started_at": utc_datetime(run.started_at),
        "finished_at": utc_datetime(run.finished_at),
        "progress": {
            "requested": run.requested_count,
            "processed": run.cursor,
            "applied": run.applied_count,
            "unknown": run.unknown_count,
            "skipped": run.skipped_count,
        },
        "remaining": run.remaining_count or 0,
        "error": error,
    }


def status_object():
    """«Состояние»: the counters, the run to show and the same ``executor`` as in the recognition API."""
    summary = services.summary()
    return {
        "pending_count": summary.pending_count,
        "unclassified_count": summary.unclassified_count,
        "auto_suggest": bool(settings.PRODUCT_CLASSIFICATION_AUTO_SUGGEST),
        "run": run_object(summary.run) if summary.run else None,
        "executor": executor_object(),
    }
