/**
 * THE `attrs` PRIVACY GATE (2026-08-05) — the structural replacement for
 * `safeAttrs`.
 *
 * The parliament module used to select the whole `attrs` jsonb and whitelist it in
 * TypeScript after arrival. That gate ran AFTER the bytes had already crossed the
 * API↔DB link, and it could only filter keys someone had thought to name: live
 * `members.attrs` carries `senate_current_roster_alias_evidence` and eight sibling
 * provenance keys, one unreviewed whitelist entry away from a public surface.
 *
 * The gate now lives in SQL: every published key is extracted BY NAME, so the
 * SELECT list is the privacy boundary and an un-named key never leaves Postgres.
 * That only holds while no query re-adds a bare `attrs` selection — which is
 * exactly what this file fails on. It compiles the repo's REAL queries through a
 * capturing driver (no database needed) and inspects the SQL those queries emit.
 *
 * Measured saving on Chronos 2026-08-05, re-validate at full scale: 595B → 278B
 * per bill, 327B → 20B per vote, 328B → 82B per member.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type CompiledQuery,
  type DatabaseConnection,
  type Driver,
  type QueryResult,
} from 'kysely';
import { describe, expect, it } from 'vitest';

import { makeParliamentRepo } from '@/modules/parliament/shell/repo/parliament-repo.js';
import { type ProdDatabase } from '@/modules/shared/index.js';

/** Strip JS line + block comments so assertions match CODE, not doc prose. */
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/\/\/[^\n]*/gu, '');

const repoSource = stripComments(
  readFileSync(
    fileURLToPath(
      new URL('../../../src/modules/parliament/shell/repo/parliament-repo.ts', import.meta.url)
    ),
    'utf8'
  )
);

/** Captures every compiled query; answers each with zero rows. */
const makeCapturingDb = (
  captured: string[]
): { db: Kysely<ProdDatabase>; sql: readonly string[] } => {
  const connection: DatabaseConnection = {
    executeQuery<R>(query: CompiledQuery): Promise<QueryResult<R>> {
      captured.push(query.sql);
      return Promise.resolve({ rows: [] as R[] });
    },
    streamQuery(): AsyncIterableIterator<QueryResult<never>> {
      throw new Error('streamQuery not supported');
    },
  };
  const driver: Driver = {
    init: () => Promise.resolve(),
    acquireConnection: () => Promise.resolve(connection),
    beginTransaction: () => Promise.resolve(),
    commitTransaction: () => Promise.resolve(),
    rollbackTransaction: () => Promise.resolve(),
    releaseConnection: () => Promise.resolve(),
    destroy: () => Promise.resolve(),
  };
  const db = new Kysely<ProdDatabase>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => driver,
      createIntrospector: (d) => new PostgresIntrospector(d),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
  return { db, sql: captured };
};

/**
 * Every `attrs` occurrence that is NOT immediately followed by a jsonb accessor
 * (`->`, `->>`, `#>`, `#>>`). An extraction like `b.attrs->'senate_cod'` is the
 * whole point of the design and is allowed; a bare `"attrs"` in a select list is
 * the bag coming back, and is what this catches.
 *
 * Identifier quotes are STRIPPED first, deliberately. Kysely emits `"b"."attrs"`
 * for a column reference but bare `v.attrs` inside a hand-written `sql` template,
 * so the two forms must be normalised. Matching the quotes inline instead (`"?attrs"?`)
 * looks equivalent and is not: the regex backtracks, matching `attrs` with the
 * closing quote UNconsumed, so the lookahead then sees `"` rather than `->` and
 * every legitimate quoted extraction reports as an offender.
 */
