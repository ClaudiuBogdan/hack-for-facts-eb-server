import { spawnSync } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const repoRoot = process.cwd();
const budgetFieldnames = [
  'source_page',
  'family',
  'section',
  'row_code',
  'capitol',
  'subcapitol',
  'paragraph',
  'grupa_titlu',
  'articol',
  'alineat',
  'functional',
  'economic',
  'description',
  'credit_type',
  'realizari_2024',
  'executie_preliminata_2025',
  'propuneri_2026',
  'crestere_descrestere_2026_2025',
  'estimari_2027',
  'estimari_2028',
  'estimari_2029',
] as const;

type BudgetField = (typeof budgetFieldnames)[number];
type BudgetRow = Record<BudgetField, string>;

function makeRow(overrides: Partial<BudgetRow>): BudgetRow {
  return {
    source_page: '1',
    family: 'budget_indicator_summary',
    section: 'Test Section',
    row_code: '',
    capitol: '00',
    subcapitol: '00',
    paragraph: '00',
    grupa_titlu: '00',
    articol: '00',
    alineat: '00',
    functional: '00.00.00',
    economic: '00.00.00',
    description: '',
    credit_type: 'II.Credite bugetare',
    realizari_2024: '',
    executie_preliminata_2025: '',
    propuneri_2026: '',
    crestere_descrestere_2026_2025: '',
    estimari_2027: '',
    estimari_2028: '',
    estimari_2029: '',
    ...overrides,
  };
}

async function writeBudgetCsv(rows: BudgetRow[]): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'budget-validator-'));
  const csvPath = path.join(dir, 'budget_indicator_summary.csv');
  const lines = [
    budgetFieldnames.join(';'),
    ...rows.map((row) => budgetFieldnames.map((fieldname) => row[fieldname]).join(';')),
  ];
  await writeFile(csvPath, `${lines.join('\n')}\n`, 'utf8');
  return csvPath;
}

function runValidator(csvPath: string): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync('python3', ['scripts/validate_pdf_totals.py', '--input', csvPath], {
    cwd: repoRoot,
    encoding: 'utf8',
  });

  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

