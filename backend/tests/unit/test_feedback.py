"""Tests for the in-app feedback endpoints (bug → Issues, feature → Discussions)."""
import httpx
import pytest
from httpx import ASGITransport, AsyncClient

from app.main import app
from app.services.feedback import github_feedback

OWNER = "BarnabasJuhasz1"
REPO = "OpenKnowledge"


@pytest.fixture
def configured(monkeypatch):
    """Enable feedback with a token + target repo, and clear cached state."""
    monkeypatch.setenv("FEEDBACK_GITHUB_TOKEN", "test-token")
    monkeypatch.setenv("FEEDBACK_REPO_OWNER", OWNER)
    monkeypatch.setenv("FEEDBACK_REPO_NAME", REPO)
    monkeypatch.setenv("FEEDBACK_DISCUSSION_CATEGORY", "Ideas")
    github_feedback._discussion_target = None
    yield
    github_feedback._discussion_target = None


def _client() -> AsyncClient:
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


@pytest.mark.asyncio
async def test_config_reports_enabled(configured):
    async with _client() as ac:
        resp = await ac.get("/api/feedback/config")
    assert resp.status_code == 200
    assert resp.json() == {"enabled": True}


@pytest.mark.asyncio
async def test_config_disabled_without_repo(monkeypatch):
    monkeypatch.delenv("FEEDBACK_GITHUB_TOKEN", raising=False)
    monkeypatch.delenv("GITHUB_TOKEN", raising=False)
    monkeypatch.delenv("FEEDBACK_REPO_OWNER", raising=False)
    monkeypatch.delenv("FEEDBACK_REPO_NAME", raising=False)
    async with _client() as ac:
        resp = await ac.get("/api/feedback/config")
    assert resp.json() == {"enabled": False}


@pytest.mark.asyncio
async def test_submit_bug_creates_issue(configured, respx_mock):
    route = respx_mock.post(
        f"https://api.github.com/repos/{OWNER}/{REPO}/issues"
    ).mock(
        return_value=httpx.Response(
            201, json={"html_url": f"https://github.com/{OWNER}/{REPO}/issues/7", "number": 7}
        )
    )
    async with _client() as ac:
        resp = await ac.post(
            "/api/feedback/bug",
            json={
                "title": "Graph fails to render",
                "description": "The citation graph stays blank after search.",
                "steps": "1. search 2. open graph",
                "severity": "High",
                "page_url": "http://localhost:4201/okgraph",
                "user_agent": "pytest",
            },
        )
    assert resp.status_code == 200
    body = resp.json()
    assert body["ok"] is True
    assert body["number"] == 7
    assert "/issues/7" in body["url"]
    # The assembled issue body carries the description + context footer.
    sent = route.calls.last.request
    assert b"Graph fails to render" in sent.content
    assert b"Steps to reproduce" in sent.content


@pytest.mark.asyncio
async def test_submit_feature_creates_discussion(configured, respx_mock):
    # Two GraphQL POSTs hit the same URL: the repo/category lookup then the
    # createDiscussion mutation. side_effect returns them in order.
    respx_mock.post("https://api.github.com/graphql").mock(
        side_effect=[
            httpx.Response(
                200,
                json={
                    "data": {
                        "repository": {
                            "id": "R_repo",
                            "discussionCategories": {
                                "nodes": [{"id": "DIC_ideas", "name": "Ideas"}]
                            },
                        }
                    }
                },
            ),
            httpx.Response(
                200,
                json={
                    "data": {
                        "createDiscussion": {
                            "discussion": {
                                "url": f"https://github.com/{OWNER}/{REPO}/discussions/3",
                                "number": 3,
                            }
                        }
                    }
                },
            ),
        ]
    )
    async with _client() as ac:
        resp = await ac.post(
            "/api/feedback/feature",
            json={
                "title": "Add dark mode for graph",
                "description": "It would help during long late-night sessions.",
                "motivation": "Reduce eye strain.",
            },
        )
    assert resp.status_code == 200
    body = resp.json()
    assert body["ok"] is True
    assert "/discussions/3" in body["url"]


@pytest.mark.asyncio
async def test_submit_bug_disabled_returns_503(monkeypatch):
    monkeypatch.delenv("FEEDBACK_GITHUB_TOKEN", raising=False)
    monkeypatch.delenv("GITHUB_TOKEN", raising=False)
    monkeypatch.delenv("FEEDBACK_REPO_OWNER", raising=False)
    async with _client() as ac:
        resp = await ac.post(
            "/api/feedback/bug",
            json={"title": "Some bug", "description": "Something is broken here."},
        )
    assert resp.status_code == 503


@pytest.mark.asyncio
async def test_submit_bug_upstream_error_returns_502(configured, respx_mock):
    respx_mock.post(
        f"https://api.github.com/repos/{OWNER}/{REPO}/issues"
    ).mock(return_value=httpx.Response(401, json={"message": "Bad credentials"}))
    async with _client() as ac:
        resp = await ac.post(
            "/api/feedback/bug",
            json={"title": "Some bug", "description": "Something is broken here."},
        )
    assert resp.status_code == 502


@pytest.mark.asyncio
async def test_short_title_is_rejected(configured):
    async with _client() as ac:
        resp = await ac.post(
            "/api/feedback/bug",
            json={"title": "x", "description": "Something is broken here."},
        )
    assert resp.status_code == 422


@pytest.mark.asyncio
async def test_invalid_email_is_rejected(configured):
    async with _client() as ac:
        resp = await ac.post(
            "/api/feedback/feature",
            json={
                "title": "Nice feature",
                "description": "Please add this thing.",
                "contact_email": "not-an-email",
            },
        )
    assert resp.status_code == 422
