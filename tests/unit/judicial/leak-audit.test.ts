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
 *     `candidates`), and the legal-ref span offsets (`span_start`, `span_end`).
 * `display_name` may survive ONLY in the one gated repo (it selects it) and in
 * `schema.ts` (it DECLARES the table column the gated repo selects).
 * `raw_text` (the stored extracted citation token, A1) may survive ONLY as its
 * `JusticeCaseLegalReferencesTable` declaration and as the single
 * `lr.raw_text as citation` selection in the legal-ref repo.
 *
 * API-04 SCOPED EXCEPTION (human instruction: serve the stored decision data as
 * is, defer the privacy project): the NEW `justice.decision_subject_links`
 * evidence JSON may survive ONLY at its exact decision-link boundaries, each
 * exactly once — the link table declaration (schema.ts), the core link type
 * (types.ts), the repo row type + mapper + single `l.evidence` selection
 * (decisions-repo.ts), the SDL link type field (typedefs.ts) and the REST link
 * schema key (rest/schemas.ts). Everywhere else `evidence` stays forbidden,
 * and the positive controls below pin that the OLD party-company and
 * case-lineage candidate evidence is still never declared, selected or served.
 *
 * Plus parsed-AST checks: the SDL declares no forbidden FIELD (`sourceField` only
 * on `JudicialLegalRef`), and the case_hearings table type omits
 * solution/solution_summary.
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

const SCHEMA_FILE = join('shell', 'db', 'schema.ts');
const LEGAL_REF_REPO_FILE = join('shell', 'repo', 'legal-ref-repo.ts');
const CITATION_SELECTION = /\blr\.raw_text as citation\b/gu;
const LEGAL_REF_TABLE = /interface JusticeCaseLegalReferencesTable\s*\{[\s\S]*?\n\}/u;

const DECISION_LINK_EVIDENCE: readonly {
  readonly file: string;
  /** The enclosing boundary (type/table/schema/selection) the permitted form must sit in. */
  readonly scope: RegExp;
  /** The permitted form, removed exactly once from inside that boundary. */
  readonly form: RegExp;
}[] = [
  {
    file: join('shell', 'db', 'schema.ts'),
    scope: /interface JusticeDecisionSubjectLinksTable\s*\{[\s\S]*?\n\}/u,
    form: /^\s*evidence: unknown;\s*$/mu,
  },
  {
    file: join('core', 'types.ts'),
    scope: /interface JudicialDecisionSubjectLink\s*\{[\s\S]*?\n\}/u,
    form: /^\s*readonly evidence: unknown;\s*$/mu,
  },
  {
    file: join('shell', 'repo', 'decisions-repo.ts'),
    scope: /interface LinkRow\s*\{[\s\S]*?\n\}/u,
    form: /^\s*evidence: unknown;\s*$/mu,
  },
  {
    file: join('shell', 'repo', 'decisions-repo.ts'),
    scope: /const mapLink = [\s\S]*?\n\}\);/u,
    form: /^\s*evidence: r\.evidence,\s*$/mu,
  },
  {
    file: join('shell', 'repo', 'decisions-repo.ts'),
    scope: /from justice\.decision_subject_links l\b/u,
    form: /\bl\.evidence,/u,
  },
  {
    file: join('shell', 'graphql', 'typedefs.ts'),
    scope: /type JudicialDecisionSubjectLink\s*\{[\s\S]*?\}/u,
    form: /^\s*evidence: JSON\s*$/mu,
  },
  {
    file: join('shell', 'rest', 'schemas.ts'),
    scope: /DecisionSubjectLinkSchema = Type\.Object\(\{[\s\S]*?\n\}\);/u,
    form: /^\s*evidence: Type\.Unknown\(\),\s*$/mu,
  },
];

/**
 * Remove each permitted decision-link `evidence` form of a file EXACTLY ONCE
 * from inside its boundary (API-04). A missing or duplicated form, or one
 * outside its boundary, leaves `evidence` in the residue and fails the audit.
 * The selection form is checked against the SQL statement that reads the link
 * table (its boundary must exist in the same file).
 */
