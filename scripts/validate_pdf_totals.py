#!/usr/bin/env python3

from __future__ import annotations

import argparse
import csv
import sys
from collections import defaultdict
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from pathlib import Path

try:
    from scripts.extract_pdf_tables import ADDITIVE_VALIDATION_COLUMNS
except ModuleNotFoundError:
    from extract_pdf_tables import ADDITIVE_VALIDATION_COLUMNS


@dataclass(frozen=True)
class RollupMismatch:
    hierarchy: str
    section: str
    credit_type: str
    fixed_key: str
    parent_key: str
    column: str
    actual: Decimal
    expected: Decimal


@dataclass(frozen=True)
class ValidationSummary:
    functional_checks: int
    economic_checks: int
    mismatches: list[RollupMismatch]


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Validate parent-child totals in budget_indicator_summary.csv"
    )
    parser.add_argument("--input", required=True, help="Path to budget_indicator_summary.csv")
    return parser.parse_args(argv)


def parse_decimal(value: str) -> Decimal:
    stripped = value.strip()
    if stripped == "":
        return Decimal("0")
    try:
        return Decimal(stripped)
    except InvalidOperation as error:
        raise ValueError(f"Invalid decimal value: {value}") from error


def read_rows(csv_path: Path) -> list[dict[str, str]]:
    with csv_path.open(encoding="utf-8", newline="") as handle:
        reader = csv.DictReader(handle, delimiter=";")
        if reader.fieldnames is None:
            raise ValueError(f"Missing header row in {csv_path}")
        return [dict(row) for row in reader]


def split_key(key: str) -> tuple[str, str, str]:
    parts = key.split(".") if key else []
    padded = [*parts[:3], *["00"] * (3 - len(parts))]
    return (padded[0], padded[1], padded[2])


def hierarchy_level(key: str) -> int:
    parts = split_key(key)
    if parts[2] != "00":
        return 3
    if parts[1] != "00":
        return 2
    if parts[0] != "00":
        return 1
    return 0


def is_immediate_child(parent_key: str, child_key: str) -> bool:
    parent_parts = split_key(parent_key)
    child_parts = split_key(child_key)
    parent_level = hierarchy_level(parent_key)
    child_level = hierarchy_level(child_key)

    if parent_level == 0 or child_level != parent_level + 1:
        return False

    if parent_parts[:parent_level] != child_parts[:parent_level]:
        return False

    if child_parts[parent_level] == "00":
        return False

    for index in range(child_level, 3):
        if child_parts[index] != "00":
            return False

    return True


def build_rollup_groups(
    rows: list[dict[str, str]],
    *,
    fixed_key_field: str,
    varying_key_field: str,
) -> dict[tuple[str, str, str], dict[str, dict[str, dict[str, Decimal] | dict[str, int]]]]:
    groups: dict[
        tuple[str, str, str],
        dict[str, dict[str, dict[str, Decimal] | dict[str, int]]],
    ] = defaultdict(
        lambda: defaultdict(
            lambda: {
                "values": {column: Decimal("0") for column in ADDITIVE_VALIDATION_COLUMNS},
                "present_counts": {column: 0 for column in ADDITIVE_VALIDATION_COLUMNS},
            }
        )
    )
    for row in rows:
        group_key = (
            row["section"],
            row["credit_type"],
            row[fixed_key_field],
        )
        varying_key = row[varying_key_field]
        for column in ADDITIVE_VALIDATION_COLUMNS:
            if row[column].strip() == "":
                continue
            groups[group_key][varying_key]["values"][column] += parse_decimal(row[column])
            groups[group_key][varying_key]["present_counts"][column] += 1
    return groups


def _all_children_duplicate_parent(
    parent_entry: dict[str, dict[str, Decimal] | dict[str, int]],
    child_entries: list[dict[str, dict[str, Decimal] | dict[str, int]]],
) -> bool:
    """Detect source-PDF duplication where every child carries the parent total.

    Some Romanian budget PDFs repeat the chapter total on each subcapitol
    credit line.  When all children have the same non-zero value as the
    parent for every present column, the rollup ``parent == sum(children)``
    is guaranteed to fail and the mismatch is a data-source artefact.
    """
    for column in ADDITIVE_VALIDATION_COLUMNS:
        parent_val = parent_entry["values"][column]
        if parent_val == Decimal("0"):
            continue
        if parent_entry["present_counts"][column] == 0:
            continue
        for child_entry in child_entries:
            if child_entry["present_counts"][column] == 0:
                continue
            if child_entry["values"][column] != parent_val:
                return False
    return True


