"""OpenAlex abstract backfill adapter (targeted / incremental).

Fetches OpenAlex abstracts for a bounded set of identifiers (DOI / PMID / MAG), reconstructs
plaintext from the inverted index, and returns them keyed by the input id. This is the
runnable-now path of the abstract backfill (plans/.../abstract_backfill_03_*): it needs no
infra and writes to the same BigQuery sink (`semantic_scholar.abstracts_openalex`) as the
bulk snapshot path, via the driver `scripts/backfill_abstracts_openalex.py`.

Honors the CLAUDE.md adapter rules: polite-pool ``mailto`` on every request, a token-bucket
rate limiter, exponential backoff on 429/5xx, and an on-disk response cache so re-runs do not
re-hit the API.

``reconstruct_abstract`` is the pure unit-test anchor and is kept behaviourally identical to
the bulk JS UDF in ``scripts/openalex_extract_abstracts.sql`` and the existing
``adapters/openalex.py`` reconstruction — same plaintext for the same inverted index.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import time
from dataclasses import dataclass
from pathlib import Path

import httpx

logger = logging.getLogger(__name__)

# OpenAlex caps OR-filters at 50 values per request; keep the payload small with `select`.
_MAX_BATCH = 50
_SELECT = "id,ids,abstract_inverted_index"
# match_key -> (OpenAlex filter field, function that normalizes the work's id back to the
# bare form we joined on / were given as input).
_FILTER_FIELD = {"doi": "doi", "pmid": "pmid", "mag": "mag"}


# ---------------------------------------------------------------------------
# Pure helpers (unit-test anchors)
# ---------------------------------------------------------------------------

def reconstruct_abstract(inverted_index: dict[str, list[int]] | None) -> str | None:
    """Rebuild plaintext from an OpenAlex ``abstract_inverted_index``.

    Place each token at each of its positions, join by a single space, strip. Returns
    ``None`` for a missing/empty index or an all-blank result. Out-of-order positions and
    gaps are handled (tokens are placed by absolute position, then read left to right).
    """
    if not inverted_index:
        return None
    pos_word: dict[int, str] = {}
    for word, positions in inverted_index.items():
        for p in positions or []:
            pos_word[p] = word
    if not pos_word:
        return None
    text = " ".join(pos_word[i] for i in sorted(pos_word)).strip()
    return text or None


def normalize_doi(value: str | None) -> str | None:
    """Bare, lowercase DOI (strip any doi.org prefix) — matches the BigQuery crosswalk."""
    if not value:
        return None
    bare = value.strip()
    for prefix in ("https://doi.org/", "http://doi.org/",
                   "https://dx.doi.org/", "http://dx.doi.org/"):
        if bare.lower().startswith(prefix):
            bare = bare[len(prefix):]
            break
    bare = bare.lower().strip()
    return bare or None


def normalize_pmid(value: str | None) -> str | None:
    """Bare PubMed id (strip the pubmed URL prefix) — matches the crosswalk's CAST."""
    if not value:
        return None
    bare = str(value).strip()
    for prefix in ("https://pubmed.ncbi.nlm.nih.gov/", "http://pubmed.ncbi.nlm.nih.gov/"):
        if bare.startswith(prefix):
            bare = bare[len(prefix):]
            break
    bare = bare.rstrip("/").strip()
    return bare or None


def normalize_mag(value: str | None) -> str | None:
    """Bare MAG id as a string — matches the crosswalk's ``CAST(MAG AS STRING)``."""
    if value is None:
        return None
    bare = str(value).strip()
    return bare or None


_NORMALIZERS = {"doi": normalize_doi, "pmid": normalize_pmid, "mag": normalize_mag}


@dataclass(frozen=True)
class OpenAlexAbstract:
    """A reconstructed abstract recovered from OpenAlex for one matched identifier."""

    source_id: str          # OpenAlex work id, e.g. 'https://openalex.org/W123'
    abstract: str           # reconstructed plaintext, non-empty
    match_key: str          # 'doi' | 'pmid' | 'mag' — which id matched
    abstract_len: int       # len(abstract)


@dataclass
class _Candidate:
    """An abstract candidate for one corpusid (before per-corpusid dedup)."""

    corpusid: int
    abstract: str
    source_id: str
    match_key: str

    @property
    def abstract_len(self) -> int:
        return len(self.abstract)


