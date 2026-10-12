"""«Семья» из клиента: ``/api/family/…`` (правила — ``accounts.family``).

Только ``accounts``: в ``local_single`` маршрутов нет (``404``). Без входа — ``401``, запись — с CSRF.
Действия главного: не главный — ``403 head_only``, пользователь без семьи — ``404``. Пароль нового
члена семьи возвращается один раз в ответе ``POST members/`` и нигде не пишется в журнал.
Неудачные попытки принять приглашение считает ``accounts.throttle`` (ключи ``i:``), сверх
предела — ``429 login_throttled`` с ``retry_after``.
"""
from rest_framework import status
from rest_framework.exceptions import ParseError, UnsupportedMediaType
from rest_framework.response import Response

from accounts import family, throttle
from accounts.access import request_user
from accounts.models import Membership
from accounts.people import display_name
from api.common import utc_datetime
from config.exceptions import AuthApiError, InvalidParameter, InvalidRequest, ObjectNotFound, RecognitionApiError

from .auth import AccountsSignedIn
from .recognition_base import JsonObjectParser, LocalAPIView

INVITE_PATH = "/family/join?token="


def raise_family(error):
    if error.code == "invalid_parameter":
        raise InvalidParameter(error.fields) from None
    if error.code == "not_found":
        raise ObjectNotFound() from None
    raise RecognitionApiError(error.code) from None


def invite_object(invite):
    return {"id": invite.pk, "created_at": utc_datetime(invite.created_at), "expires_at": utc_datetime(invite.expires_at)}


def family_object(request):
    user = request_user(request)
    own = family.membership_of(user)
    if own is None:
        return {"household": None, "is_head": True, "invites": []}
    rows = own.household.memberships.select_related("user").order_by("user__username")
    head = own.role == Membership.Role.HEAD
    return {
        "household": {
            "id": own.household.pk, "name": own.household.name,
            "members": [{"username": row.user.get_username(), "display_name": display_name(row.user), "role": row.role,
                         "is_me": row.user_id == user.pk} for row in rows],
        },
        "is_head": head,
        "invites": [invite_object(invite) for invite in family.active_invites(own.household)] if head else [],
    }


class FamilyBaseView(LocalAPIView):
    permission_classes = [AccountsSignedIn]
    parser_classes = [JsonObjectParser]

    def body(self, request, allowed):
        if request.content_type != "application/json":
            raise UnsupportedMediaType(request.content_type)
        if request._request.META.get("CONTENT_LENGTH") in (None, "", "0"):
            return {}
        try:
            data = request.data
        except ParseError:
            raise InvalidRequest() from None
        if not isinstance(data, dict):
            raise InvalidRequest()
        unknown = {key: ["Неизвестное поле."] for key in data if key not in allowed}
        if unknown:
            raise InvalidParameter(unknown)
        return data

    def head_family(self, request):
        """Семья, где запрос — главный; без семьи — ``404``, не главный — ``403 head_only``."""
        own = family.membership_of(request_user(request))
        if own is None:
            raise ObjectNotFound()
        if own.role != Membership.Role.HEAD:
            raise RecognitionApiError("head_only")
        return own.household


class FamilyView(FamilyBaseView):
    """``GET`` — семья запроса; ``POST`` ``{name}`` — создать (создатель — главный); ``PATCH`` ``{name}`` — переименовать."""

    http_method_names = ["get", "post", "patch", "head", "options"]

    def get(self, request):
        return Response(family_object(request))

    def post(self, request):
        data = self.body(request, ("name",))
        try:
            family.create(request_user(request), data.get("name"))
        except family.FamilyError as error:
            raise_family(error)
        return Response(family_object(request), status=status.HTTP_201_CREATED)

    def patch(self, request):
        data = self.body(request, ("name",))
        household = self.head_family(request)
        try:
            family.rename(household, data.get("name"))
        except family.FamilyError as error:
            raise_family(error)
        return Response(family_object(request))


class MembersView(FamilyBaseView):
    """``POST`` ``{username, first_name?, password?}`` — новая учётная запись в семье; пароль — один раз в ответе."""

    http_method_names = ["post", "options"]

    def post(self, request):
        data = self.body(request, ("username", "first_name", "password"))
        household = self.head_family(request)
        try:
            user, password = family.add_member(household, username=data.get("username"),
                                               first_name=data.get("first_name") or "", password=data.get("password"))
        except family.FamilyError as error:
            raise_family(error)
        return Response({
            "member": {"username": user.get_username(), "display_name": display_name(user), "role": "member", "is_me": False},
            "password": password,
        }, status=status.HTTP_201_CREATED)


class MemberView(FamilyBaseView):
    """``DELETE`` — убрать члена семьи: его чеки остаются за ним, доступ к семье пропадает."""

    http_method_names = ["delete", "options"]

    def delete(self, request, username):
        household = self.head_family(request)
        try:
            family.remove(household, request_user(request), username)
        except family.FamilyError as error:
            raise_family(error)
        return Response(status=status.HTTP_204_NO_CONTENT)


class HeadView(FamilyBaseView):
    """``POST`` ``{username}`` — передать роль главного члену той же семьи."""

    http_method_names = ["post", "options"]

    def post(self, request):
        data = self.body(request, ("username",))
        household = self.head_family(request)
        if not isinstance(data.get("username"), str):
            raise InvalidParameter({"username": ["Обязательное поле."]})
        try:
            family.transfer_head(household, request_user(request), data["username"])
        except family.FamilyError as error:
            raise_family(error)
        return Response(family_object(request))


class LeaveView(FamilyBaseView):
    """``POST`` — выйти из семьи (член семьи); главный — ``409 head_must_transfer``."""

    http_method_names = ["post", "options"]

    def post(self, request):
        try:
            family.leave(request_user(request))
        except family.FamilyError as error:
            raise_family(error)
        return Response(family_object(request))


class InvitesView(FamilyBaseView):
    """``POST`` — новое одноразовое приглашение на 7 дней; токен — только в этом ответе."""

    http_method_names = ["post", "options"]

    def post(self, request):
        household = self.head_family(request)
        invite, token = family.create_invite(household, request_user(request))
        return Response({**invite_object(invite), "token": token, "path": INVITE_PATH + token},
                        status=status.HTTP_201_CREATED)


class InviteView(FamilyBaseView):
    """``DELETE`` — отозвать приглашение своей семьи."""

    http_method_names = ["delete", "options"]

    def delete(self, request, pk):
        household = self.head_family(request)
        deleted, _ = household.invites.filter(pk=pk, used_at__isnull=True).delete()
        if not deleted:
            raise ObjectNotFound()
        return Response(status=status.HTTP_204_NO_CONTENT)


class JoinView(FamilyBaseView):
    """``POST`` ``{token}`` — принять приглашение (вошедший пользователь без семьи)."""

    http_method_names = ["post", "options"]

    def post(self, request):
        data = self.body(request, ("token",))
        user = request_user(request)
        bucket = throttle.address_bucket(throttle.client_address(request._request))
        keys = throttle.Keys(f"i:{bucket}:{user.pk}", f"ia:{bucket}")
        seconds = throttle.retry_after(keys)
        if seconds:
            raise AuthApiError("login_throttled", retry_after=seconds)
        try:
            family.redeem(user, data.get("token"))
        except family.FamilyError as error:
            if error.code == "invite_invalid":
                throttle.record_failure(keys)
            raise_family(error)
        return Response(family_object(request))
