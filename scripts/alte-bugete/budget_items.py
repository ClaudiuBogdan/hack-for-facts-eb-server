from __future__ import annotations

import csv
import json
import shutil
import sys
from copy import deepcopy
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any

CURRENT_DIR = Path(__file__).resolve().parent
REPO_ROOT = CURRENT_DIR.parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))
if str(CURRENT_DIR) not in sys.path:
    sys.path.insert(0, str(CURRENT_DIR))

from scripts.extract_pdf_tables import (
    ADDITIVE_VALIDATION_COLUMNS,
    FAMILY_FIELDNAMES,
    parse_budget_indicator_summary,
    run_pdftotext_layout,
    split_layout_pages,
    write_family_csv,
)
from scripts.validate_pdf_totals import RollupMismatch, ValidationSummary, validate_budget_indicator_rows

from slice_config import SliceConfig

BUDGET_FAMILY = "budget_indicator_summary"
BUDGET_FILENAME = "budget_indicator_summary.csv"
SYNTEZA_FILENAME = "sinteza_budget_indicator_summary.csv"
BATCH_SUMMARY_FILENAME = "batch-summary.json"
MERGED_FILENAME = "merged-budget-indicator-summary.csv"
MERGED_SLICE_COLUMN = "slice_id"
MANUAL_SYNC_FROM_SYNTEZA_TO_DETAIL = {
    ("cnas", "II.Credite bugetare", "5005.00.00", "60.00.00"),
    ("cnas", "II.Credite bugetare", "6605.00.00", "60.00.00"),
}


@dataclass(frozen=True)
class StructuralValidationSummary:
    warnings: list[str]


@dataclass(frozen=True)
class ConsistencyMismatch:
    credit_type: str
    functional: str
    economic: str
    column: str
    synteza_value: str
    detail_value: str
    description: str


@dataclass(frozen=True)
class ConsistencyValidationSummary:
    compared_rows: int
    mismatches: list[ConsistencyMismatch]


@dataclass(frozen=True)
class SliceValidationResult:
    structural: StructuralValidationSummary
    detail_rollups: ValidationSummary
    synteza_rollups: ValidationSummary
    consistency: ConsistencyValidationSummary

    @property
    def status(self) -> str:
        if (
            self.structural.warnings
            or self.detail_rollups.mismatches
            or self.synteza_rollups.mismatches
            or self.consistency.mismatches
        ):
            return "warning"
        return "success"


@dataclass(frozen=True)
class TableExtractionResult:
    rows: list[dict[str, Any]]
    source_pages: list[int]
    corrected_cells: int
    warnings: list[str]


@dataclass(frozen=True)
class SliceExtractionBundle:
    detail: TableExtractionResult
    synteza: TableExtractionResult
    manual_sync_cells: int


def normalize_spaces(value: str) -> str:
    return " ".join(value.split())


def parse_decimal(value: str) -> Decimal:
    stripped = value.strip()
    if stripped == "":
        return Decimal("0")
    try:
        return Decimal(stripped)
    except InvalidOperation as error:
        raise ValueError(f"Invalid decimal value: {value}") from error


def format_decimal(value: Decimal) -> str:
    return format(value, "f")


def write_json(path: Path, payload: Any) -> None:
    path.write_text(f"{json.dumps(payload, ensure_ascii=False, indent=2)}\n", encoding="utf-8")


def serialize_rollup_mismatch(mismatch: RollupMismatch) -> dict[str, str]:
    return {
        "hierarchy": mismatch.hierarchy,
        "section": mismatch.section,
        "credit_type": mismatch.credit_type,
        "fixed_key": mismatch.fixed_key,
        "parent_key": mismatch.parent_key,
        "column": mismatch.column,
        "actual": format_decimal(mismatch.actual),
        "expected": format_decimal(mismatch.expected),
    }


def serialize_consistency_mismatch(mismatch: ConsistencyMismatch) -> dict[str, str]:
    return {
        "credit_type": mismatch.credit_type,
        "functional": mismatch.functional,
        "economic": mismatch.economic,
        "column": mismatch.column,
        "synteza_value": mismatch.synteza_value,
        "detail_value": mismatch.detail_value,
        "description": mismatch.description,
    }


