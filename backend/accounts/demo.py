"""Two fictional accounts with data of each, for checks of the ``accounts`` mode. Test/QA databases only.

A catalog moderator and an ordinary user. Each has one receipt of the same store with the
same product (a shared price history), one product bought by nobody else, a photo with a
finished job and a crop whose files lie under ``MEDIA_ROOT``, and a line of a duplicate
spelling: the detector joins the two spellings into one pending merge group holding lines
of both owners. The merchant, the store, the names and the pictures are invented.

Passwords come from the caller and are stored only as hashes. Needs an empty database:
the ids go to a proxy script and the detector scans the whole catalog.
"""
import hashlib
import io
import shutil
import uuid
from datetime import date, datetime, time
from decimal import Decimal
from pathlib import Path
from zoneinfo import ZoneInfo

from django.conf import settings
from django.db import IntegrityError, transaction
from PIL import Image, ImageDraw

from merges.demo import DemoError, allowed_database
from merges.detection import SERVICE_GENERIC_NAME

MODERATOR, USER = "moderator", "user"
USERNAMES = {MODERATOR: "demo_moderator", USER: "demo_user"}
MODERATE_PERMISSION = ("catalog", "moderate_catalog")

MERCHANT = {
    "legal_name": "Kontomarkt Testhandel GmbH (вымышленный)", "brand_name": "Kontomarkt",
    "tax_id": "DEMOACCOUNTS0001", "address_raw": "Beispielallee 5, 00000 Musterstadt",
}
SHARED_PRODUCT = "Demo Vollmilch 3,5% 1L"
OWN_PRODUCTS = {MODERATOR: "Demo Roggenbrot 750g", USER: "Demo Apfelschorle 0,5L"}
# Two spellings of one product, one per account: the pending merge group. The first is
# created first, so the detector keeps it and moves the line of the second one to it.
DUPLICATES = {MODERATOR: "Demo Haferkekse Schoko", USER: "Demo Haferkeks Schoko"}
# Creation order fixes the ids.
PRODUCTS = (SHARED_PRODUCT, OWN_PRODUCTS[MODERATOR], OWN_PRODUCTS[USER], DUPLICATES[MODERATOR], DUPLICATES[USER])

# role -> (receipt number, local date, ((printed name, quantity, unit price, amount), ...))
RECEIPTS = {
    MODERATOR: ("DEMO-ACCOUNTS-01", date(2026, 9, 7), (
        (SHARED_PRODUCT, "2.000", "1.1900", "2.38"),
        (OWN_PRODUCTS[MODERATOR], "1.000", "2.4900", "2.49"),
        (DUPLICATES[MODERATOR], "1.000", "1.7900", "1.79"),
    )),
    USER: ("DEMO-ACCOUNTS-02", date(2026, 9, 21), (
        (SHARED_PRODUCT, "1.000", "1.2900", "1.29"),
        (OWN_PRODUCTS[USER], "3.000", "0.8900", "2.67"),
        (DUPLICATES[USER], "2.000", "1.8900", "3.78"),
    )),
}
# Different pictures: a foreign file served by mistake differs from one's own in bytes.
PAPER = {MODERATOR: (236, 240, 226), USER: (226, 236, 244)}
PHOTO_SIZE, CROP_SIZE = (240, 320), (200, 280)
BBOX = {"x_min": 0.1, "y_min": 0.1, "x_max": 0.9, "y_max": 0.9}


def _png(size, color, caption):
    with Image.new("RGB", size, color) as image:
        ImageDraw.Draw(image).text((12, 12), f"SYNTHETIC - TEST ONLY\n{caption}", fill="black")
        buffer = io.BytesIO()
        image.save(buffer, format="PNG")
    return buffer.getvalue()


def _write(root, name, data, written):
    """Publish ``data`` as ``MEDIA_ROOT/name`` in a new directory, as ``recognition.storage`` does."""
    target = (root / name).resolve()
    if not target.is_relative_to(root):
        raise DemoError("Demo files must remain inside MEDIA_ROOT.")
    target.parent.mkdir(parents=True, exist_ok=False)
    written.append(target.parent)
    target.write_bytes(data)
    return name


def _remove(root, written):
    """Remove the published files and the directories left empty by them, never ``root`` itself."""
    for directory in reversed(written):
        shutil.rmtree(directory, ignore_errors=True)
        for parent in directory.parents:
            if parent == root or not parent.is_relative_to(root):
                break
            try:
                parent.rmdir()
            except OSError:
                break


