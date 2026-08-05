/**
 * `ParliamentVote.kind` and `ParliamentVote.voteLinks` — what a division was ON
 * and what it was procedurally FOR, on the vote itself.
 *
 * Both exist because the vote surfaces are not the bill surface. On a bill page
 * the reader already has the bill, and `voteSubject` plus the edge's role tell
 * the divisions apart. On the votes hub and the vote-detail page neither holds:
 * 8,408 divisions have no bill link at all, and off the `legislative` bucket the
 * chamber prints no subject in 92-97% of rows — there the TITLE is already the
 * motion, and `kind` is what places it.
 *
 * The one property `kind` must never lose is that it agrees with the `kind`
 * FILTER. They are compiled from the same `VOTE_KIND_TITLE_RULES`, and this file
 * pins that they stay compiled from it — the live-data proof (both partition all
 * 20,745 prod rows identically, zero off-diagonal) is in PARLIAMENT_NOTES.
 */
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

import {
  VOTE_KINDS,
  VOTE_KIND_TITLE_RULES,
} from '../../../src/modules/parliament/shell/filters/specs.js';
import { parliamentTypeDefs } from '../../../src/modules/parliament/shell/graphql/typedefs.js';
import { makeParliamentRepo } from '../../../src/modules/parliament/shell/repo/parliament-repo.js';

import type { ProdDatabase } from '../../../src/modules/shared/index.js';

interface Captured {
  readonly sql: string;
  readonly parameters: readonly unknown[];
}

const makeCapturingDb = (captured: Captured[]): Kysely<ProdDatabase> => {
  const connection: DatabaseConnection = {
    executeQuery<R>(query: CompiledQuery): Promise<QueryResult<R>> {
      captured.push({ sql: query.sql, parameters: query.parameters });
      return Promise.resolve({ rows: [] as R[] });
    },
    streamQuery(): AsyncIterableIterator<QueryResult<never>> {
      throw new Error('streamQuery not supported in the capturing db');
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
  return new Kysely<ProdDatabase>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => driver,
      createIntrospector: (db) => new PostgresIntrospector(db),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
};

const flat = (s: string): string => s.replace(/\s+/gu, ' ').trim();

/** The SELECT list of the compiled page query (everything before ` from `). */
const selectListOf = async (): Promise<Captured> => {
  const captured: Captured[] = [];
  const repo = makeParliamentRepo(makeCapturingDb(captured));
  await repo.listVotes({}, 'voteDate', 'desc', { first: 20 });
  const page = captured.find((c) => c.sql.includes('order by'));
  if (page === undefined) throw new Error('missing page query');
  const sql = flat(page.sql);
  return { sql: sql.slice(0, sql.indexOf(' from ')), parameters: page.parameters };
};

describe('ParliamentVote.kind — one rule set, a filter AND a field', () => {
  it('projects a CASE built from every title rule, in declaration order', async () => {
    const select = await selectListOf();
    expect(select.sql).toContain('as "kind"');
    expect(select.sql).toContain("when v.bill_key is not null then 'legislative'");
    expect(select.sql).toContain("else 'unclassified' end");

    // Order is the whole correctness argument: a CASE is first-match-wins, which
    // is what makes it agree with the predicate's "fails every earlier rule".
    const positions = VOTE_KIND_TITLE_RULES.map((r) => select.sql.indexOf(`then '${r.kind}'`));
    expect(positions.every((p) => p > -1)).toBe(true);
    expect([...positions]).toEqual([...positions].sort((a, b) => a - b));
  });

  it('runs the SAME regex the filter and the description publish', async () => {
    const select = await selectListOf();
    for (const rule of VOTE_KIND_TITLE_RULES) expect(select.sql).toContain(rule.pattern);
  });

  it('binds NOTHING — a projected expression must not renumber the WHERE clause', async () => {
    // A select-list parameter sits ahead of every predicate placeholder, so
    // binding here would shift $n across all vote queries, and shift it again on
    // each new rule. The constants are compile-time literals from a frozen table
    // (the repo asserts they carry no quote before inlining them).
    const select = await selectListOf();
    expect(select.sql).not.toContain('$');
    for (const rule of VOTE_KIND_TITLE_RULES) {
      expect(select.parameters).not.toContain(rule.pattern);
    }
  });

  it('is exposed as a non-null enum rendered from VOTE_KINDS', () => {
    expect(parliamentTypeDefs).toContain('kind: ParliamentVoteKind!');
    expect(parliamentTypeDefs).toContain('enum ParliamentVoteKind {');
    // Rendered, not hand-written: every bucket the filter accepts is readable
    // back off the field, so the two vocabularies cannot drift apart.
    for (const kind of VOTE_KINDS) {
      expect(parliamentTypeDefs).toMatch(
        new RegExp(`enum ParliamentVoteKind \\{[^}]*\\b${kind}\\b`, 'u')
      );
    }
  });
});

describe('ParliamentVote.voteLinks — the role, from the vote side', () => {
  it('queries bill_vote_links by vote_key, not by bill_key', async () => {
    const captured: Captured[] = [];
    const repo = makeParliamentRepo(makeCapturingDb(captured));
    const res = await repo.getVoteLinks('senat:DE89A4FC-E2E8-467B-B730-3DA7A0EEA476');
    expect(res.isOk()).toBe(true);
    const q = captured.find((c) => c.sql.includes('bill_vote_links'));
    expect(q).toBeDefined();
    expect(flat(q?.sql ?? '')).toContain('"bvl"."vote_key" = $1');
    // Retracted edges are claims we have WITHDRAWN — excluded on every active
    // read (2026-08-04), while candidate/ambiguous edges stay surfaced with
    // their resolutionStatus intact.
    expect(flat(q?.sql ?? '')).toContain('"bvl"."resolution_status" != $2');
    expect(q?.parameters).toEqual([
      'senat:DE89A4FC-E2E8-467B-B730-3DA7A0EEA476',
      'retracted',
    ]);
    // The role is the point of the field; selecting the edge without it would
    // leave the caller exactly where billKey already left them.
    expect(flat(q?.sql ?? '')).toContain('"bvl"."role"');
  });

  it('is a LIST on the vote — 1,502 divisions link to two bills', () => {
    expect(parliamentTypeDefs).toContain('voteLinks: [ParliamentBillVoteLink!]!');
    // …and the edge can resolve its bill, so a vote page can name it rather than
    // print an opaque key.
    expect(parliamentTypeDefs).toContain('bill: ParliamentBill');
  });

  it('warns, in the schema itself, that role is the MOTION and not the result', () => {
    // The trap this whole slice exists for: a final_adoption motion voted DOWN
    // (441 links) reads as an adoption to anything that trusts role alone.
    expect(parliamentTypeDefs).toContain('role names the MOTION ON THE FLOOR');
  });
});
