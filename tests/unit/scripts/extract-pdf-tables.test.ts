import { execFileSync } from 'node:child_process';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { deserialize } from '@/infra/cache/serialization.js';

type ExtractorRow = Record<string, number | string | undefined>;

interface SummaryEntry {
  output_file: string;
  pages: number[];
  row_count: number;
}

interface ExtractorResult {
  summary: Record<string, SummaryEntry>;
  tables: Record<string, ExtractorRow[]>;
}

const repoRoot = process.cwd();
const fixtureDir = path.join(repoRoot, 'tests/fixtures/pdf-tables/layout-text');
const budgetStateTitle =
  'Bugetul pe capitole, subcapitole, paragrafe, titluri de cheltuieli, articole si alineate | pe anii 2024-2029 | (sume alocate din bugetul de stat)';
const budgetFenTitle =
  'Bugetul pe capitole, subcapitole, paragrafe, titluri de cheltuieli, articole si alineate | pe anii 2024-2029 | (sume alocate din fonduri externe nerambursabile)';
const budgetOwnRevenueTitle =
  'Bugetul pe capitole, subcapitole, paragrafe, titluri de cheltuieli, articole si alineate | pe anii 2024-2029 | (sume alocate pentru activitati finantate integral din venituri proprii)';
const budgetExternalCreditTitle =
  'Bugetul pe capitole, subcapitole, paragrafe, titluri de cheltuieli, articole si alineate | pe anii 2024-2029 | (sume alocate din credite externe)';
const sintezaTitle =
  'SINTEZA | fondurilor alocate pe surse si pe titluri de cheltuieli | pe anii 2024-2029';
const sintezaSpaceTitle =
  'SINTEZA | fondurilor alocate pe surse si pe titluri de cheltuieli | pe anii 2024 - 2029';

function runExtractorOnFixtures(fixtureNames: string[]): ExtractorResult {
  const fixturePaths = fixtureNames.map((fixtureName) => path.join(fixtureDir, fixtureName));
  const python = `
import json
import pathlib
import re
import sys

from scripts.extract_pdf_tables import extract_tables_from_pages

pages = []
for raw_path in sys.argv[1:]:
    path = pathlib.Path(raw_path)
    match = re.search(r"page-(\\d+)", path.name)
    if match is None:
        raise SystemExit(f"Could not infer page number from {path.name}")
    pages.append((int(match.group(1)), path.read_text(encoding="utf-8")))

result = extract_tables_from_pages(pages, strict_expected_families=False)
print(json.dumps(result, ensure_ascii=False))
`;

  const stdout = execFileSync('python3', ['-c', python, ...fixturePaths], {
    cwd: repoRoot,
    encoding: 'utf8',
  });

  const parsed = deserialize(stdout);
  if (!parsed.ok) {
    throw new Error(parsed.error.message);
  }

  return parsed.value as ExtractorResult;
}

function getTable(result: ExtractorResult, family: string): ExtractorRow[] {
  return result.tables[family] ?? [];
}

function getString(row: ExtractorRow | undefined, key: string): string | undefined {
  const value = row?.[key];
  return typeof value === 'string' ? value : value?.toString();
}

function getNumber(row: ExtractorRow | undefined, key: string): number | undefined {
  const value = row?.[key];
  if (typeof value === 'number') {
    return value;
  }
  if (typeof value === 'string') {
    return Number(value);
  }
  return undefined;
}