const bareAttrsSelections = (sql: string): readonly string[] =>
  sql.replace(/"/gu, '').match(/\battrs\b(?!\s*(?:->>?|#>>?))(?:.{0,40})/gu) ?? [];

/**
 * Bag selections in the repo SOURCE, matched by syntactic POSITION rather than by
 * the `'x.attrs'` token — which appears in the safe form too. Two shapes:
 *   1. a select-list element:      `['b.attrs'` or `…,\n  'b.attrs'`
 *   2. a single-expression select: `.select('b.attrs')`
 * Neither can match `attrText('b.attrs', …)`, where the literal follows `(`.
 */
const bagSelections = (source: string): readonly string[] => [
  ...(source.match(/[[,]\s*'[bvme]\.attrs'/gu) ?? []),
  ...(source.match(/\.select\w*\(\s*'[bvme]\.attrs'/gu) ?? []),
];

/**
 * Exercises the read paths that project a bill, vote or member row. Each call is
 * expected to reach the driver; the canned empty result is enough, because the
 * assertion is on the SQL that was SENT, not on what came back.
 */
const runProjectingReads = async (db: Kysely<ProdDatabase>): Promise<void> => {
  const repo = makeParliamentRepo(db);
  await repo.listBills({}, 'updated_desc', { page: 1, pageSize: 10 });
  await repo.findBill('12760');
  await repo.listVotes({}, 'vote_date', 'desc', { first: 10 });
  await repo.findVote('cdep:29892');
  await repo.getBillInitiators(['12760']);
  await repo.listVotesForBill(['12760']);
};

/**
 * The compiled-SQL checks below can only see the six queries `runProjectingReads`
 * happens to execute — roughly a quarter of the module's read paths — and they are
 * blind to `.selectAll()`, which compiles to `"t".*` and contains no `attrs` token
 * at all while shipping every column of its target. These two SOURCE-level checks
 * close both holes: they read the repo file itself, so they cover EVERY query,
 * including ones added tomorrow and never registered in the compiled-SQL harness.
 * (Prior art for asserting on repo source: `tests/unit/pnrr/pnrr-pii.test.ts`.)
 */
describe('the attrs bag never crosses the wire — source-level', () => {
  it('no query selects a bare attrs column, in ANY read path', () => {
    expect(bagSelections(repoSource)).toEqual([]);
  });

  /**
   * A POSITIVE CONTROL for the detector itself, and the reason it exists.
   *
   * The first two versions of this gate both passed while measuring the wrong
   * thing. One matched `"?attrs"?` and was defeated by regex backtracking the
   * moment identifiers became quoted; the other used `not.toContain("'b.attrs'")`
   * and flagged all 28 CORRECT `attrText('b.attrs', …)` extractions, because the
   * token appears in the safe and unsafe forms alike. A gate whose verdict tracks
   * the SQL builder's quoting style, or a helper's argument list, is decoration.
   *
   * So the detector is fed sources whose answer is known. If it stops firing on
   * the bad ones, it is no longer a gate no matter how green it looks.
   */
  it('the detector actually fires on a re-added bag, and not on a correct extraction', () => {
    // Known-BAD: the exact shapes a bag selection takes in this codebase.
    expect(bagSelections("const S = ['b.bill_key', 'b.attrs'] as const;")).not.toEqual([]);
    expect(bagSelections("  .select([\n    'v.attrs',\n  ])")).not.toEqual([]);
    expect(bagSelections(".select('m.attrs')")).not.toEqual([]);
    expect(bagSelections("const S = [\n  'e.attrs',\n];")).not.toEqual([]);

    // Known-GOOD: the helper call and its own type union must stay silent.
    expect(bagSelections("attrText('b.attrs', 'status_text').as('status_text'),")).toEqual([]);
    expect(bagSelections("column: 'b.attrs' | 'v.attrs' | 'm.attrs',")).toEqual([]);
    expect(bagSelections("sql`lower(${attrText('b.attrs', 'status_text')})`")).toEqual([]);
  });

  it('pins the known-safe .selectAll() sites so a new one must be justified', () => {
    // `.selectAll()` on a BASE table would ship every jsonb column with no `attrs`
    // token in the SQL, so nothing else here would notice. The two present sites
    // both target a DERIVED table (`ranked.as('t')`) whose inner select is already
    // MEMBER_SELECT / VOTE_SELECT, so they only propagate a named projection.
    // If this count changes, check what the new one targets before raising it.
    const sites = repoSource.match(/\.selectAll\(\)/gu) ?? [];
    expect(sites).toHaveLength(2);
  });
});

describe('the attrs bag never crosses the wire', () => {
  it('no bill / vote / member read selects a raw attrs column', async () => {
    const captured: string[] = [];
    const { db } = makeCapturingDb(captured);
    await runProjectingReads(db);

    expect(captured.length).toBeGreaterThan(0);
    const offenders = captured.flatMap((sql) =>
      bareAttrsSelections(sql).map((hit) => `${hit} … in: ${sql.slice(0, 120)}`)
    );
    expect(offenders).toEqual([]);
  });

  it('still extracts the published keys by name — the gate is not just an absence', async () => {
    const captured: string[] = [];
    const { db } = makeCapturingDb(captured);
    await runProjectingReads(db);
    const all = captured.join('\n');

    // A positive control paired with the negative above: proving "no bare attrs"
    // is worthless if the extractions silently disappeared too, which would leave
    // every one of these fields null on a green suite.
    for (const key of [
      `"b"."attrs"->'status_text'`,
      `"b"."attrs"->'procedure'->'tip_initiativa'`,
      `"b"."attrs"->'last_event_date'`,
      `"b"."attrs"->'procedure'->'caracter'`,
      `"b"."attrs"->'procedure'->'procedura_urgenta'`,
      `"b"."attrs"->'procedure'->'procedura_legislativa'`,
      `"b"."attrs"->'object_of_regulation'`,
      `"b"."attrs"->'last_event_description'`,
      `"b"."attrs"->'last_event_source'`,
      `"b"."attrs"->'cdep_project_url'`,
      `"b"."attrs"->'senate_detail_url'`,
      `"b"."attrs"->'senate_fisa_url'`,
      `"b"."attrs"->'senate_opinions_url'`,
      `"b"."attrs"->'senate_cod'`,
      `"b"."attrs"->'government_e_number'`,
      `"b"."attrs"->'government_e_year'`,
      `"b"."attrs"->'initiator_classification'->'value'`,
      `"b"."attrs"->'initiator_classification'->'confidence'`,
      `"b"."attrs"->'initiator_classification'->'method'`,
      `"v"."attrs"->'vote_action'`,
      `"v"."attrs"->'vote_datetime_text'`,
      `"m"."attrs"->'profile_url'`,
      `"m"."attrs"->'cv_pdf_url'`,
    ]) {
      expect(all, `expected the SQL to extract ${key}`).toContain(key);
    }
  });

  /**
   * `decision_chamber` is read from the COLUMN, not from
   * `attrs.procedure.camera_decizionala`. The loader's derive owns the
   * normalization (`nullif(trim(…),'-')`, which nulls the 21 rows printing the
   * source's placeholder) and recomputes the whole table every load, with drift
   * from attrs as a blocking gate term. Re-deriving that rule here would be a
   * second definition, free to drift from the one the loader enforces.
   */
  it('reads decisionChamber from the derived column, not from attrs', async () => {
    const captured: string[] = [];
    const { db } = makeCapturingDb(captured);
    await runProjectingReads(db);
    const all = captured.join('\n');

    expect(all).toContain('decision_chamber');
    expect(all).not.toContain('camera_decizionala');
  });

  /**
   * `tally_mismatch` is a jsonb OBJECT on 925 votes and only its PRESENCE is
   * public (§2.6). The SQL must reduce it to a boolean so the per-choice
   * official-vs-recorded split never leaves the database.
   *
   * It must use `jsonb_typeof(…) <> 'null'`, NOT `is not null`: `->` returns jsonb
   * 'null' rather than SQL NULL for a key holding a null, so `is not null` would
   * report a mismatch where the old mapper's `!= null` reported none. All 925 live
   * values are objects today, so this guards the contract, not a current row.
   */
  it('reduces tally_mismatch to a boolean without exposing the object', async () => {
    const captured: string[] = [];
    const { db } = makeCapturingDb(captured);
    await runProjectingReads(db);
    const all = captured.join('\n');

    expect(all).toContain("jsonb_typeof(v.attrs->'tally_mismatch')");
    expect(all).toContain("<> 'null'");
    expect(all).not.toContain("attrs->>'tally_mismatch'");
  });
});
