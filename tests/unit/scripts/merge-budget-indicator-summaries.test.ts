import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const repoRoot = process.cwd();
const budgetHeader = [
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
];

interface BatchEntry {
  document_id: string;
  interpretation: string;
  output_dir: string;
}

async function makeTempDir(prefix: string): Promise<string> {
  return mkdtemp(path.join(tmpdir(), prefix));
}

async function writeBudgetCsv(dir: string, rows: string[][], header = budgetHeader): Promise<void> {
  const csvPath = path.join(dir, 'budget_indicator_summary.csv');
  const lines = [header.join(';'), ...rows.map((row) => row.join(';'))];
  await writeFile(csvPath, `${lines.join('\n')}\n`, 'utf8');
}

async function writeBatchSummary(batchRoot: string, entries: BatchEntry[]): Promise<void> {
  await writeFile(
    path.join(batchRoot, 'batch-summary.json'),
    `${JSON.stringify(entries, null, 2)}\n`,
    'utf8'
  );
}

function runMerge(
  batchRoot: string,
  outputPath: string
): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const result = spawnSync(
    'python3',
    [
      'scripts/merge_budget_indicator_summaries.py',
      '--batch-root',
      batchRoot,
      '--output',
      outputPath,
    ],
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

describe('merge_budget_indicator_summaries.py', () => {
  it('merges acceptable budget summaries and prepends the entity column', async () => {
    const batchRoot = await makeTempDir('merge-budget-');
    const outputPath = path.join(batchRoot, 'national-budget-indicator-summary.csv');
    const entityA = path.join(batchRoot, 'entity-a');
    const entityB = path.join(batchRoot, 'entity-b');
    await mkdir(entityA);
    await mkdir(entityB);

    await writeBudgetCsv(entityA, [
      [
        '1',
        'budget_indicator_summary',
        'Section A',
        'Sinteza',
        '5000',
        '5000',
        '00',
        '00',
        '00',
        '00',
        '00',
        '5000.00.00',
        '00.00.00',
        'TOTAL GENERAL',
        'II.Credite bugetare',
        '100',
        '200',
        '300',
        '1.50',
        '400',
        '500',
        '600',
      ],
    ]);
    await writeBudgetCsv(entityB, [
      [
        '2',
        'budget_indicator_summary',
        'Section B',
        'Sinteza',
        '5100',
        '5100',
        '00',
        '00',
        '00',
        '00',
        '00',
        '5100.00.00',
        '00.00.00',
        'TOTAL GENERAL',
        'I.Credite de angajament',
        '',
        '900',
        '1000',
        '2.75',
        '1100',
        '1200',
        '1300',
      ],
    ]);

    await writeBatchSummary(batchRoot, [
      { document_id: 'entity-a', interpretation: 'acceptable', output_dir: entityA },
      { document_id: 'entity-b', interpretation: 'acceptable', output_dir: entityB },
    ]);

    const result = runMerge(batchRoot, outputPath);
    const merged = await readFile(outputPath, 'utf8');
    const lines = merged.trim().split('\n');

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Included documents: 2');
    expect(lines[0]).toBe(`entity;${budgetHeader.join(';')}`);
    expect(lines[1]?.startsWith('entity-a;1;budget_indicator_summary')).toBe(true);
    expect(lines[2]?.startsWith('entity-b;2;budget_indicator_summary')).toBe(true);
    expect(lines[1]?.includes(';Sinteza;')).toBe(true);
    expect(lines[2]?.includes(';Sinteza;')).toBe(true);
  });

  it('includes both success and warning acceptable documents and skips missing csv files', async () => {
    const batchRoot = await makeTempDir('merge-budget-');
    const outputPath = path.join(batchRoot, 'national-budget-indicator-summary.csv');
    const entityA = path.join(batchRoot, 'entity-a');
    const entityB = path.join(batchRoot, 'entity-b');
    const entityMissing = path.join(batchRoot, 'entity-missing');
    const entityExcluded = path.join(batchRoot, 'entity-excluded');
    await mkdir(entityA);
    await mkdir(entityB);
    await mkdir(entityMissing);
    await mkdir(entityExcluded);

    const row = [
      '1',
      'budget_indicator_summary',
      'Section A',
      'Sinteza',
      '5000',
      '5000',
      '00',
      '00',
      '00',
      '00',
      '00',
      '5000.00.00',
      '00.00.00',
      'TOTAL GENERAL',
      'II.Credite bugetare',
      '100',
      '200',
      '300',
      '1.50',
      '400',
      '500',
      '600',
    ];
    await writeBudgetCsv(entityA, [row]);
    await writeBudgetCsv(entityB, [row]);

    await writeBatchSummary(batchRoot, [
      { document_id: 'entity-a', interpretation: 'acceptable', output_dir: entityA },
      { document_id: 'entity-b', interpretation: 'acceptable', output_dir: entityB },
      { document_id: 'entity-missing', interpretation: 'acceptable', output_dir: entityMissing },
      {
        document_id: 'entity-excluded',
        interpretation: 'not acceptable',
        output_dir: entityExcluded,
      },
    ]);

    const result = runMerge(batchRoot, outputPath);
    const merged = await readFile(outputPath, 'utf8');
    const lines = merged.trim().split('\n');

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Included documents: 2');
    expect(result.stdout).toContain('Excluded documents: 1');
    expect(result.stdout).toContain('Skipped missing CSV: 1');
    expect(lines).toHaveLength(3);
  });

  it('fails when included headers differ', async () => {
    const batchRoot = await makeTempDir('merge-budget-');
    const outputPath = path.join(batchRoot, 'national-budget-indicator-summary.csv');
    const entityA = path.join(batchRoot, 'entity-a');
    const entityB = path.join(batchRoot, 'entity-b');
    await mkdir(entityA);
    await mkdir(entityB);

    await writeBudgetCsv(entityA, [
      [
        '1',
        'budget_indicator_summary',
        'Section A',
        'Sinteza',
        '5000',
        '5000',
        '00',
        '00',
        '00',
        '00',
        '00',
        '5000.00.00',
        '00.00.00',
        'TOTAL GENERAL',
        'II.Credite bugetare',
        '100',
        '200',
        '300',
        '1.50',
        '400',
        '500',
        '600',
      ],
    ]);
    await writeBudgetCsv(
      entityB,
      [
        [
          '2',
          'budget_indicator_summary',
          'Section B',
          'Sinteza',
          '5001',
          '5001',
          '00',
          '00',
          '00',
          '00',
          '00',
          '5001.00.00',
          '00.00.00',
          'TOTAL GENERAL',
          'I.Credite de angajament',
          '100',
          '200',
          '300',
          '1.50',
          '400',
          '500',
          '600',
          'extra',
        ],
      ],
      [...budgetHeader, 'unexpected']
    );

    await writeBatchSummary(batchRoot, [
      { document_id: 'entity-a', interpretation: 'acceptable', output_dir: entityA },
      { document_id: 'entity-b', interpretation: 'acceptable', output_dir: entityB },
    ]);

    const result = runMerge(batchRoot, outputPath);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Header mismatch');
  });
});
