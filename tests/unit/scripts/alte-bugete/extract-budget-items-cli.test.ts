import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { deserialize } from '@/infra/cache/serialization.js';

const repoRoot = process.cwd();
const scriptDir = path.join(repoRoot, 'scripts/alte-bugete');
const fixtureDir = path.join(repoRoot, 'tests/fixtures/alte-bugete/layout-text');

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
  const harness = `
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(sys.argv[1]).resolve()))

import budget_items
from extract_budget_items import main

fixture_dir = pathlib.Path(sys.argv[2]).resolve()
fixture_map = {
    'Anexa_10.pdf': fixture_dir / 'cnas-pages-001-014.txt',
    'AnexeproiectlegeBASS_09032026.pdf': None,
}
bass_layout = (fixture_dir / 'bass-pages-001-014.txt').read_text(encoding='utf-8')
bas_layout = (fixture_dir / 'bas-pages-043-060.txt').read_text(encoding='utf-8')

def fake_run_pdftotext_layout(pdf_path):
    name = pathlib.Path(pdf_path).name
    if name == 'AnexeproiectlegeBASS_09032026.pdf':
        return bass_layout + '\\n' + bas_layout
    fixture_path = fixture_map.get(name)
    if fixture_path is None:
        raise RuntimeError(f'Unexpected PDF fixture request: {name}')
    return fixture_path.read_text(encoding='utf-8')

budget_items.run_pdftotext_layout = fake_run_pdftotext_layout
raise SystemExit(main(['--input-dir', sys.argv[3], '--output-root', sys.argv[4]]))
`;

  const result = spawnSync(
    'python3',
    ['-c', harness, scriptDir, fixtureDir, inputDir, outputRoot],
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
    const inputDir = await makeTempDir('alte-bugete-cli-input-success-');
    const outputRoot = await makeTempDir('alte-bugete-cli-success-');
    await mkdir(inputDir, { recursive: true });
    await writeFile(path.join(inputDir, 'Anexa_10.pdf'), '');
    await writeFile(path.join(inputDir, 'AnexeproiectlegeBASS_09032026.pdf'), '');

    const result = runCli(inputDir, outputRoot);
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
    expect(merged).toMatch(/\ncnas;\d+;budget_indicator_summary;/);
    expect(merged).toMatch(/\nbass;\d+;budget_indicator_summary;/);
    expect(merged).toMatch(/\nbas;\d+;budget_indicator_summary;/);
  });

  it('writes batch-summary.json but skips the merged file when any slice fails', async () => {
    const inputDir = await makeTempDir('alte-bugete-cli-input-');
    const outputRoot = await makeTempDir('alte-bugete-cli-failure-');

    await mkdir(inputDir, { recursive: true });
    await writeFile(path.join(inputDir, 'Anexa_10.pdf'), '');

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
