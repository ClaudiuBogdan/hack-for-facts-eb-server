/**
 * `parliamentVotes(filter.kind)` — the vote-kind partition, and the ONE property
 * that keeps it honest: the regexes the GraphQL description publishes are the
 * regexes the SQL runs.
 *
 * The buckets are deliberately unequal — `legislative` is the `bill_key` COLUMN,
 * the other four are title heuristics over a messy free-text field, and
 * `unclassified` is a SERVED bucket rather than a silent remainder. This file
 * pins that shape:
 *
 *   1. every title pattern reaches BOTH the SQL and the published description,
 *      from the single `VOTE_KIND_TITLE_RULES` declaration (no drift);
 *   2. the buckets are a partition — a title rule excludes every EARLIER rule and
 *      `unclassified` excludes them all, so no vote is counted twice and none is
 *      dropped;
 *   3. `legislative` is a column test with NO title regex in it at all;
 *   4. an unknown bucket is an error and `in: []` matches nothing — never a
 *      quietly dropped predicate that widens the list to the whole corpus.
 *
 * The SQL is compiled by the REAL Kysely query against a capturing driver, so what
 * is asserted here is what ships. The live-data proof (the partition sums to the
 * corpus) is the parliament golden suite.
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
  votesFilterSpec,
} from '@/modules/parliament/shell/filters/specs.js';
import {
  buildVoteKindCondition,
  makeParliamentRepo,
} from '@/modules/parliament/shell/repo/parliament-repo.js';
import {
  toConditionBuilders,
  toGraphQLInput,
  type FilterInput,
  type ProdDatabase,
} from '@/modules/shared/index.js';

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

/** Both queries listVotes issues: the page (has `order by`) and the capped count. */
const compileVotes = async (
  filter: FilterInput
): Promise<{ page: Captured; count: Captured; all: readonly Captured[] }> => {
  const captured: Captured[] = [];
  const repo = makeParliamentRepo(makeCapturingDb(captured));
  const res = await repo.listVotes(filter, 'voteDate', 'desc', { first: 20 });
  expect(res.isOk()).toBe(true);
  const page = captured.find((c) => c.sql.includes('order by'));
  const count = captured.find((c) => c.sql.includes('count(*)'));
  if (page === undefined || count === undefined) throw new Error('missing page/count query');
  return {
    page: { sql: flat(page.sql), parameters: page.parameters },
    count: { sql: flat(count.sql), parameters: count.parameters },
    all: captured,
  };
};

/** The title patterns present as bound parameters of a compiled query. */
const patternParams = (captured: Captured): readonly unknown[] =>
  captured.parameters.filter((p) => VOTE_KIND_TITLE_RULES.some((r) => r.pattern === p));

/**
 * The WHERE clause alone.
 *
 * These assertions are about what the FILTER scans, and the filter is the WHERE
 * clause. The select list now carries the same rules as a projected value
 * (`ParliamentVote.kind`), inlined rather than bound — so a whole-statement
 * search finds title regexes on every vote query and would say nothing about
 * whether `kind: legislative` still rides votes_bill_idx, which is the fact
 * being pinned.
 */
const whereOf = (captured: Captured): string => {
  const from = captured.sql.indexOf(' where ');
  if (from === -1) return '';
  const to = captured.sql.indexOf(' order by ', from);
  return to === -1 ? captured.sql.slice(from) : captured.sql.slice(from, to);
};

describe('kind — one declaration, two consumers (no doc/SQL drift)', () => {
  it('is declared virtual, so the kernel composer emits NO SQL for it', () => {
    const r = toConditionBuilders(votesFilterSpec, { kind: { eq: 'amendment' } });
    expect(r.isOk()).toBe(true);
    if (r.isOk()) expect(r.value).toHaveLength(0);
  });

  it('publishes EVERY executed pattern in the GraphQL description, verbatim', async () => {
    const sdl = toGraphQLInput(votesFilterSpec);
    expect(sdl).toContain('input ParliamentVotesKindFilter');
    expect(sdl).toContain('kind: ParliamentVotesKindFilter');

    for (const rule of VOTE_KIND_TITLE_RULES) {
      // The description carries the regex as written…
      expect(sdl).toContain(rule.pattern.replace(/\\/gu, '\\\\'));
      // …and the SQL binds that same string.
      const { page } = await compileVotes({ kind: { eq: rule.kind } });
      expect(page.parameters).toContain(rule.pattern);
    }
  });

  it('names the honest signals: the column bucket, the residual, the known misfiling', () => {
    const sdl = toGraphQLInput(votesFilterSpec);
    expect(sdl).toContain('votes.bill_key is not null');
    expect(sdl).toContain('votes_bill_idx');
    expect(sdl).toContain('TITLE HEURISTICS');
    expect(sdl).toContain('unclassified');
    // The bare-reference caveat the user asked for, in the field the client reads.
    expect(sdl).toContain('PL 434/2025');
    expect(sdl).toContain('KNOWN MISFILING');
  });

  it('exposes every bucket, and only real buckets, on the enum', () => {
    const field = votesFilterSpec.fields.find((f) => f.name === 'kind');
    expect(field?.enumValues).toEqual([...VOTE_KINDS]);
    // Every title rule is a declared bucket; legislative/unclassified are the two
    // that have no title rule of their own.
    for (const rule of VOTE_KIND_TITLE_RULES) expect(VOTE_KINDS).toContain(rule.kind);
    const ruleKinds = VOTE_KIND_TITLE_RULES.map((r) => r.kind);
    expect(VOTE_KINDS.filter((k) => !ruleKinds.includes(k))).toEqual([
      'legislative',
      'unclassified',
    ]);
  });
});

