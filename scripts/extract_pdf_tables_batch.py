#!/usr/bin/env python3

from __future__ import annotations

import argparse
import json
import re
import shutil
import sys
from pathlib import Path
from typing import Any, Callable

try:
    from scripts.csvs_to_xlsx import list_csv_files, write_workbook
    from scripts.extract_pdf_tables import EXPECTED_FAMILY_ORDER, extract_pdf_to_dir
    from scripts.validate_budget_indicator_consistency import (
        ConsistencyValidationSummary,
        validate_budget_indicator_consistency_csv,
    )
    from scripts.validate_pdf_totals import ValidationSummary, validate_budget_indicator_csv
except ModuleNotFoundError:
    from csvs_to_xlsx import list_csv_files, write_workbook
    from extract_pdf_tables import EXPECTED_FAMILY_ORDER, extract_pdf_to_dir
    from validate_budget_indicator_consistency import (
        ConsistencyValidationSummary,
        validate_budget_indicator_consistency_csv,
    )
    from validate_pdf_totals import ValidationSummary, validate_budget_indicator_csv

DEFAULT_SOURCE_DIR = "/Users/claudiuconstantinbogdan/Downloads/Anexa_3"
DEFAULT_OUTPUT_ROOT = (
    "/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/"
    "scripts/output/anexa-3-batch"
)
VALIDATION_PREVIEW_LIMIT = 25


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Batch extract, validate, and package PDF tables for all PDFs in Anexa_3",
    )
    parser.add_argument(
        "--source-dir",
        default=DEFAULT_SOURCE_DIR,
        help="Directory containing source PDFs",
    )
    parser.add_argument(
        "--output-root",
        default=DEFAULT_OUTPUT_ROOT,
        help="Workspace-local output directory for staged PDFs and extraction results",
    )
    parser.add_argument(
        "--preview-limit",
        default=VALIDATION_PREVIEW_LIMIT,
        type=int,
        help="Maximum number of validation mismatches to include in markdown reports",
    )
    return parser.parse_args(argv)


def sanitize_document_id(name: str) -> str:
    sanitized = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
    return sanitized or "document"


def uniquify_document_id(base: str, used_ids: set[str]) -> str:
    candidate = base
    suffix = 2
    while candidate in used_ids:
        candidate = f"{base}-{suffix}"
        suffix += 1
    used_ids.add(candidate)
    return candidate


def stage_pdf_inputs(source_dir: Path, staged_root: Path) -> list[Path]:
    if not source_dir.exists():
        raise FileNotFoundError(f"Source directory does not exist: {source_dir}")

    shutil.rmtree(staged_root, ignore_errors=True)
    staged_root.mkdir(parents=True, exist_ok=True)

    staged_paths: list[Path] = []
    for source_path in sorted(source_dir.rglob("*")):
        if not source_path.is_file() or source_path.suffix.lower() != ".pdf":
            continue
        relative_path = source_path.relative_to(source_dir)
        staged_path = staged_root / relative_path
        staged_path.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source_path, staged_path)
        staged_paths.append(staged_path)
    return staged_paths


def serialize_validation_summary(summary: ValidationSummary) -> dict[str, Any]:
    return {
        "functional_checks": summary.functional_checks,
        "economic_checks": summary.economic_checks,
        "mismatch_count": len(summary.mismatches),
        "mismatches": [
            {
                "hierarchy": mismatch.hierarchy,
                "section": mismatch.section,
                "credit_type": mismatch.credit_type,
                "fixed_key": mismatch.fixed_key,
                "parent_key": mismatch.parent_key,
                "column": mismatch.column,
                "actual": format(mismatch.actual, "f"),
                "expected": format(mismatch.expected, "f"),
            }
            for mismatch in summary.mismatches
        ],
    }