def split_key(key: str) -> tuple[str, str, str]:
    parts = key.split(".") if key else []
    padded = [*parts[:3], *["00"] * (3 - len(parts))]
    return padded[0], padded[1], padded[2]


def hierarchy_level(key: str) -> int:
    first, second, third = split_key(key)
    if third != "00":
        return 3
    if second != "00":
        return 2
    if first != "00":
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


def _select_pages(
    layout_text: str,
    *,
    page_start: int,
    page_end: int,
) -> tuple[list[tuple[int, str]], list[str]]:
    pages = split_layout_pages(layout_text)
    selected_pages = [
        (page_number, page_text)
        for page_number, page_text in pages
        if page_start <= page_number <= page_end
    ]
    warnings: list[str] = []
    actual_pages = [page_number for page_number, _page_text in selected_pages]
    expected_pages = list(range(page_start, page_end + 1))
    if actual_pages != expected_pages:
        warnings.append(f"expected pages {expected_pages}, got {actual_pages}")
    if not selected_pages:
        warnings.append(f"no pages found in range {page_start}-{page_end}")
    return selected_pages, warnings


def _validate_first_page_title(page_text: str, required_fragments: tuple[str, ...]) -> list[str]:
    normalized_page = normalize_spaces(page_text)
    missing_fragments = [
        fragment for fragment in required_fragments if fragment not in normalized_page
    ]
    if not missing_fragments:
        return []
    missing = ", ".join(missing_fragments)
    return [f"first page is missing required title fragments: {missing}"]


def _normalize_budget_rows(
    rows: list[dict[str, Any]],
    *,
    section: str,
    table_type: str,
    page_start: int,
    page_end: int,
) -> tuple[list[dict[str, Any]], list[str]]:
    normalized_rows: list[dict[str, Any]] = []
    warnings: list[str] = []
    for raw_row in rows:
        source_page = int(raw_row["source_page"])
        if source_page < page_start or source_page > page_end:
            warnings.append(f"row page {source_page} is outside {page_start}-{page_end}")
            continue
        normalized_row = dict(raw_row)
        normalized_row["family"] = BUDGET_FAMILY
        normalized_row["section"] = section
        normalized_row["table_type"] = table_type
        normalized_rows.append(normalized_row)
    return normalized_rows, warnings


def _reconcile_rollup_axis(
    rows: list[dict[str, Any]],
    *,
    fixed_field: str,
    varying_field: str,
) -> int:
    row_index = {
        (row["section"], row["credit_type"], row[fixed_field], row[varying_field]): row
        for row in rows
    }
    grouped_keys: dict[tuple[str, str, str], set[str]] = {}
    for row in rows:
        group_key = (row["section"], row["credit_type"], row[fixed_field])
        grouped_keys.setdefault(group_key, set()).add(row[varying_field])

    corrected_cells = 0
    for section, credit_type, fixed_key in grouped_keys:
        varying_keys = grouped_keys[(section, credit_type, fixed_key)]
        ordered_parents = sorted(varying_keys, key=hierarchy_level, reverse=True)
        for parent_key in ordered_parents:
            children = [
                child_key
                for child_key in varying_keys
                if is_immediate_child(parent_key, child_key)
            ]
            if not children:
                continue

            parent_row = row_index.get((section, credit_type, fixed_key, parent_key))
            if parent_row is None:
                continue

            for column in ADDITIVE_VALIDATION_COLUMNS:
                child_rows = [
                    row_index.get((section, credit_type, fixed_key, child_key))
                    for child_key in children
                ]
                if any(
                    child_row is None or child_row.get(column, "").strip() == ""
                    for child_row in child_rows
                ):
                    continue

                total = sum(
                    (parse_decimal(child_row[column]) for child_row in child_rows if child_row is not None),
                    Decimal("0"),
                )
                normalized_total = format_decimal(total)
                if parent_row.get(column, "").strip() == normalized_total:
                    continue
                parent_row[column] = normalized_total
                corrected_cells += 1

    return corrected_cells


def reconcile_budget_rows(
    rows: list[dict[str, Any]],
    *,
    max_passes: int = 10,
) -> tuple[list[dict[str, Any]], int]:
    corrected_rows = deepcopy(rows)
    corrected_cells = 0
    for _ in range(max_passes):
        pass_corrections = 0
        pass_corrections += _reconcile_rollup_axis(
            corrected_rows,
            fixed_field="economic",
            varying_field="functional",
        )
        pass_corrections += _reconcile_rollup_axis(
            corrected_rows,
            fixed_field="functional",
            varying_field="economic",
        )
        corrected_cells += pass_corrections
        if pass_corrections == 0:
            break
    return corrected_rows, corrected_cells


