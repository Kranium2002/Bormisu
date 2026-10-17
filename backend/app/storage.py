"""File storage behind a small interface (put/get/exists/path). Keys are generated, never client names."""

from __future__ import annotations

import os
import shutil
import tempfile
from collections.abc import Callable
from pathlib import Path, PurePosixPath
from typing import BinaryIO, Protocol

from app.config import get_settings


class StorageKeyError(ValueError):
    """The key would leave the storage root."""


class Storage(Protocol):
    def path(self, key: str) -> Path: ...
    def exists(self, key: str) -> bool: ...
    def put_bytes(self, key: str, data: bytes) -> None: ...
    def put_file(self, key: str, source: Path) -> None: ...
    def get_bytes(self, key: str) -> bytes: ...
    def delete(self, key: str) -> None: ...
    def delete_prefix(self, prefix: str) -> None: ...


class FileStorage:
    """Local volume. Writes go through a temp file and an atomic rename, so readers never see half a file."""

    def __init__(self, root: Path) -> None:
        self.root = root.resolve()

    def path(self, key: str) -> Path:
        pure = PurePosixPath(key)
        if not key or pure.is_absolute() or ".." in pure.parts or "\\" in key or ":" in key:
            raise StorageKeyError(key)
        resolved = (self.root / Path(*pure.parts)).resolve()
        if self.root not in resolved.parents:
            raise StorageKeyError(key)
        return resolved

    def exists(self, key: str) -> bool:
        return self.path(key).is_file()

    def _atomic_write(self, target: Path, write: Callable[[BinaryIO], object]) -> None:
        target.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=target.parent, prefix=".tmp-")
        try:
            with os.fdopen(fd, "wb") as handle:
                write(handle)
            os.replace(tmp, target)
        except BaseException:
            Path(tmp).unlink(missing_ok=True)
            raise

    def put_bytes(self, key: str, data: bytes) -> None:
        self._atomic_write(self.path(key), lambda handle: handle.write(data))

    def put_file(self, key: str, source: Path) -> None:
        """Move a local temp file into place (copy when it lives on another filesystem)."""
        target = self.path(key)
        target.parent.mkdir(parents=True, exist_ok=True)
        try:
            os.replace(source, target)
        except OSError:
            with source.open("rb") as src:
                self._atomic_write(target, lambda handle: shutil.copyfileobj(src, handle))
            source.unlink(missing_ok=True)

    def get_bytes(self, key: str) -> bytes:
        return self.path(key).read_bytes()

    def delete(self, key: str) -> None:
        self.path(key).unlink(missing_ok=True)

    def delete_prefix(self, prefix: str) -> None:
        target = self.path(prefix)
        if target.is_dir():
            shutil.rmtree(target, ignore_errors=True)
        else:
            target.unlink(missing_ok=True)


def get_storage() -> FileStorage:
    root = get_settings().storage_dir
    root.mkdir(parents=True, exist_ok=True)
    return FileStorage(root)


def original_key(sha256: str, extension: str) -> str:
    return f"originals/{sha256}{extension}"


def page_render_key(document_id: str, n: int) -> str:
    return f"pages/{document_id}/{n:04d}.png"


def page_thumb_key(document_id: str, n: int) -> str:
    return f"pages/{document_id}/thumb/{n:04d}.png"


def page_resized_key(document_id: str, n: int, width: int) -> str:
    return f"pages/{document_id}/w{width}/{n:04d}.png"


def document_prefix(document_id: str) -> str:
    return f"pages/{document_id}"
