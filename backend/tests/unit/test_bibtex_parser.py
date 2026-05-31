from app.services.retrieval.bibtex_parser import (
    parse_bibtex,
    bib_context_text,
    collect_keywords,
)

SAMPLE = """
@article{smith2020compression,
  title = {A Survey of Model Compression and Acceleration},
  author = {Smith, Jane and Doe, John},
  year = {2020},
  journal = {JMLR},
  keywords = {model compression, pruning; quantization},
  abstract = {We review techniques for compressing deep neural networks.}
}

@inproceedings{lee2021distill,
  title = "Knowledge Distillation Revisited",
  author = "Lee, Kim",
  year = "2021",
  keywords = {knowledge distillation, model compression}
}
"""


def test_parses_entries_and_fields():
    entries = parse_bibtex(SAMPLE)
    assert len(entries) == 2

    first = entries[0]
    assert first.title == "A Survey of Model Compression and Acceleration"
    assert first.year == "2020"
    assert "model compression" in first.keywords
    assert "pruning" in first.keywords
    assert "quantization" in first.keywords
    assert first.abstract and "compressing" in first.abstract

    second = entries[1]
    assert second.title == "Knowledge Distillation Revisited"
    assert "knowledge distillation" in second.keywords


def test_context_text_and_collect():
    entries = parse_bibtex(SAMPLE)
    ctx = bib_context_text(entries)
    assert "Title:" in ctx
    assert "Keywords:" in ctx

    kws = collect_keywords(entries)
    # de-duplicated across entries (model compression appears twice)
    assert kws.count("model compression") == 1
    assert "knowledge distillation" in kws


def test_malformed_input_does_not_raise():
    assert parse_bibtex("") == []
    assert parse_bibtex("not bibtex at all") == []
    # truncated entry shouldn't blow up
    parse_bibtex("@article{x, title = {Half")
