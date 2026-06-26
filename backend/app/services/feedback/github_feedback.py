"""Thin async client that forwards feedback to GitHub.

Bug reports become Issues (REST v3); feature requests become Discussions
(GraphQL v4, since the REST API has no discussions endpoint). Failures raise
``FeedbackError`` so the API layer can return an accurate status code rather
than leaking a 500.
"""
from __future__ import annotations

import logging

import httpx

from . import config

logger = logging.getLogger(__name__)

_REST_BASE = "https://api.github.com"
_GRAPHQL_URL = "https://api.github.com/graphql"
_TIMEOUT = 15.0

# Resolved (repository node id, category id) cached per process — neither
# changes for a given repo+category, so we only pay the lookup once.
_discussion_target: tuple[str, str] | None = None


class FeedbackError(RuntimeError):
    """Raised when GitHub rejects or fails a feedback submission."""


def _headers() -> dict[str, str]:
    token = config.github_token()
    if not token:
        raise FeedbackError("Feedback is not configured (missing GitHub token).")
    return {
        "Accept": "application/vnd.github+json",
        "Authorization": f"Bearer {token}",
        "X-GitHub-Api-Version": "2022-11-28",
    }


async def create_bug_issue(*, title: str, body: str, labels: list[str]) -> dict:
    """Create an Issue on the target repo and return its url + number."""
    owner, repo = config.repo_owner(), config.repo_name()
    if not (owner and repo):
        raise FeedbackError("Feedback is not configured (missing target repo).")

    url = f"{_REST_BASE}/repos/{owner}/{repo}/issues"
    payload = {"title": title, "body": body, "labels": labels}
    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
            resp = await client.post(url, headers=_headers(), json=payload)
    except httpx.HTTPError as exc:  # network/timeout
        logger.exception("GitHub issue request failed")
        raise FeedbackError(f"Could not reach GitHub: {exc}") from exc

    if resp.status_code != 201:
        logger.warning("GitHub issue creation failed: %s %s", resp.status_code, resp.text)
        raise FeedbackError(f"GitHub rejected the bug report (HTTP {resp.status_code}).")

    data = resp.json()
    return {"url": data.get("html_url"), "number": data.get("number")}


async def _graphql(query: str, variables: dict) -> dict:
    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
            resp = await client.post(
                _GRAPHQL_URL,
                headers=_headers(),
                json={"query": query, "variables": variables},
            )
    except httpx.HTTPError as exc:
        logger.exception("GitHub GraphQL request failed")
        raise FeedbackError(f"Could not reach GitHub: {exc}") from exc

    if resp.status_code != 200:
        logger.warning("GitHub GraphQL HTTP error: %s %s", resp.status_code, resp.text)
        raise FeedbackError(f"GitHub rejected the request (HTTP {resp.status_code}).")

    data = resp.json()
    if data.get("errors"):
        logger.warning("GitHub GraphQL errors: %s", data["errors"])
        raise FeedbackError(str(data["errors"][0].get("message", "GraphQL error")))
    return data.get("data", {})


async def _resolve_discussion_target() -> tuple[str, str]:
    """Resolve and cache (repository node id, discussion category id)."""
    global _discussion_target
    if _discussion_target is not None:
        return _discussion_target

    owner, repo = config.repo_owner(), config.repo_name()
    if not (owner and repo):
        raise FeedbackError("Feedback is not configured (missing target repo).")

    query = """
    query($owner: String!, $name: String!) {
      repository(owner: $owner, name: $name) {
        id
        discussionCategories(first: 25) { nodes { id name } }
      }
    }
    """
    data = await _graphql(query, {"owner": owner, "name": repo})
    repository = data.get("repository")
    if not repository:
        raise FeedbackError("Target repository not found or token lacks access.")

    wanted = config.discussion_category().lower()
    categories = repository.get("discussionCategories", {}).get("nodes", [])
    match = next((c for c in categories if c.get("name", "").lower() == wanted), None)
    if match is None and categories:
        # Fall back to the first available category rather than failing outright.
        match = categories[0]
        logger.warning(
            "Discussion category %r not found; using %r",
            config.discussion_category(), match.get("name"),
        )
    if match is None:
        raise FeedbackError(
            "The repository has no discussion categories (enable Discussions first)."
        )

    _discussion_target = (repository["id"], match["id"])
    return _discussion_target


async def create_feature_discussion(*, title: str, body: str) -> dict:
    """Create a Discussion on the target repo and return its url."""
    repo_id, category_id = await _resolve_discussion_target()
    mutation = """
    mutation($repoId: ID!, $categoryId: ID!, $title: String!, $body: String!) {
      createDiscussion(input: {
        repositoryId: $repoId, categoryId: $categoryId, title: $title, body: $body
      }) {
        discussion { url number }
      }
    }
    """
    data = await _graphql(
        mutation,
        {"repoId": repo_id, "categoryId": category_id, "title": title, "body": body},
    )
    discussion = (data.get("createDiscussion") or {}).get("discussion") or {}
    if not discussion.get("url"):
        raise FeedbackError("GitHub did not return a discussion URL.")
    return {"url": discussion["url"], "number": discussion.get("number")}
