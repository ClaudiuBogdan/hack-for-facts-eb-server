/**
 * Regression: a ParliamentBill child field must mean the SAME thing on every
 * parent path (M2/B-F19, readiness review 2026-08-05).
 *
 * Live defect: the `parliamentBill` root serves the dossier union (requested
 * view + accepted navetă twin), but the lazy field resolvers fell back to a
 * DIRECT-KEY read. 10,171 of 18,009 linked vote edges sit on suppressed twins,
 * so `relatedVotes` selected on a bill reached from the bills list,
 * `voteLinks.bill`, or an initiative returned an EMPTY list for 3,276 canonical
 * bills whose dossier has votes — one GraphQL field, root-dependent semantics.
 *
 * These tests pin the unification AND the review-mandated guardrails:
 *   1. WIRING — all six lazy fields fan out across `getBillDossierViewKeys`
 *      and each reads ITS OWN family (a swapped import would fail loudly);
 *   2. EQUIVALENCE — against the same fake repo, every per-family reader
 *      returns exactly what `getBillDossier` merges for that family, so the
 *      two paths cannot drift (the anti-drift claim is enforced, not asserted);
 *   3. the B-F19 shape itself: a canonical view with zero direct-key votes
 *      serves its twin's votes instead of [];
 *   4. a parent PREFILLED by the dossier root short-circuits (no repo call);
 *   5. `dossierBillKeys` resolves root-independently THROUGH THE SAME memo as
 *      the children, so it reports the snapshot actually used (no torn read);
 *   6. SCOPE — one request-scope coalesces the view-key read per billKey and
 *      bounds concurrent lazy child reads at DOSSIER_CHILD_READ_CONCURRENCY
 *      (GraphQL fans list-row resolvers out concurrently; unbounded, a
 *      100-row page would schedule hundreds of statements — the 2026-07-26
 *      connection-exhaustion class).
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
import { err, ok, type Result } from 'neverthrow';
import { describe, expect, it, vi } from 'vitest';

import { DOSSIER_CHILD_READ_CONCURRENCY } from '@/modules/parliament/core/concurrency.js';
import {
  getBillDossier,
  getBillDossierActLinks,
  getBillDossierDocuments,
  getBillDossierEvents,
  getBillDossierInitiators,
  getBillDossierRelatedVotes,
  getBillDossierVoteLinks,
  makeBillChildReadScope,
} from '@/modules/parliament/core/usecases.js';
import { makeParliamentResolvers } from '@/modules/parliament/shell/graphql/resolvers.js';
import { makeParliamentRepo } from '@/modules/parliament/shell/repo/parliament-repo.js';
import { databaseError, type ApiError, type ProdDatabase } from '@/modules/shared/index.js';

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

// ── harness (same shape as bill-dossier-concurrency.test.ts) ─────────────────

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

const deps = (repo: ParliamentRepo) => ({ repo, meili: null });

const resolverDeps = (repo: ParliamentRepo) => ({
  repo,
  meili: null,
  legalActLoader: undefined,
  searchEngineUp: false,
  isApiKeyAuthorized: (): boolean => false,
  transcriptSearch: null,
});

type FieldResolver = (parent: unknown, args: unknown, context?: unknown) => Promise<unknown>;
const billFields = (repo: ParliamentRepo): Record<string, FieldResolver> =>
  (makeParliamentResolvers(resolverDeps(repo)) as Record<string, Record<string, FieldResolver>>)[
    'ParliamentBill'
  ]!;

/** Yield the macrotask queue — a deterministic barrier, not a sleep. */
const tick = async (): Promise<void> => {
  for (let i = 0; i < 3; i += 1) {
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
};

/** A resolved CDep/Senate pair: requested view 'A' first, navetă twin 'B' second. */
const PAIR: Partial<ParliamentRepo> = {
  getBillDossierViewKeys: () => okp<readonly string[]>(['A', 'B']),
};

const vote = (voteKey: string, title: string): ParliamentVote => ({
  voteKey,
  chamber: 'camera_deputatilor',
  voteDate: '2026-05-04',
  title,
  tally: { pentru: null, impotriva: null, abtinere: null, nuAVotat: null, present: null },
  outcome: 'adoptat',
  divisionNumber: null,
  billKey: 'B',
  lawReference: null,
  sourceUrl: null,
  tallyMismatch: false,
  kind: 'legislative',
  voteSubject: null,
  voteDateTimeText: null,
  // W1.3: mirror the legacy billKey so `bill` still resolves for these
  // fixtures — they exercise dossier/child wiring, not resolution.
  resolutionStatus: 'resolved',
  resolutionMethod: 'agree',
  resolvedDisplayBillKey: 'B',
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
});

const billEvent = (sourceBillKey: string, position: number): ParliamentBillEvent => ({
  sourceBillKey,
  position,
  eventDate: '2026-05-04',
  eventDateText: null,
  description: 'Adoptat',
  chamberCode: null,
  committee: null,
  voteIdv: null,
  docs: [],
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

const actLink = (targetActId: string): ParliamentBillActLink => ({
  relationshipKind: 'becomes_law',
  targetActId,
  targetActType: 'LEGE',
  targetActNumber: '423',
  targetActYear: 2023,
  targetMoActKey: null,
  resolutionStatus: 'linked',
  confidenceLabel: 'exact',
  primaryMethod: 'final_law_number',
});

const voteLink = (voteKey: string, billKey: string): ParliamentBillVoteLink => ({
  voteKey,
  billKey,
  role: 'final_adoption',
  resolutionStatus: 'linked',
  confidenceLabel: 'exact',
});

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
  // Published from attrs since 2026-08-05; this fixture carries none of them.
  decisionChamber: null,
  lawCharacter: null,
  procedureUrgency: null,
  procedureRegime: null,
  objectOfRegulation: null,
  lastEventDescription: null,
  firstEventDate: null,
  lastEventSource: null,
  cdepProjectUrl: null,
  senateDetailUrl: null,
  senateFileUrl: null,
  senateOpinionsUrl: null,
  senateCod: null,
  governmentENumber: null,
  governmentEYear: null,
  initiatorType: null,
  initiatorTypeConfidence: null,
  initiatorTypeMethod: null,
  sourceUpdatedAt: null,
  updatedAt: null,
};

/**
 * A rich two-view repo exercising every merge law at once: duplicate
 * mandate/vote keys across views (dedupe) and byte-identical observation rows
 * (kept). Used by BOTH the wiring test and the dossier-equivalence test.
 */
/**
 * A batched fake honouring the port's ordering contract (2026-08-05): ONE call
 * per family for the whole view set, rows grouped by bill_key in the order the
 * caller listed them — what `array_position($1, bill_key)` produces in SQL.
 * Every merge law under test (concat order, dedupe-keeps-first) is defined
 * against that ordering, so the fakes must not be free to reorder.
 */
const byView =
  <T>(rowsFor: (billKey: string) => readonly T[]) =>
  (billKeys: readonly string[]) =>
    okp<readonly T[]>(billKeys.flatMap((k) => [...rowsFor(k)]));

const richPairRepo = (): Partial<ParliamentRepo> => ({
  ...PAIR,
  findBill: () => okp<ParliamentBill | null>(BILL),
  getBillEvents: byView((k) =>
    k === 'A' ? [billEvent('A', 1)] : [billEvent('B', 1), billEvent('B', 2)]
  ),
  getBillDocuments: byView((k) => [billDocument(k, 'https://cdep.ro/x.pdf')]),
  getBillInitiators: byView((k) =>
    k === 'A'
      ? [member('1:2024:7', 'Barcari Dorina')]
      : [member('1:2024:7', 'STALE TWIN ROW'), member('2:2024:11', 'Popa Elena')]
  ),
  listVotesForBill: byView((k) =>
    k === 'A'
      ? [vote('cdep:9001', 'vot final')]
      : [vote('cdep:9001', 'STALE TWIN ROW'), vote('senat:5501', 'vot Senat')]
  ),
  getBillActLinks: byView(() => [actLink('77')]),
  getBillVoteLinks: byView((k) => [voteLink('cdep:9001', k)]),
});

// ── 1. wiring: all six lazy fields read their OWN family across both views ──

describe('ParliamentBill lazy children — six-field wiring across the view pair', () => {
  const CASES = [
    {
      field: 'events',
      expected: [billEvent('A', 1), billEvent('B', 1), billEvent('B', 2)],
    },
    {
      field: 'documents',
      expected: [
        billDocument('A', 'https://cdep.ro/x.pdf'),
        billDocument('B', 'https://cdep.ro/x.pdf'),
      ],
    },
    {
      field: 'initiators',
      expected: [member('1:2024:7', 'Barcari Dorina'), member('2:2024:11', 'Popa Elena')],
    },
    {
      field: 'relatedVotes',
      expected: [vote('cdep:9001', 'vot final'), vote('senat:5501', 'vot Senat')],
    },
    {
      field: 'actLinks',
      // Byte-identical from both views: observations, both kept.
      expected: [actLink('77'), actLink('77')],
    },
    {
      field: 'voteLinks',
      expected: [voteLink('cdep:9001', 'A'), voteLink('cdep:9001', 'B')],
    },
  ] as const;

  it.each(CASES)(
    '$field merges its own family, requested view first',
    async ({ field, expected }) => {
      const fields = billFields(makeRepo(richPairRepo()));
      const rows = await fields[field]?.({ billKey: 'A' }, {});
      expect(rows).toEqual(expected);
    }
  );
});

// ── 2. equivalence: per-family readers ≡ getBillDossier, same repo ───────────

describe('per-family readers return EXACTLY what getBillDossier merges', () => {
  it('per family, against the same rich two-view repo', async () => {
    const repo = makeRepo(richPairRepo());
    const d = deps(repo);

    const dossier = (await getBillDossier(d, 'A'))._unsafeUnwrap();
    expect(dossier).not.toBeNull();

    const scope = makeBillChildReadScope(d);
    expect((await getBillDossierEvents(d, scope, 'A'))._unsafeUnwrap()).toEqual(dossier?.events);
    expect((await getBillDossierDocuments(d, scope, 'A'))._unsafeUnwrap()).toEqual(
      dossier?.documents
    );
    expect((await getBillDossierInitiators(d, scope, 'A'))._unsafeUnwrap()).toEqual(
      dossier?.initiators
    );
    expect((await getBillDossierRelatedVotes(d, scope, 'A'))._unsafeUnwrap()).toEqual(
      dossier?.relatedVotes
    );
    expect((await getBillDossierActLinks(d, scope, 'A'))._unsafeUnwrap()).toEqual(
      dossier?.actLinks
    );
    expect((await getBillDossierVoteLinks(d, scope, 'A'))._unsafeUnwrap()).toEqual(
      dossier?.voteLinks
    );
  });
});

// ── 3–5. the B-F19 shape, prefill short-circuit, dossierBillKeys ─────────────

describe('ParliamentBill lazy children — dossier-union on every parent path', () => {
  it('relatedVotes serves the suppressed twin’s votes when the direct key has none', async () => {
    // The exact live shape: canonical view 'A' owns ZERO vote rows; every
    // division sits on the suppressed twin 'B'. Pre-fix this returned [].
    const listVotesForBill = vi.fn(
      byView((k: string) =>
        k === 'A' ? [] : [vote('cdep:9001', 'vot final'), vote('cdep:9002', 'raport')]
      )
    );
    const fields = billFields(makeRepo({ ...PAIR, listVotesForBill }));

    // Parent WITHOUT prefilled children — a bills-list row / voteLinks.bill parent.
    const votes = (await fields['relatedVotes']?.({ billKey: 'A' }, {})) as ParliamentVote[];

    expect(votes.map((v) => v.voteKey)).toEqual(['cdep:9001', 'cdep:9002']);
    // ONE batched read for the whole accepted view set (was one per view).
    expect(listVotesForBill).toHaveBeenCalledTimes(1);
    expect(listVotesForBill.mock.calls[0]?.[0]).toEqual(['A', 'B']);
  });

  it('a parent prefilled by the dossier root short-circuits (no repo call at all)', async () => {
    // The Proxy repo throws on ANY access — a lazy read here fails the test loudly.
    const fields = billFields(makeRepo({}));
    const prefilled = [vote('cdep:9001', 'vot final')];

    const votes = await fields['relatedVotes']?.({ billKey: 'A', relatedVotes: prefilled }, {});

    expect(votes).toBe(prefilled);
  });

  it('dossierBillKeys resolves root-independently (and passes a prefilled value through)', async () => {
    const fields = billFields(makeRepo(PAIR));
    expect(await fields['dossierBillKeys']?.({ billKey: 'A' }, {})).toEqual(['A', 'B']);

    const prefilledFields = billFields(makeRepo({}));
    expect(
      await prefilledFields['dossierBillKeys']?.({ billKey: 'A', dossierBillKeys: ['A'] }, {})
    ).toEqual(['A']);
  });

  it('a single-view bill reads exactly its own key', async () => {
    const listVotesForBill = vi.fn((_ks: readonly string[]) =>
      okp<readonly ParliamentVote[]>([vote('cdep:1', 'v')])
    );
    const repo = makeRepo({
      getBillDossierViewKeys: () => okp<readonly string[]>(['A']),
      listVotesForBill,
    });
    const d = deps(repo);

    const votes = (
      await getBillDossierRelatedVotes(d, makeBillChildReadScope(d), 'A')
    )._unsafeUnwrap();
    expect(votes.map((v) => v.voteKey)).toEqual(['cdep:1']);
    expect(listVotesForBill).toHaveBeenCalledTimes(1);
    expect(listVotesForBill.mock.calls[0]?.[0]).toEqual(['A']);
  });

  it('propagates a view-key resolution failure', async () => {
    const repo = makeRepo({
      getBillDossierViewKeys: () => errp<readonly string[]>('getBillDossierViewKeys failed'),
    });
    const d = deps(repo);

    const r = await getBillDossierVoteLinks(d, makeBillChildReadScope(d), 'A');
    expect(r.isErr()).toBe(true);
    expect(r._unsafeUnwrapErr().message).toBe('getBillDossierViewKeys failed');
  });

  it('propagates a child-read failure on the SECOND view (never silently partial)', async () => {
    const repo = makeRepo({
      ...PAIR,
      listVotesForBill: (ks: readonly string[]) =>
        ks.includes('B')
          ? errp<readonly ParliamentVote[]>('listVotesForBill failed')
          : okp<readonly ParliamentVote[]>([vote('cdep:1', 'v')]),
    });
    const d = deps(repo);

    const r = await getBillDossierRelatedVotes(d, makeBillChildReadScope(d), 'A');
    expect(r.isErr()).toBe(true);
    expect(r._unsafeUnwrapErr().message).toBe('listVotesForBill failed');
  });
});

// ── 6. getBillDossierViewKeys: the dup_review group quarantine ───────────────

/** A Kysely db whose single connection answers every query with canned rows. */
const makeCannedDb = (rows: readonly Record<string, unknown>[]): Kysely<ProdDatabase> => {
  const connection: DatabaseConnection = {
    executeQuery<R>(_query: CompiledQuery): Promise<QueryResult<R>> {
      return Promise.resolve({ rows: rows as R[] });
    },
    streamQuery(): AsyncIterableIterator<QueryResult<never>> {
      throw new Error('streamQuery not supported in the canned db');
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

describe('getBillDossierViewKeys — a dup_review mark quarantines the WHOLE group', () => {
  it('blends a clean resolved pair', async () => {
    const repo = makeParliamentRepo(
      makeCannedDb([
        { bill_key: 'A', is_canonical: true, dup_review: null },
        { bill_key: 'B', is_canonical: false, dup_review: null },
      ])
    );
    expect((await repo.getBillDossierViewKeys('A'))._unsafeUnwrap()).toEqual(['A', 'B']);
  });

  it('refuses to blend a pair-shaped group when ANY member carries a review mark', async () => {
    // The reserved `law_inconsistent` shape: pair-shaped, one canonical — the
    // count rule alone would blend it. The mark must win.
    const repo = makeParliamentRepo(
      makeCannedDb([
        { bill_key: 'A', is_canonical: true, dup_review: null },
        { bill_key: 'B', is_canonical: false, dup_review: 'law_inconsistent' },
      ])
    );
    expect((await repo.getBillDossierViewKeys('A'))._unsafeUnwrap()).toEqual(['A']);
  });
});

// ── 7. the request scope: coalescing and the concurrency bound ───────────────

describe('BillChildReadScope — request-scoped coalescing and bounding', () => {
  it('one context ⇒ ONE view-key read per billKey across all seven fields', async () => {
    const getBillDossierViewKeys = vi.fn((_k: string) => okp<readonly string[]>(['A', 'B']));
    const fields = billFields(makeRepo({ ...richPairRepo(), getBillDossierViewKeys }));
    const ctx = {}; // one request
    const parent = { billKey: 'A' };

    await Promise.all([
      fields['events']?.(parent, {}, ctx),
      fields['documents']?.(parent, {}, ctx),
      fields['initiators']?.(parent, {}, ctx),
      fields['relatedVotes']?.(parent, {}, ctx),
      fields['actLinks']?.(parent, {}, ctx),
      fields['voteLinks']?.(parent, {}, ctx),
      fields['dossierBillKeys']?.(parent, {}, ctx),
    ]);

    // Pre-scope this was SEVEN independent reads — a torn dossierBillKeys-vs-
    // children snapshot during sync nights, and 7x the statements.
    expect(getBillDossierViewKeys).toHaveBeenCalledTimes(1);
  });

  it('without a usable context, the PARENT object still coalesces its own reads', async () => {
    const getBillDossierViewKeys = vi.fn((_k: string) => okp<readonly string[]>(['A', 'B']));
    const fields = billFields(makeRepo({ ...richPairRepo(), getBillDossierViewKeys }));
    const parent = { billKey: 'A' };

    await Promise.all([
      fields['relatedVotes']?.(parent, {}),
      fields['voteLinks']?.(parent, {}),
      fields['dossierBillKeys']?.(parent, {}),
    ]);

    expect(getBillDossierViewKeys).toHaveBeenCalledTimes(1);
  });

  it('bounds concurrent lazy child reads across MANY list rows sharing a context', async () => {
    // 25 bills × (1 view-key read + 2 votes reads) fan out at once — the shape
    // of `parliamentBills(pageSize:100){ relatedVotes }`. The shared scope must
    // keep in-flight repo statements at DOSSIER_CHILD_READ_CONCURRENCY.
    let inFlight = 0;
    let peak = 0;
    const parked: (() => void)[] = [];
    const park = <T>(value: T): Promise<Result<T, ApiError>> => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      return new Promise((resolve) => {
        parked.push(() => {
          inFlight -= 1;
          resolve(ok(value));
        });
      });
    };
    const releaseAll = (): number => {
      const wave = parked.splice(0, parked.length);
      for (const release of wave) release();
      return wave.length;
    };

    const fields = billFields(
      makeRepo({
        getBillDossierViewKeys: (k: string) => park<readonly string[]>([k, `${k}:twin`]),
        listVotesForBill: (ks: readonly string[]) =>
          park<readonly ParliamentVote[]>(ks.map((k) => vote(`v:${k}`, 't'))),
      })
    );

    const ctx = {};
    const relatedVotes = fields['relatedVotes']!;
    const runs = Array.from({ length: 25 }, (_v, i) =>
      relatedVotes({ billKey: `bill${String(i)}` }, {}, ctx)
    );

    await tick();
    expect(peak).toBeLessThanOrEqual(DOSSIER_CHILD_READ_CONCURRENCY);
    while (releaseAll() > 0) {
      await tick();
      expect(inFlight).toBeLessThanOrEqual(DOSSIER_CHILD_READ_CONCURRENCY);
    }

    const all = (await Promise.all(runs)) as ParliamentVote[][];
    expect(all).toHaveLength(25);
    expect(all[0]?.map((v) => v.voteKey)).toEqual(['v:bill0', 'v:bill0:twin']);
    expect(peak).toBeLessThanOrEqual(DOSSIER_CHILD_READ_CONCURRENCY);
    // The bound actually bit: 50 total reads (25 view-key reads + 25 batched
    // family reads, down from 75 before batching) could not all run at once.
    expect(peak).toBe(DOSSIER_CHILD_READ_CONCURRENCY);
  });
});
