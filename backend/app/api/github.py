import os
import time
import logging
import httpx
from fastapi import APIRouter

router = APIRouter(prefix="/github", tags=["github"])
logger = logging.getLogger(__name__)

# Simple in-memory cache for GitHub stargazers count to avoid hitting rate limits.
# Key: (owner, repo), Value: (timestamp, stars)
_stars_cache = {}
_CACHE_TTL = 300  # Cache for 5 minutes

@router.get("/stars/{owner}/{repo}")
async def get_github_stars(owner: str, repo: str) -> dict:
    current_time = time.time()
    cache_key = (owner.lower(), repo.lower())
    
    if cache_key in _stars_cache:
        cached_time, cached_stars = _stars_cache[cache_key]
        if current_time - cached_time < _CACHE_TTL:
            return {"stargazers_count": cached_stars}
            
    # Not cached or cache expired, fetch from GitHub API
    headers = {"Accept": "application/vnd.github+json"}
    token = os.getenv("GITHUB_TOKEN")
    if token:
        headers["Authorization"] = f"Bearer {token}"
        
    try:
        async with httpx.AsyncClient() as client:
            resp = await client.get(
                f"https://api.github.com/repos/{owner}/{repo}",
                headers=headers,
                timeout=10.0,
            )
            if resp.status_code == 200:
                stars = resp.json().get("stargazers_count", 0)
                _stars_cache[cache_key] = (current_time, stars)
                return {"stargazers_count": stars}
            else:
                logger.warning(
                    f"Failed to fetch GitHub stars for {owner}/{repo}. "
                    f"Status: {resp.status_code}, Body: {resp.text}"
                )
    except Exception as exc:
        logger.exception(f"Error fetching GitHub stars for {owner}/{repo}: {exc}")
        
    # If the API call fails, fallback to the last cached value if it exists, or return 0
    if cache_key in _stars_cache:
        _, cached_stars = _stars_cache[cache_key]
        return {"stargazers_count": cached_stars}
        
    return {"stargazers_count": 0}
