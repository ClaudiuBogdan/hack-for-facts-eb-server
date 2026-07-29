/**
 * Regression: ONE dossier request must not open 12 database connections.
 *
 * Live blocker (diagnosed 2026-07-26 against the prod DB):
 *
 *   GET /parlament/proiecte/23135          → client API-error state
 *   query { parliamentBill(billKey:"23135") { … } }
 *     → failed in a ROTATING child (getBillDocuments / getBillEvents /
 *       getBillVoteLinks), with PostgreSQL reporting
 *       `FATAL: too many connections for role transparenta_prod_agent_readonly`
 *       (CNPG connectionLimit 24, 18 sessions live at diagnosis; server pool max 15).
 *
 * Bill 23135 is a RESOLVED CDep/Senate pair, so `getBillDossier` fanned
 * 2 views × 6 child families through nested `Promise.all` — 12 simultaneous
 * statements for a single page load — and ANY aborted child aborts the whole
 * dossier `Result`, which is why the failing family rotated.
 *
 * These tests pin two things at once:
 *   1. the CEILING — at most `DOSSIER_CHILD_READ_CONCURRENCY` (≤ 4) child reads are
 *      ever in flight, for a two-view pair and for a single view; and
 *   2. that throttling changed NOTHING observable — requested-view-first order,
 *      concatenation of observation families with no value dedupe, initiators deduped
 *      by mandateKey, relatedVotes deduped by voteKey, and the same
 *      first-error-by-POSITION (not by completion time) failure.
 *
 * No timing sleeps: every child read is a latch the test releases explicitly, and
 * `tick()` yields the macrotask queue (draining all microtasks) rather than waiting.
 */

import { err, ok, type Result } from 'neverthrow';
import { describe, expect, it } from 'vitest';

import {
  DOSSIER_CHILD_READ_CONCURRENCY,
  makeConcurrencyGate,
} from '@/modules/parliament/core/concurrency.js';
import { getBillDossier } from '@/modules/parliament/core/usecases.js';
import { databaseError, type ApiError } from '@/modules/shared/index.js';

import type { ParliamentRepo } from '@/modules/parliament/core/ports.js';
import type {
  ParliamentBill,
  ParliamentBillActLink,
  ParliamentBillDocument,
  ParliamentBillEvent,
  ParliamentBillVoteLink,
  ParliamentMember,
  ParliamentVote,
} from '@/modules/parliament/core/types.js';

// ── harness ──────────────────────────────────────────────────────────────────

const okp = <T>(v: T): Promise<Result<T, ApiError>> => Promise.resolve(ok(v));
const errp = <T>(message: string): Promise<Result<T, ApiError>> =>
  Promise.resolve(err(databaseError(message)));

/** Every method throws unless overridden — an unexpected repo read fails loudly. */
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

/**
 * Yield the macrotask queue. `setImmediate` runs after the microtask queue is fully
 * drained, so every promise continuation the gate scheduled has already run — a
 * deterministic barrier, not a sleep. Three rounds absorb nested chains.
 */