def serialize_consistency_validation_summary(
    summary: ConsistencyValidationSummary,
) -> dict[str, Any]:
    return {
        "top_total_checks": summary.top_total_checks,
        "chapter_checks": summary.chapter_checks,
        "main_group_checks": summary.main_group_checks,
        "mismatch_count": len(summary.mismatches),
        "mismatches": [
            {
                "level": mismatch.level,
                "entity": mismatch.entity,
                "credit_type": mismatch.credit_type,
                "detail_table_type": mismatch.detail_table_type,
                "functional": mismatch.functional,
                "economic": mismatch.economic,
                "code": mismatch.code,
                "column": mismatch.column,
                "sinteza_value": mismatch.sinteza_value,
                "detail_value": mismatch.detail_value,
                "sinteza_section": mismatch.sinteza_section,
                "detail_section": mismatch.detail_section,
                "description": mismatch.description,
            }
            for mismatch in summary.mismatches
        ],
    }


def build_validation_markdown(document_summary: dict[str, Any], *, preview_limit: int) -> str:
    lines = [
        f"# Validation Report: {document_summary['source_pdf_name']}",
        "",
        "## Overview",
        "",
        f"- Status: `{document_summary['status']}`",
        f"- Interpretation: `{document_summary['interpretation']}`",
        f"- Source PDF: `{document_summary['source_pdf_path']}`",
        f"- Output folder: `{document_summary['output_dir']}`",
        "",
        "## Extraction",
        "",
        f"- Extraction status: `{document_summary['extraction']['status']}`",
    ]

    extraction_note = document_summary["extraction"].get("note")
    if extraction_note:
        lines.append(f"- Note: {extraction_note}")

    lines.extend(["", "### Detected Families", ""])
    for family in EXPECTED_FAMILY_ORDER:
        family_summary = document_summary["families"].get(family)
        if family_summary is None:
            continue
        lines.append(
            f"- `{family}`: pages={family_summary['pages']} rows={family_summary['row_count']}"
        )

    lines.extend(["", "## Validation", ""])
    validation = document_summary["validation"]
    lines.append(f"- Validation status: `{validation['status']}`")

    validation_note = validation.get("note")
    if validation_note:
        lines.append(f"- Note: {validation_note}")

    if validation.get("summary") is not None:
        summary = validation["summary"]
        lines.extend(
            [
                f"- Functional checks: `{summary['functional_checks']}`",
                f"- Economic checks: `{summary['economic_checks']}`",
                f"- Mismatch count: `{summary['mismatch_count']}`",
            ]
        )

        mismatches = summary["mismatches"]
        if mismatches:
            lines.extend(["", "### Mismatch Preview", ""])
            for mismatch in mismatches[:preview_limit]:
                lines.append(
                    "- "
                    f"hierarchy=`{mismatch['hierarchy']}` "
                    f"section=`{mismatch['section']}` "
                    f"credit_type=`{mismatch['credit_type']}` "
                    f"fixed_key=`{mismatch['fixed_key']}` "
                    f"parent_key=`{mismatch['parent_key']}` "
                    f"column=`{mismatch['column']}` "
                    f"actual=`{mismatch['actual']}` "
                    f"expected=`{mismatch['expected']}`"
                )
            if len(mismatches) > preview_limit:
                lines.append(
                    f"- Truncated preview: showing {preview_limit} of {len(mismatches)} mismatches."
                )

    consistency_validation = document_summary.get("consistency_validation")
    if consistency_validation is not None:
        lines.extend(["", "## Consistency Validation", ""])
        lines.append(f"- Consistency validation status: `{consistency_validation['status']}`")

        consistency_note = consistency_validation.get("note")
        if consistency_note:
            lines.append(f"- Note: {consistency_note}")

        if consistency_validation.get("summary") is not None:
            summary = consistency_validation["summary"]
            lines.extend(
                [
                    f"- Top total checks: `{summary['top_total_checks']}`",
                    f"- Chapter checks: `{summary['chapter_checks']}`",
                    f"- Main-group checks: `{summary['main_group_checks']}`",
                    f"- Mismatch count: `{summary['mismatch_count']}`",
                ]
            )

            mismatches = summary["mismatches"]
            if mismatches:
                lines.extend(["", "### Consistency Mismatch Preview", ""])
                for mismatch in mismatches[:preview_limit]:
                    lines.append(
                        "- "
                        f"level=`{mismatch['level']}` "
                        f"entity=`{mismatch['entity']}` "
                        f"detail_table_type=`{mismatch['detail_table_type']}` "
                        f"credit_type=`{mismatch['credit_type']}` "
                        f"functional=`{mismatch['functional']}` "
                        f"economic=`{mismatch['economic']}` "
                        f"code=`{mismatch['code']}` "
                        f"column=`{mismatch['column']}` "
                        f"sinteza=`{mismatch['sinteza_value']}` "
                        f"detail=`{mismatch['detail_value']}`"
                    )
                if len(mismatches) > preview_limit:
                    lines.append(
                        f"- Truncated preview: showing {preview_limit} of {len(mismatches)} consistency mismatches."
                    )

    return "\n".join(lines) + "\n"