describe('validate_pdf_totals.py', () => {
  it('passes matching functional rollups', async () => {
    const csvPath = await writeBudgetCsv([
      makeRow({
        row_code: '5000',
        capitol: '5000',
        functional: '5000.00.00',
        description: 'Functional parent',
        realizari_2024: '300',
        executie_preliminata_2025: '300',
        propuneri_2026: '300',
        estimari_2027: '300',
        estimari_2028: '300',
        estimari_2029: '300',
      }),
      makeRow({
        row_code: '01',
        capitol: '5000',
        subcapitol: '01',
        functional: '5000.01.00',
        description: 'Functional child 1',
        realizari_2024: '100',
        executie_preliminata_2025: '100',
        propuneri_2026: '100',
        estimari_2027: '100',
        estimari_2028: '100',
        estimari_2029: '100',
      }),
      makeRow({
        row_code: '02',
        capitol: '5000',
        subcapitol: '02',
        functional: '5000.02.00',
        description: 'Functional child 2',
        realizari_2024: '200',
        executie_preliminata_2025: '200',
        propuneri_2026: '200',
        estimari_2027: '200',
        estimari_2028: '200',
        estimari_2029: '200',
      }),
    ]);

    const result = runValidator(csvPath);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Validated 1 functional rollups and 0 economic rollups');
    expect(result.stdout).toContain('All checked rollups matched.');
  });

  it('passes matching economic rollups', async () => {
    const csvPath = await writeBudgetCsv([
      makeRow({
        row_code: '51',
        capitol: '5000',
        functional: '5000.00.00',
        grupa_titlu: '51',
        economic: '51.00.00',
        description: 'Economic parent',
        realizari_2024: '75',
        executie_preliminata_2025: '75',
        propuneri_2026: '75',
        estimari_2027: '75',
        estimari_2028: '75',
        estimari_2029: '75',
      }),
      makeRow({
        row_code: '01',
        capitol: '5000',
        functional: '5000.00.00',
        grupa_titlu: '51',
        articol: '01',
        economic: '51.01.00',
        description: 'Economic child 1',
        realizari_2024: '25',
        executie_preliminata_2025: '25',
        propuneri_2026: '25',
        estimari_2027: '25',
        estimari_2028: '25',
        estimari_2029: '25',
      }),
      makeRow({
        row_code: '02',
        capitol: '5000',
        functional: '5000.00.00',
        grupa_titlu: '51',
        articol: '02',
        economic: '51.02.00',
        description: 'Economic child 2',
        realizari_2024: '50',
        executie_preliminata_2025: '50',
        propuneri_2026: '50',
        estimari_2027: '50',
        estimari_2028: '50',
        estimari_2029: '50',
      }),
    ]);

    const result = runValidator(csvPath);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Validated 0 functional rollups and 1 economic rollups');
    expect(result.stdout).toContain('All checked rollups matched.');
  });

  it('ignores crestere_descrestere_2026_2025 during validation', async () => {
    const csvPath = await writeBudgetCsv([
      makeRow({
        row_code: '5000',
        capitol: '5000',
        functional: '5000.00.00',
        description: 'Functional parent',
        realizari_2024: '300',
        executie_preliminata_2025: '300',
        propuneri_2026: '300',
        crestere_descrestere_2026_2025: '999.99',
        estimari_2027: '300',
        estimari_2028: '300',
        estimari_2029: '300',
      }),
      makeRow({
        row_code: '01',
        capitol: '5000',
        subcapitol: '01',
        functional: '5000.01.00',
        description: 'Functional child 1',
        realizari_2024: '100',
        executie_preliminata_2025: '100',
        propuneri_2026: '100',
        crestere_descrestere_2026_2025: '1',
        estimari_2027: '100',
        estimari_2028: '100',
        estimari_2029: '100',
      }),
      makeRow({
        row_code: '02',
        capitol: '5000',
        subcapitol: '02',
        functional: '5000.02.00',
        description: 'Functional child 2',
        realizari_2024: '200',
        executie_preliminata_2025: '200',
        propuneri_2026: '200',
        crestere_descrestere_2026_2025: '2',
        estimari_2027: '200',
        estimari_2028: '200',
        estimari_2029: '200',
      }),
    ]);

    const result = runValidator(csvPath);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('All checked rollups matched.');
    expect(result.stdout).not.toContain('crestere_descrestere_2026_2025');
  });

  it('fails with a non-zero exit code on mismatched totals', async () => {
    const csvPath = await writeBudgetCsv([
      makeRow({
        row_code: '51',
        capitol: '5000',
        functional: '5000.00.00',
        grupa_titlu: '51',
        economic: '51.00.00',
        description: 'Economic parent',
        realizari_2024: '70',
        executie_preliminata_2025: '70',
        propuneri_2026: '70',
        estimari_2027: '70',
        estimari_2028: '70',
        estimari_2029: '70',
      }),
      makeRow({
        row_code: '01',
        capitol: '5000',
        functional: '5000.00.00',
        grupa_titlu: '51',
        articol: '01',
        economic: '51.01.00',
        description: 'Economic child 1',
        realizari_2024: '25',
        executie_preliminata_2025: '25',
        propuneri_2026: '25',
        estimari_2027: '25',
        estimari_2028: '25',
        estimari_2029: '25',
      }),
      makeRow({
        row_code: '02',
        capitol: '5000',
        functional: '5000.00.00',
        grupa_titlu: '51',
        articol: '02',
        economic: '51.02.00',
        description: 'Economic child 2',
        realizari_2024: '50',
        executie_preliminata_2025: '50',
        propuneri_2026: '50',
        estimari_2027: '50',
        estimari_2028: '50',
        estimari_2029: '50',
      }),
    ]);

    const result = runValidator(csvPath);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('Found 6 mismatches:');
    expect(result.stdout).toContain('hierarchy=economic');
    expect(result.stdout).toContain('parent_key=51.00.00');
  });
});
