from __future__ import annotations
import asyncio
import logging
from abc import ABC, abstractmethod
import httpx
from ....models.paper import Paper

logger = logging.getLogger(__name__)

_MAX_RETRIES = 3
_DEFAULT_RETRY_AFTER = 5  # seconds


class DatabaseAdapter(ABC):
    name: str
    rate_limit: int  # max concurrent requests
    _request_delay: float = 0.0  # seconds between paginated requests

    def __init__(self, api_key: str | None = None, contact_email: str | None = None):
        self._semaphore = asyncio.Semaphore(self.rate_limit)
        self._api_key = api_key
        self._contact_email = contact_email
        self._client: httpx.AsyncClient | None = None

    def _get_client(self) -> httpx.AsyncClient:
        if self._client is None or self._client.is_closed:
            self._client = httpx.AsyncClient(
                timeout=httpx.Timeout(60.0),
                follow_redirects=True,
            )
        return self._client

    async def _request_with_retry(
        self,
        method: str,
        url: str,
        **kwargs,
    ) -> httpx.Response:
        """Make an HTTP request with automatic retry on 429 (rate limit) responses.

        Uses exponential backoff with Retry-After header support.
        """
        for attempt in range(_MAX_RETRIES + 1):
            async with self._semaphore:
                resp = await self._get_client().request(method, url, **kwargs)

            if resp.status_code != 429:
                resp.raise_for_status()
                return resp

            if attempt == _MAX_RETRIES:
                resp.raise_for_status()  # Will raise on 429

            # Parse Retry-After header
            retry_after = _DEFAULT_RETRY_AFTER
            ra_header = resp.headers.get("Retry-After") or resp.headers.get("retry-after")
            if ra_header:
                try:
                    retry_after = int(ra_header)
                except ValueError:
                    retry_after = _DEFAULT_RETRY_AFTER

            wait_time = retry_after * (2 ** attempt)  # exponential backoff
            logger.warning(
                "%s: rate limited (429), retrying in %ds (attempt %d/%d)",
                self.name, wait_time, attempt + 1, _MAX_RETRIES,
            )
            await asyncio.sleep(wait_time)

        # Should not reach here, but just in case
        raise httpx.HTTPStatusError(
            "Rate limited after max retries",
            request=httpx.Request(method, url),
            response=resp,
        )

    @abstractmethod
    async def search(self, query: str, *, max_results: int | None = None) -> list[Paper]:
        """Fetch results for the query and return them.

        Args:
            query: The search query string.
            max_results: Optional cap on total papers to return. None = no cap.
        """

    async def close(self) -> None:
        if self._client and not self._client.is_closed:
            await self._client.aclose()
