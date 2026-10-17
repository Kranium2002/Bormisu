"""Depth-scale detection: the anchor for every borehole-log page.

A log page has a column of numbers that increase monotonically down the page
(depth) — or decrease (elevation). We cluster numeric words by x, keep clusters
whose values are monotonic in y and whose y-vs-value relation is linear, and
return the best one as a mapping y → depth (metres).
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

import numpy as np

from ..models import Page, Word


@dataclass
class DepthScale:
    slope: float            # page units per metre
    intercept: float        # y at depth 0
    x0: float               # x-range of the scale column
    x1: float
    y_top: float            # y of first tick
    y_bottom: float         # y of last tick
    n: int
    r2: float
    kind: str               # "depth" | "elevation" | "neg-depth"
    unit: str = "m"
    ticks: list[tuple[float, float]] = None   # (y, value)

    def depth_at(self, y: float) -> float:
        return (y - self.intercept) / self.slope

    def y_at(self, depth: float) -> float:
        return self.intercept + depth * self.slope

    @property
    def depth_top(self) -> float:
        return self.depth_at(self.y_top)

    @property
    def depth_bottom(self) -> float:
        return self.depth_at(self.y_bottom)

    def as_dict(self) -> dict:
        return {k: (round(v, 3) if isinstance(v, float) else v) for k, v in self.__dict__.items() if k != "ticks"}


def _clusters_by_x(words: list[Word], tol: float = 9.0) -> list[list[Word]]:
    """Cluster by x-centre (right-aligned numbers share x1, left-aligned share x0; centre is a compromise)."""
    ws = sorted(words, key=lambda w: w.xc)
    clusters: list[list[Word]] = []
    for w in ws:
        if clusters and abs(np.mean([c.xc for c in clusters[-1]]) - w.xc) <= tol:
            clusters[-1].append(w)
        else:
            clusters.append([w])
    return clusters


def _fit(cluster: list[Word], _depth: int = 0) -> Optional[DepthScale]:
    ds = _fit_once(cluster)
    if ds is None or ds.r2 >= 0.995 or len(cluster) < 5 or _depth >= 3:
        return ds
    # robust refit: drop the point with the largest residual and try again
    ys = np.array([w.yc for w in cluster]); vs = np.array([w.number for w in cluster])
    A = np.vstack([vs, np.ones_like(vs)]).T
    coef, *_ = np.linalg.lstsq(A, ys, rcond=None)
    res = np.abs(A @ coef - ys)
    sub = [w for i, w in enumerate(cluster) if i != int(np.argmax(res))]
    better = _fit(sub, _depth + 1)
    return better if better and better.r2 > ds.r2 else ds


def _fit_once(cluster: list[Word]) -> Optional[DepthScale]:
    pts = sorted(((w.yc, w.number, w) for w in cluster if w.number is not None), key=lambda t: t[0])
    if len(pts) < 3:
        return None
    ys = np.array([p[0] for p in pts])
    vs = np.array([p[1] for p in pts])
    # dedupe identical y (OCR duplicates)
    keep = np.concatenate(([True], np.diff(ys) > 1.0))
    ys, vs = ys[keep], vs[keep]
    if len(ys) < 3:
        return None
    dv = np.diff(vs)
    if len(ys) == 3 and not (np.allclose(dv, dv[0]) and np.allclose(np.diff(ys), np.diff(ys)[0], rtol=0.02)):
        return None
    if np.all(dv > 0):
        kind = "depth"
    elif np.all(dv < 0):
        kind = "elevation"
    else:
        return None   # mixed clusters are split by _split_monotonic before fitting
    A = np.vstack([vs, np.ones_like(vs)]).T
    coef, res, *_ = np.linalg.lstsq(A, ys, rcond=None)
    slope, intercept = float(coef[0]), float(coef[1])
    pred = A @ coef
    ss_res = float(np.sum((ys - pred) ** 2))
    ss_tot = float(np.sum((ys - ys.mean()) ** 2)) or 1e-9
    r2 = 1 - ss_res / ss_tot
    # typical log scales: 1 m between 15 and 400 page units (1:200 .. 1:5 on A4)
    if not (10 <= abs(slope) <= 600):
        return None
    span_y = ys[-1] - ys[0]
    if span_y < 60:          # column must cover a real stretch of the page
        return None
    if kind == "elevation":
        # convert to depth: if values are all <= 0 they are negative depths; else elevation needs GL.
        if np.all(vs <= 0):
            kind = "neg-depth"
            slope, intercept = -slope, intercept   # depth = -value
        else:
            slope = -slope
            # intercept such that depth(y_first) = 0 (relative depth, GL = first tick value)
            intercept = ys[0]
    xs0 = min(w.x0 for w in cluster)
    xs1 = max(w.x1 for w in cluster)
    return DepthScale(slope=slope, intercept=intercept, x0=xs0, x1=xs1, y_top=float(ys[0]), y_bottom=float(ys[-1]),
                      n=len(ys), r2=r2, kind=kind, ticks=[(float(y), float(v)) for y, v in zip(ys, vs)])


def _uniformity(ds: DepthScale) -> float:
    vals = np.array([v for _, v in ds.ticks])
    d = np.abs(np.diff(vals))
    if len(d) == 0 or d.mean() == 0:
        return 0.0
    return float(1.0 - min(1.0, d.std() / d.mean()))


def _longest_monotonic(pts: list[tuple[float, float, Word]], increasing: bool) -> list[Word]:
    """Longest increasing/decreasing subsequence of values ordered by y (O(n^2), n is small)."""
    n = len(pts)
    if n == 0:
        return []
    best = [1] * n
    prev = [-1] * n
    for i in range(n):
        for j in range(i):
            ok = pts[j][1] < pts[i][1] if increasing else pts[j][1] > pts[i][1]
            if ok and best[j] + 1 > best[i]:
                best[i], prev[i] = best[j] + 1, j
    i = int(np.argmax(best))
    out = []
    while i != -1:
        out.append(pts[i][2])
        i = prev[i]
    return out[::-1]


def _split_monotonic(cluster: list[Word]) -> list[list[Word]]:
    """A column may interleave two scales (depth and elevation at the same x). Split it into
    monotonic chains: longest increasing, longest decreasing, and whatever is left (recursively)."""
    pts = sorted(((w.yc, w.number, w) for w in cluster if w.number is not None), key=lambda t: t[0])
    vals = [p[1] for p in pts]
    if len(pts) < 3:
        return []
    dv = np.diff(vals)
    if np.all(dv > 0) or np.all(dv < 0):
        return [cluster]
    inc = _longest_monotonic(pts, True)
    dec = _longest_monotonic(pts, False)
    chains = []
    for chain in (inc, dec):
        if len(chain) >= 3:
            chains.append(chain)
    used = {id(w) for c in chains for w in c}
    rest = [w for w in cluster if id(w) not in used]
    if len(rest) >= 3 and len(rest) < len(cluster):
        chains += _split_monotonic(rest)
    return chains


def find_depth_scales(page: Page, min_r2: float = 0.985) -> list[DepthScale]:
    nums = [w for w in page.words if w.number is not None and len(w.text) <= 8]
    cands: list[DepthScale] = []
    for cl in _clusters_by_x(nums):
        if len(cl) < 3:
            continue
        for chain in _split_monotonic(cl):
            ds = _fit(chain)
            if ds and ds.r2 >= min_r2:
                cands.append(ds)
    # score: many ticks, uniform spacing, long span, prefer plain depth
    def score(ds: DepthScale) -> float:
        s = ds.n * (0.2 + _uniformity(ds)) * (ds.y_bottom - ds.y_top) / page.height
        s *= max(0.0, (ds.r2 - 0.98) / 0.02) ** 3 + 0.05   # strongly prefer truly linear columns
        if ds.kind == "depth":
            s *= 1.5
        if ds.kind == "depth" and ds.ticks and ds.ticks[0][1] <= 0.5:
            s *= 1.3   # starts near zero — classic depth scale
        return s
    cands.sort(key=score, reverse=True)
    return cands


def best_depth_scale(page: Page) -> Optional[DepthScale]:
    c = find_depth_scales(page)
    return c[0] if c else None