const withoutPermittedEvidence = (file: string, residue: string): string => {
  let out = residue;
  for (const permitted of DECISION_LINK_EVIDENCE) {
    if (!file.endsWith(permitted.file)) continue;
    if (!permitted.scope.test(out)) continue;
    if (permitted.form.source === '\\bl\\.evidence,') {
      if ((out.match(/\bl\.evidence,/gu) ?? []).length === 1) out = out.replace(permitted.form, '');
      continue;
    }
    out = out.replace(permitted.scope, (scoped) => scoped.replace(permitted.form, ''));
  }
  return out;
};

/** Remove the ONE permitted `raw_text` form of each file (A1); the rest must be clean. */
const withoutPermittedRawText = (file: string, residue: string): string => {
  if (file.endsWith(SCHEMA_FILE)) {
    return residue.replace(LEGAL_REF_TABLE, (table) =>
      table.replace(/^\s*raw_text:\s*string;\s*$/mu, '')
    );
  }
  if (file.endsWith(LEGAL_REF_REPO_FILE)) return residue.replace(CITATION_SELECTION, '');
  return residue;
};

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
    expect(
      offenders,
      `solution/solution_summary in projection residue: ${offenders.join(', ')}`
    ).toEqual([]);
  });

  it('display_name survives ONLY in the gated repo (+ the schema declaration) (test 1/3.1)', () => {
    const offenders: string[] = [];
    let gatedHasIt = false;
    for (const [file, residue] of residues) {
      const hasIt = /\bdisplay_name\b/u.test(residue);
      if (file.endsWith(GATED_FILE)) gatedHasIt = hasIt;
      else if (hasIt && !file.endsWith('schema.ts')) offenders.push(label(file));
    }
    expect(
      offenders,
      `display_name selected/used outside the gated repo: ${offenders.join(', ')}`
    ).toEqual([]);
    expect(gatedHasIt, 'the gated repo must read display_name').toBe(true);
  });

  it('candidate jsonb/PII columns never survive in a projection (test 6)', () => {
    const offenders: string[] = [];
    for (const [file, residue] of residues) {
      for (const col of ['candidate_company_name', 'reviewed_by', '\\bcandidates\\b']) {
        if (new RegExp(col, 'u').test(residue)) offenders.push(`${label(file)}: ${col}`);
      }
      // API-04: only the exact decision-link evidence boundaries are exempt.
      if (/\bevidence\b/u.test(withoutPermittedEvidence(file, residue))) {
        offenders.push(`${label(file)}: \\bevidence\\b`);
      }
    }
    expect(offenders, `candidate PII/jsonb in projection residue: ${offenders.join(', ')}`).toEqual(
      []
    );
  });

  it('legal-ref span offsets never survive; raw_text only as the declared token and the one citation selection (S2, A1)', () => {
    const offenders: string[] = [];
    for (const [file, residue] of residues) {
      for (const col of ['span_start', 'span_end']) {
        if (new RegExp(`\\b${col}\\b`, 'u').test(residue)) offenders.push(`${label(file)}: ${col}`);
      }
      if (/\braw_text\b/u.test(withoutPermittedRawText(file, residue))) {
        offenders.push(`${label(file)}: raw_text`);
      }
    }
    expect(offenders, `raw legal-ref span in projection residue: ${offenders.join(', ')}`).toEqual(
      []
    );
  });

  it('the legal-ref repo selects raw_text exactly once, aliased to citation (A1)', () => {
    const residue = residues.get(join(MODULE_DIR, LEGAL_REF_REPO_FILE)) ?? '';
    expect(residue.match(CITATION_SELECTION)).toHaveLength(1);
  });
});