def _extract_table_from_layout_text(
    *,
    layout_text: str,
    page_start: int,
    page_end: int,
    section: str,
    table_type: str,
    required_title_fragments: tuple[str, ...],
) -> TableExtractionResult:
    selected_pages, warnings = _select_pages(
        layout_text,
        page_start=page_start,
        page_end=page_end,
    )
    if selected_pages:
        warnings.extend(
            _validate_first_page_title(selected_pages[0][1], required_title_fragments)
        )

    parsed_rows = parse_budget_indicator_summary(selected_pages) if selected_pages else []
    normalized_rows, normalization_warnings = _normalize_budget_rows(
        parsed_rows,
        section=section,
        table_type=table_type,
        page_start=page_start,
        page_end=page_end,
    )
    warnings.extend(normalization_warnings)

    if not normalized_rows:
        warnings.append("no budget rows were extracted")

    return TableExtractionResult(
        rows=normalized_rows,
        source_pages=[page_number for page_number, _page_text in selected_pages],
        corrected_cells=0,
        warnings=sorted(set(warnings)),
    )


def _copy_additive_columns(
    *,
    target_rows: list[dict[str, Any]],
    reference_rows: list[dict[str, Any]],
    sync_rules: set[tuple[str, str, str, str]],
    slice_id: str,
) -> int:
    target_index = {
        (row["credit_type"], row["functional"], row["economic"]): row
        for row in target_rows
    }
    reference_index = {
        (row["credit_type"], row["functional"], row["economic"]): row
        for row in reference_rows
    }

    changed_cells = 0
    for key in sync_rules:
        rule_slice_id, credit_type, functional, economic = key
        if rule_slice_id != slice_id:
            continue
        target_row = target_index.get((credit_type, functional, economic))
        reference_row = reference_index.get((credit_type, functional, economic))
        if target_row is None or reference_row is None:
            continue
        for column in ADDITIVE_VALIDATION_COLUMNS:
            reference_value = reference_row.get(column, "")
            if target_row.get(column, "") == reference_value:
                continue
            target_row[column] = reference_value
            changed_cells += 1
    return changed_cells


def extract_slice_bundle_from_layout_text(
    layout_text: str,
    config: SliceConfig,
) -> SliceExtractionBundle:
    detail = _extract_table_from_layout_text(
        layout_text=layout_text,
        page_start=config.detail_page_start,
        page_end=config.detail_page_end,
        section=config.detail_section,
        table_type=config.detail_table_type,
        required_title_fragments=config.detail_required_title_fragments,
    )
    synteza = _extract_table_from_layout_text(
        layout_text=layout_text,
        page_start=config.synteza_page_start,
        page_end=config.synteza_page_end,
        section=config.synteza_section,
        table_type="Sinteza",
        required_title_fragments=config.synteza_required_title_fragments,
    )

    detail_rows = deepcopy(detail.rows)
    synteza_rows = deepcopy(synteza.rows)
    manual_sync_cells = 0
    manual_sync_cells += _copy_additive_columns(
        target_rows=detail_rows,
        reference_rows=synteza_rows,
        sync_rules=MANUAL_SYNC_FROM_SYNTEZA_TO_DETAIL,
        slice_id=config.slice_id,
    )

    return SliceExtractionBundle(
        detail=TableExtractionResult(
            rows=detail_rows,
            source_pages=detail.source_pages,
            corrected_cells=detail.corrected_cells,
            warnings=detail.warnings,
        ),
        synteza=TableExtractionResult(
            rows=synteza_rows,
            source_pages=synteza.source_pages,
            corrected_cells=synteza.corrected_cells,
            warnings=synteza.warnings,
        ),
        manual_sync_cells=manual_sync_cells,
    )


