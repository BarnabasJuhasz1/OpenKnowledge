"""Code & dataset enrichment for retrieved papers.

Scans paper abstracts (and existing code_url) for GitHub/GitLab repository
URLs, fetches star counts from the respective APIs, and detects dataset
availability signals in the abstract text.
"""
from __future__ import annotations

import asyncio
import os
import re
from urllib.parse import quote

import httpx

from ...models.paper import Paper

# ---------------------------------------------------------------------------
# Regex patterns
# ---------------------------------------------------------------------------

# Match github.com/owner/repo — stop at whitespace, closing paren/bracket,
# period followed by whitespace/EOL (sentence-ender), commas, or angle brackets.
_GITHUB_RE = re.compile(
    r"https?://(?:www\.)?github\.com/"
    r"(?P<owner>[A-Za-z0-9\-_.]+)/(?P<repo>[A-Za-z0-9\-_.]+)"
    r"(?:/[^\s)}\]>,\"']*)?"  # optional trailing path
)

_GITLAB_RE = re.compile(
    r"https?://(?:www\.)?gitlab\.com/"
    r"(?P<path>[A-Za-z0-9\-_.]+(?:/[A-Za-z0-9\-_.]+)+)"
    r"(?:/[^\s)}\]>,\"']*)?"
)

# Dataset signals — URLs and phrases
_DATASET_URL_RE = re.compile(
    r"(?:zenodo\.org|figshare\.com|huggingface\.co/datasets|"
    r"kaggle\.com/datasets|dataverse\.harvard\.edu|"
    r"data\.mendeley\.com|osf\.io)",
    re.IGNORECASE,
)

_DATASET_PHRASE_RE = re.compile(
    r"(?:dataset\s+(?:is\s+)?(?:available|released|provided|can\s+be\s+(?:found|downloaded)))|"
    r"(?:data\s+(?:is\s+)?(?:available|released|provided)\s+(?:at|from|on|via))|"
    r"(?:publicly\s+available\s+data)|"
    r"(?:supplementary\s+data)|"
    r"(?:benchmark\s+dataset)",
    re.IGNORECASE,
)

# Rate-limiting
_MAX_CONCURRENT = 10
_SEMAPHORE = asyncio.Semaphore(_MAX_CONCURRENT)


# ---------------------------------------------------------------------------
# URL extraction
# ---------------------------------------------------------------------------

def extract_repo_url(paper: Paper) -> tuple[str | None, str]:
    """Extract a GitHub or GitLab repo URL from a paper.

    Looks at ``paper.code_url`` first (if already set by an adapter),
    then scans ``paper.abstract``.

    Returns:
        (normalized_url, host) where host is ``"github"`` or ``"gitlab"``,
        or (None, "") if nothing found.
    """
    texts = []
    if paper.code_url:
        texts.append(paper.code_url)
    if paper.abstract:
        texts.append(paper.abstract)

    for text in texts:
        # GitHub
        m = _GITHUB_RE.search(text)
        if m:
            owner = m.group("owner")
            repo = m.group("repo")
            # Strip common trailing artifacts
            repo = re.sub(r"\.(git|zip|tar\.gz)$", "", repo)
            repo = repo.rstrip(".")
            return f"https://github.com/{owner}/{repo}", "github"

        # GitLab
        m = _GITLAB_RE.search(text)
        if m:
            path = m.group("path")
            path = re.sub(r"\.(git|zip|tar\.gz)$", "", path)
            path = path.rstrip(".")
            return f"https://gitlab.com/{path}", "gitlab"

    return None, ""


# ---------------------------------------------------------------------------
# Dataset detection
# ---------------------------------------------------------------------------

def detect_dataset(abstract: str | None) -> bool:
    """Return True if the abstract contains dataset-availability signals."""
    if not abstract:
        return False
    return bool(_DATASET_URL_RE.search(abstract) or _DATASET_PHRASE_RE.search(abstract))


# ---------------------------------------------------------------------------
# Star fetching
# ---------------------------------------------------------------------------

async def _fetch_github_stars(owner: str, repo: str, client: httpx.AsyncClient) -> int:
    """Fetch stargazers_count from GitHub API."""
    headers: dict[str, str] = {"Accept": "application/vnd.github+json"}
    token = os.getenv("GITHUB_TOKEN")
    if token:
        headers["Authorization"] = f"Bearer {token}"

    async with _SEMAPHORE:
        try:
            resp = await client.get(
                f"https://api.github.com/repos/{owner}/{repo}",
                headers=headers,
                timeout=10.0,
            )
            if resp.status_code == 200:
                return resp.json().get("stargazers_count", 0)
        except Exception:
            pass
    return 0


async def _fetch_gitlab_stars(path: str, client: httpx.AsyncClient) -> int:
    """Fetch star_count from GitLab API."""
    encoded = quote(path, safe="")
    async with _SEMAPHORE:
        try:
            resp = await client.get(
                f"https://gitlab.com/api/v4/projects/{encoded}",
                timeout=10.0,
            )
            if resp.status_code == 200:
                return resp.json().get("star_count", 0)
        except Exception:
            pass
    return 0


async def _fetch_stars(url: str, host: str, client: httpx.AsyncClient) -> int:
    """Dispatch to the right API based on host."""
    if host == "github":
        m = _GITHUB_RE.match(url)
        if m:
            return await _fetch_github_stars(m.group("owner"), m.group("repo"), client)
    elif host == "gitlab":
        m = _GITLAB_RE.match(url)
        if m:
            return await _fetch_gitlab_stars(m.group("path"), client)
    return 0


# ---------------------------------------------------------------------------
# Public enrichment entry point
# ---------------------------------------------------------------------------

async def enrich_papers(papers: list[Paper]) -> None:
    """Enrich papers **in-place** with code/dataset metadata.

    For each paper:
    1. Extract repo URL from abstract / existing code_url
    2. Detect dataset availability from abstract
    3. Fetch star counts for all unique repos concurrently
    4. Write back has_public_code, code_url, repo_stars, has_dataset
    """
    if not papers:
        return

    # Step 1+2: Extract URLs and detect datasets (CPU-bound, fast)
    repo_info: list[tuple[str | None, str]] = []
    for paper in papers:
        url, host = extract_repo_url(paper)
        repo_info.append((url, host))
        paper.has_dataset = detect_dataset(paper.abstract)

    # Step 3: Collect unique repo URLs → fetch stars
    unique_repos: dict[str, str] = {}  # url → host
    for url, host in repo_info:
        if url and url not in unique_repos:
            unique_repos[url] = host

    stars_map: dict[str, int] = {}
    if unique_repos:
        async with httpx.AsyncClient(follow_redirects=True) as client:
            tasks = {
                url: asyncio.create_task(_fetch_stars(url, host, client))
                for url, host in unique_repos.items()
            }
            for url, task in tasks.items():
                stars_map[url] = await task

    # Step 4: Write back
    for paper, (url, host) in zip(papers, repo_info):
        if url:
            paper.has_public_code = True
            if not paper.code_url:
                paper.code_url = url
            paper.repo_stars = stars_map.get(url, 0)
        else:
            # Only set to False if not already set by an adapter
            if paper.has_public_code is None:
                paper.has_public_code = False
            paper.repo_stars = 0