def pick_longest_per_corpusid(candidates: list[_Candidate]) -> dict[int, _Candidate]:
    """Dedup to one abstract per corpusid, longest wins (mirrors the bulk QUALIFY).

    A corpusid can match several OpenAlex works (via different ids); keep the single longest
    reconstructed abstract so the result composes identically with the bulk path.
    """
    best: dict[int, _Candidate] = {}
    for c in candidates:
        cur = best.get(c.corpusid)
        if cur is None or c.abstract_len > cur.abstract_len:
            best[c.corpusid] = c
    return best


# ---------------------------------------------------------------------------
# Rate limiting
# ---------------------------------------------------------------------------

class _TokenBucket:
    """Simple async token bucket: at most ``rate`` permits per second, smoothed.

    ``monotonic`` and ``sleep`` are injectable so tests run without real time passing.
    """

    def __init__(self, rate: float, *, monotonic=time.monotonic, sleep=asyncio.sleep) -> None:
        self._min_interval = 1.0 / rate if rate > 0 else 0.0
        self._monotonic = monotonic
        self._sleep = sleep
        self._next_at = 0.0
        self._lock = asyncio.Lock()

    async def acquire(self) -> None:
        if self._min_interval <= 0:
            return
        async with self._lock:
            now = self._monotonic()
            wait = self._next_at - now
            if wait > 0:
                await self._sleep(wait)
                now = self._monotonic()
            self._next_at = max(now, self._next_at) + self._min_interval


# ---------------------------------------------------------------------------
# On-disk response cache
# ---------------------------------------------------------------------------

