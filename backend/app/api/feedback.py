"""In-app feedback endpoints.

Alpha testers submit bug reports and feature requests from anywhere in the SPA.
Bug reports are filed as GitHub Issues; feature requests as GitHub Discussions.
The submitter's email is attached when they happen to be signed in, but feedback
does not require authentication.
"""
from __future__ import annotations

import logging
import re

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field, field_validator
from sqlalchemy.ext.asyncio import AsyncSession

from ..db.database import get_db
from ..db.orm_models import DBUser
from ..services import feedback
from ..services.feedback import config

router = APIRouter(prefix="/feedback", tags=["feedback"])
logger = logging.getLogger(__name__)

_SESSION_KEY = "user_id"

# Lightweight email sanity check — we only need to reject obvious garbage, not
# fully RFC-validate (no email-validator dependency).
_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def _validate_optional_email(value: str | None) -> str | None:
    if value is None:
        return None
    value = value.strip()
    if not value:
        return None
    if not _EMAIL_RE.match(value):
        raise ValueError("Invalid email address.")
    return value


async def _submitter_email(request: Request, db: AsyncSession) -> str | None:
    """Best-effort lookup of the signed-in user's email (None if anonymous)."""
    user_id = request.session.get(_SESSION_KEY)
    if user_id is None:
        return None
    user = await db.get(DBUser, user_id)
    return user.email if user else None


class BugReport(BaseModel):
    title: str = Field(..., min_length=3, max_length=100)
    description: str = Field(..., min_length=10, max_length=2000)
    steps: str | None = Field(default=None, max_length=1500)
    severity: str | None = Field(default=None, max_length=20)
    contact_email: str | None = Field(default=None, max_length=254)
    page_url: str | None = Field(default=None, max_length=2000)
    user_agent: str | None = Field(default=None, max_length=500)

    @field_validator("contact_email")
    @classmethod
    def _check_email(cls, value: str | None) -> str | None:
        return _validate_optional_email(value)


class FeatureRequest(BaseModel):
    title: str = Field(..., min_length=3, max_length=100)
    description: str = Field(..., min_length=10, max_length=2000)
    motivation: str | None = Field(default=None, max_length=1500)
    contact_email: str | None = Field(default=None, max_length=254)

    @field_validator("contact_email")
    @classmethod
    def _check_email(cls, value: str | None) -> str | None:
        return _validate_optional_email(value)


def _footer(submitter: str | None, contact: str | None) -> str:
    who = contact or submitter or "anonymous"
    return f"\n\n---\nSubmitted by: {who} via OpenKnowledge in-app feedback"


def _bug_body(report: BugReport, submitter: str | None) -> str:
    parts = [f"**Description**\n{report.description}"]
    if report.steps:
        parts.append(f"**Steps to reproduce**\n{report.steps}")
    if report.severity:
        parts.append(f"**Severity:** {report.severity}")
    context = []
    if report.page_url:
        context.append(f"Page: {report.page_url}")
    if report.user_agent:
        context.append(f"User agent: {report.user_agent}")
    if context:
        parts.append("---\n" + "\n".join(context))
    return "\n\n".join(parts) + _footer(submitter, report.contact_email)


def _feature_body(req: FeatureRequest, submitter: str | None) -> str:
    parts = [f"**Description**\n{req.description}"]
    if req.motivation:
        parts.append(f"**Why / motivation**\n{req.motivation}")
    return "\n\n".join(parts) + _footer(submitter, req.contact_email)


def _require_configured() -> None:
    if not config.is_configured():
        raise HTTPException(
            status_code=503,
            detail="Feedback is not configured on this server.",
        )


@router.get("/config")
async def feedback_config() -> dict:
    """Tells the frontend whether the feedback launcher should be shown."""
    return {"enabled": config.is_configured()}


@router.post("/bug")
async def submit_bug(
    report: BugReport,
    request: Request,
    db: AsyncSession = Depends(get_db),
) -> dict:
    _require_configured()
    submitter = await _submitter_email(request, db)
    body = _bug_body(report, submitter)
    try:
        result = await feedback.create_bug_issue(
            title=report.title, body=body, labels=config.bug_labels()
        )
    except feedback.FeedbackError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return {"ok": True, **result}


@router.post("/feature")
async def submit_feature(
    req: FeatureRequest,
    request: Request,
    db: AsyncSession = Depends(get_db),
) -> dict:
    _require_configured()
    submitter = await _submitter_email(request, db)
    body = _feature_body(req, submitter)
    try:
        result = await feedback.create_feature_discussion(title=req.title, body=body)
    except feedback.FeedbackError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return {"ok": True, **result}
