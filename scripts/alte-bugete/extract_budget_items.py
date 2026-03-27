#!/usr/bin/env python3

from __future__ import annotations

import argparse
import sys
from pathlib import Path

CURRENT_DIR = Path(__file__).resolve().parent
REPO_ROOT = CURRENT_DIR.parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))
if str(CURRENT_DIR) not in sys.path:
    sys.path.insert(0, str(CURRENT_DIR))

from budget_items import (
    BATCH_SUMMARY_FILENAME,
    MERGED_FILENAME,
    merge_successful_slices,
    process_slice,
    write_json,
)
from slice_config import DEFAULT_INPUT_DIR, DEFAULT_OUTPUT_ROOT, DEFAULT_PREVIEW_LIMIT, SLICE_CONFIGS


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Extract and validate alte-bugete budget item slices",
    )
    parser.add_argument(
        "--input-dir",
        default=str(DEFAULT_INPUT_DIR),
        help="Directory containing the alte-bugete PDFs",
    )
    parser.add_argument(
        "--output-root",
        default=str(DEFAULT_OUTPUT_ROOT),
        help="Directory where per-slice outputs will be written",
    )
    parser.add_argument(
        "--preview-limit",
        default=DEFAULT_PREVIEW_LIMIT,
        type=int,
        help="Maximum number of mismatches to render in markdown reports",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(sys.argv[1:] if argv is None else argv)
    input_dir = Path(args.input_dir).expanduser().resolve()
    output_root = Path(args.output_root).expanduser().resolve()
    preview_limit = int(args.preview_limit)

    if not input_dir.exists():
        print(f"Input directory does not exist: {input_dir}", file=sys.stderr)
        return 1

    output_root.mkdir(parents=True, exist_ok=True)
    merged_output_path = output_root / MERGED_FILENAME
    merged_output_path.unlink(missing_ok=True)

    layout_cache: dict[Path, str] = {}
    summaries = [
        process_slice(
            config=config,
            input_dir=input_dir,
            output_root=output_root,
            layout_cache=layout_cache,
            preview_limit=preview_limit,
        )
        for config in SLICE_CONFIGS
    ]

    write_json(output_root / BATCH_SUMMARY_FILENAME, summaries)

    failure_count = sum(1 for summary in summaries if summary["status"] != "success")
    hard_failure_count = sum(1 for summary in summaries if summary["status"] == "failure")
    if hard_failure_count == 0:
        merge_stats = merge_successful_slices(summaries, output_path=merged_output_path)
        print(f"Merged slices: {merge_stats['included_slices']}")
        print(f"Warning slices: {merge_stats['warning_slices']}")
        print(f"Merged rows: {merge_stats['merged_rows']}")
        print(f"Merged output: {merged_output_path}")
    else:
        print(
            f"Skipped merged output because {hard_failure_count} slices failed extraction.",
            file=sys.stderr,
        )

    for summary in summaries:
        print(
            f"- {summary['slice_id']}: {summary['status']} "
            f"detail_rows={summary['detail_row_count']} "
            f"synteza_rows={summary['synteza_row_count']} "
            f"corrected={summary['detail_corrected_cells'] + summary['synteza_corrected_cells']} "
            f"manual_sync={summary['manual_sync_cells']}"
        )

    return 0 if hard_failure_count == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
