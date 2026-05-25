from __future__ import annotations
import asyncio
from abc import ABC, abstractmethod
import httpx
from ....models.paper import Paper


class DatabaseAdapter(ABC):
    name: str
    rate_limit: int  # max concurrent requests

    def __init__(self, api_key: str | None = None, contact_email: str | None = None):
        self._semaphore = asyncio.Semaphore(self.rate_limit)
        self._api_key = api_key
        self._contact_email = contact_email
        self._client: httpx.AsyncClient | None = None

    def _get_client(self) -> httpx.AsyncClient:
        if self._client is None or self._client.is_closed:
            self._client = httpx.AsyncClient(
                timeout=httpx.Timeout(30.0),
                follow_redirects=True,
            )
        return self._client

    @abstractmethod
    async def search(self, query: str) -> list[Paper]:
        """Fetch ALL results for the query and return them."""

    async def close(self) -> None:
        if self._client and not self._client.is_closed:
            await self._client.aclose()
