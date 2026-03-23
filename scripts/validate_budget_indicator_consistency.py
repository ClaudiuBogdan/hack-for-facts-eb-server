#!/usr/bin/env python3

from __future__ import annotations

import argparse
import csv
import sys
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from pathlib import Path

try:
    from scripts.extract_pdf_tables import ADDITIVE_VALIDATION_COLUMNS
except ModuleNotFoundError:
    from extract_pdf_tables import ADDITIVE_VALIDATION_COLUMNS

DETAIL_TABLE_BY_SUFFIX = {
    "01": "Buget pe capitole - buget de stat",
    "06": "Buget pe capitole - credite externe",
    "08": "Buget pe capitole - fonduri externe nerambursabile",
    "10": "Buget pe capitole - venituri proprii",
}
TOP_TOTAL_CODES = {"5001", "5006", "5008", "5010"}


@dataclass(frozen=True)
class ConsistencyMismatch:
    level: str
    entity: str
    credit_type: str
    detail_table_type: str
    functional: str
    economic: str
    code: str
    column: str
    sinteza_value: str
    detail_value: str
    sinteza_section: str
    detail_section: str
    description: str


@dataclass(frozen=True)
class ConsistencyValidationSummary:
    top_total_checks: int
    chapter_checks: int
    main_group_checks: int
    mismatches: list[ConsistencyMismatch]


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Validate Sinteza rows against matching detailed budget rows"
    )
    parser.add_argument("--input", required=True, help="Path to budget_indicator_summary.csv")
    return parser.parse_args(argv)


def read_rows(csv_path: Path) -> list[dict[str, str]]:
    with csv_path.open(encoding="utf-8", newline="") as handle:
        reader = csv.DictReader(handle, delimiter=";")
        if reader.fieldnames is None:
            raise ValueError(f"Missing header row in {csv_path}")
        return [dict(row) for row in reader]


def parse_decimal(value: str) -> Decimal:
    stripped = value.strip()
    if stripped == "":
        raise ValueError("Blank values should be handled before decimal parsing")
    try:
        return Decimal(stripped)
    except InvalidOperation as error:
        raise ValueError(f"Invalid decimal value: {value}") from error


def same_numeric_value(left: str, right: str) -> bool:
    left_stripped = left.strip()
    right_stripped = right.strip()
    if left_stripped == "" and right_stripped == "":
        return True
    if left_stripped == "" or right_stripped == "":
        return False
    return parse_decimal(left_stripped) == parse_decimal(right_stripped)


def resolve_detail_table_type(code: str) -> str | None:
    if len(code) < 2:
        return None
    return DETAIL_TABLE_BY_SUFFIX.get(code[-2:])


def classify_sinteza_row(row: dict[str, str]) -> tuple[str, str, tuple[str, ...]] | None:
    if row["table_type"] != "Sinteza":
        return None

    code = row["capitol"]
    detail_table_type = resolve_detail_table_type(code)
    if detail_table_type is None:
        return None

    if (
        code in TOP_TOTAL_CODES
        and row["economic"] == "00.00.00"
        and row["subcapitol"] == "00"
        and row["paragraph"] == "00"
    ):
        return (
            "top_total",
            detail_table_type,
            (row["entity"], row["credit_type"], code),
        )

    if (
        len(code) == 4
        and code not in TOP_TOTAL_CODES
        and row["economic"] == "00.00.00"
        and row["subcapitol"] == "00"
        and row["paragraph"] == "00"
    ):
        return (
            "chapter_total",
            detail_table_type,
            (row["entity"], row["credit_type"], code),
        )

    functional_code = row["functional"].split(".", 1)[0]
    detail_table_type = resolve_detail_table_type(functional_code)
    if detail_table_type is None:
        return None

    if (
        row["functional"].endswith(".00.00")
        and row["economic"] != "00.00.00"
        and row["economic"].endswith(".00.00")
    ):
        return (
            "main_group_total",
            detail_table_type,
            (row["entity"], row["credit_type"], row["functional"], row["economic"]),
        )

    return None


def classify_detail_row(row: dict[str, str]) -> tuple[str, tuple[str, ...]] | None:
    code = row["capitol"]
    detail_table_type = resolve_detail_table_type(code)
    if detail_table_type is None or row["table_type"] != detail_table_type:
        return None

    if (
        code in TOP_TOTAL_CODES
        and row["economic"] == "00.00.00"
        and row["subcapitol"] == "00"
        and row["paragraph"] == "00"
    ):
        return "top_total", (row["entity"], row["credit_type"], code)

    if (
        len(code) == 4
        and code not in TOP_TOTAL_CODES
        and row["economic"] == "00.00.00"
        and row["subcapitol"] == "00"
        and row["paragraph"] == "00"
    ):
        return "chapter_total", (row["entity"], row["credit_type"], code)

    if (
        row["functional"].endswith(".00.00")
        and row["economic"] != "00.00.00"
        and row["economic"].endswith(".00.00")
    ):
        return (
            "main_group_total",
            (row["entity"], row["credit_type"], row["functional"], row["economic"]),
        )

    return None