def extract_slice_bundle_from_pdf(
    pdf_path: Path,
    config: SliceConfig,
    *,
    layout_cache: dict[Path, str] | None = None,
) -> SliceExtractionBundle:
    resolved_pdf_path = pdf_path.resolve()
    if not resolved_pdf_path.exists():
        raise FileNotFoundError(f"Missing input PDF: {resolved_pdf_path}")

    if layout_cache is not None and resolved_pdf_path in layout_cache:
        layout_text = layout_cache[resolved_pdf_path]
    else:
        layout_text = run_pdftotext_layout(resolved_pdf_path)
        if layout_cache is not None:
            layout_cache[resolved_pdf_path] = layout_text

    return extract_slice_bundle_from_layout_text(layout_text, config)


def extract_slice_from_layout_text(layout_text: str, config: SliceConfig) -> TableExtractionResult:
    return extract_slice_bundle_from_layout_text(layout_text, config).detail


def extract_slice_from_pdf(
    pdf_path: Path,
    config: SliceConfig,
    *,
    layout_cache: dict[Path, str] | None = None,
) -> TableExtractionResult:
    return extract_slice_bundle_from_pdf(
        pdf_path,
        config,
        layout_cache=layout_cache,
    ).detail


def write_budget_csv(output_dir: Path, rows: list[dict[str, Any]]) -> Path:
    output_dir.mkdir(parents=True, exist_ok=True)
    return write_family_csv(output_dir, BUDGET_FAMILY, rows)


def write_synteza_csv(output_dir: Path, rows: list[dict[str, Any]]) -> Path:
    output_dir.mkdir(parents=True, exist_ok=True)
    output_path = output_dir / SYNTEZA_FILENAME
    with output_path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(
            handle,
            fieldnames=FAMILY_FIELDNAMES[BUDGET_FAMILY],
            delimiter=";",
            extrasaction="ignore",
            lineterminator="\n",
        )
        writer.writeheader()
        for row in rows:
            writer.writerow(row)
    return output_path


def read_budget_csv(csv_path: Path) -> tuple[list[str], list[dict[str, str]]]:
    with csv_path.open(encoding="utf-8", newline="") as handle:
        reader = csv.DictReader(handle, delimiter=";")
        if reader.fieldnames is None:
            raise ValueError(f"Missing header row in {csv_path}")
        return list(reader.fieldnames), [dict(row) for row in reader]


def _validate_table_csv(
    *,
    csv_path: Path,
    expected_pages: set[int],
    expected_section: str,
    expected_table_type: str,
    extraction_warnings: list[str],
) -> tuple[list[str], ValidationSummary]:
    fieldnames, rows = read_budget_csv(csv_path)
    expected_fieldnames = FAMILY_FIELDNAMES[BUDGET_FAMILY]
    if fieldnames != expected_fieldnames:
        raise ValueError(
            f"Header mismatch in {csv_path}. Expected {expected_fieldnames}, got {fieldnames}"
        )

    warnings = list(extraction_warnings)
    if not rows:
        warnings.append(f"{csv_path.name} is empty")

    for row in rows:
        try:
            source_page = int(row["source_page"])
        except ValueError:
            warnings.append(f"invalid source_page value in {csv_path.name}: {row['source_page']!r}")
            continue
        if source_page not in expected_pages:
            warnings.append(
                f"{csv_path.name}: row page {source_page} is outside {sorted(expected_pages)}"
            )
        if row["family"] != BUDGET_FAMILY:
            warnings.append(f"{csv_path.name}: unexpected family value {row['family']!r}")
        if row["section"] != expected_section:
            warnings.append(f"{csv_path.name}: unexpected section on page {source_page}: {row['section']!r}")
        if row["table_type"] != expected_table_type:
            warnings.append(
                f"{csv_path.name}: unexpected table_type on page {source_page}: {row['table_type']!r}"
            )

    rollups = validate_budget_indicator_rows(rows) if rows else ValidationSummary(
        functional_checks=0,
        economic_checks=0,
        mismatches=[],
    )
    return sorted(set(warnings)), rollups


