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
  'table_type',
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
    table_type: 'Sinteza',
    row_code: '',
    capitol: '5001',
    subcapitol: '00',
    paragraph: '00',
    grupa_titlu: '00',
    articol: '00',
    alineat: '00',
    functional: '5001.00.00',
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
  const dir = await mkdtemp(path.join(tmpdir(), 'budget-consistency-'));
  const csvPath = path.join(dir, 'budget_indicator_summary.csv');
  const lines = [
    budgetFieldnames.join(';'),
    ...rows.map((row) => budgetFieldnames.map((fieldname) => row[fieldname]).join(';')),
  ];
  await writeFile(csvPath, `${lines.join('\n')}\n`, 'utf8');
  return csvPath;
}

function runValidator(csvPath: string): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(
    'python3',
    ['scripts/validate_budget_indicator_consistency.py', '--input', csvPath],
    {
      cwd: repoRoot,
      encoding: 'utf8',
    }
  );

  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

describe('validate_budget_indicator_consistency.py', () => {
  it('passes when Sinteza totals match the detailed budget rows', async () => {
    const csvPath = await writeBudgetCsv([
      makeRow({
        table_type: 'Sinteza',
        row_code: '5001',
        description: 'CHELTUIELI - BUGET DE STAT',
        realizari_2024: '100',
        executie_preliminata_2025: '120',
        propuneri_2026: '130',
      }),
      makeRow({
        table_type: 'Buget pe capitole - buget de stat',
        section:
          'Bugetul pe capitole, subcapitole, paragrafe, titluri de cheltuieli, articole si alineate | pe anii 2024-2029 | (sume alocate din bugetul de stat)',
        row_code: '5001',
        description: 'CHELTUIELI - BUGET DE STAT',
        realizari_2024: '100',
        executie_preliminata_2025: '120',
        propuneri_2026: '130',
      }),
      makeRow({
        table_type: 'Sinteza',
        row_code: '59',
        grupa_titlu: '59',
        economic: '59.00.00',
        description: 'TITLUL XI ALTE CHELTUIELI',
        realizari_2024: '5',
        executie_preliminata_2025: '',
        propuneri_2026: '11',
      }),
      makeRow({
        table_type: 'Buget pe capitole - buget de stat',
        section:
          'Bugetul pe capitole, subcapitole, paragrafe, titluri de cheltuieli, articole si alineate | pe anii 2024-2029 | (sume alocate din bugetul de stat)',
        row_code: '59',
        grupa_titlu: '59',
        economic: '59.00.00',
        description: 'TITLUL XI ALTE CHELTUIELI',
        realizari_2024: '5',
        executie_preliminata_2025: '',
        propuneri_2026: '11',
      }),
    ]);

    const result = runValidator(csvPath);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      'Validated 1 top totals, 0 chapter totals, and 1 main-group totals'
    );
    expect(result.stdout).toContain('All checked Sinteza/detail totals matched.');
  });

  it('fails when a detailed main-group row differs from Sinteza', async () => {
    const csvPath = await writeBudgetCsv([
      makeRow({
        table_type: 'Sinteza',
        row_code: '59',
        grupa_titlu: '59',
        economic: '59.00.00',
        description: 'TITLUL XI ALTE CHELTUIELI',
        realizari_2024: '5',
        executie_preliminata_2025: '',
        propuneri_2026: '11',
      }),
      makeRow({
        table_type: 'Buget pe capitole - buget de stat',
        section:
          'Bugetul pe capitole, subcapitole, paragrafe, titluri de cheltuieli, articole si alineate | pe anii 2024-2029 | (sume alocate din bugetul de stat)',
        row_code: '59',
        grupa_titlu: '59',
        economic: '59.00.00',
        description: 'TITLUL XI ALTE CHELTUIELI',
        realizari_2024: '',
        executie_preliminata_2025: '5',
        propuneri_2026: '11',
      }),
    ]);

    const result = runValidator(csvPath);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('Found 2 consistency mismatches:');
    expect(result.stdout).toContain('level=main_group_total');
    expect(result.stdout).toContain('economic=59.00.00');
  });
});
