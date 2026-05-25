"""Tests for the strip_boolean_syntax utility."""
from __future__ import annotations

import pytest
from app.services.retrieval.query_normalizer import strip_boolean_syntax, has_boolean_operators


class TestStripBooleanSyntax:
    def test_simple_keywords_unchanged(self):
        assert strip_boolean_syntax("LLM compression") == "LLM compression"

    def test_strips_and(self):
        assert strip_boolean_syntax("LLM AND compression") == "LLM compression"

    def test_strips_or(self):
        assert strip_boolean_syntax("LLM OR compression") == "LLM compression"

    def test_strips_not(self):
        assert strip_boolean_syntax("LLM NOT RAG") == "LLM RAG"

    def test_preserves_quoted_phrases(self):
        result = strip_boolean_syntax('"large language model" AND LLM')
        assert result == '"large language model" LLM'

    def test_strips_parentheses(self):
        result = strip_boolean_syntax('("large language model" OR LLM) AND compression')
        assert result == '"large language model" LLM compression'

    def test_complex_nested_query(self):
        raw = '("large language model" OR LLM) AND compression AND RAG OR "Retrieval Augmented Generation"'
        result = strip_boolean_syntax(raw)
        assert result == '"large language model" LLM compression RAG "Retrieval Augmented Generation"'

    def test_multiple_parentheses_groups(self):
        result = strip_boolean_syntax("(A OR B) AND (C OR D)")
        assert result == "A B C D"

    def test_empty_string(self):
        assert strip_boolean_syntax("") == ""

    def test_only_operators(self):
        assert strip_boolean_syntax("AND OR NOT") == ""

    def test_quoted_phrase_with_operator_word_inside(self):
        # "AND" inside quotes should NOT be stripped
        result = strip_boolean_syntax('"search AND retrieval" OR LLM')
        assert result == '"search AND retrieval" LLM'

    def test_single_quoted_phrase(self):
        assert strip_boolean_syntax('"machine learning"') == '"machine learning"'


class TestHasBooleanOperators:
    def test_with_and(self):
        assert has_boolean_operators("LLM AND compression") is True

    def test_with_or(self):
        assert has_boolean_operators("LLM OR RAG") is True

    def test_with_not(self):
        assert has_boolean_operators("LLM NOT RAG") is True

    def test_plain_keywords(self):
        assert has_boolean_operators("LLM compression RAG") is False

    def test_quoted_phrase_no_operators(self):
        assert has_boolean_operators('"large language model"') is False
