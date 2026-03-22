#!/usr/bin/env python3

from __future__ import annotations

import argparse
import csv
import sys
from decimal import Decimal, InvalidOperation
from datetime import UTC, datetime
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile
from xml.sax.saxutils import escape

try:
    from scripts.extract_pdf_tables import NUMERIC_VALUE_COLUMNS
except ModuleNotFoundError:
    from extract_pdf_tables import NUMERIC_VALUE_COLUMNS

DEFAULT_SHEET_ORDER = [
    "policy_program_summary.csv",
    "budget_indicator_summary.csv",
    "project_sheet_financing.csv",
    "program_financing_summary.csv",
    "program_budget_financing.csv",
    "public_investments.csv",
]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Convert extracted CSV tables into a single XLSX workbook")
    parser.add_argument("--input-dir", required=True, help="Directory containing semicolon-delimited CSV files")
    parser.add_argument("--output", required=True, help="Path to the output .xlsx file")
    return parser.parse_args()


def list_csv_files(input_dir: Path) -> list[Path]:
    csv_files = {path.name: path for path in input_dir.glob("*.csv")}
    ordered = [csv_files[name] for name in DEFAULT_SHEET_ORDER if name in csv_files]
    remaining = sorted(path for name, path in csv_files.items() if name not in DEFAULT_SHEET_ORDER)
    return [*ordered, *remaining]


def sanitize_sheet_name(name: str, used_names: set[str]) -> str:
    sanitized = name.replace(".csv", "")
    for character in "[]:*?/\\":  # Excel invalid sheet characters.
        sanitized = sanitized.replace(character, "_")
    sanitized = sanitized[:31] or "Sheet"
    candidate = sanitized
    suffix = 1
    while candidate in used_names:
        suffix_text = f"_{suffix}"
        candidate = f"{sanitized[: 31 - len(suffix_text)]}{suffix_text}"
        suffix += 1
    used_names.add(candidate)
    return candidate


def read_csv_rows(csv_path: Path) -> list[list[str]]:
    with csv_path.open(encoding="utf-8", newline="") as handle:
        reader = csv.reader(handle, delimiter=";")
        return [list(row) for row in reader]


def excel_column_name(index: int) -> str:
    result = ""
    current = index
    while current > 0:
        current, remainder = divmod(current - 1, 26)
        result = chr(65 + remainder) + result
    return result


def is_numeric_string(value: str) -> bool:
    if value == "":
        return False
    try:
        Decimal(value)
    except InvalidOperation:
        return False
    return True


def build_cell(
    cell_reference: str,
    value: str,
    style_index: int | None = None,
    *,
    numeric: bool = False,
) -> str:
    style_attribute = f' s="{style_index}"' if style_index is not None else ""
    if numeric:
        return f'<c r="{cell_reference}"{style_attribute}><v>{escape(value)}</v></c>'
    return (
        f'<c r="{cell_reference}" t="inlineStr"{style_attribute}>'
        f"<is><t>{escape(value)}</t></is>"
        "</c>"
    )


def build_worksheet_xml(rows: list[list[str]]) -> str:
    if not rows:
        rows = [[""]]
    max_columns = max(len(row) for row in rows)
    last_cell = f"{excel_column_name(max_columns)}{len(rows)}"
    header = rows[0]
    numeric_columns = {
        index
        for index, column_name in enumerate(header, start=1)
        if column_name in NUMERIC_VALUE_COLUMNS
    }
    row_xml_parts: list[str] = []
    for row_index, row in enumerate(rows, start=1):
        cell_xml = []
        for column_index, value in enumerate(row, start=1):
            cell_reference = f"{excel_column_name(column_index)}{row_index}"
            style_index = 1 if row_index == 1 else None
            numeric = row_index > 1 and column_index in numeric_columns and is_numeric_string(value)
            cell_xml.append(build_cell(cell_reference, value, style_index, numeric=numeric))
        row_xml_parts.append(f'<row r="{row_index}">{"".join(cell_xml)}</row>')

    return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
        f'<dimension ref="A1:{last_cell}"/>'
        "<sheetViews><sheetView workbookViewId=\"0\">"
        "<pane ySplit=\"1\" topLeftCell=\"A2\" activePane=\"bottomLeft\" state=\"frozen\"/>"
        "</sheetView></sheetViews>"
        "<sheetFormatPr defaultRowHeight=\"15\"/>"
        f"<sheetData>{''.join(row_xml_parts)}</sheetData>"
        f'<autoFilter ref="A1:{last_cell}"/>'
        "</worksheet>"
    )


def build_content_types_xml(sheet_count: int) -> str:
    overrides = "".join(
        f'<Override PartName="/xl/worksheets/sheet{index}.xml" '
        'ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
        for index in range(1, sheet_count + 1)
    )
    return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        '<Default Extension="xml" ContentType="application/xml"/>'
        '<Override PartName="/xl/workbook.xml" '
        'ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
        '<Override PartName="/xl/styles.xml" '
        'ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
        '<Override PartName="/docProps/core.xml" '
        'ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>'
        '<Override PartName="/docProps/app.xml" '
        'ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>'
        f"{overrides}"
        "</Types>"
    )


