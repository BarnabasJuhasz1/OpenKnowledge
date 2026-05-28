"""Background fetch manager for continuing paper retrieval after initial results."""
from __future__ import annotations

import asyncio
import logging
import uuid
from dataclasses import dataclass, field

from ...models.paper import Paper, BackgroundProgress
from .adapters.base import DatabaseAdapter
from .deduplicator import deduplicate
from .merger import merge_group
from .bibtex import attach_bibtex
from .code_enrichment import enrich_papers

logger = logging.getLogger(__name__)


@dataclass
class BackgroundJob:
    """Tracks a single background fetch job across multiple adapters."""
    job_id: str
    # Per-adapter state
    adapter_tasks: dict[str, asyncio.Task] = field(default_factory=dict)
    # Accumulated results
    papers: list[Paper] = field(default_factory=list)
    papers_by_source: dict[str, int] = field(default_factory=dict)
    # Progress tracking
    total_fetched: int = 0
    is_complete: bool = False
    errors: dict[str, str] = field(default_factory=dict)
    # Event queue for SSE streaming
    progress_queue: asyncio.Queue[BackgroundProgress] = field(
        default_factory=asyncio.Queue
    )
    # Lock for thread-safe paper list updates
    _lock: asyncio.Lock = field(default_factory=asyncio.Lock)

    async def add_papers(self, source: str, papers: list[Paper]) -> None:
        async with self._lock:
            self.papers.extend(papers)
            self.papers_by_source[source] = (
                self.papers_by_source.get(source, 0) + len(papers)
            )
            self.total_fetched += len(papers)


class BackgroundFetchManager:
    """Manages background fetch jobs for continued paper retrieval."""

    def __init__(self) -> None:
        self._jobs: dict[str, BackgroundJob] = {}

    def create_job(self) -> BackgroundJob:
        job_id = str(uuid.uuid4())
        job = BackgroundJob(job_id=job_id)
        self._jobs[job_id] = job
        return job

    def get_job(self, job_id: str) -> BackgroundJob | None:
        return self._jobs.get(job_id)

    def cancel_job(self, job_id: str) -> bool:
        job = self._jobs.get(job_id)
        if not job:
            return False
        for task in job.adapter_tasks.values():
            task.cancel()
        job.is_complete = True
        return True

    def start_background_fetch(
        self,
        job: BackgroundJob,
        adapters: list[DatabaseAdapter],
        queries: dict[str, str],
        initial_counts: dict[str, int],
        max_results_per_adapter: int | None,
    ) -> None:
        """Launch background tasks for each adapter that has more results to fetch.

        Each adapter continues paginating from where the initial fetch left off.
        """
        for adapter in adapters:
            name = adapter.name
            query = queries.get(name, "")
            initial = initial_counts.get(name, 0)

            if not query:
                continue

            task = asyncio.create_task(
                self._fetch_remaining(
                    job, adapter, query, initial, max_results_per_adapter,
                ),
                name=f"bg-fetch-{name}-{job.job_id[:8]}",
            )
            job.adapter_tasks[name] = task

        # Launch a watcher task that marks the job complete when all adapters finish
        asyncio.create_task(self._watch_completion(job))

    async def _fetch_remaining(
        self,
        job: BackgroundJob,
        adapter: DatabaseAdapter,
        query: str,
        already_fetched: int,
        max_results: int | None,
    ) -> None:
        """Continue fetching papers from one adapter in the background."""
        name = adapter.name
        try:
            # The adapter's search() was already called with max_results=initial_cap.
            # Now we call it again with no cap (or the full cap) and skip the first batch.
            # Since we can't resume cursor state, we re-fetch everything but only keep new ones.
            # This is not ideal but works for all adapters.
            all_papers = await adapter.search(query, max_results=max_results)

            # Skip the papers that were already returned in the initial batch
            new_papers = all_papers[already_fetched:]

            if new_papers:
                attach_bibtex(new_papers)
                await enrich_papers(new_papers)
                await job.add_papers(name, new_papers)

            await job.progress_queue.put(BackgroundProgress(
                job_id=job.job_id,
                source=name,
                papers_fetched=len(new_papers),
                total_papers=job.total_fetched,
                is_complete=False,
            ))

        except asyncio.CancelledError:
            logger.info("Background fetch for %s cancelled", name)
            raise
        except Exception as exc:
            error_msg = str(exc)[:200]
            job.errors[name] = error_msg
            logger.warning("Background fetch for %s failed: %s", name, error_msg)
            await job.progress_queue.put(BackgroundProgress(
                job_id=job.job_id,
                source=name,
                papers_fetched=0,
                total_papers=job.total_fetched,
                is_complete=False,
                error=error_msg,
            ))
        finally:
            await adapter.close()

    async def _watch_completion(self, job: BackgroundJob) -> None:
        """Wait for all adapter tasks to finish, then mark job complete."""
        if job.adapter_tasks:
            await asyncio.gather(*job.adapter_tasks.values(), return_exceptions=True)

        job.is_complete = True

        # Deduplicate the background papers
        if job.papers:
            groups, _ = deduplicate(job.papers)
            job.papers = [merge_group(g) for g in groups]

        # Send final completion event
        await job.progress_queue.put(BackgroundProgress(
            job_id=job.job_id,
            source="__all__",
            papers_fetched=0,
            total_papers=job.total_fetched,
            is_complete=True,
        ))

        logger.info(
            "Background job %s complete: %d additional papers",
            job.job_id, len(job.papers),
        )

    def cleanup_job(self, job_id: str) -> None:
        """Remove a completed job from memory."""
        self._jobs.pop(job_id, None)


# Module-level singleton
background_manager = BackgroundFetchManager()
