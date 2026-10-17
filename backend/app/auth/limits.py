"""Sign-in and registration limits: sliding windows in memory, one set per app (API process).

A restart forgets them, and several API processes each count on their own. That is enough to slow down
password guessing on a single-process deployment, which is what docker compose runs.
"""

from __future__ import annotations

import math
import time
from collections import deque
from collections.abc import Callable
from dataclasses import dataclass

from starlette.datastructures import State

from app.config import get_settings

REGISTER_WINDOW_S = 3600


class SlidingWindow:
    """At most `limit` hits per key within `window_s` seconds."""

    def __init__(self, limit: int, window_s: float, clock: Callable[[], float] = time.monotonic) -> None:
        self.limit = limit
        self.window_s = window_s
        self._clock = clock
        self._hits: dict[str, deque[float]] = {}

    def _recent(self, key: str) -> deque[float]:
        now = self._clock()
        hits = self._hits.get(key)
        if hits is None:
            return deque()
        while hits and hits[0] <= now - self.window_s:
            hits.popleft()
        if not hits:
            del self._hits[key]
        return hits

    def retry_after(self, key: str) -> int | None:
        """Whole seconds until the next attempt is allowed, or None when it is allowed now."""
        hits = self._recent(key)
        if len(hits) < self.limit:
            return None
        return max(1, math.ceil(hits[0] + self.window_s - self._clock()))

    def hit(self, key: str) -> None:
        self._recent(key)
        self._hits.setdefault(key, deque()).append(self._clock())

    def reset(self, key: str) -> None:
        self._hits.pop(key, None)


@dataclass
class AuthLimits:
    login_email: SlidingWindow
    login_ip: SlidingWindow
    register_ip: SlidingWindow

    @classmethod
    def from_settings(cls) -> AuthLimits:
        settings = get_settings()
        return cls(
            login_email=SlidingWindow(settings.auth_login_failures_per_email, settings.auth_login_window_s),
            login_ip=SlidingWindow(settings.auth_login_failures_per_ip, settings.auth_login_window_s),
            register_ip=SlidingWindow(settings.auth_registrations_per_ip, REGISTER_WINDOW_S),
        )


def limits_of(state: State) -> AuthLimits:
    """The app's limits, created on first use (each app built by create_app counts on its own)."""
    limits = getattr(state, "auth_limits", None)
    if not isinstance(limits, AuthLimits):
        limits = AuthLimits.from_settings()
        state.auth_limits = limits
    return limits
