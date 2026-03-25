#!/usr/bin/env python3

from __future__ import annotations

import argparse
import csv
import re
import shutil
import subprocess
import sys
from collections import defaultdict
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path
from statistics import median
from typing import Any

NUMERIC_PATTERN = re.compile(r"[+-]?\d[\d.]*(?:,\d+)?")
MULTISPACE_PATTERN = re.compile(r"\s{2,}")

EXPECTED_FAMILY_ORDER = [
    "policy_program_summary",
    "budget_indicator_summary",
    "project_sheet_financing",
    "program_financing_summary",
    "program_budget_financing",
    "public_investments",
]

FAMILY_TO_OUTPUT = {
    "policy_program_summary": "policy_program_summary.csv",
    "budget_indicator_summary": "budget_indicator_summary.csv",
    "project_sheet_financing": "project_sheet_financing.csv",
    "program_financing_summary": "program_financing_summary.csv",
    "program_budget_financing": "program_budget_financing.csv",
    "public_investments": "public_investments.csv",
}

FAMILY_FIELDNAMES = {
    "policy_program_summary": [
        "source_page",
        "family",
        "section",
        "row_code",
        "description",
        "credit_type",
        "executie_pana_2025",
        "propuneri_2026",
        "estimari_2027",
        "estimari_2028",
        "estimari_2029",
    ],
    "budget_indicator_summary": [
        "source_page",
        "family",
        "section",
        "table_type",
        "row_code",
        "capitol",
        "subcapitol",
        "paragraph",
        "grupa_titlu",
        "articol",
        "alineat",
        "functional",
        "economic",
        "description",
        "credit_type",
        "realizari_2024",
        "executie_preliminata_2025",
        "propuneri_2026",
        "crestere_descrestere_2026_2025",
        "estimari_2027",
        "estimari_2028",
        "estimari_2029",
    ],
    "project_sheet_financing": [
        "source_page",
        "family",
        "section",
        "row_code",
        "description",
        "credit_type",
        "program_code",
        "program_title",
        "project_code",
        "project_name",
        "funding_source_code",
        "funding_source_description",
        "valoarea_totala",
        "realizari_pana_in_2023",
        "realizari_2024",
        "executie_preliminata_2025",
        "propuneri_2026",
        "estimari_2027",
        "estimari_2028",
        "estimari_2029",
        "anii_urmatori",
    ],
    "program_financing_summary": [
        "source_page",
        "family",
        "section",
        "row_code",
        "description",
        "credit_type",
        "program_code",
        "program_title",
        "valoarea_totala_programului",
        "realizari_2024_si_ani_anteriori",
        "executie_preliminata_2025",
        "propuneri_2026",
        "estimari_2027",
        "estimari_2028",
        "estimari_2029",
        "estimari_ani_ulteriori",
    ],
    "program_budget_financing": [
        "source_page",
        "family",
        "section",
        "row_code",
        "description",
        "credit_type",
        "program_code",
        "valoarea_totala_programului",
        "realizari_2024_si_ani_anteriori",
        "executie_preliminata_2025",
        "propuneri_2026",
        "estimari_2027",
        "estimari_2028",
        "estimari_2029",
        "estimari_ani_ulteriori",
    ],
    "public_investments": [
        "source_page",
        "family",
        "section",
        "row_code",
        "description",
        "credit_type",
        "total",
        "cheltuieli_efectuate_pana_la_31_12_2024",
        "cheltuieli_preliminate_2025",
        "propuneri_2026",
        "estimari_2027",
        "estimari_2028",
        "estimari_2029",
        "estimari_ani_ulteriori",
    ],
}

POLICY_NUMERIC_COLUMNS = [
    "executie_pana_2025",
    "propuneri_2026",
    "estimari_2027",
    "estimari_2028",
    "estimari_2029",
]
POLICY_NUMERIC_STARTS = [98, 108, 118, 127, 138]

BUDGET_INDICATOR_COLUMNS = [
    "realizari_2024",
    "executie_preliminata_2025",
    "propuneri_2026",
    "crestere_descrestere_2026_2025",
    "estimari_2027",
    "estimari_2028",
    "estimari_2029",
]
BUDGET_INDICATOR_STARTS = [78, 91, 104, 123, 131, 144, 159]
BUDGET_INDICATOR_CODE_COLUMNS = [
    "capitol",
    "subcapitol",
    "paragraph",
    "grupa_titlu",
    "articol",
    "alineat",
]
FUNCTIONAL_CODE_COLUMNS = ["capitol", "subcapitol", "paragraph"]
ECONOMIC_CODE_COLUMNS = ["grupa_titlu", "articol", "alineat"]
BUDGET_INDICATOR_CODE_ZONES = {
    "capitol": (0, 6),
    "subcapitol": (6, 11),
    "paragraph": (11, 17),
    "grupa_titlu": (17, 22),
    "articol": (22, 26),
    "alineat": (26, 30),
}
BUDGET_INDICATOR_DESCRIPTION_START = 30
BUDGET_INDICATOR_TITLE_MARKERS = (
    "SINTEZA",
    "fondurilor alocate",
    "Bugetul pe capitole",
    "BUGETUL",
    "(sume alocate",
    "(sumele alocate",
)
PROJECT_FINANCING_GROUP_CODES = {"56", "58"}
PROJECT_FINANCING_SUBITEM_CODES = {"01", "02", "03"}
PROJECT_FINANCING_SUBITEM_DESCRIPTION_PREFIXES = (
    "finantare nationala",
    "finantarea nationala",
    "finantare externa nerambursabila",
    "finantarea externa nerambursabila",
    "cheltuieli neeligibile",
    "transferuri catre",
    "transferuri din bugetul de stat catre",
    "sume din fondul de modernizare",
    "sume aferente contributiei proprii a beneficiarilor",
)
BUDGET_INDICATOR_CONTINUATION_GROUP_CODES = {"56", "58", "71", "85"}
ACTIVE_FIXE_PARENT_ARTICLE_CODE = "01"
ACTIVE_FIXE_SUBITEM_CODES = {"01", "02", "03", "30"}
ACTIVE_FIXE_SUBITEM_DESCRIPTION_PREFIXES = (
    "constructii",
    "masini",
    "mobilier",
    "alte active fixe",
)
PREVIOUS_PAYMENTS_PARENT_ARTICLE_CODE = "01"
PREVIOUS_PAYMENTS_SUBITEM_CODES = {"03", "04", "05"}
PREVIOUS_PAYMENTS_SUBITEM_DESCRIPTION_PREFIX = (
    "plati efectuate in anii precedenti si recuperate in"
)

