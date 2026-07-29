/**
 * `parliamentVotes(filter.groupVote)` — votes seen through one group's ballots.
 *
 * The field compiles TWO predicates, and `choice` picks which:
 *
 *   (A) NO `choice` — PARTICIPATION: every vote the group cast at least one ballot
 *       on. A bare semi-join, no argmax.
 *   (B) WITH `choice` — the group's derived PLURALITY stance. "PSD voted pentru" is
 *       not a fact in vote_records: 91 members each cast their own ballot. The three
 *       rules that make that derivation honest are what this file pins:
 *         1. PLURALITY over ALL FOUR choices — nu_a_votat included, so "the group
 *            mostly did not show up" is expressible and a vote CAN be attributed.
 *         2. A TIE matches NEITHER tied choice (strict `>` against every other
 *            choice) — the group did not take that position, and sort order must not
 *            invent one. This is also why (B) is a STRICT subset of (A).
 *         3. EXACT group_name matching — vote_records and the parliamentGroups
 *            nomenclator disagree on vocabulary, and fuzzy-bridging would silently
 *            answer a different question.
 *
 * The SQL is compiled by the REAL Kysely query against a capturing driver, so the
 * predicate asserted here is the predicate that ships. The live-data proof that the
 * predicate says what it means is the parliament golden suite (integration).
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
import { ok, type Result } from 'neverthrow';
import { describe, expect, it, vi } from 'vitest';

import { listVotes, type ParliamentUsecaseDeps } from '@/modules/parliament/core/usecases.js';
import { votesFilterSpec } from '@/modules/parliament/shell/filters/specs.js';
import {
  buildGroupVoteCondition,
  makeParliamentRepo,
} from '@/modules/parliament/shell/repo/parliament-repo.js';
import {
  fhashFor,
  toConditionBuilders,
  toGraphQLInput,
  type ApiError,
  type FilterInput,
  type ProdDatabase,
} from '@/modules/shared/index.js';

import type { ParliamentRepo } from '@/modules/parliament/core/ports.js';

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

/** Collapse whitespace so the multi-line raw predicate can be asserted on substrings. */
const flat = (s: string): string => s.replace(/\s+/gu, ' ').trim();

/**
 * Compile the real listVotes PAGE query and return the flattened SQL + parameters.
 * listVotes issues two queries CONCURRENTLY (the page + the capped total), so the
 * page is picked by its `order by` rather than by arrival order.
 */
const compileVotes = async (filter: FilterInput): Promise<Captured> => {
  const captured: Captured[] = [];
  const repo = makeParliamentRepo(makeCapturingDb(captured));
  const res = await repo.listVotes(filter, 'voteDate', 'desc', { first: 20 });
  expect(res.isOk()).toBe(true);
  const query = captured.find((c) => c.sql.includes('order by'));
  if (query === undefined) throw new Error('no page query captured');
  return { sql: flat(query.sql), parameters: query.parameters };
};

const CHOICES = ['pentru', 'impotriva', 'abtinere', 'nu_a_votat'] as const;

