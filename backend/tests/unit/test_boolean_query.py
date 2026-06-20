"""Tests for the safe boolean-query compiler."""
from __future__ import annotations

import pytest

from app.services.retrieval.boolean_query import (
    BooleanQueryError,
    compile_boolean_query,
)


def _terms(raw: str) -> list[str]:
    return [text for _, text in compile_boolean_query(raw).parameters]


def _leaf(name: str) -> str:
    """The SQL a single term compiles to (title OR abstract SEARCH)."""
    return f"(SEARCH(title, @{name}) OR SEARCH(abstract, @{name}))"


def test_single_term_searches_title_and_abstract():
    c = compile_boolean_query("LLM")
    assert c.parameters == [("t0", "LLM")]
    assert c.where_sql == _leaf("t0")


def test_no_user_text_leaks_into_sql():
    c = compile_boolean_query('"DROP TABLE papers"')
    # The dangerous text becomes a bound parameter, never part of the SQL string.
    assert "DROP TABLE" not in c.where_sql
    assert c.parameters == [("t0", "DROP TABLE papers")]


def test_and():
    c = compile_boolean_query("a AND b")
    assert c.where_sql == f"({_leaf('t0')} AND {_leaf('t1')})"


def test_or():
    c = compile_boolean_query("a OR b")
    assert c.where_sql == f"({_leaf('t0')} OR {_leaf('t1')})"


def test_not_binds_as_and_not():
    # "a NOT b" == "a AND (NOT b)"
    c = compile_boolean_query("a NOT b")
    assert c.where_sql == f"({_leaf('t0')} AND (NOT {_leaf('t1')}))"


def test_implicit_and_between_adjacent_terms():
    c = compile_boolean_query("alpha beta")
    assert _terms("alpha beta") == ["alpha", "beta"]
    assert c.where_sql == f"({_leaf('t0')} AND {_leaf('t1')})"


def test_precedence_or_is_loosest():
    # A OR B AND C  ==  A OR (B AND C)
    c = compile_boolean_query("A OR B AND C")
    assert c.where_sql == f"({_leaf('t0')} OR ({_leaf('t1')} AND {_leaf('t2')}))"


def test_parentheses_override_precedence():
    # (A OR B) AND C  -> AND is now the top-level operator
    c = compile_boolean_query("(A OR B) AND C")
    assert c.where_sql == f"(({_leaf('t0')} OR {_leaf('t1')}) AND {_leaf('t2')})"


def test_quoted_phrase_kept_whole():
    assert _terms('"large language model" AND compression') == [
        "large language model",
        "compression",
    ]


def test_quoted_operator_word_is_a_term():
    # "AND" inside quotes is a search term, not the boolean operator.
    assert _terms('"search AND retrieval" OR LLM') == ["search AND retrieval", "LLM"]


def test_dash_prefix_is_negation():
    c = compile_boolean_query("LLM -RAG")
    assert _terms("LLM -RAG") == ["LLM", "RAG"]
    assert c.where_sql == f"({_leaf('t0')} AND (NOT {_leaf('t1')}))"


def test_full_example_query():
    raw = '"LLM" OR "Large Language Model" AND "compression" NOT "RAG"'
    assert _terms(raw) == ["LLM", "Large Language Model", "compression", "RAG"]


def test_params_are_unique_and_sequential():
    c = compile_boolean_query("a OR b OR c OR a")
    names = [n for n, _ in c.parameters]
    assert names == ["t0", "t1", "t2", "t3"]


@pytest.mark.parametrize("bad", ["", "   ", "AND OR NOT", "(a OR b", "a AND", "a )"])
def test_invalid_queries_raise(bad):
    with pytest.raises(BooleanQueryError):
        compile_boolean_query(bad)
