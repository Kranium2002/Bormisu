"""Command line of the evaluation harness: `python -m app.eval` (see docs/eval/README.md)."""

from __future__ import annotations

import argparse
import asyncio
import logging
import sys
from collections.abc import Sequence
from pathlib import Path

from sqlalchemy import text

from app.config import BACKEND_DIR, get_settings
from app.db.session import dispose_engine, get_engine
from app.eval.expected import ExpectedFileError, load_expected
from app.eval.plan import Plan, PlanError, build_plan, max_pages_in_range, prior_usd_per_page
from app.eval.report import write_report
from app.eval.runner import environment, run_eval

DEFAULT_REPORT = BACKEND_DIR.parent / "docs" / "eval" / "report.md"


def parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="python -m app.eval",
        description=(
            "Run the real pipeline on sample files within a cost cap and compare the results with the "
            "expected entries. Writes metrics and failure categories only."
        ),
    )
    p.add_argument("--data-dir", type=Path, help="folder with the files (default: EVAL_DATA_DIR)")
    p.add_argument("--expected", type=Path, help="expected results, JSON (default: EVAL_EXPECTED)")
    p.add_argument(
        "--files",
        nargs="+",
        action="extend",
        metavar="NAME",
        help="short ids of the files or folders to run, in order (default: every expected entry found)",
    )
    p.add_argument(
        "--pages",
        nargs="+",
        action="extend",
        default=[],
        metavar="NAME=FROM-TO",
        help="process only these pages of a PDF (an excerpt is uploaded as its own document)",
    )
    p.add_argument("--max-usd", type=float, required=True, help="cost cap of this run in USD")
    p.add_argument(
        "--estimate-usd-per-page",
        type=float,
        help="cost estimate per page checked before each file (default: observed in this run, else a prior)",
    )
    p.add_argument(
        "--out", type=Path, default=DEFAULT_REPORT, help="report path (default: docs/eval/report.md)"
    )
    p.add_argument("--database-url", help="database to use (default: DATABASE_URL)")
    p.add_argument("--storage-dir", type=Path, help="storage folder to use (default: STORAGE_DIR)")
    p.add_argument("--dry-run", action="store_true", help="show the plan and estimates; call nothing")
    p.add_argument("-v", "--verbose", action="store_true", help="log pipeline progress")
    return p


def _say(text_line: str) -> None:
    print(text_line, flush=True)


def _show_plan(plan: Plan, per_page: float) -> None:
    for item in plan.files:
        excerpt = f", excerpt of {item.excerpt_pages} page(s)" if item.excerpt else ""
        entry = "expected entry found" if item.expected is not None else "no expected entry"
        ignored = f", {item.ignored_files} file(s) of other types ignored" if item.ignored_files else ""
        _say(
            f"{item.short_id}: {len(item.sources)} document(s), about {item.page_estimate} page(s){excerpt}, "
            f"{entry}{ignored}; estimate {item.page_estimate * per_page:.3f} USD"
        )
    if plan.unresolved:
        _say(f"{len(plan.unresolved)} expected entry(ies) match no file in the data folder.")


async def _check_database() -> str | None:
    try:
        async with get_engine().connect() as conn:
            await conn.execute(text("SELECT 1 FROM documents LIMIT 1"))
            await conn.execute(text("SELECT 1 FROM provider_calls LIMIT 1"))
    except Exception as exc:  # connection refused, missing tables, bad URL ...
        return type(exc).__name__
    return None


async def amain(args: argparse.Namespace) -> int:
    settings = get_settings()
    data_dir = args.data_dir or settings.eval_data_dir
    expected_path = args.expected or settings.eval_expected
    if data_dir is None or expected_path is None:
        _say("Set --data-dir and --expected (or EVAL_DATA_DIR and EVAL_EXPECTED).")
        return 2
    if args.max_usd < 0 or (args.estimate_usd_per_page is not None and args.estimate_usd_per_page < 0):
        _say("--max-usd and --estimate-usd-per-page cannot be negative.")
        return 2
    try:
        entries = load_expected(Path(expected_path), max_pages=max_pages_in_range())
        plan = build_plan(Path(data_dir), entries, names=args.files, pages=args.pages)
    except (ExpectedFileError, PlanError) as exc:
        _say(f"Cannot plan the run: {exc}")
        return 2
    per_page = args.estimate_usd_per_page if args.estimate_usd_per_page is not None else prior_usd_per_page()
    _show_plan(plan, per_page)
    _say(f"Estimate per page: {per_page:.4f} USD; cost cap {args.max_usd:.2f} USD.")
    if args.dry_run:
        return 0
    if not plan.files:
        _say("Nothing to run.")
        return 2
    if settings.mode != "live":
        _say("Provider keys are not configured (demo mode); the eval runs the real pipeline and needs them.")
        return 2

    overrides: dict[str, str | None] = {}
    if args.database_url:
        overrides["DATABASE_URL"] = args.database_url
    if args.storage_dir:
        overrides["STORAGE_DIR"] = str(args.storage_dir)
    with environment(overrides):
        if args.database_url:
            await dispose_engine()
        try:
            problem = await _check_database()
            if problem is not None:
                _say(
                    f"The database is not reachable or not migrated ({problem}). Start it and run "
                    "`alembic upgrade head` against it, or pass --database-url."
                )
                return 2
            run = await run_eval(
                plan.files,
                max_usd=args.max_usd,
                estimate_usd_per_page=args.estimate_usd_per_page,
                progress=_say,
            )
        finally:
            if args.database_url:
                await dispose_engine()
    report = write_report(run, args.out)
    stopped = f"; stopped by {run.stopped_by}" if run.stopped_by else ""
    _say(f"Spent {run.spent_usd:.4f} USD of {run.max_usd:.2f} USD{stopped}. Report: {report}")
    return 0


def main(argv: Sequence[str] | None = None) -> int:
    args = parser().parse_args(argv)
    logging.basicConfig(
        level=logging.INFO if args.verbose else logging.WARNING,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    return asyncio.run(amain(args))


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
