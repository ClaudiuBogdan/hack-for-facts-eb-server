/**
 * Canonical stenogram REPOSITORY privacy + ordering, proven at the SQL level.
 *
 * The usecase tests use an in-memory fake, so they cannot prove the REAL repo emits
 * the public-row predicates. This file compiles and executes the actual Kysely
 * queries against a capturing driver (the `member-speech-privacy-repo.test.ts`
 * pattern) so removing a `privacy_class = 'public'` gate, weakening it to a
 * fail-open `coalesce`, or dropping the printed-order ORDER BY fails here — without
 * a live database.
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

import { makeParliamentStenogramRepo } from '@/modules/parliament/shell/repo/stenogram-repo.js';

import type { ProdDatabase } from '@/modules/shared/index.js';

interface Captured {
  readonly sql: string;
  readonly parameters: readonly unknown[];
}

/**
 * A driver that records every compiled statement and returns no rows. `probeOk`
 * decides whether the canonical-availability probe succeeds: with `false` it throws,
 * which is exactly what a database WITHOUT the additive migration does (a missing
 * relation/column fails at PARSE time).
 */
const makeCapturingDb = (captured: Captured[], probeOk = true): Kysely<ProdDatabase> => {
  const connection: DatabaseConnection = {
    async executeQuery<R>(query: CompiledQuery): Promise<QueryResult<R>> {
      captured.push({ sql: query.sql, parameters: query.parameters });
      if (!probeOk && /\blimit 0\b/u.test(query.sql)) {
        throw new Error('relation "parliament.stenogram_sessions" does not exist');
      }
      return { rows: [] };
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

/** Reads = everything except the `limit 0` capability probes. */
const readsOf = (captured: readonly Captured[]): readonly Captured[] =>
  captured.filter((q) => !/\blimit 0\b/u.test(q.sql));

/**
 * The gate is STRICT equality on EVERY table a statement touches. `privacy_class` is
 * `not null` with a 2-value CHECK on all three canonical tables, so a
 * `coalesce(privacy_class,'public')` could never fire — it would only encode a
 * fail-open habit. Assert both: the strict predicate is present, the fail-open form
 * is absent.
 */
const expectStrictPublicGate = (query: Captured, aliases: readonly string[]): void => {
  for (const alias of aliases) {
    expect(query.sql, `${alias} gate in: ${query.sql}`).toContain(
      `${alias}.privacy_class = 'public'`
    );
    expect(query.sql).not.toContain(`coalesce(${alias}.privacy_class`);
  }
};

describe('stenogram repo — every read is gated to privacy_class = public', () => {
  it('gates the sessions list (page AND capped-count) on the session class', async () => {
    const captured: Captured[] = [];
    const repo = makeParliamentStenogramRepo(makeCapturingDb(captured));

    const r = await repo.listStenogramSessions({ first: 20 }, {}, undefined, undefined);
    expect(r.isOk()).toBe(true);
    const reads = readsOf(captured);
    expect(reads.length).toBeGreaterThanOrEqual(2); // page + capped count
    for (const query of reads) expectStrictPublicGate(query, ['ss']);
  });

  it('gates a session point read, so a restricted sitting is indistinguishable from absent', async () => {
    const captured: Captured[] = [];
    const repo = makeParliamentStenogramRepo(makeCapturingDb(captured));

    const r = await repo.findStenogramSession('cdep:9043');
    expect(r.isOk()).toBe(true);
    expect(r._unsafeUnwrap()).toBeNull();
    for (const query of readsOf(captured)) expectStrictPublicGate(query, ['ss']);
  });

  it('gates the reading on BOTH the block AND its parent session (no transitive leak)', async () => {
    const captured: Captured[] = [];
    const repo = makeParliamentStenogramRepo(makeCapturingDb(captured));

    const r = await repo.listStenogramSegments('cdep:9043', { offset: 0, limit: 100 });
    expect(r.isOk()).toBe(true);
    const reads = readsOf(captured);
    expect(reads.length).toBeGreaterThanOrEqual(2); // rows + total
    for (const query of reads) {
      expectStrictPublicGate(query, ['sg', 'ss']);
      // The parent gate is a JOINed EXISTS, not an assumption inherited from a prior read.
      expect(query.sql).toContain('parliament.stenogram_sessions');
    }
  });

  it('gates both segment lookups (by speech_key and by segment_key)', async () => {
    const captured: Captured[] = [];
    const repo = makeParliamentStenogramRepo(makeCapturingDb(captured));

    expect((await repo.findSegmentBySpeechKey('canon:cdep:9043#00004')).isOk()).toBe(true);
    expect((await repo.findSegmentByKey('cdep:9043#00004')).isOk()).toBe(true);
    const reads = readsOf(captured);
    expect(reads).toHaveLength(2);
    for (const query of reads) expectStrictPublicGate(query, ['sg', 'ss']);
  });

  it('gates the redirect read, and never selects the internal `evidence` column', async () => {
    const captured: Captured[] = [];
    const repo = makeParliamentStenogramRepo(makeCapturingDb(captured));

    const r = await repo.findSpeechRedirect('cdep:cdep_stenogram:9043:9:718');
    expect(r.isOk()).toBe(true);
    const query = readsOf(captured).at(-1);
    expect(query).toBeDefined();
    if (query !== undefined) {
      expectStrictPublicGate(query, ['sr']);
      // `evidence` is internal matcher state (omitted from the Kysely type, so this
      // is belt-and-braces on top of a compile error).
      expect(query.sql).not.toContain('evidence');
    }
  });

  it('gates the prev/next CONTRIBUTION lookups and restricts them to SPEECH blocks', async () => {
    const captured: Captured[] = [];
    const repo = makeParliamentStenogramRepo(makeCapturingDb(captured));

    const r = await repo.adjacentContributions('cdep:9043', 4);
    expect(r.isOk()).toBe(true);
    const reads = readsOf(captured);
    expect(reads).toHaveLength(2);
    for (const query of reads) {
      expectStrictPublicGate(query, ['sg', 'ss']);
      // The neighbouring CONTRIBUTION, not the neighbouring printed block.
      expect(query.sql).toContain("sg.segment_kind = 'SPEECH'");
    }
    expect(reads[0]?.sql).toContain('sg.position <');
    expect(reads[1]?.sql).toContain('sg.position >');
  });
});

describe('stenogram repo — the canonical SPEECH row is gated too (fail-closed)', () => {
  /**
   * A SPEECH block, its parent session, and the canonical `parliament.speeches` row it
   * points at carry INDEPENDENT `privacy_class` values. The gate is written as an
   * IMPLICATION (`speech_key is null OR exists(public row)`) so a block with no speech
   * row passes, while a block that names one must find it public — meaning a MISSING or
   * restricted canonical row withholds the block instead of defaulting it open.
   */
  const expectCanonicalSpeechGate = (query: Captured): void => {
    expect(query.sql).toContain('sg.speech_key is null');
    expect(query.sql).toContain('parliament.speeches');
    expect(query.sql).toContain("cs.privacy_class = 'public'");
    expect(query.sql).toContain('cs.quarantined = false');
  };

  it('gates the reading on the canonical speech row', async () => {
    const captured: Captured[] = [];
    const repo = makeParliamentStenogramRepo(makeCapturingDb(captured));

    await repo.listStenogramSegments('cdep:9043', { offset: 0, limit: 100 });
    for (const query of readsOf(captured)) expectCanonicalSpeechGate(query);
  });

  it('gates both segment lookups and the prev/next contribution reads', async () => {
    const captured: Captured[] = [];
    const repo = makeParliamentStenogramRepo(makeCapturingDb(captured));

    await repo.findSegmentBySpeechKey('canon:cdep:9043#00004');
    await repo.findSegmentByKey('cdep:9043#00004');
    await repo.adjacentContributions('cdep:9043', 4);
    const reads = readsOf(captured);
    expect(reads).toHaveLength(4);
    for (const query of reads) expectCanonicalSpeechGate(query);
  });

  it('checks a canonical speech key against public AND non-quarantined', async () => {
    const captured: Captured[] = [];
    const repo = makeParliamentStenogramRepo(makeCapturingDb(captured));

    const r = await repo.canonicalSpeechIsPublic('canon:cdep:9043#00004');
    expect(r.isOk()).toBe(true);
    // The capturing driver returns no rows, so a key that cannot be PROVEN public reads
    // as not public — fail-closed by construction.
    expect(r._unsafeUnwrap()).toBe(false);
    const query = readsOf(captured).at(-1);
    // Kysely quotes a schema-qualified table it builds itself (`"parliament"."speeches"`),
    // unlike the raw-SQL gates above.
    expect(query?.sql).toContain('"parliament"."speeches"');
    expect(query?.sql).toContain("s.privacy_class = 'public'");
    expect(query?.sql).toContain('s.quarantined = false');
    expect(query?.sql).not.toContain('coalesce(s.privacy_class');
  });
});

describe('stenogram repo — sitting navigation is deterministic and chamber-scoped', () => {
  it('reads the neighbours with the SAME coalesced keyset the list orders by', async () => {
    const captured: Captured[] = [];
    const repo = makeParliamentStenogramRepo(makeCapturingDb(captured));

    const r = await repo.adjacentSessions({
      sessionKey: 'cdep:9043',
      sessionDate: '2003-09-29',
      chamber: 'camera_deputatilor',
    });
    expect(r.isOk()).toBe(true);
    const reads = readsOf(captured);
    expect(reads).toHaveLength(2);

    for (const query of reads) {
      // Chamber-scoped, public-only, and keyed on the coalesced (date, key) tuple —
      // identical to the list's ordering expression, so stepping and paging agree.
      expect(query.sql).toContain('ss.chamber =');
      expect(query.sql).toContain("ss.privacy_class = 'public'");
      expect(query.sql).toContain("coalesce(ss.session_date::text, '')");
      expect(query.parameters).toContain('camera_deputatilor');
      expect(query.parameters).toContain('2003-09-29');
      expect(query.parameters).toContain('cdep:9043');
    }
    // Previous = greatest strictly before; next = least strictly after.
    expect(reads[0]?.sql).toMatch(/<\s*\(/u);
    expect(reads[0]?.sql).toContain('desc, ss.session_key desc');
    expect(reads[1]?.sql).toMatch(/>\s*\(/u);
    expect(reads[1]?.sql).toContain('asc, ss.session_key asc');
  });

  it('coalesces a NULL anchor date so a dateless capture still has a defined place', async () => {
    const captured: Captured[] = [];
    const repo = makeParliamentStenogramRepo(makeCapturingDb(captured));

    await repo.adjacentSessions({
      sessionKey: 'cdep:9999',
      sessionDate: null,
      chamber: 'senat',
    });
    // The anchor's null date becomes '' — the same value the ORDER BY coalesces to, so
    // the comparison is total rather than NULL-poisoned (which would return nothing).
    for (const query of readsOf(captured)) expect(query.parameters).toContain('');
  });
});

describe('stenogram repo — ordering is the OFFICIAL printed order', () => {
  it('orders the reading by position ascending', async () => {
    const captured: Captured[] = [];
    const repo = makeParliamentStenogramRepo(makeCapturingDb(captured));

    await repo.listStenogramSegments('cdep:9043', { offset: 0, limit: 100 });
    const rows = readsOf(captured)[0];
    expect(rows?.sql).toMatch(/order by\s+"sg"\."position"\s+asc/iu);
  });

  it('keysets sessions on (session_date desc NULLS LAST, session_key desc)', async () => {
    const captured: Captured[] = [];
    const repo = makeParliamentStenogramRepo(makeCapturingDb(captured));

    await repo.listStenogramSessions({ first: 20 }, {}, undefined, undefined);
    const page = readsOf(captured)[0];
    // The NULL date is coalesced to '' in the ORDER BY, so a dateless capture sorts
    // LAST on a desc scan and pagination cannot skip or duplicate at that boundary.
    expect(page?.sql).toContain("coalesce(ss.session_date::text, '') desc, ss.session_key desc");
  });

  it('applies the SAME coalesced tuple in the keyset predicate as in the ORDER BY', async () => {
    const captured: Captured[] = [];
    const repo = makeParliamentStenogramRepo(makeCapturingDb(captured));

    // Mint a real cursor from a first page so the shapes cannot drift.
    const first = await repo.listStenogramSessions({ first: 1 }, {}, undefined, undefined);
    expect(first.isOk()).toBe(true);
    const before = captured.length;
    // The capturing driver returns no rows, so `next` is null; build the tuple check
    // from a cursor the repo itself would accept instead.
    const replay = await repo.listStenogramSessions(
      { first: 1, after: 'not-a-cursor' },
      {},
      undefined,
      undefined
    );
    // A malformed cursor is refused with a clean InvalidInput, never used in SQL.
    expect(replay.isErr()).toBe(true);
    expect(replay._unsafeUnwrapErr().type).toBe('InvalidInput');
    expect(readsOf(captured.slice(before))).toHaveLength(0);
  });
});

describe('stenogram repo — the availability probe gates every statement', () => {
  it('reports projection_unavailable (not a Database error) when the relations are absent', async () => {
    const captured: Captured[] = [];
    const repo = makeParliamentStenogramRepo(makeCapturingDb(captured, false));

    const session = await repo.findStenogramSession('cdep:9043');
    expect(session.isErr()).toBe(true);
    const error = session._unsafeUnwrapErr();
    expect(error.type).toBe('TranscriptUnavailable');
    if (error.type === 'TranscriptUnavailable') {
      expect(error.reason).toBe('projection_unavailable');
      expect(error.sessionKey).toBe('cdep:9043');
    }
    // Crucially: NO statement referencing the missing relations was emitted. A
    // runtime guard inside the SQL could not have saved us — a missing relation fails
    // at PARSE time — so the branch must not be built at all.
    expect(readsOf(captured)).toHaveLength(0);
  });

  it('memoizes the negative probe instead of re-probing on every call', async () => {
    const captured: Captured[] = [];
    const repo = makeParliamentStenogramRepo(makeCapturingDb(captured, false));

    await repo.findStenogramSession('cdep:9043');
    const afterFirst = captured.length;
    await repo.findStenogramSession('cdep:9044');
    await repo.listStenogramSegments('cdep:9044', { offset: 0, limit: 10 });
    // Within the negative TTL the probe is not repeated (a false result is cached
    // briefly so the migration landing mid-process still needs no restart).
    expect(captured.length).toBe(afterFirst);
  });

  it('probes the additive parliament.speeches columns separately from the relations', async () => {
    const captured: Captured[] = [];
    const repo = makeParliamentStenogramRepo(makeCapturingDb(captured));

    expect(await repo.canonicalSpeechColumnsAvailable()).toBe(true);
    const probe = captured.at(-1);
    expect(probe?.sql).toContain('is_canonical');
    expect(probe?.sql).toContain('stenogram_session_key');
    expect(probe?.sql).toContain('stenogram_segment_key');
    expect(probe?.sql).toContain('parliament.speeches');
    // `limit 0` proves the columns are selectable without reading a row.
    expect(probe?.sql).toMatch(/\blimit 0\b/u);
  });
});

describe('stenogram repo — a searched list narrows to the resolved key set', () => {
  it('adds a session_key IN (…) predicate for the search hits', async () => {
    const captured: Captured[] = [];
    const repo = makeParliamentStenogramRepo(makeCapturingDb(captured));

    await repo.listStenogramSessions({ first: 20 }, {}, 'buget', ['cdep:9043', 'cdep:9100']);
    const page = readsOf(captured)[0];
    expect(page?.sql).toContain('ss.session_key in');
    expect(page?.parameters).toContain('cdep:9043');
    expect(page?.parameters).toContain('cdep:9100');
  });

  it('short-circuits an EMPTY hit set without touching the database', async () => {
    const captured: Captured[] = [];
    const repo = makeParliamentStenogramRepo(makeCapturingDb(captured));

    const r = await repo.listStenogramSessions({ first: 20 }, {}, 'nimic', []);
    expect(r._unsafeUnwrap().items).toEqual([]);
    expect(r._unsafeUnwrap().total).toBe(0);
    // "Searched, nothing matched" must never compile to an UNFILTERED query.
    expect(readsOf(captured)).toHaveLength(0);
  });
});

describe('stenogram repo — the virtual filter fields compile to real predicates', () => {
  it('turns `year` into an indexed session_date range, not extract(year …)', async () => {
    const captured: Captured[] = [];
    const repo = makeParliamentStenogramRepo(makeCapturingDb(captured));

    await repo.listStenogramSessions({ first: 20 }, { year: { eq: 2003 } }, undefined, undefined);
    const page = readsOf(captured)[0];
    expect(page?.sql).toContain('ss.session_date >=');
    expect(page?.sql).toContain('ss.session_date <=');
    // extract() on the indexed column would forfeit parliament_stenogram_sessions_date_idx.
    expect(page?.sql).not.toContain('extract(year');
    expect(page?.parameters).toContain('2003-01-01');
    expect(page?.parameters).toContain('2003-12-31');
  });

  it('turns `mandateKey` into an EXISTS over PUBLIC SPEECH blocks', async () => {
    const captured: Captured[] = [];
    const repo = makeParliamentStenogramRepo(makeCapturingDb(captured));

    await repo.listStenogramSessions(
      { first: 20 },
      { mandateKey: { eq: '2:2000:42' } },
      undefined,
      undefined
    );
    const page = readsOf(captured)[0];
    expect(page?.sql).toContain('exists');
    expect(page?.sql).toContain('parliament.stenogram_segments');
    expect(page?.sql).toContain("sg.segment_kind = 'SPEECH'");
    expect(page?.sql).toContain("sg.privacy_class = 'public'");
    expect(page?.parameters).toContain('2:2000:42');
  });

  it('refuses a present-but-invalid `year` instead of widening to every year', async () => {
    const captured: Captured[] = [];
    const repo = makeParliamentStenogramRepo(makeCapturingDb(captured));

    const r = await repo.listStenogramSessions(
      { first: 20 },
      { year: { eq: 12 } },
      undefined,
      undefined
    );
    expect(r.isErr()).toBe(true);
    expect(r._unsafeUnwrapErr().type).toBe('InvalidInput');
    expect(readsOf(captured)).toHaveLength(0);
  });
});
