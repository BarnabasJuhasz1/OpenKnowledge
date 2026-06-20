"""Unit tests for the BigQuery citation-edge client (query shape + params)."""
from __future__ import annotations

import pytest

from app.services.retrieval.bigquery_citations import (
    BigQueryCitationGraph,
    BigQueryCitationsError,
    BigQueryNotConfiguredError,
)


class _FakeJob:
    def __init__(self, rows):
        self._rows = rows

    def result(self):
        return self._rows


class _FakeClient:
    def __init__(self, rows, *, raise_=False):
        self._rows = rows
        self._raise = raise_
        self.last_sql = None
        self.last_config = None

    def query(self, sql, job_config=None):
        self.last_sql = sql
        self.last_config = job_config
        if self._raise:
            raise RuntimeError("bq exploded")
        return _FakeJob(self._rows)


def _graph(rows, **kw):
    g = BigQueryCitationGraph(dataset_ref="proj.ds")
    g._client = _FakeClient(rows, **kw)
    return g


def test_is_configured():
    assert BigQueryCitationGraph(dataset_ref="proj.ds").is_configured is True
    assert BigQueryCitationGraph(dataset_ref="").is_configured is False


def test_references_query_shape_and_rows():
    rows = [{"citingcorpusid": 100, "citedcorpusid": 200}]
    g = _graph(rows)
    out = g.references([100], cap=5)

    sql = g._client.last_sql
    assert "citation_edges`" in sql
    assert "citingcorpusid IN UNNEST(@ids)" in sql
    assert "PARTITION BY citingcorpusid" in sql
    # Cap keeps the top-K by the neighbour's citation count (ranked QUALIFY), not id order.
    assert "ORDER BY neighbor_citationcount DESC" in sql
    assert "<= @cap" in sql
    params = {p.name: p for p in g._client.last_config.query_parameters}
    assert params["ids"].values == [100]
    assert params["cap"].value == 5
    assert out == [(100, 200)]


def test_citations_uses_by_cited_table_and_partition():
    rows = [{"citingcorpusid": 300, "citedcorpusid": 100}]
    g = _graph(rows)
    out = g.citations([100], cap=10)
    sql = g._client.last_sql
    assert "citation_edges_by_cited`" in sql
    assert "citedcorpusid IN UNNEST(@ids)" in sql
    assert "PARTITION BY citedcorpusid" in sql
    assert out == [(300, 100)]


def test_empty_ids_short_circuits():
    g = _graph([])
    assert g.references([], cap=5) == []
    assert g._client.last_sql is None  # never queried


def test_not_configured_raises():
    g = BigQueryCitationGraph(dataset_ref="")
    with pytest.raises(BigQueryNotConfiguredError):
        g.references([1], cap=1)


def test_query_error_wrapped():
    g = _graph([], raise_=True)
    with pytest.raises(BigQueryCitationsError):
        g.references([1], cap=1)