describe('kind — the buckets are an ordered, disjoint, exhaustive partition', () => {
  it('legislative is the COLUMN — no title regex anywhere in the predicate', async () => {
    const { page } = await compileVotes({ kind: { eq: 'legislative' } });
    expect(whereOf(page)).toContain('v.bill_key is not null');
    expect(whereOf(page)).not.toContain('translate(coalesce(v.title');
    expect(patternParams(page)).toHaveLength(0);
  });

  it('a title bucket excludes every EARLIER rule and matches its own', async () => {
    for (const [index, rule] of VOTE_KIND_TITLE_RULES.entries()) {
      const { page } = await compileVotes({ kind: { eq: rule.kind } });
      // Title rules only ever look at votes with no bill link.
      expect(page.sql).toContain('v.bill_key is null');
      // The earlier rules are negated, in declaration order, then its own matches.
      expect(patternParams(page)).toEqual([
        ...VOTE_KIND_TITLE_RULES.slice(0, index).map((r) => r.pattern),
        rule.pattern,
      ]);
      const negations = whereOf(page).match(/!~/gu) ?? [];
      expect(negations).toHaveLength(index);
      expect(whereOf(page).match(/ ~ /gu) ?? []).toHaveLength(1);
    }
  });

  it('unclassified is a SERVED bucket: no bill link and no rule matched', async () => {
    const { page } = await compileVotes({ kind: { eq: 'unclassified' } });
    expect(page.sql).toContain('v.bill_key is null');
    expect(patternParams(page)).toEqual(VOTE_KIND_TITLE_RULES.map((r) => r.pattern));
    // EVERY rule negated, none matched — the complement of the other five buckets.
    expect(whereOf(page).match(/!~/gu) ?? []).toHaveLength(VOTE_KIND_TITLE_RULES.length);
    expect(whereOf(page)).not.toMatch(/ ~ [^~]/u);
  });

  it('folds case + diacritics on the title, exactly like the q fallback', async () => {
    const { page } = await compileVotes({ kind: { eq: 'attendance' } });
    expect(page.sql).toContain("lower(translate(coalesce(v.title, '')");
    expect(page.parameters).toContain('ăâîșşțţĂÂÎȘŞȚŢ');
  });

  it('an `in` of several buckets ORs the disjoint predicates', async () => {
    const { page } = await compileVotes({ kind: { in: ['amendment', 'procedural'] } });
    expect(page.sql).toContain(' or ');
    const amendment = VOTE_KIND_TITLE_RULES.find((r) => r.kind === 'amendment');
    const procedural = VOTE_KIND_TITLE_RULES.find((r) => r.kind === 'procedural');
    expect(page.parameters).toContain(amendment?.pattern);
    expect(page.parameters).toContain(procedural?.pattern);
  });

  it('emits NO title predicate when kind is absent', async () => {
    const { page } = await compileVotes({ chamber: { eq: 'camera_deputatilor' } });
    expect(whereOf(page)).not.toContain('translate(coalesce(v.title');
  });
});

describe('kind — input validation (never a silently dropped predicate)', () => {
  it('is a no-op when absent or empty', () => {
    expect(buildVoteKindCondition(undefined)._unsafeUnwrap()).toBeNull();
    expect(buildVoteKindCondition({})._unsafeUnwrap()).toBeNull();
    // A runtime null (GraphQL nullable input field) reads as absent, not as a crash.
    expect(buildVoteKindCondition({ eq: null })._unsafeUnwrap()).toBeNull();
  });

  it('rejects an unknown bucket instead of matching everything', () => {
    const r = buildVoteKindCondition({ eq: 'budget' });
    expect(r.isErr()).toBe(true);
    if (r.isErr()) {
      expect(r.error.type).toBe('InvalidInput');
      expect(r.error.message).toContain('kind must be one of');
    }
    expect(buildVoteKindCondition({ in: ['amendment', 'nonsense'] }).isErr()).toBe(true);
  });

  it('compiles an explicit empty `in: []` to FALSE, not to "no filter"', () => {
    const r = buildVoteKindCondition({ in: [] });
    expect(r.isOk()).toBe(true);
    expect(r._unsafeUnwrap()).not.toBeNull();
  });

  it('refuses eq AND in together rather than honouring one and dropping the other', () => {
    const r = buildVoteKindCondition({ eq: 'amendment', in: ['procedural'] });
    expect(r.isErr()).toBe(true);
    if (r.isErr()) expect(r.error.message).toContain('eq OR in');
  });
});

describe('total — the count answers the SAME question as the page', () => {
  it('carries the kind predicate into the capped count, without the keyset', async () => {
    const { count, page } = await compileVotes({ kind: { eq: 'amendment' } });
    const amendment = VOTE_KIND_TITLE_RULES.find((r) => r.kind === 'amendment');
    expect(count.parameters).toContain(amendment?.pattern);
    expect(count.sql).toContain('count(*)');
    // The cap rides a LIMIT subselect (10,000 + 1), so a huge slice never counts
    // the whole table; the page keeps its own row limit.
    expect(count.parameters).toContain(10_001);
    expect(count.sql).not.toContain('order by');
    expect(page.sql).toContain('order by');
  });

  it('counts the filtered slice for a plain filter too (one page + one count query)', async () => {
    const { all, count } = await compileVotes({ chamber: { eq: 'camera_deputatilor' } });
    expect(all).toHaveLength(2);
    expect(count.parameters).toContain('camera_deputatilor');
  });
});
