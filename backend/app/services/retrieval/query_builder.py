from __future__ import annotations

# Per-database field prefix for keyword search
_DB_SEARCH_FIELD: dict[str, str] = {
    "openalex": "",           # uses full-text search param directly
    "semantic_scholar": "",   # plain query string
    "arxiv": "all",           # all:<term>
    "europe_pmc": "",         # plain query
    "dblp": "",               # plain query
    "crossref": "",           # query param
    "core": "",               # plain query
    "pubmed": "[All Fields]", # MeSH/title/abstract qualifier
}

# Boolean AND operator per database
_AND_OP: dict[str, str] = {
    "openalex": " ",
    "semantic_scholar": " ",
    "arxiv": " AND ",
    "europe_pmc": " AND ",
    "dblp": " ",
    "crossref": " ",
    "core": " AND ",
    "pubmed": " AND ",
}


def build_query(
    keywords: list[str],
    db_name: str,
    domain_filter: str | None = None,
    strictness: float = 0.5,
) -> str:
    """
    Build a query string for a specific database from a list of keywords.

    strictness=1.0 → all keywords must match (AND)
    strictness=0.0 → any keyword matches (OR)
    Mid values use AND for the first ceil(n * strictness) keywords, OR for the rest.
    """
    if not keywords:
        return ""

    and_op = _AND_OP.get(db_name, " ")
    or_op = " OR " if db_name not in ("dblp", "openalex", "crossref", "semantic_scholar") else " "

    # Determine how many keywords to AND vs OR
    n = len(keywords)
    n_and = max(1, round(n * strictness))
    must_kws = keywords[:n_and]
    should_kws = keywords[n_and:]

    def _wrap(kw: str) -> str:
        # Quote multi-word keywords
        return f'"{kw}"' if " " in kw else kw

    must_part = and_op.join(_wrap(k) for k in must_kws)

    if should_kws:
        should_part = or_op.join(_wrap(k) for k in should_kws)
        query = f"({must_part}) AND ({should_part})" if and_op.strip() == "AND" else f"{must_part} {should_part}"
    else:
        query = must_part

    if domain_filter:
        domain_wrapped = _wrap(domain_filter)
        if db_name in ("europe_pmc", "pubmed", "arxiv", "core"):
            query = f"({query}) AND {domain_wrapped}"
        else:
            query = f"{query} {domain_wrapped}"

    return query.strip()
