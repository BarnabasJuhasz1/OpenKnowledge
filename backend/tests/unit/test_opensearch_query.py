"""Tests for the boolean AST -> OpenSearch query DSL compiler."""
from __future__ import annotations

import pytest

from app.services.retrieval.boolean_query import (
    BooleanQueryError,
    compile_to_opensearch,
)


def _term(text: str) -> dict:
    return {
        "bool": {
            "should": [
                {"match_phrase": {"title": text}},
                {"match_phrase": {"abstract": text}},
            ],
            "minimum_should_match": 1,
        }
    }


def test_single_term():
    assert compile_to_opensearch("LLM") == _term("LLM")


def test_and():
    assert compile_to_opensearch("a AND b") == {
        "bool": {"must": [_term("a"), _term("b")]}
    }


def test_or():
    assert compile_to_opensearch("a OR b") == {
        "bool": {"should": [_term("a"), _term("b")], "minimum_should_match": 1}
    }


def test_not_binds_as_and_not():
    # "a NOT b" == a AND (NOT b)
    assert compile_to_opensearch("a NOT b") == {
        "bool": {"must": [_term("a"), {"bool": {"must_not": [_term("b")]}}]}
    }


def test_implicit_and():
    assert compile_to_opensearch("alpha beta") == {
        "bool": {"must": [_term("alpha"), _term("beta")]}
    }


def test_precedence_or_loosest():
    # A OR B AND C == A OR (B AND C)
    assert compile_to_opensearch("A OR B AND C") == {
        "bool": {
            "should": [
                _term("A"),
                {"bool": {"must": [_term("B"), _term("C")]}},
            ],
            "minimum_should_match": 1,
        }
    }


def test_parentheses_override_precedence():
    assert compile_to_opensearch("(A OR B) AND C") == {
        "bool": {
            "must": [
                {"bool": {"should": [_term("A"), _term("B")], "minimum_should_match": 1}},
                _term("C"),
            ]
        }
    }


def test_quoted_phrase_is_one_match_phrase():
    dsl = compile_to_opensearch('"large language model"')
    assert dsl == _term("large language model")


def test_dash_is_negation():
    assert compile_to_opensearch("LLM -RAG") == {
        "bool": {"must": [_term("LLM"), {"bool": {"must_not": [_term("RAG")]}}]}
    }


def test_full_example():
    raw = '"LLM" OR "Large Language Model" AND "compression" NOT "RAG"'
    dsl = compile_to_opensearch(raw)
    # Top level is OR (loosest); structure is LLM OR (LLM2 AND compression AND (NOT RAG))
    assert dsl["bool"]["minimum_should_match"] == 1
    assert dsl["bool"]["should"][0] == _term("LLM")


@pytest.mark.parametrize("bad", ["", "   ", "AND OR", "(a OR b", "a AND"])
def test_invalid_raises(bad):
    with pytest.raises(BooleanQueryError):
        compile_to_opensearch(bad)