def build_batch_summary_markdown(
    batch_summary: list[dict[str, Any]],
    *,
    output_root: Path,
) -> str:
    success_count = sum(1 for item in batch_summary if item["status"] == "success")
    warning_count = sum(1 for item in batch_summary if item["status"] == "warning")
    failure_count = sum(1 for item in batch_summary if item["status"] == "failure")

    lines = [
        "# Anexa 3 Batch Extraction Summary",
        "",
        "## Totals",
        "",
        f"- Documents processed: `{len(batch_summary)}`",
        f"- Success: `{success_count}`",
        f"- Warning: `{warning_count}`",
        f"- Failure: `{failure_count}`",
        "",
        "## Documents",
        "",
    ]

    for item in batch_summary:
        document_dir = Path(item["output_dir"])
        validation_report = document_dir / "validation.md"
        relative_validation = validation_report.relative_to(output_root)
        note = item.get("summary_note") or item["interpretation"]
        lines.append(
            f"- `{item['document_id']}`: `{item['status']}` "
            f"([report](./{relative_validation.as_posix()})) "
            f"- {note}"
        )

    return "\n".join(lines) + "\n"


def default_extractor(input_path: Path, output_dir: Path) -> dict[str, Any]:
    return extract_pdf_to_dir(input_path, output_dir, strict_expected_families=False)


def default_xlsx_writer(input_dir: Path, output_path: Path) -> None:
    csv_files = list_csv_files(input_dir)
    if not csv_files:
        raise ValueError(f"No CSV files found in {input_dir}")
    write_workbook(csv_files, output_path)


def default_validator(csv_path: Path) -> ValidationSummary:
    return validate_budget_indicator_csv(csv_path)


def default_consistency_validator(csv_path: Path) -> ConsistencyValidationSummary:
    return validate_budget_indicator_consistency_csv(csv_path)


