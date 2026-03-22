import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { deserialize } from '@/infra/cache/serialization.js';

const repoRoot = process.cwd();

function runPython(script: string, args: string[] = []): unknown {
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

describe('extract_pdf_tables_batch.py', () => {
  it('stages only PDFs while preserving relative paths', async () => {
    const sourceDir = await makeTempDir('anexa-source-');
    const nestedDir = path.join(sourceDir, 'nested');
    await mkdir(nestedDir);
    await writeFile(path.join(sourceDir, 'a.pdf'), 'pdf-a', 'utf8');
    await writeFile(path.join(sourceDir, 'ignore.txt'), 'text', 'utf8');
    await writeFile(path.join(nestedDir, 'b.PDF'), 'pdf-b', 'utf8');

    const stagedDir = await makeTempDir('anexa-staged-');

    const result = runPython(
      `
import json
from pathlib import Path
from scripts.extract_pdf_tables_batch import stage_pdf_inputs

source_dir = Path(__import__('sys').argv[1])
staged_dir = Path(__import__('sys').argv[2])
paths = stage_pdf_inputs(source_dir, staged_dir)
print(json.dumps([str(path.relative_to(staged_dir)) for path in paths]))
`,
      [sourceDir, stagedDir]
    );

    expect(result).toEqual(['a.pdf', 'nested/b.PDF']);
  });

  it('marks a document as success when extraction and validation pass', async () => {
    const stagedDir = await makeTempDir('anexa-batch-staged-');
    const outputDir = await makeTempDir('anexa-batch-out-');
    const stagedPdf = path.join(stagedDir, 'entity.pdf');
    await writeFile(stagedPdf, 'dummy-pdf', 'utf8');

    const result = runPython(
      `
import json
from decimal import Decimal
from pathlib import Path

from scripts.extract_pdf_tables_batch import process_pdf_document
from scripts.validate_pdf_totals import ValidationSummary

staged_pdf = Path(__import__('sys').argv[1])
document_dir = Path(__import__('sys').argv[2])

def extractor(input_path, output_dir):
    (output_dir / 'budget_indicator_summary.csv').write_text('h\\n', encoding='utf-8')
    (output_dir / 'policy_program_summary.csv').write_text('h\\n', encoding='utf-8')
    (output_dir / 'project_sheet_financing.csv').write_text('h\\n', encoding='utf-8')
    (output_dir / 'program_financing_summary.csv').write_text('h\\n', encoding='utf-8')
    (output_dir / 'program_budget_financing.csv').write_text('h\\n', encoding='utf-8')
    (output_dir / 'public_investments.csv').write_text('h\\n', encoding='utf-8')
    return {
        'summary': {
            'policy_program_summary': {'pages': [1], 'row_count': 1, 'output_file': 'policy_program_summary.csv'},
            'budget_indicator_summary': {'pages': [1], 'row_count': 1, 'output_file': 'budget_indicator_summary.csv'},
            'project_sheet_financing': {'pages': [1], 'row_count': 1, 'output_file': 'project_sheet_financing.csv'},
            'program_financing_summary': {'pages': [1], 'row_count': 1, 'output_file': 'program_financing_summary.csv'},
            'program_budget_financing': {'pages': [1], 'row_count': 1, 'output_file': 'program_budget_financing.csv'},
            'public_investments': {'pages': [1], 'row_count': 1, 'output_file': 'public_investments.csv'},
        }
    }

def xlsx_writer(input_dir, output_path):
    output_path.write_text('xlsx', encoding='utf-8')

def validator(csv_path):
    return ValidationSummary(functional_checks=1, economic_checks=2, mismatches=[])

summary = process_pdf_document(
    staged_pdf,
    document_dir,
    extractor=extractor,
    xlsx_writer=xlsx_writer,
    validator=validator,
    preview_limit=5,
)

print(json.dumps({
    'status': summary['status'],
    'interpretation': summary['interpretation'],
    'validation_status': summary['validation']['status'],
    'xlsx_exists': (document_dir / 'tables.xlsx').exists(),
    'report_exists': (document_dir / 'validation.md').exists(),
    'json_exists': (document_dir / 'run-summary.json').exists(),
}))
`,
      [stagedPdf, path.join(outputDir, 'entity')]
    ) as Record<string, boolean | string>;

    expect(result['status']).toBe('success');
    expect(result['interpretation']).toBe('acceptable');
    expect(result['validation_status']).toBe('success');
    expect(result['xlsx_exists']).toBe(true);
    expect(result['report_exists']).toBe(true);
    expect(result['json_exists']).toBe(true);
  });

  it('marks a document as warning when validator reports mismatches', async () => {
    const stagedDir = await makeTempDir('anexa-batch-staged-');
    const outputDir = await makeTempDir('anexa-batch-out-');
    const stagedPdf = path.join(stagedDir, 'entity.pdf');
    await writeFile(stagedPdf, 'dummy-pdf', 'utf8');

    const result = runPython(
      `
import json
from decimal import Decimal
from pathlib import Path

from scripts.extract_pdf_tables_batch import process_pdf_document
from scripts.validate_pdf_totals import RollupMismatch, ValidationSummary

staged_pdf = Path(__import__('sys').argv[1])
document_dir = Path(__import__('sys').argv[2])

def extractor(input_path, output_dir):
    (output_dir / 'budget_indicator_summary.csv').write_text('h\\n', encoding='utf-8')
    return {
        'summary': {
            'policy_program_summary': {'pages': [1], 'row_count': 1, 'output_file': 'policy_program_summary.csv'},
            'budget_indicator_summary': {'pages': [1], 'row_count': 2, 'output_file': 'budget_indicator_summary.csv'},
            'project_sheet_financing': {'pages': [1], 'row_count': 1, 'output_file': 'project_sheet_financing.csv'},
            'program_financing_summary': {'pages': [1], 'row_count': 1, 'output_file': 'program_financing_summary.csv'},
            'program_budget_financing': {'pages': [1], 'row_count': 1, 'output_file': 'program_budget_financing.csv'},
            'public_investments': {'pages': [1], 'row_count': 1, 'output_file': 'public_investments.csv'},
        }
    }

def xlsx_writer(input_dir, output_path):
    output_path.write_text('xlsx', encoding='utf-8')

def validator(csv_path):
    mismatch = RollupMismatch(
        hierarchy='economic',
        section='Section A',
        credit_type='II.Credite bugetare',
        fixed_key='5000.00.00',
        parent_key='51.00.00',
        column='realizari_2024',
        actual=Decimal('10'),
        expected=Decimal('12'),
    )
    return ValidationSummary(functional_checks=1, economic_checks=1, mismatches=[mismatch])

summary = process_pdf_document(
    staged_pdf,
    document_dir,
    extractor=extractor,
    xlsx_writer=xlsx_writer,
    validator=validator,
    preview_limit=5,
)

report = (document_dir / 'validation.md').read_text(encoding='utf-8')
print(json.dumps({
    'status': summary['status'],
    'validation_status': summary['validation']['status'],
    'report_contains_mismatch': 'hierarchy=' in report and 'economic' in report,
}))
`,
      [stagedPdf, path.join(outputDir, 'entity')]
    ) as Record<string, boolean | string>;

    expect(result['status']).toBe('warning');
    expect(result['validation_status']).toBe('warning');
    expect(result['report_contains_mismatch']).toBe(true);
  });

  it('marks a document as failure when extraction fails', async () => {
    const stagedDir = await makeTempDir('anexa-batch-staged-');
    const outputDir = await makeTempDir('anexa-batch-out-');
    const stagedPdf = path.join(stagedDir, 'entity.pdf');
    await writeFile(stagedPdf, 'dummy-pdf', 'utf8');

    const result = runPython(
      `
import json
from pathlib import Path

from scripts.extract_pdf_tables_batch import process_pdf_document

staged_pdf = Path(__import__('sys').argv[1])
document_dir = Path(__import__('sys').argv[2])

def extractor(input_path, output_dir):
    raise RuntimeError('extract boom')

def xlsx_writer(input_dir, output_path):
    output_path.write_text('xlsx', encoding='utf-8')

def validator(csv_path):
    raise AssertionError('validator should not run')

summary = process_pdf_document(
    staged_pdf,
    document_dir,
    extractor=extractor,
    xlsx_writer=xlsx_writer,
    validator=validator,
    preview_limit=5,
)

print(json.dumps({
    'status': summary['status'],
    'interpretation': summary['interpretation'],
    'note': summary['extraction']['note'],
}))
`,
      [stagedPdf, path.join(outputDir, 'entity')]
    ) as Record<string, string>;

    expect(result['status']).toBe('failure');
    expect(result['interpretation']).toBe('not acceptable');
    expect(result['note']).toContain('extract boom');
  });

  it('renders truncated mismatch previews in markdown', () => {
    const result = runPython(
      `
import json
from decimal import Decimal

from scripts.extract_pdf_tables_batch import build_validation_markdown

mismatches = []
for index in range(7):
    mismatches.append({
        'hierarchy': 'economic',
        'section': f'Section {index}',
        'credit_type': 'II.Credite bugetare',
        'fixed_key': '5000.00.00',
        'parent_key': f'51.0{index}.00',
        'column': 'realizari_2024',
        'actual': '10',
        'expected': '12',
    })

document_summary = {
    'source_pdf_name': 'entity.pdf',
    'source_pdf_path': '/tmp/entity.pdf',
    'output_dir': '/tmp/out/entity',
    'status': 'warning',
    'interpretation': 'acceptable',
    'families': {'budget_indicator_summary': {'pages': [1], 'row_count': 2}},
    'extraction': {'status': 'success', 'note': ''},
    'validation': {
        'status': 'warning',
        'note': '7 mismatches detected',
        'summary': {
            'functional_checks': 1,
            'economic_checks': 1,
            'mismatch_count': 7,
            'mismatches': mismatches,
        },
    },
}

markdown = build_validation_markdown(document_summary, preview_limit=3)
print(json.dumps({
    'has_truncation': 'showing 3 of 7 mismatches' in markdown,
    'preview_count': markdown.count('hierarchy='),
}))
`
    ) as Record<string, boolean | number>;

    expect(result['has_truncation']).toBe(true);
    expect(result['preview_count']).toBe(3);
  });
});
