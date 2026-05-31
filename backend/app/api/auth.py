"""3rd-party OAuth sign-in endpoints.

Flow (authorization code):
  1. GET  /api/auth/login/{provider}      → 302 to the provider's consent screen
  2. GET/POST /api/auth/callback/{provider} → exchange code, upsert the user,
                                              store user_id in the session,
                                              302 back to the SPA dashboard
  3. GET  /api/auth/me                     → current user, or 401
  4. POST /api/auth/logout                 → clear the session

This is the only authentication mechanism: there is no password store.
"""
from __future__ import annotations

from datetime import datetime, timezone

from authlib.integrations.starlette_client import OAuthError
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import RedirectResponse, Response
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..auth.config import (
    FRONTEND_URL,
    configured_providers,
    oauth,
    redirect_uri_for,
)
from ..db.database import get_db
from ..db.orm_models import DBUser

router = APIRouter(prefix="/auth", tags=["auth"])

_SESSION_KEY = "user_id"


class UserOut(BaseModel):
    id: int
    provider: str
    email: str | None
    name: str | None
    avatar_url: str | None

    model_config = {"from_attributes": True}


class ProvidersOut(BaseModel):
    providers: list[str]


# ── Helpers ──────────────────────────────────────────────────────────────────
async def current_user(
    request: Request, db: AsyncSession = Depends(get_db)
) -> DBUser:
    """Resolve the signed-in user from the session, or 401."""
    user_id = request.session.get(_SESSION_KEY)
    if user_id is None:
        raise HTTPException(status_code=401, detail="Not authenticated")
    user = await db.get(DBUser, user_id)
    if user is None:
        request.session.pop(_SESSION_KEY, None)
        raise HTTPException(status_code=401, detail="Not authenticated")
    return user


def _require_provider(provider: str):
    if provider not in configured_providers():
        raise HTTPException(status_code=404, detail=f"Unknown or unconfigured provider: {provider}")
    return oauth.create_client(provider)


async def _profile_from_token(provider: str, client, token: dict) -> dict:
    """Normalise the provider's identity payload to a common shape."""
    if provider == "github":
        gh = (await client.get("user", token=token)).json()
        email = gh.get("email")
        if not email:
            emails = (await client.get("user/emails", token=token)).json()
            if isinstance(emails, list):
                email = next(
                    (e.get("email") for e in emails if e.get("primary")),
                    next((e.get("email") for e in emails), None),
                )
        return {
            "provider_account_id": str(gh["id"]),
            "email": email,
            "name": gh.get("name") or gh.get("login"),
            "avatar_url": gh.get("avatar_url"),
        }

    # OIDC providers: the id_token is parsed into `userinfo` during exchange.
    userinfo = token.get("userinfo")
    if not userinfo:
        userinfo = await client.userinfo(token=token)
    return {
        "provider_account_id": userinfo["sub"],
        "email": userinfo.get("email"),
        "name": userinfo.get("name") or userinfo.get("email"),
        "avatar_url": userinfo.get("picture"),
    }


async def _upsert_user(db: AsyncSession, provider: str, profile: dict) -> DBUser:
    result = await db.execute(
        select(DBUser).where(
            DBUser.provider == provider,
            DBUser.provider_account_id == profile["provider_account_id"],
        )
    )
    user = result.scalar_one_or_none()
    now = datetime.now(timezone.utc)
    if user is None:
        user = DBUser(provider=provider, provider_account_id=profile["provider_account_id"])
        db.add(user)
    # Refresh mutable profile fields on every login.
    user.email = profile.get("email")
    user.name = profile.get("name")
    user.avatar_url = profile.get("avatar_url")
    user.last_login_at = now
    await db.commit()
    await db.refresh(user)
    return user


# ── Routes ───────────────────────────────────────────────────────────────────
@router.get("/providers", response_model=ProvidersOut)
async def providers() -> ProvidersOut:
    return ProvidersOut(providers=configured_providers())


@router.get("/me", response_model=UserOut)
async def me(user: DBUser = Depends(current_user)) -> DBUser:
    return user


@router.post("/logout", status_code=204)
async def logout(request: Request) -> Response:
    request.session.clear()
    return Response(status_code=204)


@router.get("/login/{provider}")
async def login(provider: str, request: Request):
    client = _require_provider(provider)
    return await client.authorize_redirect(request, redirect_uri_for(provider))


# Apple uses response_mode=form_post, so the callback must accept POST too.
@router.api_route("/callback/{provider}", methods=["GET", "POST"])
async def callback(provider: str, request: Request, db: AsyncSession = Depends(get_db)):
    client = _require_provider(provider)
    try:
        token = await client.authorize_access_token(request)
        profile = await _profile_from_token(provider, client, token)
        user = await _upsert_user(db, provider, profile)
    except OAuthError:
        return RedirectResponse(url=f"{FRONTEND_URL}/?login=error")
    except Exception:  # noqa: BLE001 — never leak the OAuth error to the SPA
        return RedirectResponse(url=f"{FRONTEND_URL}/?login=error")

    request.session[_SESSION_KEY] = user.id
    return RedirectResponse(url=f"{FRONTEND_URL}/dashboard")
