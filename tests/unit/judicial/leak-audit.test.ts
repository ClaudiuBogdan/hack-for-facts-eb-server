/**
 * Judicial — THE PRIVACY LEAK AUDIT (plan 08 §12, the gate). STRUCTURAL guards
 * that fail CI if any surface can emit a forbidden column.
 *
 * The audit removes everything that CANNOT be a projection — TS block/line
 * comments, SDL `#` comments, and single/double-quoted STRING LITERALS (SDL
 * descriptions + MCP `description:` text are English prose, never a SQL column) —
 * and keeps what CAN be a projection: identifiers, `sql`...`` TEMPLATE LITERALS
 * (the raw SQL the repo runs), object keys, `.select([...])`. A forbidden column
 * surviving in that residue is a real leak.
 *
 * Forbidden in residue across the whole module:
 *   - `solution_summary` (permanent) and `solution` (withheld v1),
 *   - candidate jsonb/PII (`candidate_company_name`, `reviewed_by`, `evidence`,
 *     `candidates`), and the raw legal-ref span (`raw_text`, `span_start`,
 *     `span_end`).
 * `display_name` may survive ONLY in the one gated repo (it selects it) and in
 * `schema.ts` (it DECLARES the table column the gated repo selects).
 *
 * Plus parsed-AST checks: the SDL declares no forbidden FIELD, and the
 * case_hearings table type omits solution/solution_summary.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Kind, parse } from 'graphql';
import { describe, expect, it } from 'vitest';

import { judicialTypeDefs } from '@/modules/judicial/shell/graphql/typedefs.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const MODULE_DIR = join(HERE, '../../../src/modules/judicial');
const GATED_FILE = 'party-dictionary-repo.ts';

const collectFiles = (dir: string): string[] => {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...collectFiles(full));
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
};

/**
 * Reduce source to its PROJECTION RESIDUE: strip block/line comments, SDL `#`
 * comments, and single/double-quoted string literals (prose). Template literals
 * (`...`) are KEPT — that is where the SQL lives.
 */
const projectionResidue = (src: string): string =>
  src
    .replace(/\/\*[\s\S]*?\*\//gu, '') // block comments
    .replace(/^\s*\/\/.*$/gmu, '') // full-line comments
    .replace(/\/\/[^\n]*$/gmu, '') // trailing line comments
    .replace(/^\s*#.*$/gmu, '') // SDL `#` comments (inside template literals)
    .replace(/'(?:[^'\\]|\\.)*'/gu, "''") // single-quoted string literals → empty
    .replace(/"(?:[^"\\]|\\.)*"/gu, '""'); // double-quoted string literals → empty

const files = collectFiles(MODULE_DIR);

describe('judicial leak audit — projection-residue invariants', () => {
  const residues = new Map(files.map((f) => [f, projectionResidue(readFileSync(f, 'utf8'))]));
  const label = (f: string): string => f.replace(MODULE_DIR, 'judicial');

  it('solution_summary / solution never survive in a projection (test 1/2)', () => {
    const offenders: string[] = [];
    for (const [file, residue] of residues) {
      const masked = residue.replace(/solution_summary/gu, '');
      if (/\bsolution_summary\b/u.test(residue)) offenders.push(`${label(file)}: solution_summary`);
      if (/\bsolution\b/u.test(masked)) offenders.push(`${label(file)}: solution`);
    }
    expect(offenders, `solution/solution_summary in projection residue: ${offenders.join(', ')}`).toEqual([]);
  });

  it('display_name survives ONLY in the gated repo (+ the schema declaration) (test 1/3.1)', () => {
    const offenders: string[] = [];
    let gatedHasIt = false;
    for (const [file, residue] of residues) {
      const hasIt = /\bdisplay_name\b/u.test(residue);
      if (file.endsWith(GATED_FILE)) gatedHasIt = hasIt;
      else if (hasIt && !file.endsWith('schema.ts')) offenders.push(label(file));
    }
    expect(offenders, `display_name selected/used outside the gated repo: ${offenders.join(', ')}`).toEqual([]);
    expect(gatedHasIt, 'the gated repo must read display_name').toBe(true);
  });

  it('candidate jsonb/PII columns never survive in a projection (test 6)', () => {
    const offenders: string[] = [];
    for (const [file, residue] of residues) {
      for (const col of ['candidate_company_name', 'reviewed_by', '\\bevidence\\b', '\\bcandidates\\b']) {
        if (new RegExp(col, 'u').test(residue)) offenders.push(`${label(file)}: ${col}`);
      }
    }
    expect(offenders, `candidate PII/jsonb in projection residue: ${offenders.join(', ')}`).toEqual([]);
  });

  it('raw legal-ref span (raw_text/span_start/span_end) never survives in a projection (S2)', () => {
    const offenders: string[] = [];
    for (const [file, residue] of residues) {
      for (const col of ['raw_text', 'span_start', 'span_end']) {
        if (new RegExp(`\\b${col}\\b`, 'u').test(residue)) offenders.push(`${label(file)}: ${col}`);
      }
    }
    expect(offenders, `raw legal-ref span in projection residue: ${offenders.join(', ')}`).toEqual([]);
  });
});

describe('judicial leak audit — structural type invariants', () => {
  it('the case_hearings table type omits solution / solution_summary (compile-error guard)', () => {
    const schema = readFileSync(join(MODULE_DIR, 'shell/db/schema.ts'), 'utf8');
    const m = /interface JusticeCaseHearingsTable\s*\{([\s\S]*?)\n\}/u.exec(schema);
    expect(m, 'JusticeCaseHearingsTable must exist').not.toBeNull();
    const body = (m?.[1] ?? '').replace(/\/\/[^\n]*/gu, '');
    expect(/^\s*solution\s*:/mu.test(body), 'no `solution:` field').toBe(false);
    expect(/^\s*solution_summary\s*:/mu.test(body), 'no `solution_summary:` field').toBe(false);
  });

  it('GraphQL SDL declares NO forbidden FIELD (parsed AST, comments excluded)', () => {
    const forbidden = new Set(['displayName', 'solutionSummary', 'solution', 'rawText', 'sourceField']);
    const offenders: string[] = [];
    for (const def of parse(judicialTypeDefs).definitions) {
      if (
        (def.kind === Kind.OBJECT_TYPE_DEFINITION || def.kind === Kind.OBJECT_TYPE_EXTENSION) &&
        def.fields !== undefined
      ) {
        const typeName = 'name' in def ? def.name.value : '?';
        for (const field of def.fields) {
          if (forbidden.has(field.name.value)) offenders.push(`${typeName}.${field.name.value}`);
        }
      }
    }
    expect(offenders, `SDL declares forbidden field(s): ${offenders.join(', ')}`).toEqual([]);
  });

  it('the legal-ref projection excludes the solution_summary source_field (S2)', () => {
    const code = readFileSync(join(MODULE_DIR, 'shell/repo/legal-ref-repo.ts'), 'utf8');
    expect(code).toMatch(/source_field\s*<>/u);
    expect(code).toContain('FORBIDDEN_REF_SOURCE_FIELD');
  });
});
