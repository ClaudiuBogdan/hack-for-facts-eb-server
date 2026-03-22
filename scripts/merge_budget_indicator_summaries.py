#!/usr/bin/env python3

from __future__ import annotations

import argparse
import csv
import json
import sys
from pathlib import Path

DEFAULT_BATCH_ROOT = (
    "/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/"
    "scripts/output/anexa-3-batch"
)
DEFAULT_OUTPUT = (
    "/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/"
    "scripts/output/anexa-3-batch/national-budget-indicator-summary.csv"
)
BATCH_SUMMARY_FILENAME = "batch-summary.json"
BUDGET_SUMMARY_FILENAME = "budget_indicator_summary.csv"
ENTITY_COLUMN = "entity"


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Merge all acceptable per-entity budget_indicator_summary.csv files into one national CSV",
    )
    parser.add_argument(
        "--batch-root",
        default=DEFAULT_BATCH_ROOT,
        help="Batch output root containing batch-summary.json and per-document folders",
    )
    parser.add_argument(
        "--output",
        default=DEFAULT_OUTPUT,
        help="Path to the merged national budget CSV",
    )
    return parser.parse_args(argv)


def load_batch_summary(batch_root: Path) -> list[dict[str, object]]:
    summary_path = batch_root / BATCH_SUMMARY_FILENAME
    if not summary_path.exists():
        raise FileNotFoundError(f"Missing batch summary file: {summary_path}")
    data = json.loads(summary_path.read_text(encoding="utf-8"))
    if not isinstance(data, list):
        raise ValueError(f"Expected {summary_path} to contain a JSON array")
    return data


def read_budget_summary(csv_path: Path) -> tuple[list[str], list[dict[str, str]]]:
    with csv_path.open(encoding="utf-8", newline="") as handle:
        reader = csv.DictReader(handle, delimiter=";")
        if reader.fieldnames is None:
            raise ValueError(f"Missing header row in {csv_path}")
        rows = [dict(row) for row in reader]
    return list(reader.fieldnames), rows


def merge_budget_summaries(
    batch_root: Path,
) -> tuple[list[str], list[dict[str, str]], dict[str, int]]:
    summary_items = load_batch_summary(batch_root)

    merged_rows: list[dict[str, str]] = []
    base_header: list[str] | None = None
    stats = {
        "included_documents": 0,
        "excluded_documents": 0,
        "missing_csv_documents": 0,
        "merged_rows": 0,
    }

    for item in summary_items:
        interpretation = item.get("interpretation")
        if interpretation != "acceptable":
            stats["excluded_documents"] += 1
            continue

        document_id = item.get("document_id")
        output_dir = item.get("output_dir")
        if not isinstance(document_id, str) or not isinstance(output_dir, str):
            raise ValueError("Batch summary entries must contain string document_id and output_dir")

        csv_path = Path(output_dir) / BUDGET_SUMMARY_FILENAME
        if not csv_path.exists():
            stats["missing_csv_documents"] += 1
            continue

        header, rows = read_budget_summary(csv_path)
        if base_header is None:
            base_header = header
        elif header != base_header:
            raise ValueError(
                f"Header mismatch in {csv_path}. Expected {base_header}, got {header}"
            )

        for row in rows:
            merged_rows.append({ENTITY_COLUMN: document_id, **row})

        stats["included_documents"] += 1

    if base_header is None:
        raise ValueError("No acceptable budget_indicator_summary.csv files were found to merge")

    stats["merged_rows"] = len(merged_rows)
    return [ENTITY_COLUMN, *base_header], merged_rows, stats


def write_merged_csv(output_path: Path, header: list[str], rows: list[dict[str, str]]) -> None:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with output_path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(
            handle,
            fieldnames=header,
            delimiter=";",
            lineterminator="\n",
            extrasaction="ignore",
        )
        writer.writeheader()
        for row in rows:
            writer.writerow(row)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(sys.argv[1:] if argv is None else argv)
    batch_root = Path(args.batch_root).expanduser().resolve()
    output_path = Path(args.output).expanduser().resolve()

    if not batch_root.exists():
        print(f"Batch root does not exist: {batch_root}", file=sys.stderr)
        return 1

    try:
        header, rows, stats = merge_budget_summaries(batch_root)
        write_merged_csv(output_path, header, rows)
    except (FileNotFoundError, ValueError, json.JSONDecodeError) as error:
        print(str(error), file=sys.stderr)
        return 1

    print(f"Included documents: {stats['included_documents']}")
    print(f"Excluded documents: {stats['excluded_documents']}")
    print(f"Skipped missing CSV: {stats['missing_csv_documents']}")
    print(f"Merged rows: {stats['merged_rows']}")
    print(f"Output: {output_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
