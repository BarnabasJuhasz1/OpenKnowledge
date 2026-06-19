"""OpenSearch-backed search engine for Semantic Scholar mode.

BigQuery search indexes return correct results but cost is unbounded/unpredictable, so
full-text search runs against a dedicated OpenSearch index (BM25 ranking, cheap and fast).
BigQuery (`papers_search`) is kept only as the ingestion source — see
``scripts/ingest_opensearch.py``.

The boolean query string is parsed by ``boolean_query`` and compiled to an OpenSearch
query DSL; the same parser powers BigQuery and OpenSearch, so query semantics are identical.

The client is created lazily so the backend boots even when ``opensearch-py`` or the
cluster is unavailable.
"""
from __future__ import annotations

import logging
import os

from ...models.paper import Author, Paper
from .boolean_query import compile_to_opensearch

logger = logging.getLogger(__name__)

# _source fields fetched per hit (everything needed to build a Paper).
_SOURCE_FIELDS = [
    "corpusid", "title", "abstract", "year", "publicationdate",
    "citationcount", "referencecount", "is_open_access", "url", "venue",
    "journal", "authors", "doi", "arxiv_id", "pubmed_id",
    "fields_of_study", "publication_types",
]


class OpenSearchError(RuntimeError):
    """Base class for OpenSearch-backed search failures."""


class OpenSearchNotConfiguredError(OpenSearchError):
    """Raised when opensearch-py is missing or OPENSEARCH_URL is unset."""


class OpenSearchSearchError(OpenSearchError):
    """Raised when a search request to the cluster fails."""


def _env_int(name: str, default: int) -> int:
    raw = os.getenv(name)
    if raw is None or raw.strip() == "":
        return default
    try:
        return int(raw)
    except ValueError:
        logger.warning("Invalid int for %s=%r; using default %s", name, raw, default)
        return default


