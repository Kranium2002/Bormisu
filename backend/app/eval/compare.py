"""Compare what the pipeline stored for one file with the file's expected entry.

Boreholes are matched by canonical label (app.review.service.canonical_label, the pipeline's own rule), also
against the aliases the pipeline recorded. Per-borehole metrics are counted over matched boreholes only;
a borehole that was not found counts once, under `labels`. Every metric ends as match, mismatch (with a
failure category) or not comparable (with a reason). With a page excerpt only the expected boreholes whose
pages all lie inside the excerpt are compared; without page ranges in the expected entry the excerpt's
counts are not comparable.
"""

from __future__ import annotations

from collections import Counter
from collections.abc import Iterable, Sequence
from dataclasses import dataclass, field

from app.eval.expected import ExpectedBorehole, ExpectedFile, squash

METRICS = (
    "borehole_count",
    "labels",
    "coordinates",
    "crs_status",
    "total_depth",
    "layer_count",
    "unplotted_reason",
    "duplicates",
)


@dataclass(frozen=True)
class ActualBorehole:
    canonical: str
    aliases: frozenset[str]
    x_raw: str | None
    y_raw: str | None
    crs_status: str
    unplotted_reason: str | None
    depth_m: float | None
    layer_count: int

    @property
    def has_coordinates(self) -> bool:
        return self.x_raw is not None or self.y_raw is not None


@dataclass
class Tally:
    match: int = 0
    mismatch: int = 0
    not_comparable: int = 0

    def add(self, other: Tally) -> None:
        self.match += other.match
        self.mismatch += other.mismatch
        self.not_comparable += other.not_comparable

    @property
    def compared(self) -> int:
        return self.match + self.mismatch


@dataclass
class FileComparison:
    tallies: dict[str, Tally] = field(default_factory=lambda: {m: Tally() for m in METRICS})
    failures: Counter[str] = field(default_factory=Counter)
    not_comparable: Counter[str] = field(default_factory=Counter)
    expected_in_scope: int | None = None  # expected boreholes compared (None: no expected entry)
    found: int = 0  # boreholes the pipeline stored that belong to the compared scope
    matched: int = 0
    unexpected: int = 0  # stored boreholes whose label matches no expected borehole
    partly_in_excerpt: int = 0
    outside_excerpt: int = 0
    without_pages: int = 0

    def ok(self, metric: str) -> None:
        self.tallies[metric].match += 1

    def fail(self, metric: str, category: str, times: int = 1) -> None:
        self.tallies[metric].mismatch += times
        self.failures[category] += times

    def skip(self, metric: str, reason: str, times: int = 1) -> None:
        self.tallies[metric].not_comparable += times
        self.not_comparable[f"{metric}: {reason}"] += times


def _coordinates(result: FileComparison, exp: ExpectedBorehole, act: ActualBorehole) -> None:
    if exp.has_coordinates is None:
        result.skip("coordinates", "not given")
    elif exp.has_coordinates is False:
        if act.has_coordinates:
            result.fail("coordinates", "coordinates_unexpected")
        else:
            result.ok("coordinates")
    elif not act.has_coordinates:
        result.fail("coordinates", "coordinates_missed")
    elif exp.x_raw is not None or exp.y_raw is not None:
        pairs = [(e, a) for e, a in ((exp.x_raw, act.x_raw), (exp.y_raw, act.y_raw)) if e is not None]
        if all(a is not None and squash(e) == squash(a) for e, a in pairs):
            result.ok("coordinates")
        else:
            result.fail("coordinates", "coordinates_mismatch")
    else:
        printed = squash(exp.coordinates_text or "")
        values = [squash(v) for v in (act.x_raw, act.y_raw) if v is not None]
        if all(v and v in printed for v in values):
            result.ok("coordinates")
        else:
            result.fail("coordinates", "coordinates_mismatch")


def _per_borehole(
    result: FileComparison, exp: ExpectedBorehole, act: ActualBorehole, *, tolerance_m: float
) -> None:
    _coordinates(result, exp, act)
    if exp.crs_status is None:
        result.skip("crs_status", "not given")
    elif exp.crs_status == act.crs_status:
        result.ok("crs_status")
    else:
        result.fail("crs_status", "crs_status_mismatch")
    if exp.total_depth_m is None:
        result.skip("total_depth", "not given or not one printed length")
    elif act.depth_m is None:
        result.fail("total_depth", "total_depth_missing")
    elif abs(exp.total_depth_m - act.depth_m) <= tolerance_m:
        result.ok("total_depth")
    else:
        result.fail("total_depth", "total_depth_mismatch")
    if exp.layer_count is None:
        result.skip("layer_count", "not given")
    elif exp.layer_count == act.layer_count:
        result.ok("layer_count")
    else:
        result.fail("layer_count", "layer_count_mismatch")
    if not exp.unplotted_known:
        result.skip("unplotted_reason", "not given")
    elif exp.unplotted_reason == act.unplotted_reason:
        result.ok("unplotted_reason")
    else:
        result.fail("unplotted_reason", "unplotted_reason_mismatch")


