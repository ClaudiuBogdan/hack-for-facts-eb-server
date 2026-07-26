/**
 * THE DEFAULT-SERVING POPULATION RULE for the legacy speech surfaces.
 *
 * `parliament.speeches` holds two generations of rows for the same words: LEGACY
 * over-split fragments (the extraction parser walked `$('p,li,td')`, so one turn is
 * scattered across a container row and each of its paragraph rows) and CANONICAL
 * whole-turn rows (`canon:` key-space). Once the canonical projection is populated,
 * serving both would double-surface every re-derived sitting — a member's intervention
 * badge, list total and heatmap would inflate by the over-split factor.
 *
 * These tests execute the REAL Kysely queries against a capturing driver, so they assert
 * the SQL the repo actually emits — no DB, no mocking library. Two dimensions matter and
 * both are covered for every surface:
 *   pre-migration  → the predicate must be ABSENT (exact legacy behaviour), and
 *   post-migration → the predicate must be PRESENT on the rows AND on every count.
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

import { makeParliamentRepo } from '@/modules/parliament/shell/repo/parliament-repo.js';

import type { ProdDatabase } from '@/modules/shared/index.js';

interface Captured {
  readonly sql: string;
  readonly parameters: readonly unknown[];
}

/** `limit 0` capability probes are schema checks, not served reads. */
const isProbe = (query: Captured): boolean => /\blimit 0\b/u.test(query.sql);

/**
 * A capturing driver whose `canonicalAvailable` flag decides whether the two capability
 * probes succeed — i.e. whether this is a pre- or post-migration database. When false,
 * any probe throws exactly as Postgres does for a missing column/relation.
 */