NINE_VALUE_COLUMNS = [
    "valoarea_totala",
    "realizari_pana_in_2023",
    "realizari_2024",
    "executie_preliminata_2025",
    "propuneri_2026",
    "estimari_2027",
    "estimari_2028",
    "estimari_2029",
    "anii_urmatori",
]
PROJECT_SHEET_STARTS = [50, 71, 87, 105, 122, 139, 154, 170, 190]

EIGHT_VALUE_COLUMNS = [
    "valoarea_totala_programului",
    "realizari_2024_si_ani_anteriori",
    "executie_preliminata_2025",
    "propuneri_2026",
    "estimari_2027",
    "estimari_2028",
    "estimari_2029",
    "estimari_ani_ulteriori",
]
PROGRAM_FINANCING_STARTS = [77, 98, 116, 132, 152, 167, 182, 199]
PROGRAM_BUDGET_STARTS = [57, 82, 106, 122, 139, 156, 174, 195]

PUBLIC_INVESTMENT_COLUMNS = [
    "total",
    "cheltuieli_efectuate_pana_la_31_12_2024",
    "cheltuieli_preliminate_2025",
    "propuneri_2026",
    "estimari_2027",
    "estimari_2028",
    "estimari_2029",
    "estimari_ani_ulteriori",
]
PUBLIC_INVESTMENT_STARTS = [60, 73, 88, 101, 113, 124, 136, 152]
VALUE_COLUMNS_BY_FAMILY = {
    "policy_program_summary": POLICY_NUMERIC_COLUMNS,
    "budget_indicator_summary": BUDGET_INDICATOR_COLUMNS,
    "project_sheet_financing": NINE_VALUE_COLUMNS,
    "program_financing_summary": EIGHT_VALUE_COLUMNS,
    "program_budget_financing": EIGHT_VALUE_COLUMNS,
    "public_investments": PUBLIC_INVESTMENT_COLUMNS,
}
NUMERIC_VALUE_COLUMNS = {
    column
    for columns in VALUE_COLUMNS_BY_FAMILY.values()
    for column in columns
}
ADDITIVE_VALIDATION_COLUMNS = [
    "realizari_2024",
    "executie_preliminata_2025",
    "propuneri_2026",
    "estimari_2027",
    "estimari_2028",
    "estimari_2029",
]

CREDIT_LABEL_MAP = {
    "I.Credite de angajament": "I.Credite de angajament",
    "II.Credite bugetare": "II.Credite bugetare",
    "I. Credite de angajament": "I. Credite de angajament",
    "II. Credite bugetare": "II. Credite bugetare",
    "I": "I",
    "II": "II",
}

PROGRAM_BUDGET_TARGET_SECTIONS = {
    "SURSE DE FINANTARE ALE PROGRAMULUI",
    "BUGETUL PROGRAMULUI",
}


@dataclass
class PendingRow:
    source_page: int
    credit_type: str
    values: dict[str, str]


@dataclass
class PendingItem:
    source_page: int
    row_code: str = ""
    description_parts: list[str] = field(default_factory=list)
    rows: list[PendingRow] = field(default_factory=list)
    metadata: dict[str, str] = field(default_factory=dict)

    def description(self) -> str:
        return join_parts(self.description_parts)


def normalize_spaces(value: str) -> str:
    return re.sub(r"\s+", " ", value).strip()


def normalize_numeric_value(value: str) -> str:
    stripped = normalize_spaces(value)
    if not stripped:
        return ""
    return stripped.replace(".", "").replace(",", ".")


def join_parts(parts: list[str]) -> str:
    return normalize_spaces(" ".join(part.strip() for part in parts if part.strip()))


def split_multi_space(line: str) -> list[str]:
    stripped = line.strip()
    if not stripped:
        return []
    parts = [part.strip() for part in MULTISPACE_PATTERN.split(stripped) if part.strip()]
    if not parts:
        return []
    leading_pair_match = re.fullmatch(r"(\d{2})\s+(\d{7})", parts[0])
    if leading_pair_match:
        return [leading_pair_match.group(1), leading_pair_match.group(2), *parts[1:]]
    return parts


def _find_description_start(line: str) -> int:
    for i in range(26, min(36, len(line))):
        if line[i].isalpha():
            return i
    return BUDGET_INDICATOR_DESCRIPTION_START


def is_footer_line(line: str) -> bool:
    stripped = line.strip()
    if not stripped:
        return False
    return stripped.startswith("pag.") or stripped.startswith("Pag.")


def is_numeric_only_line(line: str, first_column_start: int) -> bool:
    stripped = line.strip()
    if not stripped:
        return False
    if any(character.isalpha() for character in stripped):
        return False
    return any(match.start() >= first_column_start - 6 for match in NUMERIC_PATTERN.finditer(line))


def map_numeric_columns(
    line: str,
    columns: list[str],
    starts: list[int],
    *,
    tolerance: int = 8,
    ordered: bool = False,
) -> dict[str, str]:
    if ordered:
        return map_numeric_columns_ordered(line, columns, starts, tolerance=tolerance)

    values = {column: "" for column in columns}
    first_start = starts[0]
    for match in NUMERIC_PATTERN.finditer(line):
        start = match.start()
        if start < first_start - tolerance:
            continue
        closest_index = min(range(len(starts)), key=lambda index: abs(starts[index] - start))
        if abs(starts[closest_index] - start) > tolerance:
            continue
        column = columns[closest_index]
        if values[column]:
            continue
        values[column] = normalize_numeric_value(match.group())
    return values


def map_numeric_columns_ordered(
    line: str,
    columns: list[str],
    starts: list[int],
    *,
    tolerance: int,
) -> dict[str, str]:
    values = {column: "" for column in columns}
    first_start = starts[0]
    matches = [
        (match.start(), normalize_numeric_value(match.group()))
        for match in NUMERIC_PATTERN.finditer(line)
        if match.start() >= first_start - tolerance
        and any(abs(start - match.start()) <= tolerance for start in starts)
    ]
    if not matches:
        return values

    impossible = 10**9
    match_count = len(matches)
    column_count = len(columns)
    skip_penalty = 4

    @lru_cache(maxsize=None)
    def best_cost(match_index: int, column_index: int) -> int:
        if match_index == match_count:
            return 0
        if column_index == column_count:
            return impossible

        cost = skip_penalty + best_cost(match_index, column_index + 1)
        distance = abs(starts[column_index] - matches[match_index][0])
        if distance <= tolerance:
            candidate = best_cost(match_index + 1, column_index + 1)
            if candidate != impossible:
                cost = min(cost, distance + candidate)
        return cost

    if best_cost(0, 0) == impossible:
        return map_numeric_columns(line, columns, starts, tolerance=tolerance, ordered=False)

    match_index = 0
    column_index = 0
    while match_index < match_count and column_index < column_count:
        skip_cost = skip_penalty + best_cost(match_index, column_index + 1)
        distance = abs(starts[column_index] - matches[match_index][0])
        take_cost = impossible
        if distance <= tolerance:
            candidate = best_cost(match_index + 1, column_index + 1)
            if candidate != impossible:
                take_cost = distance + candidate
        if take_cost <= skip_cost:
            values[columns[column_index]] = matches[match_index][1]
            match_index += 1
        column_index += 1
    return values