def build_root_relationships_xml() -> str:
    return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" '
        'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" '
        'Target="xl/workbook.xml"/>'
        '<Relationship Id="rId2" '
        'Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" '
        'Target="docProps/core.xml"/>'
        '<Relationship Id="rId3" '
        'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" '
        'Target="docProps/app.xml"/>'
        "</Relationships>"
    )


def build_workbook_xml(sheet_names: list[str]) -> str:
    sheets_xml = "".join(
        f'<sheet name="{escape(sheet_name)}" sheetId="{index}" r:id="rId{index}"/>'
        for index, sheet_name in enumerate(sheet_names, start=1)
    )
    return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
        f"<sheets>{sheets_xml}</sheets>"
        "</workbook>"
    )


def build_workbook_relationships_xml(sheet_count: int) -> str:
    sheet_relationships = "".join(
        f'<Relationship Id="rId{index}" '
        'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" '
        f'Target="worksheets/sheet{index}.xml"/>'
        for index in range(1, sheet_count + 1)
    )
    styles_relation = (
        f'<Relationship Id="rId{sheet_count + 1}" '
        'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" '
        'Target="styles.xml"/>'
    )
    return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        f"{sheet_relationships}{styles_relation}"
        "</Relationships>"
    )


def build_styles_xml() -> str:
    return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
        '<fonts count="2">'
        '<font><sz val="11"/><name val="Calibri"/><family val="2"/></font>'
        '<font><b/><sz val="11"/><name val="Calibri"/><family val="2"/></font>'
        "</fonts>"
        '<fills count="2"><fill><patternFill patternType="none"/></fill>'
        '<fill><patternFill patternType="gray125"/></fill></fills>'
        '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>'
        '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
        '<cellXfs count="2">'
        '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
        '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>'
        "</cellXfs>"
        '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>'
        "</styleSheet>"
    )


def build_app_xml(sheet_names: list[str]) -> str:
    heading_pairs = f"<vt:vector size=\"2\" baseType=\"variant\">" \
        "<vt:variant><vt:lpstr>Worksheets</vt:lpstr></vt:variant>" \
        f"<vt:variant><vt:i4>{len(sheet_names)}</vt:i4></vt:variant></vt:vector>"
    titles = "".join(f"<vt:lpstr>{escape(sheet_name)}</vt:lpstr>" for sheet_name in sheet_names)
    return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" '
        'xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">'
        "<Application>Codex</Application>"
        f"<HeadingPairs>{heading_pairs}</HeadingPairs>"
        f'<TitlesOfParts><vt:vector size="{len(sheet_names)}" baseType="lpstr">{titles}</vt:vector></TitlesOfParts>'
        "</Properties>"
    )


def build_core_xml() -> str:
    timestamp = datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" '
        'xmlns:dc="http://purl.org/dc/elements/1.1/" '
        'xmlns:dcterms="http://purl.org/dc/terms/" '
        'xmlns:dcmitype="http://purl.org/dc/dcmitype/" '
        'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">'
        "<dc:title>Academia Romana Extracted Tables</dc:title>"
        "<dc:creator>Codex</dc:creator>"
        "<cp:lastModifiedBy>Codex</cp:lastModifiedBy>"
        f'<dcterms:created xsi:type="dcterms:W3CDTF">{timestamp}</dcterms:created>'
        f'<dcterms:modified xsi:type="dcterms:W3CDTF">{timestamp}</dcterms:modified>'
        "</cp:coreProperties>"
    )


def write_workbook(csv_files: list[Path], output_path: Path) -> None:
    if not csv_files:
        raise ValueError(f"No CSV files found in {output_path.parent}")

    output_path.parent.mkdir(parents=True, exist_ok=True)
    used_sheet_names: set[str] = set()
    sheets = []
    for csv_path in csv_files:
        sheet_name = sanitize_sheet_name(csv_path.name, used_sheet_names)
        rows = read_csv_rows(csv_path)
        sheets.append((sheet_name, rows))

    with ZipFile(output_path, "w", compression=ZIP_DEFLATED) as workbook:
        workbook.writestr("[Content_Types].xml", build_content_types_xml(len(sheets)))
        workbook.writestr("_rels/.rels", build_root_relationships_xml())
        workbook.writestr("xl/workbook.xml", build_workbook_xml([sheet_name for sheet_name, _rows in sheets]))
        workbook.writestr(
            "xl/_rels/workbook.xml.rels",
            build_workbook_relationships_xml(len(sheets)),
        )
        workbook.writestr("xl/styles.xml", build_styles_xml())
        workbook.writestr("docProps/app.xml", build_app_xml([sheet_name for sheet_name, _rows in sheets]))
        workbook.writestr("docProps/core.xml", build_core_xml())

        for index, (_sheet_name, rows) in enumerate(sheets, start=1):
            workbook.writestr(f"xl/worksheets/sheet{index}.xml", build_worksheet_xml(rows))


def main() -> int:
    args = parse_args()
    input_dir = Path(args.input_dir).expanduser().resolve()
    output_path = Path(args.output).expanduser().resolve()

    if not input_dir.exists():
        print(f"Input directory does not exist: {input_dir}", file=sys.stderr)
        return 1

    csv_files = list_csv_files(input_dir)
    if not csv_files:
        print(f"No CSV files found in {input_dir}", file=sys.stderr)
        return 1

    write_workbook(csv_files, output_path)
    print(f"Wrote {output_path} with {len(csv_files)} sheets")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