def process_pdf_document(
    staged_pdf: Path,
    document_dir: Path,
    *,
    extractor: Callable[[Path, Path], dict[str, Any]],
    xlsx_writer: Callable[[Path, Path], None],
    validator: Callable[[Path], ValidationSummary],
    consistency_validator: Callable[[Path], ConsistencyValidationSummary] | None = None,
    preview_limit: int,
) -> dict[str, Any]:
    shutil.rmtree(document_dir, ignore_errors=True)
    document_dir.mkdir(parents=True, exist_ok=True)

    source_copy = document_dir / "source.pdf"
    shutil.copy2(staged_pdf, source_copy)

    document_summary: dict[str, Any] = {
        "document_id": document_dir.name,
        "source_pdf_name": staged_pdf.name,
        "source_pdf_path": str(staged_pdf),
        "output_dir": str(document_dir),
        "status": "failure",
        "interpretation": "not acceptable",
        "summary_note": "",
        "families": {},
        "extraction": {"status": "failure"},
        "validation": {"status": "not_run"},
        "consistency_validation": {"status": "not_run"},
        "xlsx": {"status": "not_run"},
    }

    def write_artifacts() -> None:
        validation_markdown = build_validation_markdown(document_summary, preview_limit=preview_limit)
        (document_dir / "validation.md").write_text(validation_markdown, encoding="utf-8")
        (document_dir / "run-summary.json").write_text(
            json.dumps(document_summary, indent=2, ensure_ascii=False) + "\n",
            encoding="utf-8",
        )

    try:
        extraction = extractor(source_copy, document_dir)
    except Exception as error:  # noqa: BLE001 - batch report should capture extractor failures.
        document_summary["extraction"] = {
            "status": "failure",
            "note": str(error),
        }
        document_summary["summary_note"] = f"Extractor failed: {error}"
        write_artifacts()
        return document_summary

    document_summary["families"] = extraction["summary"]
    zero_row_families = [
        family
        for family, family_summary in extraction["summary"].items()
        if family_summary["row_count"] == 0
    ]

    non_empty_families = [
        family
        for family, family_summary in extraction["summary"].items()
        if family_summary["row_count"] > 0
    ]

    if not non_empty_families:
        document_summary["extraction"] = {
            "status": "failure",
            "note": "No table families produced any rows",
        }
        document_summary["summary_note"] = "Extractor ran but produced no rows"
        write_artifacts()
        return document_summary

    extraction_status = "success"
    extraction_note = ""
    if zero_row_families:
        extraction_note = f"Zero-row families: {', '.join(zero_row_families)}"

    document_summary["extraction"] = {
        "status": extraction_status,
        "note": extraction_note,
    }

    try:
        xlsx_writer(document_dir, document_dir / "tables.xlsx")
        document_summary["xlsx"] = {"status": "success"}
    except Exception as error:  # noqa: BLE001
        document_summary["xlsx"] = {"status": "failure", "note": str(error)}
        document_summary["summary_note"] = f"XLSX generation failed: {error}"
        write_artifacts()
        return document_summary

    budget_csv_summary = extraction["summary"].get("budget_indicator_summary")
    budget_csv_path = document_dir / "budget_indicator_summary.csv"

    if budget_csv_summary is None or budget_csv_summary["row_count"] == 0 or not budget_csv_path.exists():
        document_summary["validation"] = {
            "status": "warning",
            "note": "budget_indicator_summary.csv missing or empty; validation skipped",
            "summary": None,
        }
        document_summary["consistency_validation"] = {
            "status": "warning",
            "note": "budget_indicator_summary.csv missing or empty; consistency validation skipped",
            "summary": None,
        }
        document_summary["status"] = "warning"
        document_summary["interpretation"] = "acceptable"
        document_summary["summary_note"] = "Extraction completed, but validation input was missing or empty"
    else:
        try:
            validation_summary = validator(budget_csv_path)
        except Exception as error:  # noqa: BLE001
            document_summary["validation"] = {
                "status": "failure",
                "note": str(error),
                "summary": None,
            }
            document_summary["summary_note"] = f"Validator crashed: {error}"
            write_artifacts()
            return document_summary

        validation_data = serialize_validation_summary(validation_summary)
        consistency_summary = None
        consistency_data = None
        consistency_mismatch_count = 0
        if consistency_validator is not None:
            try:
                consistency_summary = consistency_validator(budget_csv_path)
            except Exception as error:  # noqa: BLE001
                document_summary["consistency_validation"] = {
                    "status": "failure",
                    "note": str(error),
                    "summary": None,
                }
                document_summary["summary_note"] = f"Consistency validator crashed: {error}"
                write_artifacts()
                return document_summary
            consistency_data = serialize_consistency_validation_summary(consistency_summary)
            consistency_mismatch_count = len(consistency_summary.mismatches)
            document_summary["consistency_validation"] = {
                "status": "warning" if consistency_mismatch_count else "success",
                "note": (
                    f"{consistency_mismatch_count} consistency mismatches detected"
                    if consistency_mismatch_count
                    else "All checked Sinteza/detail totals matched"
                ),
                "summary": consistency_data,
            }

        validation_mismatch_count = len(validation_summary.mismatches)
        if validation_mismatch_count or consistency_mismatch_count:
            notes: list[str] = []
            if validation_mismatch_count:
                notes.append(f"{validation_mismatch_count} rollup mismatches")
            if consistency_mismatch_count:
                notes.append(f"{consistency_mismatch_count} consistency mismatches")
            document_summary["validation"] = {
                "status": "warning",
                "note": f"{validation_mismatch_count} mismatches detected",
                "summary": validation_data,
            }
            document_summary["status"] = "warning"
            document_summary["interpretation"] = "acceptable"
            document_summary["summary_note"] = f"Extraction completed with {', '.join(notes)}"
        else:
            document_summary["validation"] = {
                "status": "success",
                "note": "All checked rollups matched",
                "summary": validation_data,
            }
            if consistency_validator is None:
                document_summary["consistency_validation"] = {
                    "status": "not_run",
                    "note": "Consistency validator not configured",
                    "summary": None,
                }
            document_summary["status"] = "success"
            document_summary["interpretation"] = "acceptable"
            document_summary["summary_note"] = "Extraction and validation succeeded"

    write_artifacts()
    return document_summary


