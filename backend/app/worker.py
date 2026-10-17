"""Worker entry point: `python -m app.worker`."""

from __future__ import annotations

import asyncio
import logging

from app.config import get_settings
from app.queue import queue_app


async def main() -> None:
    settings = get_settings()
    logging.basicConfig(level=settings.log_level, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    logging.getLogger("geomemory.worker").info(
        "worker starting (mode=%s, ocr=%s, extractor=%s)",
        settings.mode,
        settings.ocr_configured,
        settings.extractor_configured,
    )
    async with queue_app.open_async():
        await queue_app.run_worker_async(queues=["pipeline"], install_signal_handlers=True)


if __name__ == "__main__":
    asyncio.run(main())
