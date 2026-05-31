"""OAuth client registry and auth-related settings.

Providers are registered lazily and only when both a client id and secret are
present in the environment, so the backend boots with zero credentials — the
frontend simply receives a shorter `providers` list and shows fewer buttons.

Supported providers: google, microsoft, apple (all OIDC) and github (plain
OAuth2 + the GitHub user API).
"""
from __future__ import annotations

import os

from authlib.integrations.starlette_client import OAuth

# ── General settings ────────────────────────────────────────────────────────
# A signed-cookie session secret. MUST be overridden in production; the dev
# default keeps local sign-in working without any setup.
SESSION_SECRET = os.getenv("SESSION_SECRET", "dev-insecure-session-secret-change-me")

# Where the SPA lives. The OAuth callback redirects back here after sign-in.
FRONTEND_URL = os.getenv("FRONTEND_URL", "http://localhost:4201").rstrip("/")

# Public base the OAuth provider redirects to. In dev the Angular proxy serves
# /api on the frontend origin, so the callback is same-origin with the SPA and
# the session cookie stays first-party (SameSite=Lax is enough).
OAUTH_REDIRECT_BASE_URL = os.getenv("OAUTH_REDIRECT_BASE_URL", FRONTEND_URL).rstrip("/")

# OIDC providers get discovery + id-token parsing for free.
_OIDC_PROVIDERS = {
    "google": {
        "server_metadata_url": "https://accounts.google.com/.well-known/openid-configuration",
        "client_kwargs": {"scope": "openid email profile"},
    },
    "microsoft": {
        # 'common' tenant accepts both work/school and personal accounts.
        "server_metadata_url": "https://login.microsoftonline.com/common/v2.0/.well-known/openid-configuration",
        "client_kwargs": {"scope": "openid email profile"},
    },
    "apple": {
        "server_metadata_url": "https://appleid.apple.com/.well-known/openid-configuration",
        # Requesting name/email makes Apple POST the callback (response_mode=
        # form_post); the callback route accepts POST for exactly this reason.
        "client_kwargs": {"scope": "openid email name", "response_mode": "form_post"},
    },
}


def _env(provider: str, key: str) -> str | None:
    return os.getenv(f"{provider.upper()}_{key}")


def _build_oauth() -> tuple[OAuth, list[str]]:
    oauth = OAuth()
    registered: list[str] = []

    for name, cfg in _OIDC_PROVIDERS.items():
        client_id = _env(name, "CLIENT_ID")
        client_secret = _env(name, "CLIENT_SECRET")
        if not (client_id and client_secret):
            continue
        oauth.register(
            name=name,
            client_id=client_id,
            client_secret=client_secret,
            server_metadata_url=cfg["server_metadata_url"],
            client_kwargs=dict(cfg["client_kwargs"]),
        )
        registered.append(name)

    # GitHub is not OIDC — register its endpoints explicitly and read the profile
    # from the REST API in the callback.
    gh_id = _env("github", "CLIENT_ID")
    gh_secret = _env("github", "CLIENT_SECRET")
    if gh_id and gh_secret:
        oauth.register(
            name="github",
            client_id=gh_id,
            client_secret=gh_secret,
            access_token_url="https://github.com/login/oauth/access_token",
            authorize_url="https://github.com/login/oauth/authorize",
            api_base_url="https://api.github.com/",
            client_kwargs={"scope": "read:user user:email"},
        )
        registered.append("github")

    return oauth, registered


# Built once at import. The known provider order is stable for the UI.
oauth, _registered = _build_oauth()


def configured_providers() -> list[str]:
    """Names of providers that have credentials and are ready to use."""
    return list(_registered)


def redirect_uri_for(provider: str) -> str:
    return f"{OAUTH_REDIRECT_BASE_URL}/api/auth/callback/{provider}"
