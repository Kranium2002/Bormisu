"""Office files (DOCX, DOC, ODT, PPTX) to PDF through Gotenberg (LibreOffice), then the PDF path."""

from __future__ import annotations

from pathlib import Path

import httpx

from app.config import get_settings

CONVERT_PATH = "/forms/libreoffice/convert"
TIMEOUT_S = 180.0


class OfficeConversionError(RuntimeError):
    """Gotenberg could not convert the file (message is safe to show to a person)."""


async def office_to_pdf(path: Path, *, client: httpx.AsyncClient | None = None) -> bytes:
    url = get_settings().gotenberg_url.rstrip("/") + CONVERT_PATH
    owns_client = client is None
    http = client or httpx.AsyncClient(timeout=TIMEOUT_S)
    try:
        with path.open("rb") as handle:
            # Gotenberg needs the right extension to pick the import filter; the name is otherwise unused.
            files = {"files": (f"document{path.suffix.lower()}", handle, "application/octet-stream")}
            response = await http.post(url, files=files)
    except httpx.HTTPError as exc:
        raise OfficeConversionError("The office-file converter is not reachable.") from exc
    finally:
        if owns_client:
            await http.aclose()
    if response.status_code != 200 or not response.content.startswith(b"%PDF-"):
        raise OfficeConversionError(
            f"The office-file converter could not read this file ({response.status_code})."
        )
    return response.content