describe('groupVote — the composite input shape', () => {
  it('is declared virtual, so the kernel composer emits NO SQL for it', () => {
    const r = toConditionBuilders(votesFilterSpec, {
      groupVote: { group: 'PSD', choice: 'pentru' },
    });
    expect(r.isOk()).toBe(true);
    if (r.isOk()) expect(r.value).toHaveLength(0);
  });

  it('renders `group` REQUIRED and `choice` OPTIONAL in the derived SDL', () => {
    const sdl = toGraphQLInput(votesFilterSpec);
    expect(sdl).toContain('input ParliamentVotesGroupVoteFilter');
    // `group` keeps its `!`: a bare `choice` is "any vote with a pentru ballot",
    // which is nearly the whole corpus, not a subset.
    expect(sdl).toContain('group: String!');
    // `choice` drops its `!`: omitting it is the PARTICIPATION reading, a narrower
    // question in its own right. Still reuses the module enum rather than growing a
    // second copy of the domain.
    expect(sdl).toContain('choice: ParliamentVoteChoice\n');
    expect(sdl).not.toContain('choice: ParliamentVoteChoice!');
    expect(sdl).toContain('groupVote: ParliamentVotesGroupVoteFilter');
    // The two-number caveat must reach the client that links from the cohesion bar.
    expect(sdl).toContain('BALLOT SLOTS');
    // Both readings must be stated where the client actually reads them.
    expect(sdl).toContain('PARTICIPATION');
  });

  it('binds a cursor to BOTH members (group, choice, and choice-vs-no-choice differ)', () => {
    const base = fhashFor(votesFilterSpec, { groupVote: { group: 'PSD', choice: 'pentru' } });
    const otherChoice = fhashFor(votesFilterSpec, {
      groupVote: { group: 'PSD', choice: 'impotriva' },
    });
    const otherGroup = fhashFor(votesFilterSpec, { groupVote: { group: 'AUR', choice: 'pentru' } });
    // The participation reading returns a DIFFERENT (wider) set, so it must not
    // share a cursor with any stance — else a page-2 cursor would replay across it.
    const participation = fhashFor(votesFilterSpec, { groupVote: { group: 'PSD' } });
    expect(base).not.toBe(otherChoice);
    expect(base).not.toBe(otherGroup);
    expect(participation).not.toBe(base);
    expect(participation).not.toBe(fhashFor(votesFilterSpec, { groupVote: { group: 'AUR' } }));
  });
});

describe('groupVote — input validation (never a silently dropped predicate)', () => {
  it('is a no-op when absent or empty', () => {
    expect(
      buildGroupVoteCondition(undefined).isOk() &&
        buildGroupVoteCondition(undefined)._unsafeUnwrap()
    ).toBeNull();
    expect(buildGroupVoteCondition({})._unsafeUnwrap()).toBeNull();
  });

  it('rejects a `choice` with no `group` — that is not a subset of the votes', () => {
    const noGroup = buildGroupVoteCondition({ choice: 'pentru' });
    expect(noGroup.isErr()).toBe(true);
    if (noGroup.isErr()) {
      expect(noGroup.error.type).toBe('InvalidInput');
      expect(noGroup.error.message).toContain('group');
    }
  });

  it('ACCEPTS a `group` with no `choice` — the participation reading, not half a predicate', () => {
    const r = buildGroupVoteCondition({ group: 'PSD' });
    expect(r.isOk()).toBe(true);
    if (r.isOk()) expect(r.value).not.toBeNull();
    // A runtime null choice reads as absent (the GraphQL arg is nullable), so it
    // takes the same participation path rather than erroring.
    expect(buildGroupVoteCondition({ group: 'PSD', choice: null })._unsafeUnwrap()).not.toBeNull();
  });

  it('rejects an unknown choice and a blank group', () => {
    expect(buildGroupVoteCondition({ group: 'PSD', choice: 'maybe' }).isErr()).toBe(true);
    expect(buildGroupVoteCondition({ group: '   ', choice: 'pentru' }).isErr()).toBe(true);
    // A blank group is blank under BOTH readings — the participation path must not
    // become a back door to an unnamed group.
    expect(buildGroupVoteCondition({ group: '   ' }).isErr()).toBe(true);
    // A runtime null on either member reads as absent, not as a crash.
    expect(buildGroupVoteCondition({ group: null, choice: null })._unsafeUnwrap()).toBeNull();
  });
});