def validate_synteza_consistency(
    *,
    detail_rows: list[dict[str, str]],
    synteza_rows: list[dict[str, str]],
) -> ConsistencyValidationSummary:
    detail_index = {
        (row["credit_type"], row["functional"], row["economic"]): row
        for row in detail_rows
    }
    mismatches: list[ConsistencyMismatch] = []
    compared_rows = 0

    for synteza_row in synteza_rows:
        key = (
            synteza_row["credit_type"],
            synteza_row["functional"],
            synteza_row["economic"],
        )
        detail_row = detail_index.get(key)
        if detail_row is None:
            continue
        compared_rows += 1
        for column in ADDITIVE_VALIDATION_COLUMNS:
            if synteza_row.get(column, "").strip() == detail_row.get(column, "").strip():
                continue
            mismatches.append(
                ConsistencyMismatch(
                    credit_type=synteza_row["credit_type"],
                    functional=synteza_row["functional"],
                    economic=synteza_row["economic"],
                    column=column,
                    synteza_value=synteza_row.get(column, ""),
                    detail_value=detail_row.get(column, ""),
                    description=synteza_row["description"],
                )
            )

    return ConsistencyValidationSummary(compared_rows=compared_rows, mismatches=mismatches)


def validate_slice_outputs(
    *,
    detail_csv_path: Path,
    synteza_csv_path: Path,
    config: SliceConfig,
    detail_extraction_warnings: list[str],
    synteza_extraction_warnings: list[str],
) -> SliceValidationResult:
    detail_warnings, detail_rollups = _validate_table_csv(
        csv_path=detail_csv_path,
        expected_pages=set(config.expected_detail_pages),
        expected_section=config.detail_section,
        expected_table_type=config.detail_table_type,
        extraction_warnings=detail_extraction_warnings,
    )
    synteza_warnings, synteza_rollups = _validate_table_csv(
        csv_path=synteza_csv_path,
        expected_pages=set(config.expected_synteza_pages),
        expected_section=config.synteza_section,
        expected_table_type="Sinteza",
        extraction_warnings=synteza_extraction_warnings,
    )

    _detail_header, detail_rows = read_budget_csv(detail_csv_path)
    _synteza_header, synteza_rows = read_budget_csv(synteza_csv_path)
    consistency = validate_synteza_consistency(
        detail_rows=detail_rows,
        synteza_rows=synteza_rows,
    )

    return SliceValidationResult(
        structural=StructuralValidationSummary(
            warnings=sorted(set([*detail_warnings, *synteza_warnings])),
        ),
        detail_rollups=detail_rollups,
        synteza_rollups=synteza_rollups,
        consistency=consistency,
    )


def serialize_validation_result(validation: SliceValidationResult) -> dict[str, Any]:
    return {
        "status": validation.status,
        "structural_warnings": validation.structural.warnings,
        "detail_rollups": {
            "functional_checks": validation.detail_rollups.functional_checks,
            "economic_checks": validation.detail_rollups.economic_checks,
            "mismatch_count": len(validation.detail_rollups.mismatches),
            "mismatches": [
                serialize_rollup_mismatch(mismatch)
                for mismatch in validation.detail_rollups.mismatches
            ],
        },
        "synteza_rollups": {
            "functional_checks": validation.synteza_rollups.functional_checks,
            "economic_checks": validation.synteza_rollups.economic_checks,
            "mismatch_count": len(validation.synteza_rollups.mismatches),
            "mismatches": [
                serialize_rollup_mismatch(mismatch)
                for mismatch in validation.synteza_rollups.mismatches
            ],
        },
        "consistency": {
            "compared_rows": validation.consistency.compared_rows,
            "mismatch_count": len(validation.consistency.mismatches),
            "mismatches": [
                serialize_consistency_mismatch(mismatch)
                for mismatch in validation.consistency.mismatches
            ],
        },
    }