const tick = async (): Promise<void> => {
  for (let i = 0; i < 3; i += 1) {
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
};

/** The six child families, in the order `getBillDossier` requests them. */
const FAMILIES = [
  'getBillEvents',
  'getBillDocuments',
  'getBillInitiators',
  'listVotesForBill',
  'getBillActLinks',
  'getBillVoteLinks',
] as const;
type Family = (typeof FAMILIES)[number];

type ChildRead<T> = (billKey: string) => Promise<Result<readonly T[], ApiError>>;

/**
 * Wraps each child read in a latch: the call records its start (so we can observe
 * in-flight counts and start order) and then parks until `releaseAll()`.
 */
const makeLatches = () => {
  const started: string[] = [];
  const parked: (() => void)[] = [];
  let inFlight = 0;
  let peak = 0;

  const latch =
    <T>(
      family: Family,
      respond: (billKey: string) => Result<readonly T[], ApiError>
    ): ChildRead<T> =>
    (billKey) => {
      started.push(`${family}@${billKey}`);
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      return new Promise<Result<readonly T[], ApiError>>((resolve) => {
        parked.push(() => {
          inFlight -= 1;
          resolve(respond(billKey));
        });
      });
    };

  /** Settle every currently-parked read; returns how many were released. */
  const releaseAll = (): number => {
    const wave = parked.splice(0, parked.length);
    for (const release of wave) release();
    return wave.length;
  };

  return {
    started,
    releaseAll,
    inFlight: (): number => inFlight,
    peak: (): number => peak,
    /** All six families latched, each answering with an empty list. */
    empty: (): Partial<ParliamentRepo> => ({
      getBillEvents: latch<ParliamentBillEvent>('getBillEvents', () => ok([])),
      getBillDocuments: latch<ParliamentBillDocument>('getBillDocuments', () => ok([])),
      getBillInitiators: latch<ParliamentMember>('getBillInitiators', () => ok([])),
      listVotesForBill: latch<ParliamentVote>('listVotesForBill', () => ok([])),
      getBillActLinks: latch<ParliamentBillActLink>('getBillActLinks', () => ok([])),
      getBillVoteLinks: latch<ParliamentBillVoteLink>('getBillVoteLinks', () => ok([])),
    }),
  };
};

// ── fixtures ─────────────────────────────────────────────────────────────────

const BILL: ParliamentBill = {
  billKey: 'A',
  plxNumber: '23135',
  plxYear: 2025,
  senateNumber: 'L512',
  senateYear: 2025,
  title: 'Lege privind transparenta',
  finalLawNumber: null,
  finalLawYear: null,
  statusText: 'la Camera Deputatilor',
  billType: 'Proiect de Lege',
  lastEventDate: '2026-05-04',
  isCanonical: true,
  canonicalBillKey: null,
  attrs: {},
  sourceUpdatedAt: null,
  updatedAt: null,
};

const billEvent = (
  sourceBillKey: string,
  position: number,
  description: string
): ParliamentBillEvent => ({
  sourceBillKey,
  position,
  eventDate: '2026-05-04',
  eventDateText: null,
  description,
  chamberCode: null,
  committee: null,
  voteIdv: null,
  docs: [],
  // An event that the procedure derive has not classified yet — the shape the
  // dossier must still merge and render, never drop.
  rowKind: null,
  parentPosition: null,
  stepKind: null,
  actorKind: null,
  links: [],
});

const billDocument = (sourceBillKey: string, url: string): ParliamentBillDocument => ({
  sourceBillKey,
  url,
  label: 'Forma adoptata',
  kind: 'pdf',
  position: 1,
});

const member = (mandateKey: string, fullName: string): ParliamentMember => ({
  mandateKey,
  chamber: 'camera_deputatilor',
  legislature: '2024',
  fullName,
  normalizedName: fullName.toLowerCase(),
  groupName: null,
  groupId: null,
  constituencyName: null,
  birthDate: null,
  personId: null,
  profileUrl: null,
  cvPdfUrl: null,
  isCurrent: true,
  mandateEndDate: null,
  mandateEndReason: null,
  attrs: {},
});

const vote = (voteKey: string, title: string): ParliamentVote => ({
  voteKey,
  chamber: 'camera_deputatilor',
  voteDate: '2026-05-04',
  title,
  tally: { pentru: null, impotriva: null, abtinere: null, nuAVotat: null, present: null },
  outcome: 'adoptat',
  divisionNumber: null,
  billKey: 'A',
  lawReference: null,
  sourceUrl: null,
  tallyMismatch: false,
  kind: 'legislative',
  attrs: {},
});

const ACT_LINK: ParliamentBillActLink = {
  relationshipKind: 'becomes_law',
  targetActId: '77',
  targetActType: 'LEGE',
  targetActNumber: '423',
  targetActYear: 2023,
  targetMoActKey: null,
  resolutionStatus: 'linked',
  confidenceLabel: 'exact',
  primaryMethod: 'final_law_number',
};

const VOTE_LINK: ParliamentBillVoteLink = {
  voteKey: 'cdep:9001',
  billKey: 'A',
  role: 'final_adoption',
  resolutionStatus: 'linked',
  confidenceLabel: 'exact',
};

const deps = (repo: ParliamentRepo) => ({ repo, meili: null });

/** A resolved CDep/Senate pair: requested view 'A' first, navetă twin 'B' second. */
const PAIR: Partial<ParliamentRepo> = {
  findBill: () => okp<ParliamentBill | null>(BILL),
  getBillDossierViewKeys: () => okp<readonly string[]>(['A', 'B']),
};

// ── the ceiling ──────────────────────────────────────────────────────────────

/**
 * The hard budget, written out independently of the production constant so BOTH
 * failure modes are caught: raising `DOSSIER_CHILD_READ_CONCURRENCY` past the pool
 * budget, and dropping the gate so the fan-out goes unbounded again.
 */
const MAX_CHILD_READS_IN_FLIGHT = 4;

describe('getBillDossier — bounded child fan-out', () => {
  it('caps the constant itself at 4 (the pool/role budget it was chosen against)', () => {
    expect(DOSSIER_CHILD_READ_CONCURRENCY).toBeLessThanOrEqual(MAX_CHILD_READS_IN_FLIGHT);
    expect(DOSSIER_CHILD_READ_CONCURRENCY).toBeGreaterThanOrEqual(1);
  });

  it('never exceeds the ceiling for a two-view pair, yet still runs all 12 reads', async () => {
    const latches = makeLatches();
    const repo = makeRepo({ ...PAIR, ...latches.empty() });

    const run = getBillDossier(deps(repo), 'A');

    // The whole fan-out has had every chance to start: only the ceiling holds it back.
    // Pre-fix this was 12 — one connection per child read, from a single page load.
    await tick();
    expect(latches.inFlight()).toBe(DOSSIER_CHILD_READ_CONCURRENCY);
    expect(latches.inFlight()).toBeLessThanOrEqual(MAX_CHILD_READS_IN_FLIGHT);
    expect(latches.started).toHaveLength(DOSSIER_CHILD_READ_CONCURRENCY);

    let waves = 0;
    for (;;) {
      const released = latches.releaseAll();
      if (released === 0) break;
      waves += 1;
      expect(released).toBeLessThanOrEqual(MAX_CHILD_READS_IN_FLIGHT);
      await tick();
      expect(latches.inFlight()).toBeLessThanOrEqual(MAX_CHILD_READS_IN_FLIGHT);
    }

    const r = await run;
    expect(r.isOk()).toBe(true);
    // 2 views × 6 families, every one of them actually performed…
    expect(latches.started).toHaveLength(12);
    // …but never more than the ceiling at a time (12 / 4 = 3 waves).
    expect(latches.peak()).toBe(DOSSIER_CHILD_READ_CONCURRENCY);
    expect(latches.peak()).toBeLessThanOrEqual(MAX_CHILD_READS_IN_FLIGHT);
    expect(waves).toBe(Math.ceil(12 / DOSSIER_CHILD_READ_CONCURRENCY));
  });

  it('starts the reads requested-view-first, in family order (FIFO, not reordered)', async () => {
    const latches = makeLatches();
    const repo = makeRepo({ ...PAIR, ...latches.empty() });

    const run = getBillDossier(deps(repo), 'A');
    await tick();
    while (latches.releaseAll() > 0) await tick();
    await run;

    expect(latches.started).toEqual([
      ...FAMILIES.map((f) => `${f}@A`),
      ...FAMILIES.map((f) => `${f}@B`),
    ]);
  });

  it('holds the ceiling for a single-view bill too (6 reads, 2 waves)', async () => {
    const latches = makeLatches();
    const repo = makeRepo({
      findBill: () => okp<ParliamentBill | null>(BILL),
      getBillDossierViewKeys: () => okp<readonly string[]>(['A']),
      ...latches.empty(),
    });

    const run = getBillDossier(deps(repo), 'A');
    await tick();
    while (latches.releaseAll() > 0) await tick();

    expect((await run).isOk()).toBe(true);
    expect(latches.started).toHaveLength(6);
    expect(latches.peak()).toBe(Math.min(6, DOSSIER_CHILD_READ_CONCURRENCY));
    expect(latches.peak()).toBeLessThanOrEqual(MAX_CHILD_READS_IN_FLIGHT);
  });
});

// ── merge semantics (must be byte-identical to the unthrottled behaviour) ────

describe('getBillDossier — merge laws survive the throttle', () => {
  const merged = async (over: Partial<ParliamentRepo>) => {
    const r = await getBillDossier(deps(makeRepo({ ...PAIR, ...over })), 'A');
    expect(r.isOk()).toBe(true);
    return r._unsafeUnwrap();
  };

  it('concatenates observation families requested-view-first with NO value dedupe', async () => {
    const dossier = await merged({
      // Same (position, description) from both views: two source observations, kept.
      getBillEvents: (k: string) =>
        okp<readonly ParliamentBillEvent[]>(
          k === 'A'
            ? [billEvent('A', 1, 'Adoptat')]
            : [billEvent('B', 1, 'Adoptat'), billEvent('B', 2, 'Promulgat')]
        ),
      // Same URL from both views.
      getBillDocuments: (k: string) =>
        okp<readonly ParliamentBillDocument[]>([billDocument(k, 'https://cdep.ro/pl-x-23135.pdf')]),
      // Byte-identical act links — the strongest no-dedupe case (no source column).
      getBillActLinks: () => okp<readonly ParliamentBillActLink[]>([ACT_LINK]),
      // Same voteKey twice: voteLinks are observations, only relatedVotes dedupe on it.
      getBillVoteLinks: () => okp<readonly ParliamentBillVoteLink[]>([VOTE_LINK]),
      getBillInitiators: () => okp<readonly ParliamentMember[]>([]),
      listVotesForBill: () => okp<readonly ParliamentVote[]>([]),
    });

    expect(dossier).not.toBeNull();
    expect(dossier?.viewBillKeys).toEqual(['A', 'B']);
    expect(dossier?.events.map((e) => `${e.sourceBillKey}:${String(e.position)}`)).toEqual([
      'A:1',
      'B:1',
      'B:2',
    ]);
    expect(dossier?.documents.map((d) => d.sourceBillKey)).toEqual(['A', 'B']);
    expect(dossier?.actLinks).toHaveLength(2);
    expect(dossier?.voteLinks).toHaveLength(2);
    expect(dossier?.voteLinks.every((v) => v.voteKey === 'cdep:9001')).toBe(true);
  });

  it('dedupes initiators by mandateKey, keeping the requested view’s row', async () => {
    const dossier = await merged({
      getBillInitiators: (k: string) =>
        okp<readonly ParliamentMember[]>(
          k === 'A'
            ? [member('1:2024:7', 'Barcari Dorina'), member('1:2024:8', 'Ionescu Radu')]
            : [member('1:2024:7', 'STALE TWIN ROW'), member('2:2024:11', 'Popa Elena')]
        ),
      getBillEvents: () => okp<readonly ParliamentBillEvent[]>([]),
      getBillDocuments: () => okp<readonly ParliamentBillDocument[]>([]),
      listVotesForBill: () => okp<readonly ParliamentVote[]>([]),
      getBillActLinks: () => okp<readonly ParliamentBillActLink[]>([]),
      getBillVoteLinks: () => okp<readonly ParliamentBillVoteLink[]>([]),
    });

    expect(dossier?.initiators.map((m) => m.mandateKey)).toEqual([
      '1:2024:7',
      '1:2024:8',
      '2:2024:11',
    ]);
    expect(dossier?.initiators[0]?.fullName).toBe('Barcari Dorina');
  });

  it('dedupes relatedVotes by voteKey, keeping the requested view’s row', async () => {
    const dossier = await merged({
      listVotesForBill: (k: string) =>
        okp<readonly ParliamentVote[]>(
          k === 'A'
            ? [vote('cdep:9001', 'vot final'), vote('cdep:9002', 'raport')]
            : [vote('cdep:9001', 'STALE TWIN ROW'), vote('senat:5501', 'vot Senat')]
        ),
      getBillEvents: () => okp<readonly ParliamentBillEvent[]>([]),
      getBillDocuments: () => okp<readonly ParliamentBillDocument[]>([]),
      getBillInitiators: () => okp<readonly ParliamentMember[]>([]),
      getBillActLinks: () => okp<readonly ParliamentBillActLink[]>([]),
      getBillVoteLinks: () => okp<readonly ParliamentBillVoteLink[]>([]),
    });

    expect(dossier?.relatedVotes.map((v) => v.voteKey)).toEqual([
      'cdep:9001',
      'cdep:9002',
      'senat:5501',
    ]);
    expect(dossier?.relatedVotes[0]?.title).toBe('vot final');
  });
});

// ── failure semantics ────────────────────────────────────────────────────────

describe('getBillDossier — failure semantics unchanged', () => {
  const allOk: Partial<ParliamentRepo> = {
    getBillEvents: () => okp<readonly ParliamentBillEvent[]>([]),
    getBillDocuments: () => okp<readonly ParliamentBillDocument[]>([]),
    getBillInitiators: () => okp<readonly ParliamentMember[]>([]),
    listVotesForBill: () => okp<readonly ParliamentVote[]>([]),
    getBillActLinks: () => okp<readonly ParliamentBillActLink[]>([]),
    getBillVoteLinks: () => okp<readonly ParliamentBillVoteLink[]>([]),
  };

  it('returns not-found without reading any child (findBill is the only call)', async () => {
    const r = await getBillDossier(
      deps(makeRepo({ findBill: () => okp<ParliamentBill | null>(null) })),
      'nope'
    );

    expect(r.isOk()).toBe(true);
    expect(r._unsafeUnwrap()).toBeNull();
  });

  it('propagates a findBill failure', async () => {
    const r = await getBillDossier(
      deps(makeRepo({ findBill: () => errp<ParliamentBill | null>('findBill failed') })),
      'A'
    );

    expect(r.isErr()).toBe(true);
    expect(r._unsafeUnwrapErr().message).toBe('findBill failed');
  });

  it('propagates a view-key resolution failure', async () => {
    const r = await getBillDossier(
      deps(
        makeRepo({
          findBill: () => okp<ParliamentBill | null>(BILL),
          getBillDossierViewKeys: () => errp<readonly string[]>('getBillDossierViewKeys failed'),
        })
      ),
      'A'
    );

    expect(r.isErr()).toBe(true);
    expect(r._unsafeUnwrapErr().message).toBe('getBillDossierViewKeys failed');
  });

  it('fails the whole dossier when a required family fails on the SECOND view', async () => {
    // The 12th read — the last one the gate lets start. A throttled child that fails
    // must still fail the Result (the bound must not silently skip it).
    const r = await getBillDossier(
      deps(
        makeRepo({
          ...PAIR,
          ...allOk,
          getBillVoteLinks: (k: string) =>
            k === 'B'
              ? errp<readonly ParliamentBillVoteLink[]>('getBillVoteLinks failed')
              : okp<readonly ParliamentBillVoteLink[]>([]),
        })
      ),
      'A'
    );

    expect(r.isErr()).toBe(true);
    expect(r._unsafeUnwrapErr().message).toBe('getBillVoteLinks failed');
  });

  it('picks the first error by POSITION, not by which read failed first in time', async () => {
    // B/getBillEvents (position [1][0]) fails immediately; A/getBillVoteLinks
    // (position [0][5]) fails much later. The pre-throttle code scanned
    // perView in order, so A/getBillVoteLinks wins — that must not drift into
    // "whichever rejected first", which would make the error message nondeterministic.
    let failSlow = (): void => {
      throw new Error('latch not armed');
    };
    const slow = new Promise<Result<readonly ParliamentBillVoteLink[], ApiError>>((resolve) => {
      failSlow = () => {
        resolve(err(databaseError('A/getBillVoteLinks failed LAST')));
      };
    });

    const run = getBillDossier(
      deps(
        makeRepo({
          ...PAIR,
          ...allOk,
          getBillEvents: (k: string) =>
            k === 'B'
              ? errp<readonly ParliamentBillEvent[]>('B/getBillEvents failed FIRST')
              : okp<readonly ParliamentBillEvent[]>([]),
          getBillVoteLinks: (k: string) =>
            k === 'A' ? slow : okp<readonly ParliamentBillVoteLink[]>([]),
        })
      ),
      'A'
    );

    await tick(); // everything except the parked read has settled by now
    failSlow();

    const r = await run;
    expect(r.isErr()).toBe(true);
    expect(r._unsafeUnwrapErr().message).toBe('A/getBillVoteLinks failed LAST');
  });
});

// ── the gate itself ──────────────────────────────────────────────────────────

describe('makeConcurrencyGate', () => {
  /** N tasks that park until released, reporting peak concurrency and start order. */
  const gated = (limit: number, count: number) => {
    const gate = makeConcurrencyGate(limit);
    const started: number[] = [];
    const parked: (() => void)[] = [];
    let inFlight = 0;
    let peak = 0;

    const all = Promise.all(
      Array.from({ length: count }, (_v, i) =>
        gate(async () => {
          started.push(i);
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          await new Promise<void>((resolve) => {
            parked.push(() => {
              inFlight -= 1;
              resolve();
            });
          });
          return i;
        })
      )
    );

    return {
      all,
      started,
      peak: (): number => peak,
      releaseAll: (): number => {
        const wave = parked.splice(0, parked.length);
        for (const release of wave) release();
        return wave.length;
      },
    };
  };

  it('runs at most `limit` tasks at a time and starts them FIFO', async () => {
    const g = gated(3, 10);

    await tick();
    expect(g.started).toEqual([0, 1, 2]);

    while (g.releaseAll() > 0) await tick();

    expect(await g.all).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(g.peak()).toBe(3);
    expect(g.started).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('resolves in argument order even when tasks finish out of order', async () => {
    const gate = makeConcurrencyGate(2);
    const order: string[] = [];
    const results = await Promise.all([
      gate(async () => {
        await tick();
        order.push('slow');
        return 'slow';
      }),
      gate(() => {
        order.push('fast');
        return Promise.resolve('fast');
      }),
    ]);

    expect(results).toEqual(['slow', 'fast']);
    expect(order).toEqual(['fast', 'slow']);
  });

  it('releases the permit when a task REJECTS (a throwing read cannot wedge it)', async () => {
    const gate = makeConcurrencyGate(1);
    const boom = gate(() => Promise.reject(new Error('connection reset')));

    await expect(boom).rejects.toThrow('connection reset');
    // The permit came back, so the next read still runs.
    await expect(gate(() => Promise.resolve('ok'))).resolves.toBe('ok');
  });

  it.each([0, Number.NaN, Number.POSITIVE_INFINITY])(
    'clamps an invalid limit (%s) to 1 instead of deadlocking or going unbounded',
    async (limit) => {
      const g = gated(limit, 3);

      await tick();
      expect(g.started).toEqual([0]);

      while (g.releaseAll() > 0) await tick();

      expect(await g.all).toEqual([0, 1, 2]);
      expect(g.peak()).toBe(1);
    }
  );
});
