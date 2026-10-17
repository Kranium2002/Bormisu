"""Upload validation: type by magic bytes (not by the client's name), size limit, sha256 while streaming."""

from __future__ import annotations

import hashlib
import re
import tempfile
import unicodedata
import zipfile
from dataclasses import dataclass
from pathlib import Path
from typing import BinaryIO

from app.errors import ApiError

# Extension -> (mime type, detector family). DOC/ODT/PPTX can be added when ACCEPTED_EXTENSIONS lists them.
TYPES: dict[str, tuple[str, str]] = {
    ".pdf": ("application/pdf", "pdf"),
    ".png": ("image/png", "png"),
    ".jpg": ("image/jpeg", "jpeg"),
    ".jpeg": ("image/jpeg", "jpeg"),
    ".webp": ("image/webp", "webp"),
    ".tif": ("image/tiff", "tiff"),
    ".tiff": ("image/tiff", "tiff"),
    ".docx": ("application/vnd.openxmlformats-officedocument.wordprocessingml.document", "docx"),
    ".xlsx": ("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "xlsx"),
    ".csv": ("text/csv", "csv"),
    ".odt": ("application/vnd.oasis.opendocument.text", "odt"),
    ".pptx": ("application/vnd.openxmlformats-officedocument.presentationml.presentation", "pptx"),
    ".doc": ("application/msword", "ole"),
}

_ZIP_MARKERS = {"docx": "word/", "xlsx": "xl/", "pptx": "ppt/"}
_CHUNK = 1024 * 1024


def detect_family(head: bytes, path: Path) -> str | None:
    """Content family from the first bytes (and the zip directory for Office files)."""
    if head.startswith(b"%PDF-"):
        return "pdf"
    if head.startswith(b"\x89PNG\r\n\x1a\n"):
        return "png"
    if head.startswith(b"\xff\xd8\xff"):
        return "jpeg"
    if head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return "webp"
    if head[:4] in (b"II*\x00", b"MM\x00*"):
        return "tiff"
    if head.startswith(b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1"):
        return "ole"
    if head.startswith(b"PK\x03\x04"):
        try:
            with zipfile.ZipFile(path) as archive:
                names = archive.namelist()
                if "mimetype" in names and archive.read("mimetype").startswith(
                    b"application/vnd.oasis.opendocument.text"
                ):
                    return "odt"
        except (zipfile.BadZipFile, OSError, KeyError):
            return None
        for family, marker in _ZIP_MARKERS.items():
            if any(name.startswith(marker) for name in names):
                return family
        return None
    if head and b"\x00" not in head:
        try:
            head.decode("utf-8")
        except UnicodeDecodeError:
            try:
                head.decode("cp1252")
            except UnicodeDecodeError:
                return None
        return "csv"
    return None


def display_name(name: str | None) -> str:
    """Client file name for display only (never used as a path)."""
    base = re.split(r"[\\/]", name or "")[-1]
    base = unicodedata.normalize("NFC", base)
    base = "".join(ch for ch in base if ch.isprintable()).strip()
    return base[:255] or "upload"


@dataclass(frozen=True)
class StoredUpload:
    path: Path
    sha256: str
    size_bytes: int
    extension: str
    mime_type: str


def receive(
    source: BinaryIO, *, file_name: str, accepted: list[str], max_bytes: int, tmp_dir: Path
) -> StoredUpload:
    """Stream `source` into a temp file under `tmp_dir`, hashing as it goes; validate size and type."""
    extension = Path(display_name(file_name)).suffix.lower()
    if extension not in accepted or extension not in TYPES:
        raise ApiError(415, "unsupported_type", f"Files of type {extension or '(none)'} are not accepted.")
    tmp_dir.mkdir(parents=True, exist_ok=True)
    digest = hashlib.sha256()
    size = 0
    handle = tempfile.NamedTemporaryFile(dir=tmp_dir, prefix="upload-", delete=False)  # noqa: SIM115
    path = Path(handle.name)
    try:
        with handle:
            while chunk := source.read(_CHUNK):
                size += len(chunk)
                if size > max_bytes:
                    raise ApiError(
                        413, "too_large", f"The file is larger than {max_bytes // (1024 * 1024)} MB."
                    )
                digest.update(chunk)
                handle.write(chunk)
        if size == 0:
            raise ApiError(415, "unsupported_type", "The file is empty.")
        with path.open("rb") as check:
            head = check.read(4096)
        mime_type, family = TYPES[extension]
        detected = detect_family(head, path)
        if detected != family:
            raise ApiError(
                415, "unsupported_type", f"The file content does not match its {extension} extension."
            )
    except BaseException:
        path.unlink(missing_ok=True)
        raise
    return StoredUpload(
        path=path, sha256=digest.hexdigest(), size_bytes=size, extension=extension, mime_type=mime_type
    )