def build_validation_markdown(
    summary: dict[str, Any],
    *,
    preview_limit: int,
) -> str:
    lines = [
        f"# Validation Report: {summary['slice_id']}",
        "",
        "## Overview",
        "",
        f"- Status: `{summary['status']}`",
        f"- Interpretation: `{summary['interpretation']}`",
        f"- Source PDF: `{summary['source_pdf_path']}`",
        f"- Output folder: `{summary['output_dir']}`",
        f"- Detailed page range: `{summary['detail_page_range']}`",
        f"- Sinteza page range: `{summary['synteza_page_range']}`",
        f"- Detailed section: `{summary['detail_section']}`",
        f"- Detailed table type: `{summary['detail_table_type']}`",
        "",
        "## Extraction",
        "",
        f"- Extraction status: `{summary['extraction']['status']}`",
        f"- Detailed row count: `{summary['detail_row_count']}`",
        f"- Sinteza row count: `{summary['synteza_row_count']}`",
        f"- Detailed corrected cells: `{summary['detail_corrected_cells']}`",
        f"- Sinteza corrected cells: `{summary['synteza_corrected_cells']}`",
        f"- Manual sync cells: `{summary['manual_sync_cells']}`",
    ]

    extraction_note = summary["extraction"].get("note")
    if extraction_note:
        lines.append(f"- Note: {extraction_note}")

    validation = summary["validation"]
    lines.extend(["", "## Validation", "", f"- Validation status: `{validation['status']}`"])
    lines.append(
        f"- Detailed functional checks: `{validation['detail_rollups']['functional_checks']}`"
    )
    lines.append(
        f"- Detailed economic checks: `{validation['detail_rollups']['economic_checks']}`"
    )
    lines.append(
        f"- Detailed mismatch count: `{validation['detail_rollups']['mismatch_count']}`"
    )
    lines.append(
        f"- Sinteza functional checks: `{validation['synteza_rollups']['functional_checks']}`"
    )
    lines.append(
        f"- Sinteza economic checks: `{validation['synteza_rollups']['economic_checks']}`"
    )
    lines.append(
        f"- Sinteza mismatch count: `{validation['synteza_rollups']['mismatch_count']}`"
    )
    lines.append(
        f"- Synteza/detail compared rows: `{validation['consistency']['compared_rows']}`"
    )
    lines.append(
        f"- Synteza/detail mismatch count: `{validation['consistency']['mismatch_count']}`"
    )

    if validation["structural_warnings"]:
        lines.extend(["", "### Structural Warnings", ""])
        for warning in validation["structural_warnings"]:
            lines.append(f"- {warning}")

    if validation["detail_rollups"]["mismatches"]:
        lines.extend(["", "### Detailed Rollup Warnings", ""])
        for mismatch in validation["detail_rollups"]["mismatches"][:preview_limit]:
            lines.append(
                "- "
                f"hierarchy=`{mismatch['hierarchy']}` "
                f"fixed_key=`{mismatch['fixed_key']}` "
                f"parent_key=`{mismatch['parent_key']}` "
                f"column=`{mismatch['column']}` "
                f"actual=`{mismatch['actual']}` "
                f"expected=`{mismatch['expected']}`"
            )

    if validation["synteza_rollups"]["mismatches"]:
        lines.extend(["", "### Sinteza Rollup Warnings", ""])
        for mismatch in validation["synteza_rollups"]["mismatches"][:preview_limit]:
            lines.append(
                "- "
                f"hierarchy=`{mismatch['hierarchy']}` "
                f"fixed_key=`{mismatch['fixed_key']}` "
                f"parent_key=`{mismatch['parent_key']}` "
                f"column=`{mismatch['column']}` "
                f"actual=`{mismatch['actual']}` "
                f"expected=`{mismatch['expected']}`"
            )

    if validation["consistency"]["mismatches"]:
        lines.extend(["", "### Synteza vs Detailed Warnings", ""])
        for mismatch in validation["consistency"]["mismatches"][:preview_limit]:
            lines.append(
                "- "
                f"credit_type=`{mismatch['credit_type']}` "
                f"functional=`{mismatch['functional']}` "
                f"economic=`{mismatch['economic']}` "
                f"column=`{mismatch['column']}` "
                f"synteza=`{mismatch['synteza_value']}` "
                f"detail=`{mismatch['detail_value']}`"
            )
        if len(validation["consistency"]["mismatches"]) > preview_limit:
            lines.append(
                f"- Truncated preview: showing {preview_limit} of {len(validation['consistency']['mismatches'])} mismatches."
            )

    return "\n".join(lines) + "\n"


