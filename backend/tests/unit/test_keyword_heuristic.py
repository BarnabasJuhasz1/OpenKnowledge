import pytest

from app.services.keywords.heuristic import HeuristicKeywordGenerator, extract_keywords
from app.services.keywords.base import keywords_to_query


def test_extract_keywords_from_description():
    kws = extract_keywords(
        "I want to know about model compression techniques for large language models"
    )
    assert kws, "expected some keywords"
    joined = " ".join(kws).lower()
    assert "model compression" in joined or "compression" in joined
    # stopwords / filler should be gone
    assert "i want to know" not in joined


@pytest.mark.asyncio
async def test_generator_merges_bib_keywords():
    gen = HeuristicKeywordGenerator()
    bib_context = "Title: Some Paper | Keywords: knowledge distillation, pruning"
    result = await gen.generate(
        "model compression for neural networks", bib_context=bib_context
    )
    assert result.method == "heuristic"
    low = [k.lower() for k in result.keywords]
    assert "knowledge distillation" in low
    assert "pruning" in low


def test_keywords_to_query_quotes_phrases():
    q = keywords_to_query(["model compression", "quantization"])
    assert q == '"model compression" AND quantization'


def test_keywords_to_query_passes_boolean_groups_through():
    q = keywords_to_query(['("LLM" OR "large language model")', '("pruning")'])
    assert q == '("LLM" OR "large language model") AND ("pruning")'