describe('extract_pdf_tables.py', () => {
  it('parses the policy program summary from page 11', () => {
    const result = runExtractorOnFixtures(['page-011.txt']);
    const row = getTable(result, 'policy_program_summary').find(
      (entry) => entry['row_code'] === '96' && entry['credit_type'] === 'I'
    );

    expect(row).toBeDefined();
    expect(getString(row, 'description')).toBe(
      'Program 96. Actiuni suport pentru cresterea eficientei si valorificarea cercetarii stiintifice'
    );
    expect(getString(row, 'executie_pana_2025')).toBe('1764526');
    expect(getString(row, 'propuneri_2026')).toBe('501457');
    expect(getString(row, 'estimari_2027')).toBe('447023');
    expect(result.summary['policy_program_summary']?.pages).toEqual([11]);
  });

  it('parses the budget indicator summary row from page 12', () => {
    const result = runExtractorOnFixtures(['page-012.txt']);
    const totalRow = getTable(result, 'budget_indicator_summary').find(
      (entry) =>
        getNumber(entry, 'source_page') === 12 &&
        entry['row_code'] === '5000' &&
        entry['credit_type'] === 'II.Credite bugetare'
    );
    const titleRow = getTable(result, 'budget_indicator_summary').find(
      (entry) =>
        getNumber(entry, 'source_page') === 12 &&
        entry['row_code'] === '01' &&
        entry['credit_type'] === 'II.Credite bugetare'
    );

    expect(totalRow).toBeDefined();
    expect(getString(totalRow, 'section')).toBe(sintezaTitle);
    expect(getString(totalRow, 'table_type')).toBe('Sinteza');
    expect(getString(totalRow, 'description')).toBe('TOTAL GENERAL');
    expect(getString(totalRow, 'capitol')).toBe('5000');
    expect(getString(totalRow, 'subcapitol')).toBe('00');
    expect(getString(totalRow, 'paragraph')).toBe('00');
    expect(getString(totalRow, 'grupa_titlu')).toBe('00');
    expect(getString(totalRow, 'articol')).toBe('00');
    expect(getString(totalRow, 'alineat')).toBe('00');
    expect(getString(totalRow, 'functional')).toBe('5000.00.00');
    expect(getString(totalRow, 'economic')).toBe('00.00.00');
    expect(getString(totalRow, 'realizari_2024')).toBe('535943');
    expect(getString(totalRow, 'executie_preliminata_2025')).toBe('570104');
    expect(getString(totalRow, 'propuneri_2026')).toBe('752967');

    expect(titleRow).toBeDefined();
    expect(getString(titleRow, 'capitol')).toBe('5000');
    expect(getString(titleRow, 'subcapitol')).toBe('00');
    expect(getString(titleRow, 'paragraph')).toBe('00');
    expect(getString(titleRow, 'grupa_titlu')).toBe('01');
    expect(getString(titleRow, 'articol')).toBe('00');
    expect(getString(titleRow, 'alineat')).toBe('00');
    expect(getString(titleRow, 'functional')).toBe('5000.00.00');
    expect(getString(titleRow, 'economic')).toBe('01.00.00');
  });

  it('fills deeper economic hierarchy codes from page 20 and resets descendants on title changes', () => {
    const result = runExtractorOnFixtures(['page-020.txt']);
    const line08 = getTable(result, 'budget_indicator_summary').find(
      (entry) =>
        getNumber(entry, 'source_page') === 20 &&
        entry['row_code'] === '08' &&
        entry['credit_type'] === 'II.Credite bugetare'
    );
    const line01 = getTable(result, 'budget_indicator_summary').find(
      (entry) =>
        getNumber(entry, 'source_page') === 20 &&
        entry['row_code'] === '01' &&
        entry['description'] === 'Transferuri catre institutii publice' &&
        entry['credit_type'] === 'II.Credite bugetare'
    );
    const resetRow = getTable(result, 'budget_indicator_summary').find(
      (entry) =>
        getNumber(entry, 'source_page') === 20 &&
        entry['row_code'] === '55' &&
        entry['credit_type'] === 'II.Credite bugetare'
    );

    expect(line08).toBeDefined();
    expect(getString(line08, 'section')).toBe(budgetStateTitle);
    expect(getString(line08, 'table_type')).toBe('Buget pe capitole - buget de stat');
    expect(getString(line08, 'capitol')).toBe('5001');
    expect(getString(line08, 'subcapitol')).toBe('00');
    expect(getString(line08, 'paragraph')).toBe('00');
    expect(getString(line08, 'grupa_titlu')).toBe('51');
    expect(getString(line08, 'articol')).toBe('02');
    expect(getString(line08, 'alineat')).toBe('08');
    expect(getString(line08, 'functional')).toBe('5001.00.00');
    expect(getString(line08, 'economic')).toBe('51.02.08');

    expect(line01).toBeDefined();
    expect(getString(line01, 'economic')).toBe('51.01.01');

    expect(resetRow).toBeDefined();
    expect(getString(resetRow, 'grupa_titlu')).toBe('55');
    expect(getString(resetRow, 'articol')).toBe('00');
    expect(getString(resetRow, 'alineat')).toBe('00');
    expect(getString(resetRow, 'economic')).toBe('55.00.00');
  });

  it('fills deeper functional hierarchy codes from pages 26-27 and clears stale economic state', () => {
    const result = runExtractorOnFixtures(['page-020.txt', 'page-026.txt', 'page-027.txt']);
    const combinedFunctionalRow = getTable(result, 'budget_indicator_summary').find(
      (entry) =>
        getNumber(entry, 'source_page') === 26 &&
        entry['row_code'] === '6500' &&
        entry['credit_type'] === 'II.Credite bugetare'
    );
    const subchapterRow = getTable(result, 'budget_indicator_summary').find(
      (entry) =>
        getNumber(entry, 'source_page') === 27 &&
        entry['row_code'] === '04' &&
        entry['credit_type'] === 'II.Credite bugetare'
    );
    const paragraphRow = getTable(result, 'budget_indicator_summary').find(
      (entry) =>
        getNumber(entry, 'source_page') === 27 &&
        entry['row_code'] === '05' &&
        entry['credit_type'] === 'II.Credite bugetare'
    );
    const chapterResetRow = getTable(result, 'budget_indicator_summary').find(
      (entry) =>
        getNumber(entry, 'source_page') === 27 &&
        entry['row_code'] === '6701' &&
        entry['credit_type'] === 'II.Credite bugetare'
    );

    expect(combinedFunctionalRow).toBeDefined();
    expect(getString(combinedFunctionalRow, 'capitol')).toBe('6500');
    expect(getString(combinedFunctionalRow, 'subcapitol')).toBe('01');
    expect(getString(combinedFunctionalRow, 'paragraph')).toBe('00');
    expect(getString(combinedFunctionalRow, 'functional')).toBe('6500.01.00');
    expect(getString(combinedFunctionalRow, 'economic')).toBe('00.00.00');

    expect(subchapterRow).toBeDefined();
    expect(getString(subchapterRow, 'section')).toBe(budgetStateTitle);
    expect(getString(subchapterRow, 'table_type')).toBe('Buget pe capitole - buget de stat');
    expect(getString(subchapterRow, 'capitol')).toBe('6601');
    expect(getString(subchapterRow, 'subcapitol')).toBe('04');
    expect(getString(subchapterRow, 'paragraph')).toBe('00');
    expect(getString(subchapterRow, 'functional')).toBe('6601.04.00');
    expect(getString(subchapterRow, 'economic')).toBe('00.00.00');

    expect(paragraphRow).toBeDefined();
    expect(getString(paragraphRow, 'capitol')).toBe('6601');
    expect(getString(paragraphRow, 'subcapitol')).toBe('04');
    expect(getString(paragraphRow, 'paragraph')).toBe('05');
    expect(getString(paragraphRow, 'functional')).toBe('6601.04.05');
    expect(getString(paragraphRow, 'economic')).toBe('00.00.00');

    expect(chapterResetRow).toBeDefined();
    expect(getString(chapterResetRow, 'capitol')).toBe('6701');
    expect(getString(chapterResetRow, 'subcapitol')).toBe('00');
    expect(getString(chapterResetRow, 'paragraph')).toBe('00');
    expect(getString(chapterResetRow, 'functional')).toBe('6701.00.00');
  });

  it('uses 00 for missing parent hierarchy levels on child-only rows', () => {
    const result = runExtractorOnFixtures(['page-900.txt']);
    const row = getTable(result, 'budget_indicator_summary').find(
      (entry) =>
        getNumber(entry, 'source_page') === 900 &&
        entry['row_code'] === '03' &&
        entry['credit_type'] === 'II.Credite bugetare'
    );

    expect(row).toBeDefined();
    expect(getString(row, 'section')).toBe(budgetStateTitle);
    expect(getString(row, 'table_type')).toBe('Buget pe capitole - buget de stat');
    expect(getString(row, 'capitol')).toBe('00');
    expect(getString(row, 'subcapitol')).toBe('00');
    expect(getString(row, 'paragraph')).toBe('00');
    expect(getString(row, 'grupa_titlu')).toBe('00');
    expect(getString(row, 'articol')).toBe('00');
    expect(getString(row, 'alineat')).toBe('03');
    expect(getString(row, 'functional')).toBe('00.00.00');
    expect(getString(row, 'economic')).toBe('00.00.03');
    expect(getString(row, 'realizari_2024')).toBe('833');
  });

  it('maps the spaced-year sinteza variant to the shared Sinteza table type', () => {
    const result = runExtractorOnFixtures(['page-901.txt']);
    const row = getTable(result, 'budget_indicator_summary').find(
      (entry) =>
        getNumber(entry, 'source_page') === 901 &&
        entry['row_code'] === '5000' &&
        entry['credit_type'] === 'II.Credite bugetare'
    );

    expect(row).toBeDefined();
    expect(getString(row, 'section')).toContain(sintezaSpaceTitle);
    expect(getString(row, 'table_type')).toBe('Sinteza');
  });

  it('maps all supported non-state budget variants to shared table types', () => {
    const result = runExtractorOnFixtures(['page-902.txt', 'page-903.txt', 'page-904.txt']);
    const budgetFenRow = getTable(result, 'budget_indicator_summary').find(
      (entry) =>
        getNumber(entry, 'source_page') === 902 && entry['credit_type'] === 'II.Credite bugetare'
    );
    const budgetOwnRevenueRow = getTable(result, 'budget_indicator_summary').find(
      (entry) =>
        getNumber(entry, 'source_page') === 903 && entry['credit_type'] === 'II.Credite bugetare'
    );
    const budgetExternalCreditRow = getTable(result, 'budget_indicator_summary').find(
      (entry) =>
        getNumber(entry, 'source_page') === 904 && entry['credit_type'] === 'II.Credite bugetare'
    );

    expect(budgetFenRow).toBeDefined();
    expect(getString(budgetFenRow, 'section')).toContain(budgetFenTitle);
    expect(getString(budgetFenRow, 'table_type')).toBe(
      'Buget pe capitole - fonduri externe nerambursabile'
    );

    expect(budgetOwnRevenueRow).toBeDefined();
    expect(getString(budgetOwnRevenueRow, 'section')).toContain(budgetOwnRevenueTitle);
    expect(getString(budgetOwnRevenueRow, 'table_type')).toBe(
      'Buget pe capitole - venituri proprii'
    );

    expect(budgetExternalCreditRow).toBeDefined();
    expect(getString(budgetExternalCreditRow, 'section')).toContain(budgetExternalCreditTitle);
    expect(getString(budgetExternalCreditRow, 'table_type')).toBe(
      'Buget pe capitole - credite externe'
    );
  });

  it('parses the project sheet financing row from page 54', () => {
    const result = runExtractorOnFixtures(['page-054.txt']);
    const row = getTable(result, 'project_sheet_financing').find(
      (entry) =>
        getNumber(entry, 'source_page') === 54 &&
        entry['row_code'] === '5301566602' &&
        entry['credit_type'] === 'I. Credite de angajament'
    );

    expect(row).toBeDefined();
    expect(getString(row, 'description')).toBe('Finantare externa nerambursabila');
    expect(getString(row, 'project_code')).toBe('27848');
    expect(getString(row, 'valoarea_totala')).toBe('585');
    expect(getString(row, 'executie_preliminata_2025')).toBe('19');
    expect(getString(row, 'propuneri_2026')).toBe('566');
  });

  it('parses the program financing summary row from page 55', () => {
    const result = runExtractorOnFixtures(['page-055.txt']);
    const row = getTable(result, 'program_financing_summary').find(
      (entry) =>
        getNumber(entry, 'source_page') === 55 &&
        entry['description'] === 'TOTAL CHELTUIELI' &&
        entry['credit_type'] === 'II. Credite bugetare'
    );

    expect(row).toBeDefined();
    expect(getString(row, 'valoarea_totala_programului')).toBe('11274740');
    expect(getString(row, 'realizari_2024_si_ani_anteriori')).toBe('4965078');
    expect(getString(row, 'executie_preliminata_2025')).toBe('691157');
    expect(getString(row, 'propuneri_2026')).toBe('882017');
  });

  it('filters FISA PROGRAMULUI BUGETAR to financing sections and carries program context', () => {
    const result = runExtractorOnFixtures(['page-061.txt', 'page-063.txt', 'page-064.txt']);
    const rows = getTable(result, 'program_budget_financing');
    const row = rows.find(
      (entry) =>
        getNumber(entry, 'source_page') === 64 &&
        entry['row_code'] === '530110' &&
        entry['credit_type'] === 'I. Credite de angajament'
    );

    expect(rows.length).toBeGreaterThan(0);
    expect(
      rows.every((entry) => getString(entry, 'description')?.includes('INDICATORI') !== true)
    ).toBe(true);
    expect(row).toBeDefined();
    expect(getString(row, 'program_code')).toBe('89');
    expect(getString(row, 'section')).toBe('BUGETUL PROGRAMULUI');
    expect(getString(row, 'valoarea_totala_programului')).toBe('2035145');
  });

  it('merges multiline public investment descriptions from page 98', () => {
    const result = runExtractorOnFixtures(['page-098.txt']);
    const totalRow = getTable(result, 'public_investments').find(
      (entry) =>
        getNumber(entry, 'source_page') === 98 &&
        entry['row_code'] === '5000' &&
        entry['credit_type'] === 'I'
    );
    const multilineRow = getTable(result, 'public_investments').find(
      (entry) =>
        getNumber(entry, 'source_page') === 98 &&
        entry['row_code'] === '500151' &&
        entry['credit_type'] === 'I'
    );

    expect(totalRow).toBeDefined();
    expect(getString(totalRow, 'total')).toBe('365387');
    expect(getString(totalRow, 'cheltuieli_efectuate_pana_la_31_12_2024')).toBe('64296');
    expect(getString(totalRow, 'cheltuieli_preliminate_2025')).toBe('43460');
    expect(getString(totalRow, 'propuneri_2026')).toBe('116573');

    expect(multilineRow).toBeDefined();
    expect(getString(multilineRow, 'description')).toBe(
      'TITLUL VI TRANSFERURI INTRE UNITATI ALE ADMINISTRATIEI PUBLICE'
    );
  });
});
