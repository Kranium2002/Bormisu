"""Stage graph as Procrastinate tasks.

M0: the task is registered so uploads are queued durably; the stages (triage, classify, OCR, extract,
normalise) arrive in M1. A queued document stays `queued` until then; nothing is faked.
"""

from __future__ import annotations

import logging

from app.queue import queue_app

logger = logging.getLogger("geomemory.pipeline")

PIPELINE_QUEUE = "pipeline"


@queue_app.task(name="process_document", queue=PIPELINE_QUEUE, pass_context=False)
async def process_document(document_id: str) -> None:
    logger.info("process_document %s: pipeline stages are not available in this build yet", document_id)


async def enqueue_document(document_id: str) -> None:
    """Queue processing; the queueing lock keeps one pending job per document."""
    await process_document.configure(lock=document_id, queueing_lock=document_id).defer_async(
        document_id=document_id
    )