def _validated(passwords):
    from django.contrib.auth import get_user_model
    from django.contrib.auth.password_validation import validate_password
    from django.core.exceptions import ValidationError

    for role, username in USERNAMES.items():
        password = passwords.get(role)
        if not isinstance(password, str) or not password:
            raise DemoError(f"A password for {username} is required.")
        try:
            validate_password(password, get_user_model()(username=username))
        except ValidationError as error:
            raise DemoError(f"The password for {username} is refused: {' '.join(error.messages)}") from None


def _require_empty():
    from django.contrib.auth import get_user_model

    from catalog.models import Product
    from merges.models import ProductMerge
    from receipts.models import Receipt
    from recognition.models import SourcePhoto

    occupied = [
        model._meta.label for model in (Product, Receipt, SourcePhoto, ProductMerge) if model.objects.exists()
    ]
    if get_user_model().objects.filter(username__in=USERNAMES.values()).exists():
        occupied.append("demo accounts")
    if occupied:
        raise DemoError(
            f"Accounts demo data require an empty QA database; found: {', '.join(occupied)}. Nothing was changed."
        )


def _photo(root, owner, role, receipt, written):
    from django.utils import timezone

    from recognition.models import ProcessingJob, ReceiptImage, SourcePhoto

    storage_uuid = uuid.uuid4()
    source = _png(PHOTO_SIZE, PAPER[role], f"{USERNAMES[role]} photo")
    crop = _png(CROP_SIZE, PAPER[role], f"{USERNAMES[role]} crop")
    width, height = PHOTO_SIZE
    photo = SourcePhoto.objects.create(
        owner=owner, storage_uuid=storage_uuid,
        original_file=_write(root, f"originals/{storage_uuid}/source.png", source, written),
        upright_file=_write(root, f"prepared/{storage_uuid}/{uuid.uuid4()}/upright-v1.png", source, written),
        sha256=hashlib.sha256(source).hexdigest(), content_type="image/png", bytes=len(source),
        raw_width=width, raw_height=height, width=width, height=height, preparation_version=1,
    )
    now = timezone.now()
    job = ProcessingJob.objects.create(
        photo=photo, status=ProcessingJob.Status.SUCCEEDED, stage=ProcessingJob.Stage.FINISHED,
        detected_count=1, completed_count=1, imported_count=1, started_at=now, finished_at=now,
    )
    image = ReceiptImage.objects.create(
        photo=photo, job=job, position=1,
        file=_write(root, f"crops/{storage_uuid}/{job.pk}/1-{uuid.uuid4()}/crop.png", crop, written),
        sha256=hashlib.sha256(crop).hexdigest(), width=CROP_SIZE[0], height=CROP_SIZE[1], bbox=BBOX,
        status=ReceiptImage.Status.IMPORTED, receipt=receipt, import_effect=ReceiptImage.ImportEffect.CREATED,
        outcome_snapshot={"receipt_id": receipt.pk},
    )
    return {
        "photo_id": photo.pk, "job_id": job.pk, "image_id": image.pk, "storage_uuid": str(storage_uuid),
        "original": photo.original_file.name, "prepared": photo.upright_file.name, "crop": image.file.name,
    }


