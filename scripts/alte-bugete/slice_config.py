from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_INPUT_DIR = REPO_ROOT / "scripts" / "input" / "alte-bugete"
DEFAULT_OUTPUT_ROOT = REPO_ROOT / "scripts" / "output" / "alte-bugete"
DEFAULT_PREVIEW_LIMIT = 25


@dataclass(frozen=True)
class SliceConfig:
    slice_id: str
    source_pdf_name: str
    detail_page_start: int
    detail_page_end: int
    detail_section: str
    detail_table_type: str
    detail_required_title_fragments: tuple[str, ...]
    top_row_code: str
    synteza_page_start: int
    synteza_page_end: int
    synteza_section: str
    synteza_required_title_fragments: tuple[str, ...]

    @property
    def expected_detail_pages(self) -> list[int]:
        return list(range(self.detail_page_start, self.detail_page_end + 1))

    @property
    def expected_synteza_pages(self) -> list[int]:
        return list(range(self.synteza_page_start, self.synteza_page_end + 1))


SLICE_CONFIGS = (
    SliceConfig(
        slice_id="cnas",
        source_pdf_name="Anexa_10.pdf",
        detail_page_start=8,
        detail_page_end=14,
        detail_section=(
            "CASA NATIONALA DE ASIGURARI DE SANATATE | "
            "Bugetul pe capitole, subcapitole, paragrafe, titluri de cheltuieli "
            "articole si alineate | pe anii 2024-2029 | "
            "(sume alocate din bugetul Fondului national unic de asigurari sociale de sanatate)"
        ),
        detail_table_type="Buget pe capitole - FNUASS",
        detail_required_title_fragments=(
            "CASA NATIONALA DE ASIGURARI DE SANATATE",
            "Bugetul pe capitole, subcapitole, paragrafe, titluri de cheltuieli",
            "Fondului national unic de asigurari sociale de sanatate",
        ),
        top_row_code="5005",
        synteza_page_start=1,
        synteza_page_end=7,
        synteza_section=(
            "CASA NATIONALA DE ASIGURARI DE SANATATE | "
            "Sinteza veniturilor si cheltuielilor alocate pe surse si pe titluri | "
            "pe anii 2024-2029"
        ),
        synteza_required_title_fragments=(
            "CASA NATIONALA DE ASIGURARI DE SANATATE",
            "Sinteza veniturilor si cheltuielilor alocate pe surse si pe titluri",
        ),
    ),
    SliceConfig(
        slice_id="bass",
        source_pdf_name="AnexeproiectlegeBASS_09032026.pdf",
        detail_page_start=7,
        detail_page_end=14,
        detail_section=(
            "MINISTERUL MUNCII, FAMILIEI, TINERETULUI SI | SOLIDARITATII SOCIALE | "
            "Bugetul pe capitole, subcapitole, paragrafe, titluri de cheltuieli, "
            "articole si alineate | pe anii 2024-2029 | "
            "(sume alocate din Bugetul asigurarilor sociale de stat)"
        ),
        detail_table_type="Buget pe capitole - BASS",
        detail_required_title_fragments=(
            "MINISTERUL MUNCII, FAMILIEI, TINERETULUI SI",
            "Bugetul pe capitole, subcapitole, paragrafe, titluri de cheltuieli, articole si alineate",
            "Bugetul asigurarilor sociale de stat",
        ),
        top_row_code="5003",
        synteza_page_start=1,
        synteza_page_end=6,
        synteza_section=(
            "MINISTERUL MUNCII, FAMILIEI, TINERETULUI SI SOLIDARITATII SOCIALE | "
            "Sinteza veniturilor si cheltuielilor alocate pe surse si pe titluri | "
            "pe anii 2024-2029"
        ),
        synteza_required_title_fragments=(
            "MINISTERUL MUNCII, FAMILIEI, TINERETULUI SI",
            "Sinteza veniturilor si cheltuielilor alocate pe surse si pe titluri",
        ),
    ),
    SliceConfig(
        slice_id="bas",
        source_pdf_name="AnexeproiectlegeBASS_09032026.pdf",
        detail_page_start=50,
        detail_page_end=60,
        detail_section=(
            "MINISTERUL MUNCII, FAMILIEI, TINERETULUI SI | SOLIDARITATII SOCIALE | "
            "Bugetul pe capitole, subcapitole, paragrafe, titluri de cheltuieli, "
            "articole si alineate | pe anii 2024-2029 | "
            "(sume alocate din Bugetul asigurarilor pentru somaj)"
        ),
        detail_table_type="Buget pe capitole - BAS",
        detail_required_title_fragments=(
            "MINISTERUL MUNCII, FAMILIEI, TINERETULUI SI",
            "Bugetul pe capitole, subcapitole, paragrafe, titluri de cheltuieli, articole si alineate",
            "Bugetul asigurarilor pentru somaj",
        ),
        top_row_code="5004",
        synteza_page_start=43,
        synteza_page_end=49,
        synteza_section=(
            "MINISTERUL MUNCII, FAMILIEI, TINERETULUI SI SOLIDARITATII SOCIALE | "
            "Sinteza veniturilor si cheltuielilor alocate pe surse si pe titluri | "
            "pe anii 2024-2029"
        ),
        synteza_required_title_fragments=(
            "MINISTERUL MUNCII, FAMILIEI, TINERETULUI SI",
            "Sinteza veniturilor si cheltuielilor alocate pe surse si pe titluri",
        ),
    ),
)

SLICE_CONFIGS_BY_ID = {config.slice_id: config for config in SLICE_CONFIGS}
