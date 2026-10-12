"""Семья из клиента: создание, члены, приглашения, передача роли главного, выход.

Правила (вью проверяют вход и CSRF, здесь — смысл):

- семью создаёт пользователь без семьи и становится её главным;
- главный добавляет человека новой учётной записью (пароль проверяют валидаторы Django,
  хранится только хеш, в ответ попадает один раз) либо одноразовым приглашением на 7 дней
  (хранится SHA-256 токена); приглашение принимает вошедший пользователь без семьи;
- главный убирает члена семьи и передаёт роль; член семьи выходит сам; главный выйти не
  может, пока не передал роль (одному в семье выходить некуда — семья с лимитами останется);
- чеки и фото убранного либо вышедшего остаются за ним (``owner``), семья их больше не видит.

Отказы — ``FamilyError(code, fields=None)``; коды переводит вью.
"""
import hashlib
import secrets
from datetime import timedelta

from django.contrib.auth import get_user_model
from django.contrib.auth.password_validation import validate_password
from django.core.exceptions import ValidationError
from django.db import IntegrityError, transaction
from django.utils import timezone

from accounts.models import Household, Invite, Membership

INVITE_DAYS = 7
NAME_MAX = 100


class FamilyError(Exception):
    def __init__(self, code, fields=None):
        super().__init__(code)
        self.code = code
        self.fields = fields or {}


def token_hash(token):
    return hashlib.sha256(token.encode("utf-8", "surrogatepass")).hexdigest()


def membership_of(user):
    return Membership.objects.select_related("household").filter(user_id=user.pk).first()


def clean_name(name):
    if not isinstance(name, str) or not name.strip():
        raise FamilyError("invalid_parameter", {"name": ["Введите название семьи."]})
    if len(name.strip()) > NAME_MAX:
        raise FamilyError("invalid_parameter", {"name": [f"Не длиннее {NAME_MAX} символов."]})
    return name.strip()


@transaction.atomic
def create(user, name):
    """Новая семья с ``user`` главным; уже в семье — ``already_in_family``."""
    name = clean_name(name)
    if Membership.objects.select_for_update().filter(user_id=user.pk).exists():
        raise FamilyError("already_in_family")
    family = Household.objects.create(name=name)
    try:
        with transaction.atomic():
            Membership.objects.create(user=user, household=family, role=Membership.Role.HEAD)
    except IntegrityError:
        raise FamilyError("already_in_family") from None
    return family


def rename(family, name):
    family.name = clean_name(name)
    family.save(update_fields=["name"])
    return family


def generate_password():
    return secrets.token_urlsafe(12)


@transaction.atomic
def add_member(family, *, username, first_name="", password=None):
    """Новая учётная запись в семье; возвращает ``(user, password)`` — пароль показывается один раз."""
    User = get_user_model()
    errors = {}
    if not isinstance(username, str) or not username.strip():
        errors["username"] = ["Введите логин."]
    else:
        username = username.strip()
        try:
            User.username_validator(username)
        except ValidationError:
            errors["username"] = ["Логин: буквы, цифры и @ . + - _, не длиннее 150."]
        else:
            if len(username) > 150:
                errors["username"] = ["Логин: буквы, цифры и @ . + - _, не длиннее 150."]
            elif User.objects.filter(username__iexact=username).exists():
                errors["username"] = ["Такой логин уже есть."]
    if not isinstance(first_name, str) or len(first_name) > 150:
        errors["first_name"] = ["Имя — строка не длиннее 150 символов."]
    if password is None or password == "":
        password = generate_password()
    elif not isinstance(password, str):
        errors["password"] = ["Ожидается строка."]
    if errors:
        raise FamilyError("invalid_parameter", errors)
    candidate = User(username=username, first_name=first_name.strip())
    try:
        validate_password(password, candidate)
    except ValidationError as error:
        raise FamilyError("invalid_parameter", {"password": [str(message) for message in error.messages]}) from None
    candidate.set_password(password)
    try:
        with transaction.atomic():
            candidate.save()
    except IntegrityError:
        raise FamilyError("invalid_parameter", {"username": ["Такой логин уже есть."]}) from None
    Membership.objects.create(user=candidate, household=family, role=Membership.Role.MEMBER)
    return candidate, password


def member(family, username):
    found = Membership.objects.select_related("user").filter(household=family, user__username=username).first()
    if found is None:
        raise FamilyError("not_found")
    return found


def remove(family, actor, username):
    """Главный убирает члена семьи; себя — нельзя (``head_must_transfer``). Данные остаются за человеком."""
    found = member(family, username)
    if found.user_id == actor.pk:
        raise FamilyError("head_must_transfer")
    found.delete()


@transaction.atomic
def transfer_head(family, actor, username):
    """Роль главного переходит к ``username`` из той же семьи; ``actor`` становится членом."""
    target = member(family, username)
    if target.user_id == actor.pk:
        return target
    Membership.objects.filter(household=family, role=Membership.Role.HEAD).update(role=Membership.Role.MEMBER)
    Membership.objects.filter(pk=target.pk).update(role=Membership.Role.HEAD)
    return target


def leave(user):
    """Член семьи выходит; главный — только после передачи роли (``head_must_transfer``)."""
    found = membership_of(user)
    if found is None:
        raise FamilyError("not_found")
    if found.role == Membership.Role.HEAD:
        raise FamilyError("head_must_transfer")
    found.delete()


def create_invite(family, actor):
    """Новое приглашение: ``(invite, token)``; токен в базе не хранится."""
    token = secrets.token_urlsafe(24)
    invite = Invite.objects.create(household=family, token_hash=token_hash(token), created_by=actor,
                                   expires_at=timezone.now() + timedelta(days=INVITE_DAYS))
    return invite, token


def active_invites(family):
    return Invite.objects.filter(household=family, used_at__isnull=True, expires_at__gt=timezone.now())


@transaction.atomic
def redeem(user, token):
    """Принять приглашение: ``user`` без семьи становится членом. Неверное, просроченное,
    принятое — ``invite_invalid``; уже в семье — ``already_in_family``."""
    if not isinstance(token, str) or not token or len(token) > 200:
        raise FamilyError("invite_invalid")
    invite = Invite.objects.select_for_update().filter(token_hash=token_hash(token)).first()
    if invite is None or invite.used_at is not None or invite.expires_at <= timezone.now():
        raise FamilyError("invite_invalid")
    if Membership.objects.filter(user_id=user.pk).exists():
        raise FamilyError("already_in_family")
    Membership.objects.create(user=user, household=invite.household, role=Membership.Role.MEMBER)
    invite.used_at, invite.used_by = timezone.now(), user
    invite.save(update_fields=["used_at", "used_by"])
    return invite.household
