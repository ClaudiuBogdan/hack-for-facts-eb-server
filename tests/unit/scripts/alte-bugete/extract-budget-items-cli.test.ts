import { spawnSync } from 'node:child_process';
import { copyFile, mkdtemp, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { deserialize } from '@/infra/cache/serialization.js';

const repoRoot = process.cwd();
const cliPath = path.join(repoRoot, 'scripts/alte-bugete/extract_budget_items.py');
const sourceInputDir = path.join(repoRoot, 'scripts/input/alte-bugete');

async function makeTempDir(prefix: string): Promise<string> {
  return mkdtemp(path.join(tmpdir(), prefix));
}

function runCli(
  inputDir: string,
  outputRoot: string
): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const result = spawnSync(
    'python3',
    [cliPath, '--input-dir', inputDir, '--output-root', outputRoot],
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

describe('alte-bugete extract_budget_items.py', () => {
  it('writes per-slice outputs, batch-summary.json, and merged-budget-indicator-summary.csv', async () => {
    const outputRoot = await makeTempDir('alte-bugete-cli-success-');
    const result = runCli(sourceInputDir, outputRoot);
    const batchSummaryFile = await readFile(path.join(outputRoot, 'batch-summary.json'), 'utf8');
    const batchSummaryResult = deserialize(batchSummaryFile);
    const merged = await readFile(
      path.join(outputRoot, 'merged-budget-indicator-summary.csv'),
      'utf8'
    );

    if (!batchSummaryResult.ok) {
      throw new Error(batchSummaryResult.error.message);
    }
    const batchSummary = batchSummaryResult.value as { slice_id: string; status: string }[];

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Merged slices: 3');
    expect(result.stdout).toContain('Warning slices: 3');
    expect(result.stdout).toContain('- cnas: warning');
    expect(result.stdout).toContain('- bass: warning');
    expect(result.stdout).toContain('- bas: warning');

    expect(batchSummary.map((entry) => entry.slice_id)).toEqual(['cnas', 'bass', 'bas']);
    expect(batchSummary.every((entry) => entry.status === 'warning')).toBe(true);
    await expect(
      readFile(path.join(outputRoot, 'cnas', 'sinteza_budget_indicator_summary.csv'), 'utf8')
    ).resolves.toContain('Sinteza');
    expect(merged.split('\n')[0]).toBe(
      'slice_id;source_page;family;section;table_type;row_code;capitol;subcapitol;paragraph;grupa_titlu;articol;alineat;functional;economic;description;credit_type;realizari_2024;executie_preliminata_2025;propuneri_2026;crestere_descrestere_2026_2025;estimari_2027;estimari_2028;estimari_2029'
    );
    expect(merged).toContain('cnas;8;budget_indicator_summary;');
    expect(merged).toContain('bass;7;budget_indicator_summary;');
    expect(merged).toContain('bas;50;budget_indicator_summary;');
  });

  it('writes batch-summary.json but skips the merged file when any slice fails', async () => {
    const inputDir = await makeTempDir('alte-bugete-cli-input-');
    const outputRoot = await makeTempDir('alte-bugete-cli-failure-');

    await mkdir(inputDir, { recursive: true });
    await copyFile(path.join(sourceInputDir, 'Anexa_10.pdf'), path.join(inputDir, 'Anexa_10.pdf'));

    const result = runCli(inputDir, outputRoot);
    const batchSummaryFile = await readFile(path.join(outputRoot, 'batch-summary.json'), 'utf8');
    const batchSummaryResult = deserialize(batchSummaryFile);

    if (!batchSummaryResult.ok) {
      throw new Error(batchSummaryResult.error.message);
    }
    const batchSummary = batchSummaryResult.value as { slice_id: string; status: string }[];

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Skipped merged output because');
    expect(batchSummary.map((entry) => entry.slice_id)).toEqual(['cnas', 'bass', 'bas']);
    expect(batchSummary.some((entry) => entry.status === 'failure')).toBe(true);
    await expect(
      readFile(path.join(outputRoot, 'merged-budget-indicator-summary.csv'), 'utf8')
    ).rejects.toThrow();
  });
});