def build_detail_indexes(
    rows: list[dict[str, str]],
) -> dict[str, dict[tuple[str, ...], dict[str, str]]]:
    indexes: dict[str, dict[tuple[str, ...], dict[str, str]]] = {
        "top_total": {},
        "chapter_total": {},
        "main_group_total": {},
    }
    for row in rows:
        classified = classify_detail_row(row)
        if classified is None:
            continue
        level, key = classified
        indexes[level][key] = row
    return indexes


def compare_rows(
    *,
    level: str,
    detail_table_type: str,
    sinteza_row: dict[str, str],
    detail_row: dict[str, str] | None,
) -> list[ConsistencyMismatch]:
    functional = sinteza_row["functional"]
    economic = sinteza_row["economic"]
    code = sinteza_row["capitol"]
    if level == "main_group_total":
        code = economic

    if detail_row is None:
        return [
            ConsistencyMismatch(
                level=level,
                entity=sinteza_row["entity"],
                credit_type=sinteza_row["credit_type"],
                detail_table_type=detail_table_type,
                functional=functional,
                economic=economic,
                code=code,
                column="missing_row",
                sinteza_value=sinteza_row["description"],
                detail_value="missing",
                sinteza_section=sinteza_row["section"],
                detail_section="",
                description=sinteza_row["description"],
            )
        ]

    mismatches: list[ConsistencyMismatch] = []
    for column in ADDITIVE_VALIDATION_COLUMNS:
        if same_numeric_value(sinteza_row[column], detail_row[column]):
            continue
        mismatches.append(
            ConsistencyMismatch(
                level=level,
                entity=sinteza_row["entity"],
                credit_type=sinteza_row["credit_type"],
                detail_table_type=detail_table_type,
                functional=functional,
                economic=economic,
                code=code,
                column=column,
                sinteza_value=sinteza_row[column],
                detail_value=detail_row[column],
                sinteza_section=sinteza_row["section"],
                detail_section=detail_row["section"],
                description=sinteza_row["description"],
            )
        )
    return mismatches


def validate_budget_indicator_consistency_rows(
    rows: list[dict[str, str]],
) -> ConsistencyValidationSummary:
    detail_indexes = build_detail_indexes(rows)
    mismatches: list[ConsistencyMismatch] = []
    top_total_checks = 0
    chapter_checks = 0
    main_group_checks = 0

    for row in rows:
        classified = classify_sinteza_row(row)
        if classified is None:
            continue
        level, detail_table_type, key = classified
        detail_row = detail_indexes[level].get(key)
        if level == "top_total":
            top_total_checks += 1
        elif level == "chapter_total":
            chapter_checks += 1
        elif level == "main_group_total":
            main_group_checks += 1
        mismatches.extend(
            compare_rows(
                level=level,
                detail_table_type=detail_table_type,
                sinteza_row=row,
                detail_row=detail_row,
            )
        )

    return ConsistencyValidationSummary(
        top_total_checks=top_total_checks,
        chapter_checks=chapter_checks,
        main_group_checks=main_group_checks,
        mismatches=mismatches,
    )


def validate_budget_indicator_consistency_csv(csv_path: Path) -> ConsistencyValidationSummary:
    rows = read_rows(csv_path)
    fallback_entity = csv_path.parent.name
    rows = [{**row, "entity": row.get("entity", "") or fallback_entity} for row in rows]
    return validate_budget_indicator_consistency_rows(rows)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(sys.argv[1:] if argv is None else argv)
    input_path = Path(args.input).expanduser().resolve()

    if not input_path.exists():
        print(f"Input CSV does not exist: {input_path}", file=sys.stderr)
        return 1

    try:
        summary = validate_budget_indicator_consistency_csv(input_path)
    except ValueError as error:
        print(str(error), file=sys.stderr)
        return 1

    print(
        "Validated "
        f"{summary.top_total_checks} top totals, "
        f"{summary.chapter_checks} chapter totals, and "
        f"{summary.main_group_checks} main-group totals "
        f"from {input_path.name}"
    )

    if summary.mismatches:
        print(f"Found {len(summary.mismatches)} consistency mismatches:")
        for mismatch in summary.mismatches:
            print(
                f"- level={mismatch.level} "
                f"entity={mismatch.entity!r} "
                f"detail_table_type={mismatch.detail_table_type!r} "
                f"credit_type={mismatch.credit_type!r} "
                f"functional={mismatch.functional} "
                f"economic={mismatch.economic} "
                f"code={mismatch.code} "
                f"column={mismatch.column} "
                f"sinteza={mismatch.sinteza_value!r} "
                f"detail={mismatch.detail_value!r}"
            )
        return 1

    print("All checked Sinteza/detail totals matched.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
