from __future__ import annotations

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from ..services.keywords import generate_keywords, keywords_to_query
from ..services.retrieval.bibtex_parser import parse_bibtex, bib_context_text

router = APIRouter(prefix="/keywords", tags=["keywords"])

_MAX_BIBTEX_CHARS = 100_000


class KeywordGenRequest(BaseModel):
    prompt: str = ""
    bibtex: str | None = None


class KeywordGenResponse(BaseModel):
    keywords: list[str]
    query: str
    method: str
    model: str | None = None


@router.post("/generate", response_model=KeywordGenResponse)
async def generate(body: KeywordGenRequest) -> KeywordGenResponse:
    prompt = (body.prompt or "").strip()
    bibtex = (body.bibtex or "")[:_MAX_BIBTEX_CHARS]

    bib_context = ""
    if bibtex.strip():
        entries = parse_bibtex(bibtex)
        bib_context = bib_context_text(entries)

    if not prompt and not bib_context:
        raise HTTPException(
            status_code=422,
            detail="Provide a research description or a .bib file.",
        )

    result = await generate_keywords(prompt, bib_context)
    if not result.keywords:
        raise HTTPException(
            status_code=422,
            detail="Could not derive keywords from the input.",
        )

    return KeywordGenResponse(
        keywords=result.keywords,
        query=keywords_to_query(result.keywords),
        method=result.method,
        model=result.model,
    )