def process_slice(
    *,
    config: SliceConfig,
    input_dir: Path,
    output_root: Path,
    layout_cache: dict[Path, str] | None = None,
    preview_limit: int,
) -> dict[str, Any]:
    source_pdf_path = (input_dir / config.source_pdf_name).resolve()
    output_dir = (output_root / config.slice_id).resolve()
    shutil.rmtree(output_dir, ignore_errors=True)
    output_dir.mkdir(parents=True, exist_ok=True)

    summary: dict[str, Any] = {
        "slice_id": config.slice_id,
        "source_pdf_name": config.source_pdf_name,
        "source_pdf_path": str(source_pdf_path),
        "detail_page_range": f"{config.detail_page_start}-{config.detail_page_end}",
        "synteza_page_range": f"{config.synteza_page_start}-{config.synteza_page_end}",
        "detail_section": config.detail_section,
        "detail_table_type": config.detail_table_type,
        "output_dir": str(output_dir),
        "detail_output_file": BUDGET_FILENAME,
        "synteza_output_file": SYNTEZA_FILENAME,
        "detail_row_count": 0,
        "synteza_row_count": 0,
        "detail_corrected_cells": 0,
        "synteza_corrected_cells": 0,
        "manual_sync_cells": 0,
        "status": "failure",
        "interpretation": "not acceptable",
        "extraction": {"status": "failure"},
        "validation": {
            "status": "failure",
            "structural_warnings": [],
            "detail_rollups": {
                "functional_checks": 0,
                "economic_checks": 0,
                "mismatch_count": 0,
                "mismatches": [],
            },
            "synteza_rollups": {
                "functional_checks": 0,
                "economic_checks": 0,
                "mismatch_count": 0,
                "mismatches": [],
            },
            "consistency": {
                "compared_rows": 0,
                "mismatch_count": 0,
                "mismatches": [],
            },
        },
    }

    try:
        extraction = extract_slice_bundle_from_pdf(
            source_pdf_path,
            config,
            layout_cache=layout_cache,
        )
        detail_csv_path = write_budget_csv(output_dir, extraction.detail.rows)
        synteza_csv_path = write_synteza_csv(output_dir, extraction.synteza.rows)
        validation = validate_slice_outputs(
            detail_csv_path=detail_csv_path,
            synteza_csv_path=synteza_csv_path,
            config=config,
            detail_extraction_warnings=extraction.detail.warnings,
            synteza_extraction_warnings=extraction.synteza.warnings,
        )
        serialized_validation = serialize_validation_result(validation)
        status = validation.status
        interpretation = (
            "acceptable" if status == "success" else "acceptable with warnings"
        )

        summary.update(
            {
                "detail_row_count": len(extraction.detail.rows),
                "synteza_row_count": len(extraction.synteza.rows),
                "detail_corrected_cells": extraction.detail.corrected_cells,
                "synteza_corrected_cells": extraction.synteza.corrected_cells,
                "manual_sync_cells": extraction.manual_sync_cells,
                "status": status,
                "interpretation": interpretation,
                "extraction": {
                    "status": "success",
                    "detail_pages": extraction.detail.source_pages,
                    "synteza_pages": extraction.synteza.source_pages,
                },
                "validation": serialized_validation,
            }
        )
    except (FileNotFoundError, RuntimeError, ValueError) as error:
        summary["extraction"]["note"] = str(error)

    write_json(output_dir / "run-summary.json", summary)
    (output_dir / "validation.md").write_text(
        build_validation_markdown(summary, preview_limit=preview_limit),
        encoding="utf-8",
    )
    return summary


def merge_successful_slices(
    summaries: list[dict[str, Any]],
    *,
    output_path: Path,
) -> dict[str, int]:
    merged_rows: list[dict[str, str]] = []
    base_header = FAMILY_FIELDNAMES[BUDGET_FAMILY]

    for summary in summaries:
        if summary["status"] == "failure":
            continue
        csv_path = Path(summary["output_dir"]) / BUDGET_FILENAME
        fieldnames, rows = read_budget_csv(csv_path)
        if fieldnames != base_header:
            raise ValueError(
                f"Header mismatch in {csv_path}. Expected {base_header}, got {fieldnames}"
            )
        for row in rows:
            merged_rows.append({MERGED_SLICE_COLUMN: summary["slice_id"], **row})

    output_path.parent.mkdir(parents=True, exist_ok=True)
    with output_path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(
            handle,
            fieldnames=[MERGED_SLICE_COLUMN, *base_header],
            delimiter=";",
            lineterminator="\n",
            extrasaction="ignore",
        )
        writer.writeheader()
        for row in merged_rows:
            writer.writerow(row)

    return {
        "included_slices": sum(1 for summary in summaries if summary["status"] != "failure"),
        "warning_slices": sum(1 for summary in summaries if summary["status"] == "warning"),
        "merged_rows": len(merged_rows),
    }