const makeDb = (
  captured: Captured[],
  opts: { canonicalAvailable: boolean; rows?: readonly Record<string, unknown>[] }
): Kysely<ProdDatabase> => {
  const connection: DatabaseConnection = {
    async executeQuery<R>(query: CompiledQuery): Promise<QueryResult<R>> {
      captured.push({ sql: query.sql, parameters: query.parameters });
      if (!opts.canonicalAvailable && /\blimit 0\b/u.test(query.sql)) {
        throw new Error('column "is_canonical" does not exist');
      }
      return { rows: (opts.rows ?? []) as R[] };
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

/**
 * Erase PARAMETER ORDINALS (`$1` → `$?`) so two statements that bind the same value at
 * different positions compare equal. Only the ordinal is normalised; every other
 * character of the predicate still has to match.
 */
const anonymizePlaceholders = (s: string): string => s.replace(/\$\d+/gu, '$?');

/** The suppression predicate, as the repo emits it. */
const SUPPRESSION_MARKER = 'parliament.speech_redirects sr';

const hasSuppression = (query: Captured): boolean => query.sql.includes(SUPPRESSION_MARKER);

/**
 * Run one repo call and return every SERVED statement (probes dropped). `rows` lets a
 * caller feed the single-row shape `memberActivityCounts` needs.
 */
const run = async (
  canonicalAvailable: boolean,
  call: (repo: ReturnType<typeof makeParliamentRepo>) => Promise<unknown>,
  rows?: readonly Record<string, unknown>[]
): Promise<readonly Captured[]> => {
  const captured: Captured[] = [];
  const repo = makeParliamentRepo(
    makeDb(captured, { canonicalAvailable, ...(rows !== undefined && { rows }) })
  );
  await call(repo);
  return captured.filter((q) => !isProbe(q));
};

const COUNT_ROW = [
  { votes: '1', control_items: '0', speeches: '6252', initiatives: '0', declarations: '0' },
];

/** Every anonymous speech collection/activity path the rule must cover, uniformly. */
const SURFACES: readonly {
  readonly name: string;
  readonly call: (repo: ReturnType<typeof makeParliamentRepo>) => Promise<unknown>;
  readonly rows?: readonly Record<string, unknown>[];
  /** Statements expected to carry the predicate (rows AND counts/aggregates). */
  readonly minStatements: number;
}[] = [
  {
    name: 'member speeches — offset list + its total',
    call: (repo) => repo.listMemberSpeeches('1:2024:7', { page: 1, pageSize: 20 }),
    minStatements: 2,
  },
  {
    name: 'member speeches — cursor page + its exact total',
    call: (repo) => repo.listMemberSpeechesCursor('1:2024:7', { first: 20 }, {}, undefined),
    minStatements: 2,
  },
  {
    name: 'member speech activity — per-day + availableYears',
    call: (repo) => repo.memberSpeechActivity('1:2024:7', 2025, {}, undefined),
    minStatements: 2,
  },
  {
    name: 'global speeches — page + capped total',
    call: (repo) =>
      repo.listSpeeches({ first: 20 }, { mandateKey: { eq: '1:2024:7' } }, undefined, false),
    minStatements: 2,
  },
  {
    name: 'global speech activity — per-day + availableYears',
    call: (repo) => repo.speechActivity(2025, { mandateKey: { eq: '1:2024:7' } }, undefined, false),
    minStatements: 2,
  },
  {
    name: 'member activity counts — the interventions aggregate (also feeds careerTotals)',
    call: (repo) => repo.memberActivityCounts('1:2024:7'),
    rows: COUNT_ROW,
    minStatements: 1,
  },
];

describe('pre-migration — every speech surface keeps EXACT legacy behaviour', () => {
  for (const surface of SURFACES) {
    it(`emits no suppression predicate: ${surface.name}`, async () => {
      const served = await run(false, surface.call, surface.rows);
      expect(served.length).toBeGreaterThanOrEqual(surface.minStatements);
      for (const query of served) {
        // The fail-safe default: we never suppress on the strength of tables we could
        // not read. Nothing references the redirect table at all.
        expect(hasSuppression(query), flat(query.sql)).toBe(false);
        // No PREDICATE reads the additive column either. (The projection still emits the
        // `is_canonical` ALIAS — as the SQL literal `false` — so the row shape is
        // identical on both kinds of database and one mapper serves both; that literal
        // is not a read of the column.)
        expect(query.sql).not.toContain('s.is_canonical');
        // …and the legacy privacy gates are untouched.
        expect(query.sql).toContain("s.privacy_class = 'public'");
        expect(query.sql).toContain('s.quarantined = false');
      }
    });
  }
});

describe('post-migration — canonical rows are preferred on EVERY surface and count', () => {
  for (const surface of SURFACES) {
    it(`suppresses redirected legacy rows: ${surface.name}`, async () => {
      const served = await run(true, surface.call, surface.rows);
      expect(served.length).toBeGreaterThanOrEqual(surface.minStatements);
      for (const query of served) {
        // Applied to the ROWS and to the COUNT alike: a page and its total must never
        // describe different populations, or the UI shows N rows and a total of 4N.
        expect(hasSuppression(query), flat(query.sql)).toBe(true);
      }
    });
  }
});

describe('the suppression predicate — exactly what it conditions on', () => {
  const predicateOf = async (): Promise<string> => {
    const served = await run(true, (repo) =>
      repo.listMemberSpeechesCursor('1:2024:7', { first: 20 }, {}, undefined)
    );
    return flat(served[0]?.sql ?? '');
  };

  it('serves canonical rows unconditionally, and suppresses only MAPPED legacy rows', async () => {
    const sql = await predicateOf();
    // `is_canonical OR NOT EXISTS(redirect …)`: a canonical row always passes; a legacy
    // row passes only when NO qualifying redirect exists for it.
    expect(sql).toContain('s.is_canonical');
    expect(sql).toContain('not exists');
    expect(sql).toContain('sr.legacy_speech_key = s.speech_key');
  });

  it('RETAINS an unmapped legacy row — coverage never disappears mid-rollout', async () => {
    const sql = await predicateOf();
    // The suppression is keyed on the EXISTENCE of a redirect for that exact legacy key.
    // A legacy row the loader has not mapped yet matches nothing, so `not exists` holds
    // and the row is served — the loader's coverage lag cannot empty the API.
    expect(sql).toContain('not exists');
    expect(sql).toContain('sr.legacy_speech_key = s.speech_key');
  });

  it('never infers equivalence from text, speaker name or date', async () => {
    const sql = await predicateOf();
    // Isolate the suppression EXISTS subquery — not the whole statement, which naturally
    // mentions spoken_at in its projection and ORDER BY.
    const start = sql.indexOf('not exists');
    const end = sql.indexOf('order by');
    expect(start).toBeGreaterThan(-1);
    const suppression = sql.slice(start, end === -1 ? undefined : end);

    // Suppression is decided ONLY by the loader's source-keyed mapping
    // (`sr.legacy_speech_key = s.speech_key`). Nothing in it compares words, names or
    // dates between the two generations — inferring equivalence that way would silently
    // drop a real turn whose text merely resembles another.
    for (const forbidden of [
      'speaker_name',
      'spoken_at',
      's.title',
      's.summary',
      'similar',
      'ilike',
    ]) {
      expect(suppression, forbidden).not.toContain(forbidden);
    }
    expect(suppression).toContain('sr.legacy_speech_key = s.speech_key');
  });

  it('requires a PUBLIC redirect and a PUBLIC canonical sitting (strict, fail-safe)', async () => {
    const sql = await predicateOf();
    // A restricted redirect is not evidence we may act on, and a restricted canonical
    // sitting has no servable canonical rows — in both cases the legacy row must STAY,
    // or content would silently vanish behind a privacy gate.
    expect(sql).toContain("sr.privacy_class = 'public'");
    expect(sql).toContain("ss.privacy_class = 'public'");
    expect(sql).toContain('parliament.stenogram_sessions ss');
    expect(sql).toContain('ss.session_key = sr.session_key');
    // Strict equality only — never a fail-open coalesce.
    expect(sql).not.toContain('coalesce(sr.privacy_class');
    expect(sql).not.toContain('coalesce(ss.privacy_class');
  });

  it('decides at SITTING grain, so a session_only redirect still suppresses its fragments', async () => {
    const sql = await predicateOf();
    // A `session_only` redirect proves the sitting but not the turn, and the canonical
    // sitting may hold several contributions by that member. Conditioning on the
    // individual canonical speech row would keep the legacy fragments of a sitting that
    // IS canonically served — exactly the double-surfacing this prevents. So the
    // predicate joins the SESSION and never the canonical speech/segment row.
    expect(sql).toContain('ss.session_key = sr.session_key');
    expect(sql).not.toContain('sr.canonical_speech_key');
    expect(sql).not.toContain('sr.canonical_segment_key');
    expect(sql).not.toContain('sr.mapping_kind');
  });

  it('keeps the legacy privacy gates alongside it (added, never replaced)', async () => {
    const sql = await predicateOf();
    expect(sql).toContain("s.privacy_class = 'public'");
    expect(sql).toContain('s.quarantined = false');
    expect(sql).not.toContain('coalesce(s.privacy_class');
  });
});

describe('no count inflation — a page and its total share an IDENTICAL population filter', () => {
  /** Everything between `where` and the first `order by` / `limit` / end. */
  const whereOf = (query: Captured): string => {
    const sql = flat(query.sql);
    const start = sql.indexOf(' where ');
    expect(start, sql).toBeGreaterThan(-1);
    const tail = sql.slice(start + 7);
    const cut = ['order by ', 'limit '].map((k) => tail.indexOf(k)).filter((i) => i > -1);
    return (cut.length > 0 ? tail.slice(0, Math.min(...cut)) : tail).trim();
  };

  /**
   * THE INVARIANT behind "no double-surfacing / no count inflation": whatever the
   * population rule does, the rows query and the count query must select from the SAME
   * population. If they diverge, the client shows N canonical turns above a total of
   * ~4N (the CDep over-split factor) — the exact corruption this slice exists to prevent.
   * Comparing the compiled WHERE clauses proves it structurally, for both databases.
   */
  for (const canonicalAvailable of [false, true]) {
    const label = canonicalAvailable ? 'post-migration' : 'pre-migration';

    it(`member cursor list and its exact total agree (${label})`, async () => {
      const served = await run(canonicalAvailable, (repo) =>
        repo.listMemberSpeechesCursor('1:2024:7', { first: 20 }, {}, undefined)
      );
      const [page, count] = served;
      expect(page).toBeDefined();
      expect(count).toBeDefined();
      // The page adds NOTHING but the keyset predicate; the population terms match.
      expect(whereOf(count!)).toBe(whereOf(page!));
      expect(count?.sql).toContain('count(*)');
    });

    it(`member offset list and its total agree (${label})`, async () => {
      const served = await run(canonicalAvailable, (repo) =>
        repo.listMemberSpeeches('1:2024:7', { page: 1, pageSize: 20 })
      );
      const [page, count] = served;
      expect(whereOf(count!)).toBe(whereOf(page!));
    });

    it(`global list and its capped total agree (${label})`, async () => {
      const served = await run(canonicalAvailable, (repo) =>
        repo.listSpeeches({ first: 20 }, { mandateKey: { eq: '1:2024:7' } }, undefined, false)
      );
      const [page, count] = served;
      expect(whereOf(count!)).toBe(whereOf(page!));
    });

    it(`the member interventions AGGREGATE matches the list population (${label})`, async () => {
      const list = await run(
        canonicalAvailable,
        (repo) => repo.listMemberSpeeches('1:2024:7', { page: 1, pageSize: 20 }),
        undefined
      );
      const counts = await run(
        canonicalAvailable,
        (repo) => repo.memberActivityCounts('1:2024:7'),
        COUNT_ROW
      );
      // The five-total statement holds five sub-selects, so its placeholders are
      // numbered $1..$5 while the list's start at $1. Normalise the ORDINAL only — the
      // predicate text itself must match exactly.
      const aggregate = anonymizePlaceholders(flat(counts[0]?.sql ?? ''));
      const listWhere = anonymizePlaceholders(whereOf(list[0]!));
      for (const term of listWhere.split(' and ')) {
        expect(aggregate, term).toContain(term.trim());
      }
    });

    it(`the member heatmap matches the list population (${label})`, async () => {
      const list = await run(canonicalAvailable, (repo) =>
        repo.listMemberSpeechesCursor('1:2024:7', { first: 20 }, {}, undefined)
      );
      const activity = await run(canonicalAvailable, (repo) =>
        repo.memberSpeechActivity('1:2024:7', 2025, {}, undefined)
      );
      const perDay = whereOf(activity[0]!);
      // The heatmap adds only the year bounds on top of the list's population terms.
      for (const term of whereOf(list[0]!).split(' and ')) {
        const t = term.trim();
        // Skip the keyset/paging term, which the aggregate legitimately lacks.
        if (t.includes('coalesce(s.spoken_at::text')) continue;
        expect(perDay, t).toContain(t);
      }
    });
  }
});

describe('cursor ordering and identity survive the rule', () => {
  it('leaves the member keyset ORDER BY and tie-break untouched', async () => {
    const served = await run(true, (repo) =>
      repo.listMemberSpeechesCursor('1:2024:7', { first: 20 }, {}, undefined)
    );
    const page = flat(served[0]?.sql ?? '');
    // The population predicate is a WHERE term only. The total order — and therefore
    // tie stability at equal `spoken_at` — is exactly what it was.
    expect(page).toContain("coalesce(s.spoken_at::text, '') desc, s.speech_key desc");
  });

  it('leaves the global keyset ORDER BY and tie-break untouched', async () => {
    const served = await run(true, (repo) =>
      repo.listSpeeches({ first: 20 }, { mandateKey: { eq: '1:2024:7' } }, undefined, false)
    );
    const page = flat(served[0]?.sql ?? '');
    expect(page).toContain("coalesce(s.spoken_at::text, '') desc, s.speech_key desc");
  });

  it('reports the APPLIED population so the shell can bind it into per-edge cursors', async () => {
    const captured: Captured[] = [];
    const legacyRepo = makeParliamentRepo(makeDb(captured, { canonicalAvailable: false }));
    const legacy = await legacyRepo.listMemberSpeechesCursor(
      '1:2024:7',
      { first: 20 },
      {},
      undefined
    );
    expect(legacy._unsafeUnwrap().population).toBe('LEGACY');

    const canonicalRepo = makeParliamentRepo(makeDb([], { canonicalAvailable: true }));
    const canonical = await canonicalRepo.listMemberSpeechesCursor(
      '1:2024:7',
      { first: 20 },
      {},
      undefined
    );
    expect(canonical._unsafeUnwrap().population).toBe('CANONICAL_PREFERRED');

    const globalPage = await canonicalRepo.listSpeeches(
      { first: 20 },
      { mandateKey: { eq: '1:2024:7' } },
      undefined,
      false
    );
    expect(globalPage._unsafeUnwrap().population).toBe('CANONICAL_PREFERRED');
  });
});

describe('direct legacy reads stay compatible', () => {
  it('findSpeech(speechKey) NEVER applies the population rule', async () => {
    for (const canonicalAvailable of [false, true]) {
      const served = await run(canonicalAvailable, (repo) =>
        repo.findSpeech('cdep:cdep_stenogram:9043:9:718')
      );
      expect(served).toHaveLength(1);
      const sql = flat(served[0]?.sql ?? '');
      // A known legacy deep link must keep resolving to its own row even once its
      // content is served canonically in the lists — suppressing it here would 404 a
      // URL that has worked for years. Redirect resolution is a SEPARATE, explicit
      // surface (parliamentSpeechContext), not a silent rewrite of this read.
      expect(hasSuppression(served[0]!)).toBe(false);
      // …and the row's own privacy gates still apply.
      expect(sql).toContain("s.privacy_class = 'public'");
      expect(sql).toContain('s.quarantined = false');
      expect(served[0]?.parameters).toContain('cdep:cdep_stenogram:9043:9:718');
    }
  });
});
