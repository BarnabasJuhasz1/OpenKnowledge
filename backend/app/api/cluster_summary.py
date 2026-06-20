from __future__ import annotations

import json
from collections.abc import AsyncIterator

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from ..services.cluster_summary import (
    stream_cluster_summary,
    PaperInput,
    ChildInput,
    SiblingInput,
)

router = APIRouter(prefix="/clusters", tags=["clusters"])


class PaperIn(BaseModel):
    title: str
    abstract: str | None = None
    archetypes: list[str] = []


class ChildIn(BaseModel):
    title: str = ""
    summary: str


class SiblingIn(BaseModel):
    title: str = ""
    size: int = 0
    archetypes: list[str] = []


class SummarizeRequest(BaseModel):
    kind: str  # "finest" | "higher"
    name: str = ""
    papers: list[PaperIn] | None = None
    children: list[ChildIn] | None = None
    # Compact structural fingerprints of the sibling clusters at the same level,
    # used to steer the summary toward this cluster's distinct characteristics.
    siblings: list[SiblingIn] | None = None


def _sse(events: AsyncIterator[dict]) -> AsyncIterator[bytes]:
    """Frame each event dict as one SSE `data:` message (JSON-encoded so summary
    newlines never break framing)."""
    async def gen() -> AsyncIterator[bytes]:
        async for event in events:
            yield f"data: {json.dumps(event, ensure_ascii=False)}\n\n".encode("utf-8")
    return gen()


@router.post("/summarize")
async def summarize(body: SummarizeRequest) -> StreamingResponse:
    """Stream a cluster summary token-by-token as Server-Sent Events.

    Each message is `data: {"delta": "..."}`; the stream ends with
    `data: {"done": true, "title", "summary", "method", "model"}`. Request
    validation still fails fast with a JSON 422 before any streaming begins.
    """
    if body.kind not in ("finest", "higher"):
        raise HTTPException(status_code=422, detail="kind must be 'finest' or 'higher'")

    siblings = [
        SiblingInput(title=s.title, size=s.size, archetypes=list(s.archetypes or []))
        for s in (body.siblings or [])
    ]

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
        events = stream_cluster_summary(
            "finest", papers=papers, siblings=siblings, name=body.name
        )
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
        events = stream_cluster_summary(
            "higher", children=children, siblings=siblings, name=body.name
        )

    return StreamingResponse(
        _sse(events),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