def seed_demo(*, moderator_password, user_password):
    """Create the demo on an empty database and return the ids; a refusal changes nothing.

    ``media`` paths are relative to ``MEDIA_ROOT`` (the URL is ``/media/`` + path). The
    passwords are not part of the result.
    """
    from django.contrib.auth import get_user_model
    from django.contrib.auth.models import Permission

    from catalog.models import Category, GenericProduct, Product
    from merges import services
    from merges.models import ProductMerge
    from receipts.dedup import name_key
    from receipts.models import ProductAlias, Receipt, ReceiptLine
    from stores.models import Country, Currency, Merchant, Store

    if not allowed_database(settings.DATABASES["default"]["NAME"]):
        raise DemoError("Accounts demo data require a test_* or checkist_qa* database; dev/production is forbidden.")
    passwords = {MODERATOR: moderator_password, USER: user_password}
    _validated(passwords)
    root = Path(settings.MEDIA_ROOT).resolve()
    written = []
    try:
        with transaction.atomic():
            _require_empty()
            app_label, codename = MODERATE_PERMISSION
            permission = Permission.objects.filter(content_type__app_label=app_label, codename=codename).first()
            if permission is None:
                raise DemoError(f"Permission {app_label}.{codename} is missing; apply the migrations first.")
            User = get_user_model()
            users = {
                role: User.objects.create_user(username, password=passwords[role])
                for role, username in USERNAMES.items()
            }
            users[MODERATOR].user_permissions.add(permission)

            country, _ = Country.objects.get_or_create(code="DE", defaults={"name": "Германия"})
            currency, _ = Currency.objects.get_or_create(code="EUR", defaults={"name": "Евро"})
            merchant = Merchant.objects.create(
                country=country, legal_name=MERCHANT["legal_name"], brand_name=MERCHANT["brand_name"],
                tax_id=MERCHANT["tax_id"], tax_id_type=Merchant.TaxIdType.OTHER,
            )
            store = Store.objects.create(
                merchant=merchant, country=country, name=MERCHANT["brand_name"],
                address_raw=MERCHANT["address_raw"], city="Musterstadt", timezone="Europe/Berlin",
            )
            category, _ = Category.objects.get_or_create(parent=None, name=SERVICE_GENERIC_NAME)
            generic, _ = GenericProduct.objects.get_or_create(
                name__iexact=SERVICE_GENERIC_NAME,
                defaults={"name": SERVICE_GENERIC_NAME, "category": category, "base_unit": "pcs"},
            )
            # Products as the importer leaves them: the service generic and one alias per spelling.
            products = {}
            for name in PRODUCTS:
                products[name] = Product.objects.create(generic=generic, name=name)
                ProductAlias.objects.create(
                    merchant=merchant, product=products[name], name_key=name_key(name), raw_name=name,
                )
            receipts = {}
            for role, (number, on, rows) in RECEIPTS.items():
                receipts[role] = Receipt.objects.create(
                    owner=users[role], store=store, currency=currency, operation=Receipt.Operation.SALE,
                    purchased_on=on, purchased_at=datetime.combine(on, time(12, 0), tzinfo=ZoneInfo(store.timezone)),
                    receipt_number=number, total=sum(Decimal(row[3]) for row in rows),
                )
                ReceiptLine.objects.bulk_create(
                    ReceiptLine(
                        receipt=receipts[role], position=position, kind=ReceiptLine.Kind.PRODUCT, raw_name=name,
                        quantity=Decimal(quantity), unit="pcs", unit_price=Decimal(unit_price),
                        amount=Decimal(amount), product=products[name],
                    )
                    for position, (name, quantity, unit_price, amount) in enumerate(rows, 1)
                )
            media = {role: _photo(root, users[role], role, receipts[role], written) for role in USERNAMES}

            try:
                detected = services.detect()
            except services.MergeBusy:
                raise DemoError("The catalog is being changed by an import or another merge. Retry later.") from None
            if detected.created != 1 or len(detected.group_ids) != 1:
                raise DemoError("The duplicate detector did not make exactly one group of the demo spellings.")
            group = ProductMerge.objects.get(pk=detected.group_ids[0])
            duplicate_ids = sorted(products[name].pk for name in DUPLICATES.values())
            if sorted(group.members.values_list("product_ref", flat=True)) != duplicate_ids:
                raise DemoError("The duplicate detector grouped other products than the demo spellings.")
            merge_lines = {
                role: list(ReceiptLine.objects.filter(
                    receipt=receipts[role], product_id=group.target_ref,
                ).order_by("position").values_list("pk", flat=True))
                for role in USERNAMES
            }
    except IntegrityError:
        _remove(root, written)
        raise DemoError("Demo names collide with existing records; use an empty QA database.") from None
    except BaseException:
        _remove(root, written)
        raise
    return {
        "created": True,
        "users": {role: {"id": users[role].pk, "username": users[role].username} for role in USERNAMES},
        "store_id": store.pk,
        "shared_product_id": products[SHARED_PRODUCT].pk,
        "own_product_ids": {role: products[name].pk for role, name in OWN_PRODUCTS.items()},
        "receipt_ids": {role: receipts[role].pk for role in USERNAMES},
        "merge": {
            "group_id": group.pk, "target_product_id": group.target_ref, "product_ids": duplicate_ids,
            "line_ids": merge_lines,
        },
        "media": media,
    }
