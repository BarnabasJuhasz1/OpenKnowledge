import pytest
import httpx
from httpx import AsyncClient, ASGITransport
from app.main import app
from app.api.github import _stars_cache

@pytest.mark.asyncio
async def test_github_stars_endpoint(respx_mock):
    # Clear cache before test
    _stars_cache.clear()
    
    # Mock the github api call
    owner = "BarnabasJuhasz1"
    repo = "OpenKnowledge"
    respx_mock.get(f"https://api.github.com/repos/{owner}/{repo}").mock(
        return_value=httpx.Response(
            status_code=200,
            json={"stargazers_count": 42}
        )
    )
    
    # Use ASGITransport for FastAPI testing
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        response = await ac.get(f"/api/github/stars/{owner}/{repo}")
        
    assert response.status_code == 200
    assert response.json() == {"stargazers_count": 42}
    
    # Verify caching: if we call again and the API returned a different value (or is not mocked),
    # it should still return the cached 42 without making another call.
    respx_mock.clear()
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        response = await ac.get(f"/api/github/stars/{owner}/{repo}")
        
    assert response.status_code == 200
    assert response.json() == {"stargazers_count": 42}