def _env_bool(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None or raw.strip() == "":
        return default
    return raw.strip().lower() in ("1", "true", "yes", "on")


# A plain search() cannot page past index.max_result_window (default 10k); beyond that we
# must scroll. Kept conservative so we never trip the window even if the index lowers it.
_MAX_RESULT_WINDOW = 10000

# Sentinel for "caller did not pass result_limit" — distinct from an explicit None, which
# the caller may pass to mean "unlimited".
_UNSET = object()


def _resolve_result_limit(passed) -> int | None:
    """Resolve the result cap. ``None`` means unlimited (return every match).

    Empty/unset/0/negative/invalid ``OPENSEARCH_RESULT_LIMIT`` -> unlimited; a positive
    integer -> that cap. An explicitly passed value (incl. ``None``) wins over the env.
    """
    if passed is not _UNSET:
        return passed
    raw = os.getenv("OPENSEARCH_RESULT_LIMIT")
    if raw is None or raw.strip() == "":
        return None
    try:
        value = int(raw)
    except ValueError:
        logger.warning("Invalid int for OPENSEARCH_RESULT_LIMIT=%r; using unlimited", raw)
        return None
    return value if value > 0 else None


class OpenSearchEngine:
    """Runs boolean full-text searches against the OpenSearch papers index."""

    def __init__(
        self,
        url: str | None = None,
        *,
        index: str | None = None,
        result_limit=_UNSET,
        timeout: int | None = None,
        max_retries: int | None = None,
        retry_on_timeout: bool | None = None,
    ) -> None:
        # Empty string (not None) means intentionally unconfigured.
        self.url = url if url is not None else os.getenv("OPENSEARCH_URL", "http://localhost:9200")
        self.index = index if index is not None else os.getenv("OPENSEARCH_INDEX", "papers")
        # None => unlimited (stream every match via scroll); an int => hard cap.
        self.result_limit = _resolve_result_limit(result_limit)
        # Scroll tuning for the unlimited / >window path.
        self.scan_batch = _env_int("OPENSEARCH_SCAN_BATCH", 2000)
        self.scroll = os.getenv("OPENSEARCH_SCROLL") or "2m"
        # Connection resilience: the live node may be answering while it ingests on only
        # 2 vCPUs, so a bare client (no timeout/retry) stalls or fails intermittently.
        self.timeout = timeout if timeout is not None else _env_int("OPENSEARCH_TIMEOUT", 30)
        self.max_retries = (
            max_retries if max_retries is not None else _env_int("OPENSEARCH_MAX_RETRIES", 3)
        )
        self.retry_on_timeout = (
            retry_on_timeout if retry_on_timeout is not None
            else _env_bool("OPENSEARCH_RETRY_ON_TIMEOUT", True)
        )
        self._client = None  # lazily created

    @property
    def is_configured(self) -> bool:
        return bool(self.url)

    def _get_client(self):
        if self._client is not None:
            return self._client
        if not self.url:
            raise OpenSearchNotConfiguredError(
                "OPENSEARCH_URL is not set; Semantic Scholar mode is unavailable."
            )
        try:
            from opensearchpy import OpenSearch
        except ImportError as exc:  # pragma: no cover - only without the lib
            raise OpenSearchNotConfiguredError(
                "opensearch-py is not installed; run `pip install opensearch-py`."
            ) from exc
        try:
            self._client = OpenSearch(
                hosts=[self.url],
                timeout=self.timeout,
                max_retries=self.max_retries,
                retry_on_timeout=self.retry_on_timeout,
            )
        except Exception as exc:
            raise OpenSearchNotConfiguredError(
                f"Could not initialise the OpenSearch client: {exc}"
            ) from exc
        return self._client

    def ping(self) -> bool:
        """True if the cluster is reachable. Lets a caller probe connectivity cheaply.

        Raises:
            OpenSearchNotConfiguredError: if OpenSearch is unavailable/unconfigured.
        """
        return bool(self._get_client().ping())

    def resolve_corpusids(self, seeds: list[str]) -> dict[str, int]:
        """Map each seed string to a corpusid using indexed fields only.

        Resolution rules (so the citation graph never needs the public S2 API):

        * a bare integer is taken to be a corpusid directly;
        * a whitespace-free non-integer (DOI, arXiv id, …) is matched against the
          indexed ``doi`` / ``arxiv_id`` keyword fields (case-insensitively);
        * a multi-word string is treated as a title and matched against ``title``.

        Only seeds that resolve are returned; unknown ids (e.g. legacy S2 SHA
        hashes, which are not stored locally) are silently dropped.

        Raises:
            OpenSearchNotConfiguredError: if OpenSearch is unavailable/unconfigured.
            OpenSearchSearchError: if a lookup request fails.
        """
        client = self._get_client()
        resolved: dict[str, int] = {}
        identifiers: list[str] = []
        titles: list[str] = []
        for seed in seeds:
            s = (seed or "").strip()
            if not s:
                continue
            if s.isdigit():
                resolved[seed] = int(s)
            elif any(c.isspace() for c in s):
                titles.append(seed)
            else:
                identifiers.append(seed)

        if identifiers:
            # One query for all identifier seeds: match either keyword field, then map
            # the returned doi/arxiv_id back to the originating seed (case-insensitive).
            lowered = [s.strip().lower() for s in identifiers]
            body = {
                "query": {
                    "bool": {
                        "should": [
                            {"terms": {"doi": lowered}},
                            {"terms": {"arxiv_id": lowered}},
                        ],
                        "minimum_should_match": 1,
                    }
                },
                "size": min(len(identifiers), _MAX_RESULT_WINDOW),
                "_source": ["corpusid", "doi", "arxiv_id"],
                "track_total_hits": False,
            }
            try:
                resp = client.search(index=self.index, body=body)
            except Exception as exc:
                raise OpenSearchSearchError(f"OpenSearch seed lookup failed: {exc}") from exc
            by_key: dict[str, int] = {}
            for hit in resp.get("hits", {}).get("hits", []):
                src = hit.get("_source", {})
                cid = src.get("corpusid")
                if cid is None:
                    continue
                for field in ("doi", "arxiv_id"):
                    val = src.get(field)
                    if val:
                        by_key[str(val).lower()] = int(cid)
            for seed in identifiers:
                cid = by_key.get(seed.strip().lower())
                if cid is not None:
                    resolved[seed] = cid

        for seed in titles:
            body = {
                "query": {"match": {"title": seed.strip()}},
                "size": 1,
                "_source": ["corpusid"],
                "track_total_hits": False,
            }
            try:
                resp = client.search(index=self.index, body=body)
            except Exception as exc:
                raise OpenSearchSearchError(f"OpenSearch seed lookup failed: {exc}") from exc
            hits = resp.get("hits", {}).get("hits", [])
            if hits:
                cid = hits[0].get("_source", {}).get("corpusid")
                if cid is not None:
                    resolved[seed] = int(cid)

        return resolved

    def fetch_nodes_by_corpusid(self, corpusids: list[int]) -> dict[int, Paper]:
        """Batch-fetch papers by corpusid (OpenSearch only).

        corpusids absent from the index are simply omitted from the result — the
        caller drops their nodes/edges. Chunked so we never approach the result
        window even for a large frontier.

        Raises:
            OpenSearchNotConfiguredError: if OpenSearch is unavailable/unconfigured.
            OpenSearchSearchError: if a fetch request fails.
        """
        client = self._get_client()
        out: dict[int, Paper] = {}
        unique = list({int(c) for c in corpusids})
        chunk = 1000
        for start in range(0, len(unique), chunk):
            ids = unique[start:start + chunk]
            body = {
                "query": {"terms": {"corpusid": ids}},
                "size": len(ids),
                "_source": _SOURCE_FIELDS,
                "track_total_hits": False,
            }
            try:
                resp = client.search(index=self.index, body=body)
            except Exception as exc:
                raise OpenSearchSearchError(f"OpenSearch node fetch failed: {exc}") from exc
            for hit in resp.get("hits", {}).get("hits", []):
                src = hit.get("_source", {})
                cid = src.get("corpusid")
                if cid is not None:
                    out[int(cid)] = self._hit_to_paper(src)
        return out

    def searchable_count(self) -> int:
        """Number of documents currently searchable in the index.

        This is the *refreshed* count: during ingestion the loader sets
        ``refresh_interval=-1``, so in-flight docs are not yet visible — this reflects
        exactly what boolean searches can return right now.

        Raises:
            OpenSearchNotConfiguredError: if OpenSearch is unavailable/unconfigured.
            OpenSearchSearchError: if the count request fails.
        """
        client = self._get_client()
        try:
            return int(client.count(index=self.index)["count"])
        except Exception as exc:
            raise OpenSearchSearchError(f"OpenSearch count failed: {exc}") from exc

    def search(self, boolean_query: str) -> list[Paper]:
        """Compile and run a boolean query; return matching papers.

        Convenience wrapper that materializes :meth:`iter_search` into a list. For an
        unbounded result set (``result_limit is None``) this can be very large — prefer
        :meth:`iter_search` to stream lazily and keep memory bounded.

        Raises:
            BooleanQueryError: if the boolean query is malformed.
            OpenSearchNotConfiguredError: if OpenSearch is unavailable/unconfigured.
            OpenSearchSearchError: if the search request fails.
        """
        return list(self.iter_search(boolean_query))

    def iter_search(self, boolean_query: str):
        """Compile and run a boolean query; yield matching papers lazily.

        This is the scalable entry point. Behaviour depends on ``result_limit``:

        * **Finite and within the result window** (``<= _MAX_RESULT_WINDOW``): a single
          ``search`` request, BM25-ranked — the right thing for top-N queries.
        * **Unlimited (``None``) or larger than the window**: a scroll/scan that streams
          the entire match set in ``scan_batch``-sized pages. A plain ``search`` cannot
          page past ``index.max_result_window`` (default 10k), so anything bigger must
          scroll. Scan order is ``_doc`` (not relevance): cheap and constant-memory, which
          is what lets it scale to millions. A finite cap still stops the stream early.

        Raises:
            BooleanQueryError: if the boolean query is malformed.
            OpenSearchNotConfiguredError: if OpenSearch is unavailable/unconfigured.
            OpenSearchSearchError: if the search request fails.
        """
        client = self._get_client()  # raises OpenSearchNotConfiguredError if unavailable
        query = compile_to_opensearch(boolean_query)
        limit = self.result_limit

        if limit is not None and limit <= _MAX_RESULT_WINDOW:
            yield from self._search_top_n(client, query, limit)
        else:
            yield from self._scan_all(client, query, limit)

    def _search_top_n(self, client, query: dict, limit: int):
        """Single-request fast path: top ``limit`` hits, BM25-ranked."""
        body = {
            "query": query,
            "size": limit,
            "_source": _SOURCE_FIELDS,
            "track_total_hits": False,
        }
        try:
            resp = client.search(index=self.index, body=body)
        except Exception as exc:
            raise OpenSearchSearchError(f"OpenSearch query failed: {exc}") from exc
        hits = resp.get("hits", {}).get("hits", [])
        logger.info("Semantic Scholar (OpenSearch) search ok: %d hits (top-%d)",
                    len(hits), limit)
        for hit in hits:
            yield self._hit_to_paper(hit.get("_source", {}))

    def _scan_all(self, client, query: dict, limit: int | None):
        """Scroll path: stream every match (or up to ``limit``) past the result window."""
        from opensearchpy import helpers

        scanner = helpers.scan(
            client,
            index=self.index,
            query={"query": query},
            _source=_SOURCE_FIELDS,
            size=self.scan_batch,
            scroll=self.scroll,
            preserve_order=False,  # _doc order: constant memory, scales to millions
        )
        emitted = 0
        try:
            for hit in scanner:
                yield self._hit_to_paper(hit.get("_source", {}))
                emitted += 1
                if limit is not None and emitted >= limit:
                    break
        except Exception as exc:
            raise OpenSearchSearchError(f"OpenSearch scroll failed: {exc}") from exc
        finally:
            # On early break the underlying generator is GC'd; opensearch-py clears the
            # scroll on exhaustion, and any leftover context expires after `scroll`.
            close = getattr(scanner, "close", None)
            if close is not None:
                close()
        logger.info("Semantic Scholar (OpenSearch) scan ok: %d hits (limit=%s)",
                    emitted, "∞" if limit is None else limit)

    @staticmethod
    def _hit_to_paper(src: dict) -> Paper:
        corpusid = src.get("corpusid")
        authors = [Author(name=n) for n in (src.get("authors") or []) if n]
        pub_date = src.get("publicationdate")
        pub_types = src.get("publication_types") or []

        def s(v):  # ids may come back as ints (e.g. PubMed); Paper wants strings
            return str(v) if v is not None else None

        return Paper(
            semantic_scholar_id=str(corpusid) if corpusid is not None else None,
            doi=s(src.get("doi")),
            arxiv_id=s(src.get("arxiv_id")),
            pubmed_id=s(src.get("pubmed_id")),
            title=src.get("title") or "",
            abstract=src.get("abstract"),
            year=src.get("year"),
            publication_date=str(pub_date) if pub_date else None,
            authors=authors,
            journal=src.get("journal"),
            venue=src.get("journal") or src.get("venue"),
            is_open_access=bool(src.get("is_open_access", False)),
            landing_url=src.get("url"),
            citation_count=src.get("citationcount"),
            reference_count=src.get("referencecount"),
            fields_of_study=list(src.get("fields_of_study") or []),
            is_peer_reviewed=any(t in pub_types for t in ("JournalArticle", "Conference")),
            sources=["semantic_scholar"],
        )


_engine: OpenSearchEngine | None = None


def get_engine() -> OpenSearchEngine:
    """Return the process-wide engine, building it (and reading env) on first use."""
    global _engine
    if _engine is None:
        _engine = OpenSearchEngine()
    return _engine