def parse_batch_documents(
    staged_pdfs: list[Path],
    output_root: Path,
    *,
    extractor: Callable[[Path, Path], dict[str, Any]],
    xlsx_writer: Callable[[Path, Path], None],
    validator: Callable[[Path], ValidationSummary],
    consistency_validator: Callable[[Path], ConsistencyValidationSummary] | None = None,
    preview_limit: int,
) -> list[dict[str, Any]]:
    used_ids: set[str] = set()
    document_summaries: list[dict[str, Any]] = []

    for staged_pdf in staged_pdfs:
        base_id = sanitize_document_id(staged_pdf.stem)
        document_id = uniquify_document_id(base_id, used_ids)
        document_dir = output_root / document_id
        document_summary = process_pdf_document(
            staged_pdf,
            document_dir,
            extractor=extractor,
            xlsx_writer=xlsx_writer,
            validator=validator,
            consistency_validator=consistency_validator,
            preview_limit=preview_limit,
        )
        document_summaries.append(document_summary)

    return document_summaries


def main(argv: list[str] | None = None) -> int:
    args = parse_args(sys.argv[1:] if argv is None else argv)
    source_dir = Path(args.source_dir).expanduser().resolve()
    output_root = Path(args.output_root).expanduser().resolve()
    staged_root = output_root / "staged-inputs"

    try:
        staged_pdfs = stage_pdf_inputs(source_dir, staged_root)
    except FileNotFoundError as error:
        print(str(error), file=sys.stderr)
        return 1

    if not staged_pdfs:
        print(f"No PDF files found in {source_dir}", file=sys.stderr)
        return 1

    output_root.mkdir(parents=True, exist_ok=True)
    document_summaries = parse_batch_documents(
        staged_pdfs,
        output_root,
        extractor=default_extractor,
        xlsx_writer=default_xlsx_writer,
        validator=default_validator,
        consistency_validator=default_consistency_validator,
        preview_limit=args.preview_limit,
    )

    batch_summary_path = output_root / "README.md"
    batch_summary_path.write_text(
        build_batch_summary_markdown(document_summaries, output_root=output_root),
        encoding="utf-8",
    )
    (output_root / "batch-summary.json").write_text(
        json.dumps(document_summaries, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )

    success_count = sum(1 for item in document_summaries if item["status"] == "success")
    warning_count = sum(1 for item in document_summaries if item["status"] == "warning")
    failure_count = sum(1 for item in document_summaries if item["status"] == "failure")

    print(
        f"Processed {len(document_summaries)} PDFs: "
        f"{success_count} success, {warning_count} warning, {failure_count} failure"
    )
    print(f"Batch summary written to {batch_summary_path}")

    return 0 if failure_count == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