def _take(pool: list[ActualBorehole], canonical: str) -> ActualBorehole | None:
    """The first stored borehole with this label (or alias), removed from the pool."""
    for candidates in (
        [a for a in pool if a.canonical == canonical],
        [a for a in pool if canonical in a.aliases],
    ):
        if candidates:
            pool.remove(candidates[0])
            return candidates[0]
    return None


def compare_file(
    expected: ExpectedFile | None,
    actual: Sequence[ActualBorehole],
    *,
    excerpt: tuple[int, int] | None,
    duplicates_expected: Iterable[str] | None,
    duplicates_found: Iterable[str],
    tolerance_m: float,
) -> FileComparison:
    result = FileComparison(found=len(actual))
    if expected is None:
        for metric in METRICS:
            result.skip(metric, "no expected entry")
        return result

    in_scope: list[ExpectedBorehole] = []
    excluded: list[ExpectedBorehole] = []  # partly in or outside the excerpt
    unplaced: list[ExpectedBorehole] = []  # no page ranges: may or may not lie in the excerpt
    if excerpt is None:
        in_scope = list(expected.boreholes)
    else:
        pages = frozenset(range(excerpt[0], excerpt[1] + 1))
        for hole in expected.boreholes:
            if hole.pages is None:
                result.without_pages += 1
                unplaced.append(hole)
            elif hole.pages <= pages:
                in_scope.append(hole)
            elif hole.pages & pages:
                result.partly_in_excerpt += 1
                excluded.append(hole)
            else:
                result.outside_excerpt += 1
                excluded.append(hole)

    pool = list(actual)
    pairs: list[tuple[ExpectedBorehole, ActualBorehole]] = []
    missed = 0
    for hole in in_scope:
        found = _take(pool, hole.canonical)
        if found is None:
            missed += 1
        else:
            pairs.append((hole, found))
    for hole in excluded:  # stored parts of boreholes the excerpt cuts are neither found nor extra
        _take(pool, hole.canonical)
    unplaced_found = sum(_take(pool, hole.canonical) is not None for hole in unplaced)
    result.matched = len(pairs)
    result.found = len(pairs) + unplaced_found + len(pool)

    # Borehole count
    if excerpt is None:
        count = expected.borehole_count if expected.borehole_count is not None else len(expected.boreholes)
        if expected.borehole_count is None and not expected.boreholes:
            result.skip("borehole_count", "not given")
        else:
            result.expected_in_scope = count
            if count == len(actual):
                result.ok("borehole_count")
            else:
                result.fail("borehole_count", "borehole_count_mismatch")
    elif not expected.boreholes or result.without_pages or not expected.listed_completely:
        result.skip("borehole_count", "excerpt without page ranges for every borehole")
    else:
        result.expected_in_scope = len(in_scope)
        if len(in_scope) == result.found:
            result.ok("borehole_count")
        else:
            result.fail("borehole_count", "borehole_count_mismatch")

    # Labels: one check per expected borehole in scope; extra stored labels are failures only when the
    # expected entry lists every borehole (and, for an excerpt, says where each one is).
    for _ in pairs:
        result.ok("labels")
    if missed:
        result.fail("labels", "label_missed", missed)
    if not in_scope and not expected.boreholes:
        result.skip("labels", "no boreholes listed")
    if pool:
        complete = bool(expected.boreholes) and expected.listed_completely and not result.without_pages
        if complete:
            result.unexpected = len(pool)
            result.failures["label_unexpected"] += len(pool)
        else:
            result.not_comparable["labels: extra labels, list incomplete"] += len(pool)

    tolerance = max(0.0, tolerance_m)
    for hole, found in pairs:
        _per_borehole(result, hole, found, tolerance_m=tolerance)

    # Duplicates (file level)
    if duplicates_expected is None:
        result.skip("duplicates", "not given")
    else:
        want, got = set(duplicates_expected), set(duplicates_found)
        if want == got:
            result.ok("duplicates")
        else:
            if want - got:
                result.fail("duplicates", "duplicate_missed", len(want - got))
            if got - want:
                result.fail("duplicates", "duplicate_unexpected", len(got - want))
    return result