class _JsonBatchCache:
    """Keyed on-disk JSON cache for id-batch responses (so re-runs don't re-hit the API)."""

    def __init__(self, directory: str | os.PathLike[str] | None) -> None:
        self._dir = Path(directory) if directory else None
        if self._dir is not None:
            self._dir.mkdir(parents=True, exist_ok=True)

    def _path(self, match_key: str, ids: list[str]) -> Path | None:
        if self._dir is None:
            return None
        digest = hashlib.sha256(("|".join(sorted(ids))).encode()).hexdigest()[:32]
        return self._dir / f"{match_key}_{digest}.json"

    def get(self, match_key: str, ids: list[str]) -> list[dict] | None:
        p = self._path(match_key, ids)
        if p is None or not p.exists():
            return None
        try:
            return json.loads(p.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None

    def set(self, match_key: str, ids: list[str], results: list[dict]) -> None:
        p = self._path(match_key, ids)
        if p is None:
            return
        try:
            p.write_text(json.dumps(results), encoding="utf-8")
        except OSError as exc:  # cache is best-effort
            logger.warning("openalex abstract cache write failed: %s", exc)


# ---------------------------------------------------------------------------
# Fetcher
# ---------------------------------------------------------------------------

def _chunked(seq: list[str], size: int) -> list[list[str]]:
    return [seq[i:i + size] for i in range(0, len(seq), size)]


class OpenAlexAbstractFetcher:
    """Batched OpenAlex abstract lookups by DOI / PMID / MAG with etiquette + caching.

    Construct with no args to read config from the environment, or inject ``client`` /
    ``sleep`` / ``cache_dir`` for tests. ``aclose()`` (or ``async with``) closes the client.
    """

    def __init__(
        self,
        *,
        base_url: str | None = None,
        mailto: str | None = None,
        api_key: str | None = None,
        batch_size: int | None = None,
        max_rps: float | None = None,
        cache_dir: str | os.PathLike[str] | None = None,
        client: httpx.AsyncClient | None = None,
        sleep=asyncio.sleep,
        max_retries: int = 5,
    ) -> None:
        self.base_url = (base_url or os.getenv("OPENALEX_BASE_URL", "https://api.openalex.org")).rstrip("/")
        self.mailto = mailto or os.getenv("OPENALEX_MAILTO") or os.getenv("CONTACT_EMAIL") or None
        self.api_key = api_key or os.getenv("OPENALEX_API_KEY") or None
        env_batch = os.getenv("OPENALEX_BATCH_SIZE")
        self.batch_size = min(batch_size or (int(env_batch) if env_batch else _MAX_BATCH), _MAX_BATCH)
        env_rps = os.getenv("OPENALEX_MAX_RPS")
        self.max_rps = max_rps if max_rps is not None else (float(env_rps) if env_rps else 10.0)
        self.max_retries = max_retries
        self._sleep = sleep
        self._owns_client = client is None
        self._client = client or httpx.AsyncClient(timeout=httpx.Timeout(60.0), follow_redirects=True)
        self._bucket = _TokenBucket(self.max_rps, sleep=sleep)
        self._cache = _JsonBatchCache(
            cache_dir if cache_dir is not None else os.getenv("OPENALEX_CACHE_DIR"))

    # -- public API ---------------------------------------------------------

    async def fetch_by_dois(self, dois: list[str]) -> dict[str, OpenAlexAbstract]:
        return await self._fetch("doi", dois)

    async def fetch_by_pmids(self, pmids: list[str]) -> dict[str, OpenAlexAbstract]:
        return await self._fetch("pmid", pmids)

    async def fetch_by_mags(self, mags: list[str]) -> dict[str, OpenAlexAbstract]:
        return await self._fetch("mag", mags)

    async def aclose(self) -> None:
        if self._owns_client and not self._client.is_closed:
            await self._client.aclose()

    async def __aenter__(self) -> "OpenAlexAbstractFetcher":
        return self

    async def __aexit__(self, *exc) -> None:
        await self.aclose()

    # -- internals ----------------------------------------------------------

    async def _fetch(self, match_key: str, ids: list[str]) -> dict[str, OpenAlexAbstract]:
        """Fetch reconstructed abstracts for ``ids`` of one type, keyed by normalized id."""
        normalize = _NORMALIZERS[match_key]
        # Normalize + de-dup the input while preserving the caller's ids as cache/lookup keys.
        wanted = [n for n in (normalize(i) for i in ids) if n]
        wanted = list(dict.fromkeys(wanted))
        out: dict[str, OpenAlexAbstract] = {}
        for chunk in _chunked(wanted, self.batch_size):
            results = await self._request_batch(match_key, chunk)
            for work in results:
                abstract = reconstruct_abstract(work.get("abstract_inverted_index"))
                if not abstract:
                    continue
                work_ids = work.get("ids") or {}
                key = normalize(work_ids.get(match_key))
                if key is None or key not in set(chunk):
                    continue
                out[key] = OpenAlexAbstract(
                    source_id=work.get("id") or "",
                    abstract=abstract,
                    match_key=match_key,
                    abstract_len=len(abstract),
                )
        return out

    async def _request_batch(self, match_key: str, chunk: list[str]) -> list[dict]:
        """One OR-filter request for up to ``batch_size`` ids; cached + retried."""
        cached = self._cache.get(match_key, chunk)
        if cached is not None:
            return cached
        field = _FILTER_FIELD[match_key]
        params = {
            "filter": f"{field}:{'|'.join(chunk)}",
            "per-page": len(chunk),
            "select": _SELECT,
        }
        if self.mailto:
            params["mailto"] = self.mailto
        headers = {"api_key": self.api_key} if self.api_key else None
        url = f"{self.base_url}/works"

        results = await self._get_with_retry(url, params, headers)
        self._cache.set(match_key, chunk, results)
        return results

    async def _get_with_retry(self, url: str, params: dict, headers: dict | None) -> list[dict]:
        """GET with token-bucket pacing + exponential backoff on 429/5xx; returns results[]."""
        delay = 1.0
        last_exc: Exception | None = None
        for attempt in range(1, self.max_retries + 1):
            await self._bucket.acquire()
            try:
                resp = await self._client.get(url, params=params, headers=headers)
            except httpx.HTTPError as exc:  # transient network fault
                last_exc = exc
            else:
                if resp.status_code < 400:
                    return (resp.json() or {}).get("results", [])
                if resp.status_code not in (429, 500, 502, 503, 504):
                    resp.raise_for_status()
                last_exc = httpx.HTTPStatusError(
                    f"OpenAlex {resp.status_code}", request=resp.request, response=resp)
            if attempt >= self.max_retries:
                break
            logger.warning("openalex batch failed (%s); retry %d/%d in %.1fs",
                           last_exc, attempt, self.max_retries, delay)
            await self._sleep(delay)
            delay = min(delay * 2, 60.0)
        assert last_exc is not None
        raise last_exc
