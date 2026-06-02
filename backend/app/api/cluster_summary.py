from __future__ import annotations

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from ..services.cluster_summary import (
    summarize_cluster,
    PaperInput,
    ChildInput,
)

router = APIRouter(prefix="/clusters", tags=["clusters"])


class PaperIn(BaseModel):
    title: str
    abstract: str | None = None
    archetypes: list[str] = []


class ChildIn(BaseModel):
    title: str = ""
    summary: str


class SummarizeRequest(BaseModel):
    kind: str  # "finest" | "higher"
    name: str = ""
    papers: list[PaperIn] | None = None
    children: list[ChildIn] | None = None


class SummarizeResponse(BaseModel):
    title: str
    summary: str
    method: str
    model: str | None = None


@router.post("/summarize", response_model=SummarizeResponse)
async def summarize(body: SummarizeRequest) -> SummarizeResponse:
    if body.kind not in ("finest", "higher"):
        raise HTTPException(status_code=422, detail="kind must be 'finest' or 'higher'")

    if body.kind == "finest":
        papers = [
            PaperInput(
                title=p.title,
                abstract=(p.abstract or ""),
                archetypes=list(p.archetypes or []),
            )
            for p in (body.papers or [])
            if p.title.strip()
        ]
        if not papers:
            raise HTTPException(status_code=422, detail="A finest summary requires papers.")
        result = await summarize_cluster("finest", papers=papers, name=body.name)
    else:
        children = [
            ChildInput(title=c.title, summary=c.summary)
            for c in (body.children or [])
            if c.summary.strip()
        ]
        if not children:
            raise HTTPException(
                status_code=422, detail="A higher-level summary requires child summaries."
            )
        result = await summarize_cluster("higher", children=children, name=body.name)

    return SummarizeResponse(
        title=result.title,
        summary=result.summary,
        method=result.method,
        model=result.model,
    )