def detect_family(page_text: str) -> str | None:
    if "SINTEZA POLITICILOR SI A PROGRAMELOR BUGETARE FINANTATE PRIN BUGET" in page_text:
        return "policy_program_summary"
    if "Denumire indicator" in page_text:
        return "budget_indicator_summary"
    if "FISA PROIECTULUI" in page_text:
        return "project_sheet_financing"
    if "SINTEZA FINANTARII PROGRAMELOR" in page_text:
        return "program_financing_summary"
    if "FISA PROGRAMULUI BUGETAR" in page_text:
        return "program_budget_financing"
    if "PROGRAMUL DE INVESTITII PUBLICE" in page_text:
        return "public_investments"
    return None


def split_layout_pages(layout_text: str) -> list[tuple[int, str]]:
    pages: list[tuple[int, str]] = []
    for index, page_text in enumerate(layout_text.split("\f"), start=1):
        if not page_text.strip():
            continue
        pages.append((index, page_text))
    return pages


def extract_policy_code(description: str) -> str:
    program_match = re.search(r"Program\s+(\d+)", description)
    if program_match:
        return program_match.group(1)
    if description.lower().startswith("programe bugetare - total"):
        return "TOTAL"
    return ""


def flush_item_rows(
    rows: list[dict[str, Any]],
    *,
    family: str,
    section: str,
    item: PendingItem | None,
    extra: dict[str, str] | None = None,
) -> None:
    if item is None or not item.rows:
        return
    description = item.description()
    base = {
        "source_page": item.source_page,
        "family": family,
        "section": section,
        "row_code": item.row_code,
        "description": description,
    }
    if family == "budget_indicator_summary":
        base["table_type"] = derive_budget_indicator_table_type(section)
    if item.metadata:
        base.update(item.metadata)
    if extra:
        base.update(extra)
    for pending_row in item.rows:
        row = dict(base)
        row["credit_type"] = pending_row.credit_type
        row.update(pending_row.values)
        rows.append(row)