describe('judicial leak audit — the API-04 decision-link evidence exception stays exact', () => {
  const read = (rel: string): string => readFileSync(join(MODULE_DIR, rel), 'utf8');
  const residueOf = (rel: string): string => projectionResidue(read(rel));

  it('each permitted decision-link form exists exactly once, inside its boundary', () => {
    for (const permitted of DECISION_LINK_EVIDENCE) {
      const residue = residueOf(permitted.file);
      const scope = permitted.scope.exec(residue);
      expect(scope, `${permitted.file}: boundary ${permitted.scope.source}`).not.toBeNull();
      const where = permitted.form.source === '\\bl\\.evidence,' ? residue : (scope?.[0] ?? '');
      const global = new RegExp(permitted.form.source, 'gmu');
      expect(where.match(global), `${permitted.file}: ${permitted.form.source}`).toHaveLength(1);
    }
  });

  it('the exception admits no evidence anywhere else: a second selection would fail', () => {
    const repo = residueOf(join('shell', 'repo', 'decisions-repo.ts'));
    const file = join(MODULE_DIR, 'shell', 'repo', 'decisions-repo.ts');
    expect(/\bevidence\b/u.test(withoutPermittedEvidence(file, repo))).toBe(false);
    const doubled = repo.replace(/\bl\.evidence,/u, 'l.evidence, l.evidence,');
    expect(/\bevidence\b/u.test(withoutPermittedEvidence(file, doubled))).toBe(true);
    const routes = join(MODULE_DIR, 'shell', 'rest', 'routes.ts');
    expect(/\bevidence\b/u.test(withoutPermittedEvidence(routes, 'reply.evidence'))).toBe(true);
  });

  it('POSITIVE CONTROL: the old candidate tables still declare no evidence', () => {
    const schema = residueOf(join('shell', 'db', 'schema.ts'));
    for (const table of [
      'JusticePartyCompanyCandidatesTable',
      'JusticeCaseLineageCandidatesTable',
    ]) {
      const body = new RegExp(`interface ${table}\\s*\\{[\\s\\S]*?\\n\\}`, 'u').exec(schema)?.[0];
      expect(body, table).toBeDefined();
      expect(/\bevidence\b/u.test(body ?? ''), `${table} declares evidence`).toBe(false);
    }
  });

  it('POSITIVE CONTROL: the lineage and company-link repos select no evidence; only the link table is read for it', () => {
    for (const rel of [
      join('shell', 'repo', 'lineage-repo.ts'),
      join('shell', 'repo', 'company-link-repo.ts'),
    ]) {
      expect(/\bevidence\b/u.test(residueOf(rel)), rel).toBe(false);
    }
    const repo = read(join('shell', 'repo', 'decisions-repo.ts'));
    expect(repo).not.toMatch(/party_company_candidates|case_lineage_candidates/u);
  });

  it('POSITIVE CONTROL: only JudicialDecisionSubjectLink declares an evidence field in the SDL', () => {
    const owners: string[] = [];
    for (const def of parse(judicialTypeDefs).definitions) {
      if (
        (def.kind === Kind.OBJECT_TYPE_DEFINITION || def.kind === Kind.OBJECT_TYPE_EXTENSION) &&
        def.fields !== undefined
      ) {
        for (const field of def.fields) {
          if (field.name.value === 'evidence') owners.push(def.name.value);
        }
      }
    }
    expect(owners).toEqual(['JudicialDecisionSubjectLink']);
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
    const forbidden = new Set(['displayName', 'solutionSummary', 'solution', 'rawText']);
    const offenders: string[] = [];
    let legalRefHasSourceField = false;
    for (const def of parse(judicialTypeDefs).definitions) {
      if (
        (def.kind === Kind.OBJECT_TYPE_DEFINITION || def.kind === Kind.OBJECT_TYPE_EXTENSION) &&
        def.fields !== undefined
      ) {
        const typeName = 'name' in def ? def.name.value : '?';
        for (const field of def.fields) {
          if (forbidden.has(field.name.value)) offenders.push(`${typeName}.${field.name.value}`);
          // A1: the citation's source field is served on the legal ref ONLY.
          if (field.name.value === 'sourceField') {
            if (typeName === 'JudicialLegalRef') legalRefHasSourceField = true;
            else offenders.push(`${typeName}.sourceField`);
          }
        }
      }
    }
    expect(offenders, `SDL declares forbidden field(s): ${offenders.join(', ')}`).toEqual([]);
    expect(legalRefHasSourceField, 'JudicialLegalRef.sourceField').toBe(true);
  });

  it('BOTH legal-ref readers exclude the solution_summary source_field (S2)', () => {
    const code = readFileSync(join(MODULE_DIR, 'shell/repo/legal-ref-repo.ts'), 'utf8');
    expect(code.match(/lr\.source_field <> \$\{FORBIDDEN_REF_SOURCE_FIELD\}/gu)).toHaveLength(2);
  });
});
