"""BigQuery-backed citation edge provider for the citation graph.

The citation graph's *structure* (which paper cites which) is not in OpenSearch — only
node metadata is. The edges live in BigQuery as two clustered tables built from the
Semantic Scholar dump (see ``plans/.../citgraph-hosted-01-bigquery-edge-tables.md``):

* ``citation_edges``           CLUSTER BY ``citingcorpusid`` — references (past) lookups.
* ``citation_edges_by_cited``  CLUSTER BY ``citedcorpusid``  — citations (future) lookups.

Both have schema ``citingcorpusid INT64, citedcorpusid INT64, isinfluential BOOL`` and all
ids are integer corpusids (matching OpenSearch). Per-corpusid lookups are cheap because the
``WHERE ... IN UNNEST(@ids)`` predicate hits the leading cluster column and prunes the scan.

The client is created lazily so the backend boots even when ``google-cloud-bigquery`` or
credentials are unavailable.
"""
from __future__ import annotations

import logging
import os

logger = logging.getLogger(__name__)


class BigQueryCitationsError(RuntimeError):
    """Base class for BigQuery citation-edge lookup failures."""


class BigQueryNotConfiguredError(BigQueryCitationsError):
    """Raised when google-cloud-bigquery is missing or the dataset ref is unset."""


class BigQueryCitationGraph:
    """Fetches citation edges (by corpusid) from the clustered BigQuery tables."""

    def __init__(
        self,
        *,
        dataset_ref: str | None = None,
        edges_table: str | None = None,
        edges_by_cited_table: str | None = None,
    ) -> None:
        # e.g. "openknowledge-498014.semantic_scholar"
        self.dataset_ref = (
            dataset_ref if dataset_ref is not None else os.getenv("BIGQUERY_DATASET_REF", "")
        )
        self.edges_table = (
            edges_table
            if edges_table is not None
            else os.getenv("BIGQUERY_CITATION_EDGES_TABLE", "citation_edges")
        )
        self.edges_by_cited_table = (
            edges_by_cited_table
            if edges_by_cited_table is not None
            else os.getenv("BIGQUERY_CITATION_EDGES_BY_CITED_TABLE", "citation_edges_by_cited")
        )
        self._client = None  # lazily created

    @property
    def is_configured(self) -> bool:
        return bool(self.dataset_ref)

    def _get_client(self):
        if self._client is not None:
            return self._client
        if not self.dataset_ref:
            raise BigQueryNotConfiguredError(
                "BIGQUERY_DATASET_REF is not set; citation edges are unavailable."
            )
        try:
            from google.cloud import bigquery
        except ImportError as exc:  # pragma: no cover - only without the lib
            raise BigQueryNotConfiguredError(
                "google-cloud-bigquery is not installed; run `pip install google-cloud-bigquery`."
            ) from exc
        try:
            self._client = bigquery.Client()
        except Exception as exc:
            raise BigQueryNotConfiguredError(
                f"Could not initialise the BigQuery client: {exc}"
            ) from exc
        return self._client

    def _table(self, name: str) -> str:
        return f"`{self.dataset_ref}.{name}`"

    def _run(self, table: str, partition_col: str, corpusids: list[int], cap: int) -> list[tuple[int, int, bool]]:
        """Run a capped edge lookup and return (citing, cited, is_influential) tuples.

        ``partition_col`` is the leading cluster column of ``table`` (so the scan is pruned)
        and also the column the ``cap`` per-source limit partitions on. ``is_influential`` is
        S2's per-edge "highly influential citation" flag (NULL is treated as ``False``).
        """
        if not corpusids:
            return []
        from google.cloud import bigquery

        other_col = "citedcorpusid" if partition_col == "citingcorpusid" else "citingcorpusid"
        # Rank each source paper's edges influential-first, then by the *neighbour's*
        # citation count (the ok-score proxy, denormalized into ``neighbor_citationcount`` on
        # both edge tables), so the per-source ``cap`` keeps the highly-influential neighbours
        # plus the top non-influential ones — matching the builder's per-paper top-K priority.
        # Without the leading ``isinfluential DESC`` a low-citation influential neighbour could
        # be truncated out of the over-fetch buffer before the builder's Python sort sees it.
        # ``{other_col}`` is a deterministic tie-break. ``isinfluential`` is already in the
        # clustered tables, so ordering by it adds no scan cost.
        sql = (
            f"SELECT citingcorpusid, citedcorpusid, isinfluential FROM {self._table(table)} "
            f"WHERE {partition_col} IN UNNEST(@ids) "
            f"QUALIFY ROW_NUMBER() OVER (PARTITION BY {partition_col} "
            f"ORDER BY isinfluential DESC, neighbor_citationcount DESC, {other_col}) <= @cap"
        )
        job_config = bigquery.QueryJobConfig(
            query_parameters=[
                bigquery.ArrayQueryParameter("ids", "INT64", [int(c) for c in corpusids]),
                bigquery.ScalarQueryParameter("cap", "INT64", int(cap)),
            ]
        )
        client = self._get_client()
        try:
            rows = client.query(sql, job_config=job_config).result()
            return [
                (int(r["citingcorpusid"]), int(r["citedcorpusid"]), bool(r["isinfluential"]))
                for r in rows
            ]
        except Exception as exc:
            raise BigQueryCitationsError(f"BigQuery citation lookup failed: {exc}") from exc

    def references(self, corpusids: list[int], cap: int) -> list[tuple[int, int, bool]]:
        """Edges where the given papers are the *citing* side (their references / past).

        Returns ``(citing, cited, is_influential)`` tuples with ``citing`` in ``corpusids``,
        at most ``cap`` per citing paper.
        """
        return self._run(self.edges_table, "citingcorpusid", corpusids, cap)

    def citations(self, corpusids: list[int], cap: int) -> list[tuple[int, int, bool]]:
        """Edges where the given papers are the *cited* side (their citers / future).

        Returns ``(citing, cited, is_influential)`` tuples with ``cited`` in ``corpusids``,
        at most ``cap`` per cited paper.
        """
        return self._run(self.edges_by_cited_table, "citedcorpusid", corpusids, cap)


_graph: BigQueryCitationGraph | None = None


def get_citation_graph() -> BigQueryCitationGraph:
    """Return the process-wide BigQuery citation-edge client (reads env on first use)."""
    global _graph
    if _graph is None:
        _graph = BigQueryCitationGraph()
    return _graph