def parse_policy_program_summary(pages: list[tuple[int, str]]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    item: PendingItem | None = None

    def flush() -> None:
        nonlocal item
        if item is None or not item.rows:
            item = PendingItem(source_page=item.source_page) if item else None
            return
        description = item.description()
        row_code = extract_policy_code(description)
        for pending_row in item.rows:
            row = {
                "source_page": item.source_page,
                "family": "policy_program_summary",
                "section": "",
                "row_code": row_code,
                "description": description,
                "credit_type": pending_row.credit_type,
            }
            row.update(pending_row.values)
            rows.append(row)
        item = None

    for page_number, page_text in pages:
        for line in page_text.splitlines():
            stripped = line.strip()
            if (
                not stripped
                or stripped == "ACADEMIA ROMANA"
                or "SINTEZA POLITICILOR" in stripped
                or stripped.startswith("I.Credite de angajament")
                or stripped.startswith("II.Credite bugetare")
                or stripped.startswith("Programe bugetare Cod")
                or stripped.startswith("1")
                or stripped == "-mii lei-"
                or is_footer_line(line)
            ):
                continue
            credit_match: re.Match[str] | None = None
            for candidate in re.finditer(r"(?<!\S)(I|II)\s+", line):
                if candidate.start() >= 85:
                    credit_match = candidate
                    break
            if credit_match:
                if item is not None and item.rows and item.rows[-1].credit_type == "II" and line[: credit_match.start()].strip():
                    flush()
                if item is None:
                    item = PendingItem(source_page=page_number)
                description_fragment = line[: credit_match.start()].strip()
                if description_fragment:
                    item.description_parts.append(description_fragment)
                    if not item.source_page:
                        item.source_page = page_number
                values = map_numeric_columns(line, POLICY_NUMERIC_COLUMNS, POLICY_NUMERIC_STARTS)
                item.rows.append(
                    PendingRow(
                        source_page=page_number,
                        credit_type=credit_match.group(1),
                        values=values,
                    )
                )
                continue
            if item is not None and item.rows and item.rows[-1].credit_type == "II" and stripped.startswith("Program"):
                flush()
            if item is None:
                item = PendingItem(source_page=page_number)
            if not item.source_page:
                item.source_page = page_number
            item.description_parts.append(stripped)
    flush()
    return rows


def parse_budget_indicator_summary(pages: list[tuple[int, str]]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    item: PendingItem | None = None
    functional_state = {column: "" for column in FUNCTIONAL_CODE_COLUMNS}
    economic_state = {column: "" for column in ECONOMIC_CODE_COLUMNS}
    current_table_title = ""
    expected_entity_prefix = ""
    continuation_article_active = False
    skip_foreign_entity = False

    def flush() -> None:
        nonlocal item
        flush_item_rows(
            rows,
            family="budget_indicator_summary",
            section=current_table_title,
            item=item,
        )
        item = None

    for page_number, page_text in pages:
        title_lines = extract_budget_indicator_title_lines(page_text)
        page_entity_prefix = extract_budget_indicator_entity_prefix(title_lines)
        page_has_explicit_title = has_budget_indicator_title_markers(title_lines)
        if page_has_explicit_title and page_entity_prefix:
            if not expected_entity_prefix:
                expected_entity_prefix = page_entity_prefix
                skip_foreign_entity = False
            elif page_entity_prefix == expected_entity_prefix:
                skip_foreign_entity = False
            else:
                if item is not None:
                    flush()
                skip_foreign_entity = True
                continue
        if skip_foreign_entity:
            continue

        page_table_title = extract_budget_indicator_table_title_from_lines(
            title_lines,
            current_table_title,
        )
        page_numeric_starts = extract_budget_indicator_numeric_starts(page_text)
        page_numeric_end_anchors = extract_budget_indicator_numeric_end_anchors(page_text)
        if page_table_title != current_table_title:
            if item is not None:
                flush()
            current_table_title = page_table_title
            functional_state = {column: "" for column in FUNCTIONAL_CODE_COLUMNS}
            economic_state = {column: "" for column in ECONOMIC_CODE_COLUMNS}
            continuation_article_active = False
        for line in page_text.splitlines():
            stripped = line.strip()
            if (
                not stripped
                or stripped == "ACADEMIA ROMANA"
                or "SINTEZA" in stripped
                or "Anexa nr." in stripped
                or stripped.startswith("Capi-")
                or stripped.startswith("tol ")
                or stripped.startswith("tol capi-")
                or stripped.startswith("A")
                or stripped.startswith("B")
                or re.fullmatch(r"[1-7](?:\s+[1-7])*", stripped)
                or is_footer_line(line)
            ):
                continue
            if stripped.startswith("I.Credite de angajament") or stripped.startswith("II.Credite bugetare"):
                if item is None:
                    continue
                values = map_numeric_columns(
                    line,
                    BUDGET_INDICATOR_COLUMNS,
                    page_numeric_starts,
                    tolerance=16,
                    ordered=True,
                )
                values = detect_and_correct_budget_indicator_shift(values)
                values = correct_budget_indicator_sparse_first_value(
                    line,
                    values,
                    page_numeric_end_anchors,
                )
                item.rows.append(
                    PendingRow(
                        source_page=page_number,
                        credit_type=stripped.split("  ", 1)[0].strip(),
                        values=values,
                    )
                )
                continue
            description_fragment = line[_find_description_start(line):].strip()
            detected_codes, promoted_group_to_article, promoted_article_to_alineat = normalize_budget_indicator_codes(
                extract_budget_indicator_codes(line),
                description_fragment,
                economic_state,
                continuation_article_active,
            )
            has_functional_codes = any(detected_codes[column] for column in FUNCTIONAL_CODE_COLUMNS)
            has_economic_codes = any(detected_codes[column] for column in ECONOMIC_CODE_COLUMNS)
            if description_fragment and (has_functional_codes or has_economic_codes):
                if item is not None:
                    flush()
                if has_functional_codes and not has_economic_codes:
                    for column in ECONOMIC_CODE_COLUMNS:
                        economic_state[column] = ""
                    continuation_article_active = False
                fill_missing_parent_codes(functional_state, detected_codes, FUNCTIONAL_CODE_COLUMNS)
                fill_missing_parent_codes(economic_state, detected_codes, ECONOMIC_CODE_COLUMNS)
                apply_hierarchy_update(functional_state, detected_codes, FUNCTIONAL_CODE_COLUMNS)
                apply_hierarchy_update(economic_state, detected_codes, ECONOMIC_CODE_COLUMNS)
                if has_functional_codes:
                    continuation_article_active = False
                else:
                    continuation_article_active = should_keep_budget_indicator_continuation_active(
                        economic_state
                    )
                row_metadata = make_budget_indicator_metadata(functional_state, economic_state)
                item = PendingItem(
                    source_page=page_number,
                    row_code=select_budget_indicator_row_code(detected_codes),
                    description_parts=[description_fragment],
                    metadata=row_metadata,
                )
                continue
            if item is None:
                continue
            item.description_parts.append(stripped)
    flush()
    return rows


def extract_budget_indicator_codes(line: str) -> dict[str, str]:
    code_area = line[:BUDGET_INDICATOR_DESCRIPTION_START]
    values = {column: "" for column in BUDGET_INDICATOR_CODE_COLUMNS}
    for match in re.finditer(r"\d{2,10}", code_area):
        start = match.start()
        for column, (zone_start, zone_end) in BUDGET_INDICATOR_CODE_ZONES.items():
            if zone_start <= start < zone_end:
                values[column] = match.group()
                break
    return values


def is_budget_indicator_group_header(description_fragment: str) -> bool:
    description = normalize_spaces(description_fragment)
    if not description:
        return False
    if description.startswith(
        (
            "TOTAL GENERAL",
            "CHELTUIELI",
            "TITLUL",
            "PLATI",
            "OPERATIUNI",
            "DOBANZI",
            "FONDURI EXTERNE NERAMBURSABILE",
            "VENITURI PROPRII - TOTAL CHELTUIELI",
            "CREDITE EXTERNE",
        )
    ):
        return True
    letters = [character for character in description if character.isalpha()]
    if not letters:
        return False
    uppercase_ratio = sum(character.isupper() for character in letters) / len(letters)
    return uppercase_ratio >= 0.8


def is_project_financing_group_code(code: str) -> bool:
    return code in PROJECT_FINANCING_GROUP_CODES


def is_project_financing_subitem_description(description_fragment: str) -> bool:
    normalized = normalize_spaces(description_fragment).lower()
    return normalized.startswith(PROJECT_FINANCING_SUBITEM_DESCRIPTION_PREFIXES)


def is_active_fixe_subitem_description(description_fragment: str) -> bool:
    normalized = normalize_spaces(description_fragment).lower()
    return normalized.startswith(ACTIVE_FIXE_SUBITEM_DESCRIPTION_PREFIXES)


def is_previous_payments_subitem_description(description_fragment: str) -> bool:
    normalized = normalize_spaces(description_fragment).lower()
    return normalized.startswith(PREVIOUS_PAYMENTS_SUBITEM_DESCRIPTION_PREFIX)


def should_promote_project_financing_article_to_alineat(
    current_group: str,
    current_article: str,
    detected_article: str,
    description_fragment: str,
) -> bool:
    if is_budget_indicator_group_header(description_fragment):
        return False
    if current_group in PROJECT_FINANCING_GROUP_CODES:
        return (
            detected_article in PROJECT_FINANCING_SUBITEM_CODES
            and is_project_financing_subitem_description(description_fragment)
        )
    if current_group == "71":
        return (
            current_article == ACTIVE_FIXE_PARENT_ARTICLE_CODE
            and detected_article in ACTIVE_FIXE_SUBITEM_CODES
            and is_active_fixe_subitem_description(description_fragment)
        )
    if current_group == "85":
        return (
            current_article == PREVIOUS_PAYMENTS_PARENT_ARTICLE_CODE
            and detected_article in PREVIOUS_PAYMENTS_SUBITEM_CODES
            and is_previous_payments_subitem_description(description_fragment)
        )
    return False


def should_keep_budget_indicator_continuation_active(economic_state: dict[str, str]) -> bool:
    current_group = economic_state.get("grupa_titlu") or ""
    current_article = economic_state.get("articol") or ""
    return bool(current_article) and current_group in BUDGET_INDICATOR_CONTINUATION_GROUP_CODES


def normalize_budget_indicator_codes(
    detected_codes: dict[str, str],
    description_fragment: str,
    economic_state: dict[str, str],
    continuation_article_active: bool,
) -> tuple[dict[str, str], bool, bool]:
    if any(detected_codes[column] for column in FUNCTIONAL_CODE_COLUMNS):
        return detected_codes, False, False
    if detected_codes["alineat"]:
        return detected_codes, False, False
    current_group = economic_state.get("grupa_titlu") or ""
    detected_group = detected_codes["grupa_titlu"]
    if not current_group or not detected_group or is_budget_indicator_group_header(description_fragment):
        remapped = dict(detected_codes)
        promoted_group_to_article = False
    else:
        remapped = dict(detected_codes)
        remapped["articol"] = detected_group
        remapped["grupa_titlu"] = ""
        promoted_group_to_article = True

    current_article = economic_state.get("articol") or ""
    detected_article = remapped["articol"]
    promoted_article_to_alineat = False
    if (
        continuation_article_active
        and current_article
        and detected_article
        and not remapped["alineat"]
    ):
        if should_promote_project_financing_article_to_alineat(
            current_group,
            current_article,
            detected_article,
            description_fragment,
        ):
            remapped["alineat"] = detected_article
            remapped["articol"] = current_article
            promoted_article_to_alineat = True

    return remapped, promoted_group_to_article, promoted_article_to_alineat


def extract_budget_indicator_table_title(page_text: str, current_title: str) -> str:
    title_lines = extract_budget_indicator_title_lines(page_text)
    return extract_budget_indicator_table_title_from_lines(title_lines, current_title)


def extract_budget_indicator_title_lines(page_text: str) -> list[str]:
    title_lines: list[str] = []
    for line in page_text.splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        if stripped.startswith("Capi-"):
            break
        if (
            "ACADEMIA ROMANA" in stripped
            or "Anexa nr." in stripped
            or "Pag." in stripped
            or stripped.startswith("- mii lei -")
            or stripped.startswith("-mii lei-")
        ):
            continue
        title_lines.append(stripped)
    return title_lines


def has_budget_indicator_title_markers(title_lines: list[str]) -> bool:
    return any(
        any(marker in line for marker in BUDGET_INDICATOR_TITLE_MARKERS)
        for line in title_lines
    )


def extract_budget_indicator_entity_prefix(title_lines: list[str]) -> str:
    marker_index = next(
        (
            index
            for index, line in enumerate(title_lines)
            if any(marker in line for marker in BUDGET_INDICATOR_TITLE_MARKERS)
        ),
        None,
    )
    prefix_lines = title_lines[:marker_index] if marker_index is not None else title_lines
    return join_parts(prefix_lines)


def extract_budget_indicator_table_title_from_lines(
    title_lines: list[str],
    current_title: str,
) -> str:
    if not title_lines:
        return current_title
    if current_title and not any(
        any(marker in line for marker in BUDGET_INDICATOR_TITLE_MARKERS) for line in title_lines
    ):
        return current_title
    return join_parts([" | ".join(title_lines)])


def extract_budget_indicator_numeric_starts(page_text: str) -> list[int]:
    for line in page_text.splitlines():
        if re.fullmatch(r"\s*A\s+B\s+1\s+2\s+3\s+4\S*\s+5\s+6\s+7\s*", line):
            positions = [match.start() for match in re.finditer(r"(?<!\S)[1-7]", line)]
            if len(positions) == 7:
                return positions
    return BUDGET_INDICATOR_STARTS


def extract_budget_indicator_numeric_end_anchors(page_text: str) -> list[int] | None:
    end_positions: list[list[int]] = []
    for line in page_text.splitlines():
        stripped = line.strip()
        if not (
            stripped.startswith("I.Credite de angajament")
            or stripped.startswith("II.Credite bugetare")
        ):
            continue
        matches = list(NUMERIC_PATTERN.finditer(line))
        if len(matches) != len(BUDGET_INDICATOR_COLUMNS):
            continue
        end_positions.append([match.end() for match in matches])
    if not end_positions:
        return None
    return [
        int(round(median(column_positions))) for column_positions in zip(*end_positions)
    ]


def derive_budget_indicator_table_type(section: str) -> str:
    if "SINTEZA | fondurilor alocate pe surse si pe titluri de cheltuieli | pe anii 2024-2029" in section:
        return "Sinteza"
    if "SINTEZA | fondurilor alocate pe surse si pe titluri de cheltuieli | pe anii 2024 - 2029" in section:
        return "Sinteza"
    if "(sume alocate din credite externe)" in section:
        return "Buget pe capitole - credite externe"
    if "(sume alocate din fonduri externe nerambursabile)" in section:
        return "Buget pe capitole - fonduri externe nerambursabile"
    if "(sume alocate pentru activitati finantate integral din venituri proprii)" in section:
        return "Buget pe capitole - venituri proprii"
    if "(sume alocate din bugetul de stat)" in section:
        return "Buget pe capitole - buget de stat"
    return "Necunoscut"


def fill_missing_parent_codes(
    state: dict[str, str], detected_codes: dict[str, str], columns: list[str]
) -> None:
    for index, column in enumerate(columns):
        if not detected_codes[column]:
            continue
        for ancestor in columns[:index]:
            if not state[ancestor]:
                state[ancestor] = "00"


def apply_hierarchy_update(
    state: dict[str, str], detected_codes: dict[str, str], columns: list[str]
) -> None:
    for index, column in enumerate(columns):
        new_value = detected_codes[column]
        if not new_value:
            continue
        state[column] = new_value
        for descendant in columns[index + 1 :]:
            state[descendant] = ""


def join_code_path(state: dict[str, str], columns: list[str]) -> str:
    return ".".join(state.get(column) or "00" for column in columns)


def make_budget_indicator_metadata(
    functional_state: dict[str, str], economic_state: dict[str, str]
) -> dict[str, str]:
    metadata = {
        column: functional_state.get(column) or "00" for column in FUNCTIONAL_CODE_COLUMNS
    }
    metadata.update({column: economic_state.get(column) or "00" for column in ECONOMIC_CODE_COLUMNS})
    metadata["functional"] = join_code_path(functional_state, FUNCTIONAL_CODE_COLUMNS)
    metadata["economic"] = join_code_path(economic_state, ECONOMIC_CODE_COLUMNS)
    return metadata


def _try_float_value(raw: str) -> float | None:
    stripped = raw.strip()
    if not stripped:
        return None
    try:
        return float(stripped)
    except ValueError:
        return None


def _percentage_matches(executie: float, propuneri: float, crestere: float) -> bool:
    if abs(executie) < 0.01:
        return False
    expected = (propuneri - executie) / executie * 100
    return abs(expected - crestere) <= 1.0


def detect_and_correct_budget_indicator_shift(values: dict[str, str]) -> dict[str, str]:
    """Detect and correct a one-column-left shift in budget indicator values.

    The DP column mapper sometimes assigns the first numeric value to
    realizari_2024 instead of executie_preliminata_2025, shifting all
    values left by one position.  Detection relies on the percentage
    column ``crestere_descrestere_2026_2025`` which must satisfy
    ``(propuneri - executie) / executie * 100``.  When shifting right by
    one position makes the formula hold, the values are corrected.
    """
    executie = _try_float_value(values.get("executie_preliminata_2025", ""))
    propuneri = _try_float_value(values.get("propuneri_2026", ""))
    crestere = _try_float_value(values.get("crestere_descrestere_2026_2025", ""))

    if executie is None or propuneri is None or crestere is None:
        return values

    if _percentage_matches(executie, propuneri, crestere):
        return values

    realizari = _try_float_value(values.get("realizari_2024", ""))
    if realizari is None:
        return values

    if _percentage_matches(realizari, executie, propuneri):
        columns = BUDGET_INDICATOR_COLUMNS
        corrected = {columns[0]: ""}
        for i in range(1, len(columns)):
            corrected[columns[i]] = values.get(columns[i - 1], "")
        return corrected

    return values


def correct_budget_indicator_sparse_first_value(
    line: str,
    values: dict[str, str],
    end_anchors: list[int] | None,
) -> dict[str, str]:
    if end_anchors is None:
        return values
    if (
        values.get("realizari_2024", "")
        or not values.get("executie_preliminata_2025", "")
        or not values.get("propuneri_2026", "")
        or values.get("crestere_descrestere_2026_2025", "")
    ):
        return values

    matches = list(NUMERIC_PATTERN.finditer(line))
    if len(matches) != 5:
        return values

    first_end = matches[0].end()
    second_end = matches[1].end()
    if abs(first_end - end_anchors[0]) > abs(first_end - end_anchors[1]):
        return values
    if abs(second_end - end_anchors[2]) >= abs(second_end - end_anchors[1]):
        return values

    corrected = dict(values)
    corrected["realizari_2024"] = corrected["executie_preliminata_2025"]
    corrected["executie_preliminata_2025"] = ""
    return corrected


def select_budget_indicator_row_code(detected_codes: dict[str, str]) -> str:
    for column in BUDGET_INDICATOR_CODE_COLUMNS:
        if detected_codes[column]:
            return detected_codes[column]
    return ""


def parse_project_sheet_financing(pages: list[tuple[int, str]]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    item: PendingItem | None = None
    program_code = ""
    program_title = ""
    project_code = ""
    project_name = ""
    funding_source_code = ""
    funding_source_description = ""

    def flush() -> None:
        nonlocal item
        flush_item_rows(
            rows,
            family="project_sheet_financing",
            section=funding_source_description,
            item=item,
            extra={
                "program_code": program_code,
                "program_title": program_title,
                "project_code": project_code,
                "project_name": project_name,
                "funding_source_code": funding_source_code,
                "funding_source_description": funding_source_description,
            },
        )
        item = None

    for page_number, page_text in pages:
        for line in page_text.splitlines():
            stripped = line.strip()
            if stripped.startswith("I. Credite de angajament") or stripped.startswith("II. Credite bugetare"):
                if item is None:
                    continue
                values = map_numeric_columns(line, NINE_VALUE_COLUMNS, PROJECT_SHEET_STARTS)
                item.rows.append(
                    PendingRow(
                        source_page=page_number,
                        credit_type=stripped.split("  ", 1)[0].strip(),
                        values=values,
                    )
                )
                continue
            if (
                not stripped
                or stripped.startswith("Anexa nr.")
                or stripped.startswith("Pag.")
                or stripped == "Academia Romana"
                or stripped == "I. Credite de angajament"
                or stripped == "II. Credit bugetar"
                or "FISA PROIECTULUI" in stripped
                or stripped.startswith("finantat / propus la finantare")
                or stripped.startswith("de Pescuit")
                or stripped.startswith("- mii lei -")
                or stripped.startswith("Denumirea si codul proiectului/")
                or stripped.startswith("surse")
                or stripped.startswith("de finantare")
                or is_footer_line(line)
            ):
                continue
            program_match = re.match(r"^Program/ facilitate/ instrument:\s+(\d+)\s+(.+)$", stripped)
            if program_match:
                program_code = program_match.group(1)
                program_title = program_match.group(2)
                continue
            project_match = re.match(r"^Proiectul:\s+(\d+)\s+(.+)$", stripped)
            if project_match:
                project_code = project_match.group(1)
                project_name = project_match.group(2)
                continue
            funding_match = re.match(r"^Fond de finantare:\s+(\d+)\s+(.+)$", stripped)
            if funding_match:
                funding_source_code = funding_match.group(1)
                funding_source_description = funding_match.group(2)
                continue
            row_match = re.match(r"^(\d{4,10})\s+(.+)$", stripped)
            if row_match:
                if item is not None and item.rows:
                    flush()
                item = PendingItem(
                    source_page=page_number,
                    row_code=row_match.group(1),
                    description_parts=[row_match.group(2)],
                )
                continue
            if item is None:
                continue
            item.description_parts.append(stripped)
    flush()
    return rows


def is_credit_label(value: str) -> bool:
    return value in CREDIT_LABEL_MAP


def parse_program_financing_summary(pages: list[tuple[int, str]]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    current_program_code = ""
    current_program_title = ""
    current_description = ""
    current_description_page = 0
    current_description_has_rows = False
    awaiting_program_title = False
    pending_credit_type = ""
    pending_source_page = 0

    def set_description(value: str, page_number: int) -> None:
        nonlocal current_description, current_description_page, current_description_has_rows
        current_description = value
        current_description_page = page_number
        current_description_has_rows = False

    for page_number, page_text in pages:
        for line in page_text.splitlines():
            stripped = line.strip()
            if (
                not stripped
                or stripped.startswith("SINTEZA FINANTARII PROGRAMELOR")
                or stripped.startswith("Anexa nr.")
                or stripped.startswith("Pag.")
                or stripped.startswith("Cod ordonator")
                or stripped.startswith("programului")
                or stripped.startswith("pag.")
                or stripped == "- mii lei -"
                or is_footer_line(line)
            ):
                continue
            if is_numeric_only_line(line, PROGRAM_FINANCING_STARTS[0]):
                if not pending_credit_type:
                    continue
                row = {
                    "source_page": pending_source_page or current_description_page or page_number,
                    "family": "program_financing_summary",
                    "section": current_program_title,
                    "row_code": current_program_code,
                    "description": current_description,
                    "credit_type": pending_credit_type,
                    "program_code": current_program_code,
                    "program_title": current_program_title,
                }
                row.update(map_numeric_columns(line, EIGHT_VALUE_COLUMNS, PROGRAM_FINANCING_STARTS))
                rows.append(row)
                pending_credit_type = ""
                pending_source_page = 0
                current_description_has_rows = True
                continue
            parts = split_multi_space(line)
            if not parts:
                continue
            if parts[0] == "37" and len(parts) >= 3:
                if len(parts) == 3:
                    # Institution header.
                    continue
                if len(parts) >= 4 and parts[2].isdigit():
                    current_program_code = parts[2]
                    last_value = parts[3]
                    if is_credit_label(last_value):
                        pending_credit_type = CREDIT_LABEL_MAP[last_value]
                        pending_source_page = current_description_page or page_number
                    else:
                        awaiting_program_title = last_value == "PROGRAM"
                        if awaiting_program_title:
                            continue
                        set_description(last_value, page_number)
                    continue
            if len(parts) == 2 and parts[0].isdigit():
                current_program_code = parts[0]
                if is_credit_label(parts[1]):
                    pending_credit_type = CREDIT_LABEL_MAP[parts[1]]
                    pending_source_page = current_description_page or page_number
                    continue
                if parts[1] == "PROGRAM":
                    awaiting_program_title = True
                    continue
                if awaiting_program_title:
                    current_program_title = parts[1]
                    awaiting_program_title = False
                    continue
                set_description(parts[1], page_number)
                continue
            if len(parts) == 1:
                if is_credit_label(parts[0]):
                    pending_credit_type = CREDIT_LABEL_MAP[parts[0]]
                    pending_source_page = current_description_page or page_number
                    continue
                if awaiting_program_title:
                    current_program_title = parts[0]
                    awaiting_program_title = False
                    continue
                if current_description and not current_description_has_rows and current_description.endswith("-"):
                    current_description = normalize_spaces(f"{current_description} {parts[0]}")
                    continue
                set_description(parts[0], page_number)
    return rows


def parse_program_budget_financing(pages: list[tuple[int, str]]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    current_program_code = ""
    current_section = ""
    current_row_code = ""
    current_description = ""
    current_description_page = 0
    current_description_has_rows = False
    pending_credit_type = ""
    pending_source_page = 0

    def set_description(value: str, page_number: int, *, row_code: str = "") -> None:
        nonlocal current_description, current_description_page, current_description_has_rows, current_row_code
        current_row_code = row_code
        current_description = value
        current_description_page = page_number
        current_description_has_rows = False

    for page_number, page_text in pages:
        for line in page_text.splitlines():
            stripped = line.strip()
            if (
                not stripped
                or stripped.startswith("FISA PROGRAMULUI BUGETAR")
                or stripped.startswith("Anexa nr.")
                or stripped.startswith("Pag.")
                or stripped.startswith("Cod   ordonator")
                or stripped.startswith("program indicator")
                or stripped == "- mii lei-"
                or is_footer_line(line)
            ):
                continue
            if stripped in PROGRAM_BUDGET_TARGET_SECTIONS:
                current_section = stripped
                current_row_code = ""
                current_description = ""
                current_description_page = page_number
                current_description_has_rows = False
                pending_credit_type = ""
                pending_source_page = 0
                continue
            if stripped.startswith("INDICATORI DE") or stripped.startswith("MASURI "):
                current_section = ""
                current_row_code = ""
                current_description = ""
                current_description_has_rows = False
                pending_credit_type = ""
                pending_source_page = 0
                continue
            parts = split_multi_space(line)
            if parts and parts[0] == "37" and len(parts) >= 3 and parts[2].isdigit():
                current_program_code = parts[2]
            if not current_section:
                continue
            if is_numeric_only_line(line, PROGRAM_BUDGET_STARTS[0]):
                if not pending_credit_type:
                    continue
                row = {
                    "source_page": pending_source_page or current_description_page or page_number,
                    "family": "program_budget_financing",
                    "section": current_section,
                    "row_code": current_row_code,
                    "description": current_description,
                    "credit_type": pending_credit_type,
                    "program_code": current_program_code,
                }
                row.update(map_numeric_columns(line, EIGHT_VALUE_COLUMNS, PROGRAM_BUDGET_STARTS))
                rows.append(row)
                pending_credit_type = ""
                pending_source_page = 0
                current_description_has_rows = True
                continue
            if not parts:
                continue
            if parts[0] == "37" and len(parts) >= 4 and parts[2].isdigit():
                if len(parts) >= 5 and re.fullmatch(r"\d{4,10}", parts[3]):
                    set_description(join_parts(parts[4:]), page_number, row_code=parts[3])
                    continue
                if len(parts) >= 4 and is_credit_label(parts[3]):
                    pending_credit_type = CREDIT_LABEL_MAP[parts[3]]
                    pending_source_page = current_description_page or page_number
                    continue
            if re.fullmatch(r"\d{4,10}", parts[0]):
                if len(parts) >= 2 and is_credit_label(parts[1]):
                    current_row_code = parts[0]
                    pending_credit_type = CREDIT_LABEL_MAP[parts[1]]
                    pending_source_page = current_description_page or page_number
                    continue
                set_description(join_parts(parts[1:]), page_number, row_code=parts[0])
                continue
            if len(parts) == 1:
                if is_credit_label(parts[0]):
                    pending_credit_type = CREDIT_LABEL_MAP[parts[0]]
                    pending_source_page = current_description_page or page_number
                    continue
                if current_row_code and not current_description_has_rows:
                    current_description = join_parts([current_description, parts[0]])
                    continue
                set_description(parts[0], page_number)
                continue
    return rows


def parse_public_investments(pages: list[tuple[int, str]]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    section = ""
    item: PendingItem | None = None

    def flush() -> None:
        nonlocal item
        flush_item_rows(rows, family="public_investments", section=section, item=item)
        item = None

    for page_number, page_text in pages:
        for line in page_text.splitlines():
            stripped = line.strip()
            if (
                not stripped
                or stripped == "ACADEMIA ROMANA"
                or stripped.startswith("Anexa nr.")
                or stripped.startswith("Pag.")
                or stripped.startswith("PROGRAMUL DE INVESTITII PUBLICE")
                or stripped.startswith("PE GRUPE DE INVESTITII")
                or stripped.startswith("I - Credite de angajament")
                or stripped.startswith("II - Credite bugetare")
                or stripped.startswith("CAPITOL/GRUPA/SURSA")
                or stripped.startswith("-mii lei-")
                or re.fullmatch(r"[0-9](?:\s+[0-9])+", stripped)
                or is_footer_line(line)
            ):
                continue
            parts = split_multi_space(line)
            if not parts:
                continue
            if parts[0] in {"I", "II"}:
                if item is None:
                    continue
                values = map_numeric_columns(line, PUBLIC_INVESTMENT_COLUMNS, PUBLIC_INVESTMENT_STARTS)
                item.rows.append(
                    PendingRow(
                        source_page=page_number,
                        credit_type=parts[0],
                        values=values,
                    )
                )
                continue
            if len(parts) == 1 and item is None:
                section = parts[0]
                continue
            if len(parts) >= 2 and parts[1] in {"I", "II"}:
                first_segment = parts[0]
                row_match = re.match(r"^(\d{4,10})\s+(.+)$", first_segment)
                if row_match:
                    if item is not None and item.rows:
                        flush()
                    item = PendingItem(
                        source_page=page_number,
                        row_code=row_match.group(1),
                        description_parts=[row_match.group(2)],
                    )
                else:
                    if item is None:
                        item = PendingItem(source_page=page_number)
                    item.description_parts.append(first_segment)
                values = map_numeric_columns(line, PUBLIC_INVESTMENT_COLUMNS, PUBLIC_INVESTMENT_STARTS)
                item.rows.append(
                    PendingRow(
                        source_page=page_number,
                        credit_type=parts[1],
                        values=values,
                    )
                )
                continue
            row_match = re.match(r"^(\d{4,10})\s+(.+)$", stripped)
            if row_match:
                if item is not None and item.rows:
                    flush()
                item = PendingItem(
                    source_page=page_number,
                    row_code=row_match.group(1),
                    description_parts=[row_match.group(2)],
                )
                continue
            if item is not None:
                item.description_parts.append(stripped)
            else:
                section = stripped
    flush()
    return rows


def extract_tables_from_pages(
    pages: list[tuple[int, str]],
    *,
    strict_expected_families: bool = False,
) -> dict[str, Any]:
    family_pages: dict[str, list[tuple[int, str]]] = defaultdict(list)
    for page_number, page_text in pages:
        family = detect_family(page_text)
        if family is None:
            continue
        family_pages[family].append((page_number, page_text))

    tables = {
        "policy_program_summary": parse_policy_program_summary(family_pages["policy_program_summary"]),
        "budget_indicator_summary": parse_budget_indicator_summary(family_pages["budget_indicator_summary"]),
        "project_sheet_financing": parse_project_sheet_financing(family_pages["project_sheet_financing"]),
        "program_financing_summary": parse_program_financing_summary(family_pages["program_financing_summary"]),
        "program_budget_financing": parse_program_budget_financing(family_pages["program_budget_financing"]),
        "public_investments": parse_public_investments(family_pages["public_investments"]),
    }

    summary: dict[str, dict[str, Any]] = {}
    for family in EXPECTED_FAMILY_ORDER:
        summary[family] = {
            "pages": [page_number for page_number, _page_text in family_pages.get(family, [])],
            "row_count": len(tables[family]),
            "output_file": FAMILY_TO_OUTPUT[family],
        }

    if strict_expected_families:
        missing = [family for family in EXPECTED_FAMILY_ORDER if not summary[family]["pages"]]
        empty = [
            family
            for family in EXPECTED_FAMILY_ORDER
            if summary[family]["pages"] and summary[family]["row_count"] == 0
        ]
        if missing or empty:
            details: list[str] = []
            if missing:
                details.append(f"missing families: {', '.join(missing)}")
            if empty:
                details.append(f"empty outputs: {', '.join(empty)}")
            raise ValueError("; ".join(details))

    return {"tables": tables, "summary": summary}


def extract_tables_from_layout_text(
    layout_text: str,
    *,
    strict_expected_families: bool = False,
) -> dict[str, Any]:
    return extract_tables_from_pages(
        split_layout_pages(layout_text),
        strict_expected_families=strict_expected_families,
    )


def run_pdftotext_layout(pdf_path: Path) -> str:
    if shutil.which("pdftotext") is None:
        raise RuntimeError("pdftotext is required but was not found on PATH")
    process = subprocess.run(
        ["pdftotext", "-layout", str(pdf_path), "-"],
        check=False,
        capture_output=True,
        text=True,
    )
    if process.returncode != 0:
        stderr = process.stderr.strip()
        raise RuntimeError(f"pdftotext failed for {pdf_path}: {stderr or 'unknown error'}")
    return process.stdout


def write_family_csv(output_dir: Path, family: str, rows: list[dict[str, Any]]) -> Path:
    output_path = output_dir / FAMILY_TO_OUTPUT[family]
    fieldnames = FAMILY_FIELDNAMES[family]
    with output_path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(
            handle,
            fieldnames=fieldnames,
            delimiter=";",
            extrasaction="ignore",
            lineterminator="\n",
        )
        writer.writeheader()
        for row in rows:
            writer.writerow(row)
    return output_path


def extract_pdf_to_dir(
    input_path: Path,
    output_dir: Path,
    *,
    strict_expected_families: bool = True,
) -> dict[str, Any]:
    layout_text = run_pdftotext_layout(input_path)
    extraction = extract_tables_from_layout_text(
        layout_text,
        strict_expected_families=strict_expected_families,
    )

    output_dir.mkdir(parents=True, exist_ok=True)
    written_files: dict[str, str] = {}
    for family in EXPECTED_FAMILY_ORDER:
        rows = extraction["tables"][family]
        output_path = write_family_csv(output_dir, family, rows)
        written_files[family] = str(output_path)

    extraction["written_files"] = written_files
    return extraction


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Extract document-specific financial tables from Academia_Romana.pdf",
    )
    parser.add_argument("--input", required=True, help="Path to the input PDF")
    parser.add_argument("--output-dir", required=True, help="Directory where CSV files will be written")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(sys.argv[1:] if argv is None else argv)
    input_path = Path(args.input).expanduser().resolve()
    output_dir = Path(args.output_dir).expanduser().resolve()

    if not input_path.exists():
        print(f"Input PDF does not exist: {input_path}", file=sys.stderr)
        return 1

    try:
        extraction = extract_pdf_to_dir(
            input_path,
            output_dir,
            strict_expected_families=True,
        )
    except (RuntimeError, ValueError) as error:
        print(str(error), file=sys.stderr)
        return 1

    print("Detected families:")
    for family in EXPECTED_FAMILY_ORDER:
        summary = extraction["summary"][family]
        page_list = ",".join(str(page_number) for page_number in summary["pages"])
        print(
            f"- {family}: pages=[{page_list}] rows={summary['row_count']} "
            f"output={Path(extraction['written_files'][family]).name}"
        )

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
