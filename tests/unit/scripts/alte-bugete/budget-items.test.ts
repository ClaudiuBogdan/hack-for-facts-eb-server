import { execFileSync } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { deserialize } from '@/infra/cache/serialization.js';

const repoRoot = process.cwd();
const scriptDir = path.join(repoRoot, 'scripts/alte-bugete');
const fixtureDir = path.join(repoRoot, 'tests/fixtures/alte-bugete/layout-text');

function runPythonJson(script: string, args: string[] = []): unknown {
  const stdout = execFileSync('python3', ['-c', script, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  const parsed = deserialize(stdout);
  if (!parsed.ok) {
    throw new Error(parsed.error.message);
  }
  return parsed.value;
}

async function makeTempDir(prefix: string): Promise<string> {
  return mkdtemp(path.join(tmpdir(), prefix));
}

describe('alte-bugete budget_items.py', () => {
  it('extracts detailed and synteza slices with normalized metadata', () => {
    const result = runPythonJson(
      `
import json
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(sys.argv[1]).resolve()))

from budget_items import extract_slice_bundle_from_layout_text
from slice_config import SLICE_CONFIGS_BY_ID

fixture_dir = pathlib.Path(sys.argv[2])
slice_specs = {
    'cnas': fixture_dir / 'cnas-pages-001-014.txt',
    'bass': fixture_dir / 'bass-pages-001-014.txt',
    'bas': fixture_dir / 'bas-pages-043-060.txt',
}

payload = {}
for slice_id, fixture_path in slice_specs.items():
    config = SLICE_CONFIGS_BY_ID[slice_id]
    bundle = extract_slice_bundle_from_layout_text(fixture_path.read_text(encoding='utf-8'), config)
    detail_top_row = next(
        row for row in bundle.detail.rows
        if row['row_code'] == config.top_row_code and row['credit_type'] == 'II.Credite bugetare'
    )
    synteza_top_row = next(
        row for row in bundle.synteza.rows
        if row['row_code'] == config.top_row_code and row['credit_type'] == 'II.Credite bugetare'
    )
    payload[slice_id] = {
        'detail_pages': bundle.detail.source_pages,
        'synteza_pages': bundle.synteza.source_pages,
        'detail_table_types': sorted({row['table_type'] for row in bundle.detail.rows}),
        'synteza_table_types': sorted({row['table_type'] for row in bundle.synteza.rows}),
        'detail_out_of_range_pages': sorted({
            row['source_page']
            for row in bundle.detail.rows
            if row['source_page'] < config.detail_page_start or row['source_page'] > config.detail_page_end
        }),
        'synteza_out_of_range_pages': sorted({
            row['source_page']
            for row in bundle.synteza.rows
            if row['source_page'] < config.synteza_page_start or row['source_page'] > config.synteza_page_end
        }),
        'detail_top': {
            'row_code': detail_top_row['row_code'],
            'description': detail_top_row['description'],
            'realizari_2024': detail_top_row['realizari_2024'],
        },
        'synteza_top': {
            'row_code': synteza_top_row['row_code'],
            'description': synteza_top_row['description'],
            'realizari_2024': synteza_top_row['realizari_2024'],
        },
    }

print(json.dumps(payload))
`,
      [scriptDir, fixtureDir]
    ) as Record<
      string,
      {
        detail_out_of_range_pages: number[];
        detail_pages: number[];
        detail_table_types: string[];
        detail_top: { description: string; realizari_2024: string; row_code: string };
        synteza_out_of_range_pages: number[];
        synteza_pages: number[];
        synteza_table_types: string[];
        synteza_top: { description: string; realizari_2024: string; row_code: string };
      }
    >;

    expect(result['cnas']?.detail_pages).toEqual([8, 9, 10, 11, 12, 13, 14]);
    expect(result['cnas']?.synteza_pages).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(result['cnas']?.detail_table_types).toEqual(['Buget pe capitole - FNUASS']);
    expect(result['cnas']?.synteza_table_types).toEqual(['Sinteza']);
    expect(result['cnas']?.detail_out_of_range_pages).toEqual([]);
    expect(result['cnas']?.synteza_out_of_range_pages).toEqual([]);
    expect(result['cnas']?.detail_top.row_code).toBe('5005');
    expect(result['cnas']?.synteza_top.row_code).toBe('5005');

    expect(result['bass']?.detail_pages).toEqual([7, 8, 9, 10, 11, 12, 13, 14]);
    expect(result['bass']?.synteza_pages).toEqual([1, 2, 3, 4, 5, 6]);
    expect(result['bass']?.detail_table_types).toEqual(['Buget pe capitole - BASS']);
    expect(result['bass']?.synteza_table_types).toEqual(['Sinteza']);
    expect(result['bass']?.detail_out_of_range_pages).toEqual([]);
    expect(result['bass']?.synteza_out_of_range_pages).toEqual([]);
    expect(result['bass']?.detail_top.row_code).toBe('5003');
    expect(result['bass']?.synteza_top.row_code).toBe('5003');

    expect(result['bas']?.detail_pages).toEqual([50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 60]);
    expect(result['bas']?.synteza_pages).toEqual([43, 44, 45, 46, 47, 48, 49]);
    expect(result['bas']?.detail_table_types).toEqual(['Buget pe capitole - BAS']);
    expect(result['bas']?.synteza_table_types).toEqual(['Sinteza']);
    expect(result['bas']?.detail_out_of_range_pages).toEqual([]);
    expect(result['bas']?.synteza_out_of_range_pages).toEqual([]);
    expect(result['bas']?.detail_top.row_code).toBe('5004');
    expect(result['bas']?.synteza_top.row_code).toBe('5004');
  });

  it('keeps raw pdf values except direct parser fixes and surfaces warnings', async () => {
    const tempDir = await makeTempDir('alte-bugete-budget-items-');
    const result = runPythonJson(
      `
import json
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(sys.argv[1]).resolve()))

from budget_items import (
    extract_slice_bundle_from_layout_text,
    validate_slice_outputs,
    write_budget_csv,
    write_synteza_csv,
)
from slice_config import SLICE_CONFIGS_BY_ID

fixture_dir = pathlib.Path(sys.argv[2])
temp_dir = pathlib.Path(sys.argv[3])
slice_specs = {
    'cnas': fixture_dir / 'cnas-pages-001-014.txt',
    'bass': fixture_dir / 'bass-pages-001-014.txt',
    'bas': fixture_dir / 'bas-pages-043-060.txt',
}

payload = {}
for slice_id, fixture_path in slice_specs.items():
    config = SLICE_CONFIGS_BY_ID[slice_id]
    bundle = extract_slice_bundle_from_layout_text(fixture_path.read_text(encoding='utf-8'), config)
    output_dir = temp_dir / slice_id
    detail_csv = write_budget_csv(output_dir, bundle.detail.rows)
    synteza_csv = write_synteza_csv(output_dir, bundle.synteza.rows)
    validation = validate_slice_outputs(
        detail_csv_path=detail_csv,
        synteza_csv_path=synteza_csv,
        config=config,
        detail_extraction_warnings=bundle.detail.warnings,
        synteza_extraction_warnings=bundle.synteza.warnings,
    )

    selected = {}
    if slice_id == 'cnas':
        selected['detail_5005_60'] = next(
            row for row in bundle.detail.rows
            if row['credit_type'] == 'II.Credite bugetare'
            and row['functional'] == '5005.00.00'
            and row['economic'] == '60.00.00'
        )
        selected['detail_6605_04'] = next(
            row for row in bundle.detail.rows
            if row['credit_type'] == 'II.Credite bugetare'
            and row['functional'] == '6605.04.00'
            and row['economic'] == '00.00.00'
        )
        selected['synteza_6605_top'] = next(
            row for row in bundle.synteza.rows
            if row['credit_type'] == 'II.Credite bugetare'
            and row['functional'] == '6605.00.00'
            and row['economic'] == '00.00.00'
        )
    if slice_id == 'bass':
        selected['synteza_5003_top_i'] = next(
            row for row in bundle.synteza.rows
            if row['credit_type'] == 'I.Credite de angajament'
            and row['functional'] == '5003.00.00'
            and row['economic'] == '00.00.00'
        )
        selected['synteza_6803_top_ii'] = next(
            row for row in bundle.synteza.rows
            if row['credit_type'] == 'II.Credite bugetare'
            and row['functional'] == '6803.00.00'
            and row['economic'] == '00.00.00'
        )
    if slice_id == 'bas':
        selected['synteza_6804_top'] = next(
            row for row in bundle.synteza.rows
            if row['credit_type'] == 'II.Credite bugetare'
            and row['functional'] == '6804.00.00'
            and row['economic'] == '00.00.00'
        )

    payload[slice_id] = {
        'status': validation.status,
        'detail_mismatch_count': len(validation.detail_rollups.mismatches),
        'synteza_mismatch_count': len(validation.synteza_rollups.mismatches),
        'consistency_mismatch_count': len(validation.consistency.mismatches),
        'structural_warnings': validation.structural.warnings,
        'manual_sync_cells': bundle.manual_sync_cells,
        'selected': selected,
    }

print(json.dumps(payload))
`,
      [scriptDir, fixtureDir, tempDir]
    ) as Record<
      string,
      {
        consistency_mismatch_count: number;
        detail_mismatch_count: number;
        manual_sync_cells: number;
        selected: Record<string, Record<string, string>>;
        status: string;
        structural_warnings: string[];
        synteza_mismatch_count: number;
      }
    >;
    const cnas = result['cnas'];
    const bass = result['bass'];
    const bas = result['bas'];

    expect(cnas).toBeDefined();
    expect(bass).toBeDefined();
    expect(bas).toBeDefined();

    expect(cnas?.status).toBe('warning');
    expect(cnas?.detail_mismatch_count).toBe(1);
    expect(cnas?.synteza_mismatch_count).toBe(0);
    expect(cnas?.consistency_mismatch_count).toBe(0);
    expect(cnas?.structural_warnings).toEqual([]);
    expect(cnas?.manual_sync_cells).toBe(4);
    expect(cnas?.selected['detail_5005_60']?.['realizari_2024']).toBe('1');
    expect(cnas?.selected['detail_5005_60']?.['executie_preliminata_2025']).toBe('');
    expect(cnas?.selected['detail_6605_04']?.['realizari_2024']).toBe('11995091');
    expect(cnas?.selected['synteza_6605_top']?.['realizari_2024']).toBe('69498831');

    expect(bass?.status).toBe('warning');
    expect(bass?.detail_mismatch_count).toBe(4);
    expect(bass?.synteza_mismatch_count).toBe(0);
    expect(bass?.consistency_mismatch_count).toBe(18);
    expect(bass?.structural_warnings).toEqual([]);
    expect(bass?.manual_sync_cells).toBe(0);
    expect(bass?.selected['synteza_5003_top_i']?.['realizari_2024']).toBe('158185277');
    expect(bass?.selected['synteza_5003_top_i']?.['executie_preliminata_2025']).toBe('158792814');
    expect(bass?.selected['synteza_5003_top_i']?.['propuneri_2026']).toBe('');
    expect(bass?.selected['synteza_6803_top_ii']?.['realizari_2024']).toBe('137651409');
    expect(bass?.selected['synteza_6803_top_ii']?.['executie_preliminata_2025']).toBe('157932041');

    expect(bas?.status).toBe('warning');
    expect(bas?.detail_mismatch_count).toBe(5);
    expect(bas?.synteza_mismatch_count).toBe(0);
    expect(bas?.consistency_mismatch_count).toBe(0);
    expect(bas?.structural_warnings).toEqual([]);
    expect(bas?.manual_sync_cells).toBe(0);
    expect(bas?.selected['synteza_6804_top']?.['realizari_2024']).toBe('1005247');
  });

  it('downgrades validation issues to warnings', async () => {
    const tempDir = await makeTempDir('alte-bugete-budget-warning-');
    const result = runPythonJson(
      `
import json
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(sys.argv[1]).resolve()))

from budget_items import (
    extract_slice_bundle_from_layout_text,
    read_budget_csv,
    validate_slice_outputs,
    write_budget_csv,
    write_synteza_csv,
)
from slice_config import SLICE_CONFIGS_BY_ID

fixture_path = pathlib.Path(sys.argv[2])
temp_dir = pathlib.Path(sys.argv[3])
config = SLICE_CONFIGS_BY_ID['cnas']
bundle = extract_slice_bundle_from_layout_text(fixture_path.read_text(encoding='utf-8'), config)
detail_csv = write_budget_csv(temp_dir, bundle.detail.rows)
synteza_csv = write_synteza_csv(temp_dir, bundle.synteza.rows)

fieldnames, rows = read_budget_csv(detail_csv)
for row in rows:
    if row['credit_type'] == 'II.Credite bugetare' and row['functional'] == '5005.00.00' and row['economic'] == '00.00.00':
        row['realizari_2024'] = '999999'
        break

with detail_csv.open('w', encoding='utf-8', newline='') as handle:
    import csv
    writer = csv.DictWriter(handle, fieldnames=fieldnames, delimiter=';', extrasaction='ignore', lineterminator='\\n')
    writer.writeheader()
    for row in rows:
        writer.writerow(row)

validation = validate_slice_outputs(
    detail_csv_path=detail_csv,
    synteza_csv_path=synteza_csv,
    config=config,
    detail_extraction_warnings=bundle.detail.warnings,
    synteza_extraction_warnings=bundle.synteza.warnings,
)

print(json.dumps({
    'status': validation.status,
    'detail_mismatch_count': len(validation.detail_rollups.mismatches),
    'consistency_mismatch_count': len(validation.consistency.mismatches),
}))
`,
      [scriptDir, path.join(fixtureDir, 'cnas-pages-001-014.txt'), tempDir]
    ) as {
      consistency_mismatch_count: number;
      detail_mismatch_count: number;
      status: string;
    };

    expect(result.status).toBe('warning');
    expect(result.detail_mismatch_count).toBeGreaterThanOrEqual(0);
    expect(result.consistency_mismatch_count).toBeGreaterThan(0);
  });
});