def validate_groups(
    groups: dict[
        tuple[str, str, str],
        dict[str, dict[str, dict[str, Decimal] | dict[str, int]]],
    ],
    *,
    hierarchy: str,
) -> tuple[list[RollupMismatch], int]:
    mismatches: list[RollupMismatch] = []
    checks = 0

    for (section, credit_type, fixed_key), key_values in groups.items():
        keys = sorted(key_values)
        for parent_key, parent_values in key_values.items():
            children = [child_key for child_key in keys if is_immediate_child(parent_key, child_key)]
            if not children:
                continue
            if len(children) > 1 and _all_children_duplicate_parent(
                parent_values, [key_values[child_key] for child_key in children]
            ):
                continue
            checks += 1
            for column in ADDITIVE_VALIDATION_COLUMNS:
                parent_present = parent_values["present_counts"][column] > 0
                child_presence = [
                    key_values[child_key]["present_counts"][column] > 0 for child_key in children
                ]
                if not parent_present or not all(child_presence):
                    continue
                expected = sum(
                    (key_values[child_key]["values"][column] for child_key in children), Decimal("0")
                )
                actual = parent_values["values"][column]
                if actual != expected:
                    mismatches.append(
                        RollupMismatch(
                            hierarchy=hierarchy,
                            section=section,
                            credit_type=credit_type,
                            fixed_key=fixed_key,
                            parent_key=parent_key,
                            column=column,
                            actual=actual,
                            expected=expected,
                        )
                    )

    return mismatches, checks


def format_decimal(value: Decimal) -> str:
    return format(value, "f")


def _is_sinteza_partea_row(row: dict[str, str]) -> bool:
    """Detect Sinteza 'Partea' grouping rows that aggregate multiple chapters.

    In the Sinteza table, rows like 'Partea I-a SERVICII PUBLICE GENERALE'
    carry a subcapitol code (e.g. ``5100.01.00``) but span multiple
    functional chapters.  Including them in the functional hierarchy
    creates false parent-child relationships with chapter-level totals.
    """
    return (
        row.get("table_type") == "Sinteza"
        and row.get("subcapitol", "00") != "00"
    )


def validate_budget_indicator_rows(rows: list[dict[str, str]]) -> ValidationSummary:
    functional_rows = [row for row in rows if not _is_sinteza_partea_row(row)]
    functional_groups = build_rollup_groups(
        functional_rows,
        fixed_key_field="economic",
        varying_key_field="functional",
    )
    economic_groups = build_rollup_groups(
        rows,
        fixed_key_field="functional",
        varying_key_field="economic",
    )

    functional_mismatches, functional_checks = validate_groups(
        functional_groups,
        hierarchy="functional",
    )
    economic_mismatches, economic_checks = validate_groups(
        economic_groups,
        hierarchy="economic",
    )

    return ValidationSummary(
        functional_checks=functional_checks,
        economic_checks=economic_checks,
        mismatches=[*functional_mismatches, *economic_mismatches],
    )


def validate_budget_indicator_csv(csv_path: Path) -> ValidationSummary:
    rows = read_rows(csv_path)
    return validate_budget_indicator_rows(rows)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(sys.argv[1:] if argv is None else argv)
    input_path = Path(args.input).expanduser().resolve()

    if not input_path.exists():
        print(f"Input CSV does not exist: {input_path}", file=sys.stderr)
        return 1

    try:
        summary = validate_budget_indicator_csv(input_path)
    except ValueError as error:
        print(str(error), file=sys.stderr)
        return 1

    print(
        "Validated "
        f"{summary.functional_checks} functional rollups and "
        f"{summary.economic_checks} economic rollups "
        f"from {input_path.name}"
    )

    if summary.mismatches:
        print(f"Found {len(summary.mismatches)} mismatches:")
        for mismatch in summary.mismatches:
            print(
                f"- hierarchy={mismatch.hierarchy} "
                f"section={mismatch.section!r} "
                f"credit_type={mismatch.credit_type!r} "
                f"fixed_key={mismatch.fixed_key} "
                f"parent_key={mismatch.parent_key} "
                f"column={mismatch.column} "
                f"actual={format_decimal(mismatch.actual)} "
                f"expected={format_decimal(mismatch.expected)}"
            )
        return 1

    print("All checked rollups matched.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