describe('groupVote — the plurality predicate that ships', () => {
  /** The bound values between the chamber bound and the `limit`. */
  const predicateParams = (captured: Captured): readonly unknown[] =>
    captured.parameters.slice(1, -1);

  it('requires the target choice to STRICTLY beat every one of the other three', async () => {
    const captured = await compileVotes({
      chamber: { eq: 'camera_deputatilor' },
      groupVote: { group: 'PSD', choice: 'pentru' },
    });
    // Exactly three rival comparisons — one per other choice.
    const comparisons =
      captured.sql.match(
        /count\(\*\) filter \(where vr\.choice = \$\d+\) > count\(\*\) filter \(where vr\.choice = \$\d+\)/gu
      ) ?? [];
    expect(comparisons).toHaveLength(3);
    // TIE RULE: strict `>` only — a `>=` would let a tied group match BOTH sides of
    // its own split (real case: cdep:37014, PSD 38 pentru / 38 nu_a_votat).
    expect(captured.sql).not.toMatch(/count\(\*\) filter \(where vr\.choice = \$\d+\) >=/u);
    // The bound values pair the target against each rival exactly once.
    expect(predicateParams(captured)).toEqual([
      'PSD',
      'pentru', // the `> 0` guard
      'pentru',
      'impotriva',
      'pentru',
      'abtinere',
      'pentru',
      'nu_a_votat',
    ]);
  });

  it('counts nu_a_votat as a rival stance (plurality over ALL FOUR choices)', async () => {
    const captured = await compileVotes({
      chamber: { eq: 'camera_deputatilor' },
      groupVote: { group: 'PSD', choice: 'pentru' },
    });
    const rivals = predicateParams(captured).filter((p) => p !== 'PSD' && p !== 'pentru');
    expect(new Set(rivals)).toEqual(new Set(CHOICES.filter((c) => c !== 'pentru')));
  });

  it('attributes a vote TO nu_a_votat when that is the plurality', async () => {
    const captured = await compileVotes({
      chamber: { eq: 'camera_deputatilor' },
      groupVote: { group: 'PSD', choice: 'nu_a_votat' },
    });
    expect(predicateParams(captured)).toEqual([
      'PSD',
      'nu_a_votat',
      'nu_a_votat',
      'pentru',
      'nu_a_votat',
      'impotriva',
      'nu_a_votat',
      'abtinere',
    ]);
  });

  it('never matches a group that cast no ballots on the vote (the > 0 guard)', async () => {
    const { sql } = await compileVotes({
      chamber: { eq: 'camera_deputatilor' },
      groupVote: { group: 'PSD', choice: 'pentru' },
    });
    expect(sql).toMatch(/having count\(\*\) filter \(where vr\.choice = \$\d+\) > 0 and/u);
  });

  it('matches group_name EXACTLY — no ilike, no fold, no slug bridging', async () => {
    const captured = await compileVotes({
      chamber: { eq: 'camera_deputatilor' },
      // The ballot vocabulary, diacritics and all — passed through untouched.
      groupVote: { group: 'Senatori neafiliați', choice: 'pentru' },
    });
    expect(captured.sql).toMatch(/vr\.group_name = \$\d+/u);
    expect(captured.parameters).toContain('Senatori neafiliați');
    expect(captured.sql).not.toContain('vr.group_name ilike');
    expect(captured.sql).not.toContain('translate(vr.group_name');
    expect(captured.sql).not.toContain('lower(vr.group_name');
  });

  it('correlates on vote_key so the aggregate rides vote_records_pkey', async () => {
    const { sql } = await compileVotes({
      chamber: { eq: 'camera_deputatilor' },
      groupVote: { group: 'PSD', choice: 'pentru' },
    });
    expect(sql).toContain(
      'exists (select 1 from parliament.vote_records vr where vr.vote_key = v.vote_key'
    );
  });

  it('emits NO vote_records predicate when groupVote is absent', async () => {
    const { sql } = await compileVotes({ chamber: { eq: 'camera_deputatilor' } });
    expect(sql).not.toContain('vote_records');
  });
});

describe('groupVote — the PARTICIPATION predicate (choice omitted)', () => {
  it('is a bare semi-join on the group: no argmax, no tally, no having', async () => {
    const captured = await compileVotes({
      chamber: { eq: 'camera_deputatilor' },
      groupVote: { group: 'PSD' },
    });
    expect(captured.sql).toContain(
      "exists (select 1 from parliament.vote_records vr where vr.vote_key = v.vote_key and vr.group_name = $2 and vr.privacy_class = 'public')"
    );
    // The four-way tally belongs to the plurality reading only — participation must
    // not pay for it, and must not inherit its tie rule.
    expect(captured.sql).not.toContain('count(*) filter');
    expect(captured.sql).not.toContain('having');
    // The group is the ONLY bound value the predicate adds.
    expect(captured.parameters.slice(1, -1)).toEqual(['PSD']);
  });

  it('never constrains vr.choice — every one of the four counts as taking part', async () => {
    const { sql } = await compileVotes({
      chamber: { eq: 'camera_deputatilor' },
      groupVote: { group: 'PSD' },
    });
    // Including nu_a_votat: those are RECORDED ballots, so the group was on the sheet.
    expect(sql).not.toContain('vr.choice');
  });

  it('matches group_name EXACTLY here too — no ilike, no fold', async () => {
    const captured = await compileVotes({
      chamber: { eq: 'camera_deputatilor' },
      groupVote: { group: 'Senatori neafiliați' },
    });
    expect(captured.parameters).toContain('Senatori neafiliați');
    expect(captured.sql).not.toContain('vr.group_name ilike');
    expect(captured.sql).not.toContain('lower(vr.group_name');
  });

  it('the plurality predicate is the SAME scoped rows plus an argmax (B ⊂ A)', async () => {
    const participation = await compileVotes({
      chamber: { eq: 'camera_deputatilor' },
      groupVote: { group: 'PSD' },
    });
    const plurality = await compileVotes({
      chamber: { eq: 'camera_deputatilor' },
      groupVote: { group: 'PSD', choice: 'pentru' },
    });
    // The plurality SQL is the participation SQL with a `having` appended, which is
    // the structural reason a stance can only ever narrow the participation set.
    const scoped =
      "select 1 from parliament.vote_records vr where vr.vote_key = v.vote_key and vr.group_name = $2 and vr.privacy_class = 'public'";
    expect(participation.sql).toContain(scoped);
    expect(plurality.sql).toContain(`${scoped} having`);
  });
});

describe('groupVote — boundedness (there is no group_name/choice index)', () => {
  const okp = <T>(v: T): Promise<Result<T, ApiError>> => Promise.resolve(ok(v));
  const makeRepo = (over: Partial<ParliamentRepo>): ParliamentRepo =>
    new Proxy({} as ParliamentRepo, {
      get(_t, prop: string) {
        return (
          over[prop as keyof ParliamentRepo] ??
          ((): never => {
            throw new Error(`unexpected repo call: ${prop}`);
          })
        );
      },
    });
  const deps = (repo: ParliamentRepo): ParliamentUsecaseDeps => ({ repo, meili: null });

  it('refuses an UNBOUNDED groupVote list instead of scanning 4.1M ballots', async () => {
    const r = await listVotes(deps(makeRepo({})), {
      filter: { groupVote: { group: 'PSD', choice: 'pentru' } },
      sort: 'voteDate',
      dir: 'desc',
      page: { first: 20 },
      searchEngineUp: true,
    });
    expect(r.isErr()).toBe(true);
    if (r.isErr()) {
      expect(r.error.type).toBe('InvalidInput');
      expect(r.error.message).toContain('groupVote');
    }
  });

  it('accepts a chamber, a voteDate window, or a billKey as the bound', async () => {
    for (const bound of [
      { chamber: { eq: 'camera_deputatilor' } },
      { voteDate: { between: { from: '2026-01-28', to: '2026-07-28' } } },
      { billKey: { eq: '12760' } },
    ]) {
      const listVotesFn = vi.fn(() =>
        okp({ items: [], next: null, total: 0, totalEstimated: false })
      );
      const r = await listVotes(deps(makeRepo({ listVotes: listVotesFn })), {
        filter: { ...bound, groupVote: { group: 'PSD', choice: 'pentru' } },
        sort: 'voteDate',
        dir: 'desc',
        page: { first: 20 },
        searchEngineUp: true,
      });
      expect(r.isOk()).toBe(true);
      expect(listVotesFn).toHaveBeenCalledOnce();
    }
  });

  it('refuses an UNBOUNDED participation list too (same table, same missing index)', async () => {
    const r = await listVotes(deps(makeRepo({})), {
      filter: { groupVote: { group: 'PSD' } },
      sort: 'voteDate',
      dir: 'desc',
      page: { first: 20 },
      searchEngineUp: true,
    });
    expect(r.isErr()).toBe(true);
    if (r.isErr()) {
      expect(r.error.type).toBe('InvalidInput');
      expect(r.error.message).toContain('groupVote');
    }
  });

  it('an EMPTY chamber object is not a bound (it emits no predicate)', async () => {
    const r = await listVotes(deps(makeRepo({})), {
      filter: { chamber: {}, groupVote: { group: 'PSD', choice: 'pentru' } },
      sort: 'voteDate',
      dir: 'desc',
      page: { first: 20 },
      searchEngineUp: true,
    });
    expect(r.isErr()).toBe(true);
  });
});
