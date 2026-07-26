/**
 * Parliament module — usecases (plan 04 §4). Framework-free, over the port,
 * returning `Result`. The SAME usecase backs the GraphQL resolver AND the MCP tool
 * (tri-surface equivalence, §14.7). This is where the CROSS-FIELD guards live (the
 * per-field kernel composer can't express them — Codex SHOULD-FIX):
 *   - votes `q`-only requires a chamber/date bound when the search engine is down.
 *   - control-items list requires a date window OR recipient/author bound.
 *   - cohesion accepts EXACTLY ONE mode (billKey OR chamber+from+to) and hard-caps
 *     the vote set at COHESION_VOTE_CAP before any vote_records fan-in.
 */

import { err, ok, type Result } from 'neverthrow';

import {
  databaseError,
  foldDiacritics,
  invalidInput,
  normalizeOffset,
  notFound,
  type ApiError,
  type CursorPage,
  type CursorPageRequest,
  type FilterInput,
  type MeiliClient,
} from '@/modules/shared/index.js';

import { DOSSIER_CHILD_READ_CONCURRENCY, makeConcurrencyGate } from './concurrency.js';
import {
  COHESION_VOTE_CAP,
  PARLIAMENT_RESOLVE_DIMS,
  VOTE_CHAMBERS_OK,
  searchUnavailable,
  toStenogramSessionRef,
  transcriptUnavailable,
  type MemberActivityKind,
  type ParliamentActLineage,
  type ParliamentActivityCounts,
  type ParliamentBallot,
  type ParliamentBill,
  type ParliamentBillDossier,
  type ParliamentCommittee,
  type ParliamentCommitteeDetail,
  type ParliamentControlItem,
  type ParliamentDataFreshness,
  type ParliamentGroup,
  type ParliamentGroupCohesion,
  type ParliamentInitiative,
  type ParliamentLineageVote,
  type ParliamentMember,
  type ParliamentMemberSpeechActivity,
  type ParliamentMemberVote,
  type ParliamentMemberVoteActivity,
  type ParliamentPerson,
  type ParliamentPersonCandidate,
  type ParliamentPersonCareer,
  type ParliamentResolveDim,
  type ParliamentResolveHit,
  type ParliamentSittingNavigation,
  type ParliamentSpeech,
  type ParliamentSpeechActivity,
  type ParliamentSpeechContext,
  type ParliamentSpeechPopulation,
  type ParliamentSpeechRedirect,
  type ParliamentSpeechSearchDepth,
  type ParliamentStenogramError,
  type ParliamentStenogramSegment,
  type ParliamentStenogramSession,
  type ParliamentStenogramTranscript,
  type ParliamentVote,
  type ParliamentVoteDetail,
  type VoteChamber,
} from './types.js';

import type { OffsetResult, ParliamentRepo, ParliamentTranscriptSearchPort } from './ports.js';

export interface ParliamentUsecaseDeps {
  readonly repo: ParliamentRepo;
  /** Kernel Meili client for name resolution (null → pg fallback only). */
  readonly meili: MeiliClient | null;
}

/**
 * The stenogram usecases additionally need the canonical full-history transcript
 * search projection. It is EXPLICITLY nullable and never defaulted to a substitute:
 * `null` means the surface answers a `q` with `SearchUnavailable`, which is the whole
 * point of the port (a silent title-only fallback is the failure mode we refuse).
 */
export interface ParliamentStenogramUsecaseDeps extends ParliamentUsecaseDeps {
  readonly transcriptSearch: ParliamentTranscriptSearchPort | null;
}

const VOTE_CHAMBER_SET = new Set(VOTE_CHAMBERS_OK);

/**
 * A field carries a REAL bound only when it has at least one op whose value is a
 * non-empty primitive / non-empty range / non-empty array (Codex BLOCKER #1: an
 * empty `{chamber:{}}` or `{recipient:{contains:""}}` must NOT count as a bound —
 * it emits no SQL predicate, so it would not actually bound the scan).
 */
const fieldHasValue = (filter: FilterInput, name: string): boolean => {
  // Read as unknown: FilterInput omits null, but a GraphQL-nullable filter field can
  // arrive as `null` at runtime; `typeof null === 'object'`, so guard it before
  // Object.values (else `filter:{q:null}` throws a raw TypeError).
  const ff: unknown = filter[name];
  if (ff === null || typeof ff !== 'object') return false;
  for (const v of Object.values(ff as Record<string, unknown>)) {
    if (v === undefined || v === null) continue;
    if (typeof v === 'string') {
      if (v !== '') return true;
    } else if (Array.isArray(v)) {
      if (v.length > 0) return true;
    } else if (typeof v === 'object') {
      const range = v as { from?: unknown; to?: unknown };
      if (range.from !== undefined || range.to !== undefined) return true;
    } else {
      return true; // number / boolean
    }
  }
  return false;
};

const hasVoteBound = (filter: FilterInput): boolean =>
  fieldHasValue(filter, 'chamber') ||
  fieldHasValue(filter, 'voteDate') ||
  fieldHasValue(filter, 'billKey');

const hasControlBound = (filter: FilterInput): boolean =>
  fieldHasValue(filter, 'itemDate') ||
  fieldHasValue(filter, 'recipient') ||
  fieldHasValue(filter, 'author');

// ── members / persons / groups ───────────────────────────────────────────────

export interface MembersInput {
  readonly filter: FilterInput;
  readonly sort: string;
  readonly page: { page?: number; pageSize?: number };
}

export const listMembers = async (
  deps: ParliamentUsecaseDeps,
  input: MembersInput
): Promise<Result<OffsetResult<ParliamentMember>, ApiError>> => {
  // Default the legislature to the latest when the caller omits it (bounds the scan).
  let filter = input.filter;
  if (filter['legislature'] === undefined) {
    const latest = await deps.repo.latestLegislature();
    if (latest.isErr()) return err(latest.error);
    if (latest.value !== null) filter = { ...filter, legislature: { eq: latest.value } };
  }
  return deps.repo.listMembers(
    filter,
    input.sort,
    normalizeOffset(input.page.page, input.page.pageSize)
  );
};

/**
 * A member's IDENTITY — and nothing else.
 *
 * This is deliberately ONE query. It used to eagerly fan out to `findPerson` +
 * `listGroupIntervals` + five count queries (seven concurrent DB round trips) and
 * return `err` if ANY of them failed, which the GraphQL root then turned into
 * `parliamentMember: null` — a valid member rendered as "not found" because an
 * ancillary count had a bad day. Person / group intervals / activity counts are
 * now resolved LAZILY by their own field resolvers, so:
 *   - a deep-link that selects only identity fields costs exactly one query, and
 *   - an ancillary failure degrades that field, never the member.
 */
export const getMember = async (
  deps: ParliamentUsecaseDeps,
  mandateKey: string
): Promise<Result<ParliamentMember | null, ApiError>> => deps.repo.findMember(mandateKey);

/**
 * The member's five activity totals. ONE bounded round trip (see
 * `ParliamentRepo.memberActivityCounts`). Ancillary by contract: callers must
 * degrade to an explicit "unavailable" on error and MUST NOT substitute zeros —
 * a fabricated `0` is indistinguishable from a real "never spoke".
 */
export const getMemberActivityCounts = (
  deps: ParliamentUsecaseDeps,
  mandateKey: string
): Promise<Result<ParliamentActivityCounts, ApiError>> =>
  deps.repo.memberActivityCounts(mandateKey);

export const getPersonCareer = async (
  deps: ParliamentUsecaseDeps,
  personId: string
): Promise<Result<ParliamentPersonCareer | null, ApiError>> => {
  const p = await deps.repo.findPerson(personId);
  if (p.isErr()) return err(p.error);
  if (p.value === null) return ok(null);

  const [mandates, intervals] = await Promise.all([
    deps.repo.listPersonMandates(personId),
    deps.repo.listGroupIntervalsForPerson(personId),
  ]);
  if (mandates.isErr()) return err(mandates.error);
  if (intervals.isErr()) return err(intervals.error);

  // Career totals: sum the bounded per-mandate counts (one round trip per mandate;
  // a person holds at most a handful).
  let votes = 0;
  let initiatives = 0;
  let speeches = 0;
  for (const m of mandates.value) {
    const counts = await deps.repo.memberActivityCounts(m.mandateKey);
    if (counts.isErr()) return err(counts.error);
    votes += counts.value.votes;
    initiatives += counts.value.initiatives;
    speeches += counts.value.speeches;
  }
  return ok({
    person: p.value,
    mandates: mandates.value,
    groupIntervals: intervals.value,
    careerTotals: { mandates: mandates.value.length, votes, initiatives, speeches },
  });
};

export const listGroups = (
  deps: ParliamentUsecaseDeps,
  legislature: string | undefined,
  chamber: string | undefined,
  current?: boolean
): Promise<Result<readonly ParliamentGroup[], ApiError>> =>
  (async () => {
    let leg = legislature;
    if (leg === undefined) {
      const latest = await deps.repo.latestLegislature();
      if (latest.isErr()) return err(latest.error);
      leg = latest.value ?? '';
    }
    if (leg === '') return ok([]);
    // current (SC-1): currently-seated composition counts (camera 330 / senat 134).
    return deps.repo.listGroupCounts(leg, chamber, current);
  })();

// ── bills ────────────────────────────────────────────────────────────────────

export interface BillsInput {
  readonly filter: FilterInput;
  readonly sort: string;
  readonly page: { page?: number; pageSize?: number };
}

export const listBills = (
  deps: ParliamentUsecaseDeps,
  input: BillsInput
): Promise<Result<OffsetResult<ParliamentBill>, ApiError>> =>
  deps.repo.listBills(
    input.filter,
    input.sort,
    normalizeOffset(input.page.page, input.page.pageSize)
  );

export const getBillDossier = async (
  deps: ParliamentUsecaseDeps,
  billKey: string
): Promise<Result<ParliamentBillDossier | null, ApiError>> => {
  const b = await deps.repo.findBill(billKey);
  if (b.isErr()) return err(b.error);
  if (b.value === null) return ok(null);

  // 2026-07-22 readiness fix: read children across the FULL accepted view set —
  // the requested view plus its resolved-pair navetă twin — so a canonical read
  // no longer drops the suppressed source view's events/documents/links.
  // Ambiguous dup-review groups resolve to [billKey] alone (never blended).
  const keysRes = await deps.repo.getBillDossierViewKeys(billKey);
  if (keysRes.isErr()) return err(keysRes.error);
  const viewBillKeys = keysRes.value;

  // 2026-07-26 connection-exhaustion fix: a resolved pair asks for 2 views × 6 child
  // families, and starting all 12 at once burned 12 simultaneous connections for ONE
  // request — enough to trip `FATAL: too many connections for role
  // transparenta_prod_agent_readonly` and abort the dossier. The gate throttles STARTS
  // only, at DOSSIER_CHILD_READ_CONCURRENCY; every read below still runs to completion,
  // in the same tuple positions, so the merge and first-error-wins scan are untouched.
  const gate = makeConcurrencyGate(DOSSIER_CHILD_READ_CONCURRENCY);
  const perView = await Promise.all(
    viewBillKeys.map((k) =>
      Promise.all([
        gate(() => deps.repo.getBillEvents(k)),
        gate(() => deps.repo.getBillDocuments(k)),
        gate(() => deps.repo.getBillInitiators(k)),
        gate(() => deps.repo.listVotesForBill(k)),
        gate(() => deps.repo.getBillActLinks(k)),
        gate(() => deps.repo.getBillVoteLinks(k)),
      ])
    )
  );
  for (const six of perView) {
    for (const r of six) {
      if (r.isErr()) return err(r.error);
    }
  }
  // Merge laws per child family (panel-locked aggregation rules):
  //  - events/documents/act-links/vote-links stay source-qualified OBSERVATIONS —
  //    concatenated per view (requested view first), never value-deduplicated;
  //  - relatedVotes deduplicate by stable vote_key (the same voting event may be
  //    linked from both views);
  //  - initiators deduplicate by mandate_key (same member mentioned in both views).
  const events = perView.flatMap((v) => v[0]._unsafeUnwrap());
  const documents = perView.flatMap((v) => v[1]._unsafeUnwrap());
  const seenMandates = new Set<string>();
  const initiators = perView
    .flatMap((v) => v[2]._unsafeUnwrap())
    .filter((m) => {
      if (seenMandates.has(m.mandateKey)) return false;
      seenMandates.add(m.mandateKey);
      return true;
    });
  const seenVotes = new Set<string>();
  const relatedVotes = perView
    .flatMap((v) => v[3]._unsafeUnwrap())
    .filter((vote) => {
      if (seenVotes.has(vote.voteKey)) return false;
      seenVotes.add(vote.voteKey);
      return true;
    });
  const actLinks = perView.flatMap((v) => v[4]._unsafeUnwrap());
  const voteLinks = perView.flatMap((v) => v[5]._unsafeUnwrap());

  return ok({
    viewBillKeys,
    bill: b.value,
    events,
    documents,
    // H10: pass the full members through (no reduced projection) so initiators expose
    // the same shape as parliamentMember(s) — legislature/normalizedName/constituency/
    // birthDate and the nested group/person/interval resolvers all resolve.
    initiators,
    relatedVotes,
    actLinks,
    voteLinks,
  });
};

// ── votes / records ──────────────────────────────────────────────────────────

export interface VotesInput {
  readonly filter: FilterInput;
  readonly sort: string;
  readonly dir: 'asc' | 'desc';
  readonly page: CursorPageRequest;
  /** True when a search engine (Meili/OS) is available — relaxes the q-only bound. */
  readonly searchEngineUp: boolean;
}

export const listVotes = (
  deps: ParliamentUsecaseDeps,
  input: VotesInput
): Promise<Result<CursorPage<ParliamentVote>, ApiError>> =>
  (async () => {
    // q-only-without-bound guard (Codex SHOULD-FIX): when the search engine is down
    // the ILIKE fallback needs a bounding predicate, else it scans 20k votes title-wide.
    const f = input.filter;
    const hasQ = fieldHasValue(f, 'q');
    if (hasQ && !input.searchEngineUp && !hasVoteBound(f)) {
      return err(
        invalidInput(
          'votes q-search requires a chamber or date bound when the search service is unavailable',
          'q'
        )
      );
    }
    return deps.repo.listVotes(f, input.sort, input.dir, input.page);
  })();

export const getVoteDetail = async (
  deps: ParliamentUsecaseDeps,
  voteKey: string
): Promise<Result<ParliamentVoteDetail | null, ApiError>> => {
  const v = await deps.repo.findVote(voteKey);
  if (v.isErr()) return err(v.error);
  if (v.value === null) return ok(null);
  const gb = await deps.repo.voteGroupBreakdown(voteKey);
  if (gb.isErr()) return err(gb.error);
  return ok({ vote: v.value, groupBreakdown: gb.value });
};

export const getVoteBallots = (
  deps: ParliamentUsecaseDeps,
  voteKey: string,
  page: CursorPageRequest
): Promise<Result<CursorPage<ParliamentBallot>, ApiError>> =>
  deps.repo.listVoteRecords(voteKey, page);

// ── member activity ──────────────────────────────────────────────────────────

export const getMemberVotes = (
  deps: ParliamentUsecaseDeps,
  mandateKey: string,
  page: CursorPageRequest,
  filter: FilterInput = {}
): Promise<Result<CursorPage<ParliamentMemberVote> & { total: number }, ApiError>> =>
  deps.repo.listMemberVotes(mandateKey, page, filter);

export const getMemberVoteActivity = (
  deps: ParliamentUsecaseDeps,
  mandateKey: string,
  year: number,
  filter: FilterInput
): Promise<Result<ParliamentMemberVoteActivity, ApiError>> =>
  (async () => {
    // voteDate is not a client bound here — the year argument bounds the range (a
    // voteDate filter would double-bound the per-day window and confuse the caller).
    if (fieldHasValue(filter, 'voteDate')) {
      return err(
        invalidInput(
          'voteDate is not accepted on voteActivity; the year argument bounds the range',
          'voteDate'
        )
      );
    }
    if (!Number.isInteger(year) || year < 1990 || year > 2100) {
      return err(invalidInput('year must be an integer between 1990 and 2100', 'year'));
    }
    return deps.repo.memberVoteActivity(mandateKey, year, filter);
  })();

export const getMemberControlItems = (
  deps: ParliamentUsecaseDeps,
  mandateKey: string,
  page: { page?: number; pageSize?: number }
): Promise<Result<OffsetResult<ParliamentControlItem>, ApiError>> =>
  deps.repo.listMemberControlItems(mandateKey, normalizeOffset(page.page, page.pageSize));

export const getMemberSpeeches = (
  deps: ParliamentUsecaseDeps,
  mandateKey: string,
  page: { page?: number; pageSize?: number }
): Promise<Result<OffsetResult<ParliamentSpeech>, ApiError>> =>
  deps.repo.listMemberSpeeches(mandateKey, normalizeOffset(page.page, page.pageSize));

/** Max length of the member-speech search token (guards a pathological ILIKE). */
export const SPEECH_Q_MAX = 200;

/**
 * Normalize a member-speech `q`: trim, LOWER-CASE, and treat empty as ABSENT
 * (undefined). Pure + idempotent — the resolver threads the SAME normalized value into
 * both the repo call and the connection's cursor fhash so paging never mismatches on
 * the search term. Lower-casing is load-bearing for cursor identity: the predicate is
 * `ILIKE` (case-insensitive), so 'Lege' and 'lege' are the SAME effective query and
 * MUST share the fhash — normalizing to one canonical form guarantees they do.
 */
export const normalizeSpeechQ = (q: string | null | undefined): string | undefined => {
  if (q === null || q === undefined) return undefined;
  const t = q.trim().toLowerCase();
  return t === '' ? undefined : t;
};

export const getMemberSpeechesConnection = (
  deps: ParliamentUsecaseDeps,
  mandateKey: string,
  page: CursorPageRequest,
  filter: FilterInput = {},
  rawQ?: string | null
): Promise<
  Result<
    CursorPage<ParliamentSpeech> & {
      total: number;
      population: ParliamentSpeechPopulation;
    },
    ApiError
  >
> =>
  (async () => {
    const q = normalizeSpeechQ(rawQ);
    if (q !== undefined && q.length > SPEECH_Q_MAX) {
      return err(invalidInput(`q must be at most ${String(SPEECH_Q_MAX)} characters`, 'q'));
    }
    return deps.repo.listMemberSpeechesCursor(mandateKey, page, filter, q);
  })();

export const getMemberSpeechActivity = (
  deps: ParliamentUsecaseDeps,
  mandateKey: string,
  year: number,
  filter: FilterInput = {},
  rawQ?: string | null
): Promise<Result<ParliamentMemberSpeechActivity, ApiError>> =>
  (async () => {
    // spokenAt is not a client bound here — the year argument bounds the range (a
    // spokenAt filter would double-bound the per-day window and confuse the caller).
    if (fieldHasValue(filter, 'spokenAt')) {
      return err(
        invalidInput(
          'spokenAt is not accepted on speechActivity; the year argument bounds the range',
          'spokenAt'
        )
      );
    }
    if (!Number.isInteger(year) || year < 1990 || year > 2100) {
      return err(invalidInput('year must be an integer between 1990 and 2100', 'year'));
    }
    const q = normalizeSpeechQ(rawQ);
    if (q !== undefined && q.length > SPEECH_Q_MAX) {
      return err(invalidInput(`q must be at most ${String(SPEECH_Q_MAX)} characters`, 'q'));
    }
    return deps.repo.memberSpeechActivity(mandateKey, year, filter, q);
  })();

export const getMemberInitiatives = (
  deps: ParliamentUsecaseDeps,
  mandateKey: string,
  page: { page?: number; pageSize?: number }
): Promise<Result<OffsetResult<ParliamentInitiative>, ApiError>> =>
  deps.repo.listMemberInitiatives(mandateKey, normalizeOffset(page.page, page.pageSize));

// ── global speeches (stenograme) ───────────────────────────────────────────────

/**
 * Hard bound for a global-speeches `spokenAt` window (INCLUSIVE days). The only
 * index on `parliament.speeches` is `(mandate_key, spoken_at desc)` — there is NO
 * date index — so an unparented list is a sequential scan; a year-wide window
 * (366 days covers a leap year) keeps that scan bounded. An unbounded list is
 * REFUSED with InvalidInput (the `parliamentControlItems` guard precedent), never
 * silently defaulted.
 */
export const SPEECHES_WINDOW_MAX_DAYS = 366;

/**
 * Max `spokenAt` window (INCLUSIVE days) for FULL-TEXT `q` depth on the global
 * list. Rationale for 92 (a quarter): the transcript search is an EXISTS probe
 * per candidate row into the ~1GB `parliament.speech_texts` table; a quarter is
 * ≈20–40k EXISTS probes — parity with the accepted member-connection worst case
 * (~35k rows per mandate). A 366-day window would mean 70–150k random heap
 * fetches into that table — not safe. A wider (but ≤366-day) window still
 * searches, at TITLE_SUMMARY depth; the connection reports the APPLIED depth.
 */
export const SPEECHES_FULLTEXT_WINDOW_MAX_DAYS = 92;

/** Parse 'YYYY-MM-DD' to a UTC epoch-day integer; null when malformed/impossible. */
const utcEpochDay = (s: unknown): number | null => {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(s)) return null;
  const [y = 0, m = 0, d = 0] = s.split('-').map(Number);
  const ms = Date.UTC(y, m - 1, d);
  const dt = new Date(ms);
  // Round-trip check rejects impossible dates ('2026-02-30' would roll to March).
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return ms / 86_400_000;
};

/**
 * The INCLUSIVE day-span of a filter's `spokenAt` window, or null unless BOTH ends
 * are present and valid and from ≤ to. Takes the TIGHTEST bounds across gte/lte
 * AND between (multiple ops AND together in SQL, so the effective window is the
 * intersection). Pure UTC integer math over 'YYYY-MM-DD' — no timezone/DST
 * wobble. Exported for direct unit coverage.
 */
export const spokenAtWindowDays = (filter: FilterInput): number | null => {
  const ff: unknown = filter['spokenAt'];
  if (ff === null || typeof ff !== 'object' || Array.isArray(ff)) return null;
  const f = ff as { gte?: unknown; lte?: unknown; between?: unknown };
  const between =
    f.between !== null && typeof f.between === 'object' && !Array.isArray(f.between)
      ? (f.between as { from?: unknown; to?: unknown })
      : undefined;
  const lowers = [utcEpochDay(f.gte), utcEpochDay(between?.from)].filter(
    (x): x is number => x !== null
  );
  const uppers = [utcEpochDay(f.lte), utcEpochDay(between?.to)].filter(
    (x): x is number => x !== null
  );
  if (lowers.length === 0 || uppers.length === 0) return null;
  const from = Math.max(...lowers);
  const to = Math.min(...uppers);
  if (from > to) return null;
  return to - from + 1;
};

/**
 * Cardinality cap on `mandateKey` values (eq + in, deduped). Each mandate is a
 * bounded index slice (median 72 turns, worst ~35k), so a HANDFUL of mandates is
 * still bounded — but an uncapped `in:` list would let a caller reassemble a
 * near-global scan out of thousands of "bounds" (codex round-3 MAJOR).
 */
export const SPEECHES_MANDATE_KEYS_MAX = 20;

/** The deduped non-empty mandateKey values selected by eq + in. */
const mandateKeyValues = (filter: FilterInput): readonly string[] => {
  const ff: unknown = filter['mandateKey'];
  if (ff === null || typeof ff !== 'object' || Array.isArray(ff)) return [];
  const f = ff as { eq?: unknown; in?: unknown };
  const picked = [
    ...(typeof f.eq === 'string' && f.eq !== '' ? [f.eq] : []),
    ...(Array.isArray(f.in)
      ? (f.in as unknown[]).filter((x): x is string => typeof x === 'string' && x !== '')
      : []),
  ];
  return [...new Set(picked)];
};

/**
 * True when a `spokenAt` operand is PRESENT but not a valid YYYY-MM-DD date.
 * Checked even when a mandate bound makes the window irrelevant for boundedness:
 * without this, `mandateKey + spokenAt:{gte:"junk"}` skips the window math and
 * the junk reaches PostgreSQL as a DatabaseError instead of a clean InvalidInput
 * (codex round-3 MINOR).
 */
const hasMalformedSpokenAt = (filter: FilterInput): boolean => {
  const ff: unknown = filter['spokenAt'];
  if (ff === null || ff === undefined || typeof ff !== 'object' || Array.isArray(ff)) return false;
  const f = ff as { gte?: unknown; lte?: unknown; between?: unknown };
  const between =
    f.between !== null && typeof f.between === 'object' && !Array.isArray(f.between)
      ? (f.between as { from?: unknown; to?: unknown })
      : undefined;
  const operands = [f.gte, f.lte, between?.from, between?.to];
  return operands.some((x) => x !== undefined && x !== null && utcEpochDay(x) === null);
};

/**
 * A global-speeches list is bounded iff `mandateKey` carries 1..20 REAL values
 * (`fieldHasValue` semantics — Codex BLOCKER #1: empty `{eq:''}`/`in:[]`/`{}`
 * never count; the cardinality cap keeps an `in:` list from reassembling a
 * near-global scan) OR the `spokenAt` window is fully bounded (both ends) within
 * SPEECHES_WINDOW_MAX_DAYS. `chamber`/`q` alone bound NOTHING (no index).
 */
export const hasSpeechesBound = (filter: FilterInput): boolean => {
  const mandates = mandateKeyValues(filter);
  if (mandates.length > 0 && mandates.length <= SPEECHES_MANDATE_KEYS_MAX) return true;
  if (mandates.length > SPEECHES_MANDATE_KEYS_MAX) return false;
  const days = spokenAtWindowDays(filter);
  return days !== null && days <= SPEECHES_WINDOW_MAX_DAYS;
};

/**
 * Whether the EXPENSIVE full-text `q` depth may apply: EXACTLY ONE mandateKey
 * (the ~35k-rows-per-mandate parity argument holds per mandate, not per `in:`
 * list — codex round-3 MAJOR) OR a fully-bounded window ≤ 92 days. The repo
 * still intersects this with the live speech_texts probe — probe-false degrades
 * to TITLE_SUMMARY, and the connection reports the applied depth.
 */
export const speechesFullTextEligible = (filter: FilterInput): boolean => {
  if (mandateKeyValues(filter).length === 1) return true;
  const days = spokenAtWindowDays(filter);
  return days !== null && days <= SPEECHES_FULLTEXT_WINDOW_MAX_DAYS;
};

/** Shared pre-repo validation for the global speech surfaces (list + activity). */
const speechesFilterGuard = (filter: FilterInput): Result<true, ApiError> => {
  if (hasMalformedSpokenAt(filter)) {
    return err(invalidInput('spokenAt dates must be valid YYYY-MM-DD values', 'spokenAt'));
  }
  if (mandateKeyValues(filter).length > SPEECHES_MANDATE_KEYS_MAX) {
    return err(
      invalidInput(
        `mandateKey accepts at most ${String(SPEECHES_MANDATE_KEYS_MAX)} values`,
        'mandateKey'
      )
    );
  }
  return ok(true);
};

export interface ParliamentSpeechesInput {
  readonly filter: FilterInput;
  readonly page: CursorPageRequest;
  readonly q?: string | null | undefined;
}

export const listParliamentSpeeches = (
  deps: ParliamentUsecaseDeps,
  input: ParliamentSpeechesInput
): Promise<
  Result<
    CursorPage<ParliamentSpeech> & {
      total: number;
      totalEstimated: boolean;
      searchDepth: ParliamentSpeechSearchDepth | null;
      population: ParliamentSpeechPopulation;
    },
    ApiError
  >
> =>
  (async () => {
    const q = normalizeSpeechQ(input.q);
    if (q !== undefined && q.length > SPEECH_Q_MAX) {
      return err(invalidInput(`q must be at most ${String(SPEECH_Q_MAX)} characters`, 'q'));
    }
    const guarded = speechesFilterGuard(input.filter);
    if (guarded.isErr()) return err(guarded.error);
    // BOUND guard (the parliamentControlItems precedent): no date index exists on
    // speeches, so an unbounded list is refused — never silently defaulted.
    if (!hasSpeechesBound(input.filter)) {
      return err(
        invalidInput(
          'parliamentSpeeches requires a mandateKey bound or a bounded spokenAt window (from AND to, at most 366 days)',
          'filter'
        )
      );
    }
    return deps.repo.listSpeeches(
      input.page,
      input.filter,
      q,
      speechesFullTextEligible(input.filter)
    );
  })();

export const getParliamentSpeechActivity = (
  deps: ParliamentUsecaseDeps,
  year: number,
  filter: FilterInput = {},
  rawQ?: string | null
): Promise<Result<ParliamentSpeechActivity, ApiError>> =>
  (async () => {
    // spokenAt is not a client bound here — the year argument bounds the range (a
    // spokenAt filter would double-bound the per-day window and confuse the caller).
    if (fieldHasValue(filter, 'spokenAt')) {
      return err(
        invalidInput(
          'spokenAt is not accepted on parliamentSpeechActivity; the year argument bounds the range',
          'spokenAt'
        )
      );
    }
    if (!Number.isInteger(year) || year < 1990 || year > 2100) {
      return err(invalidInput('year must be an integer between 1990 and 2100', 'year'));
    }
    const q = normalizeSpeechQ(rawQ);
    if (q !== undefined && q.length > SPEECH_Q_MAX) {
      return err(invalidInput(`q must be at most ${String(SPEECH_Q_MAX)} characters`, 'q'));
    }
    const guarded = speechesFilterGuard(filter);
    if (guarded.isErr()) return err(guarded.error);
    // Full-text depth: EXACTLY ONE mandateKey ONLY — the year argument is a
    // 365/366-day window, wider than the 92-day full-text cap, so an unparented
    // activity q stays at TITLE_SUMMARY depth.
    return deps.repo.speechActivity(year, filter, q, speechesFullTextEligible(filter));
  })();

export const getParliamentSpeech = (
  deps: ParliamentUsecaseDeps,
  speechKey: string
): Promise<Result<ParliamentSpeech | null, ApiError>> => deps.repo.findSpeech(speechKey);

// ── canonical stenogram (sessions / transcript / contribution context) ─────────
//
// Three usecases back all four surfaces (GraphQL, MCP, REST, and the module's own
// tests), so a boundedness, privacy, or availability decision cannot differ between
// them. Every one returns `Result<…, ParliamentStenogramError>` — the kernel
// `ApiError` WIDENED with the two module-owned variants — and never throws.
//
// NO BOUNDEDNESS GUARD HERE, deliberately. `parliamentSpeeches` needs one because
// `parliament.speeches` has 1.4M rows and no date index; `stenogram_sessions` is one
// row per captured sitting with `session_date desc` indexed, so an unfiltered first
// page is a cheap index scan. The asymmetry is stated rather than copied.

/** Max sessions a full-history `q` may resolve before the total is reported estimated. */
export const STENOGRAM_SEARCH_SESSION_CAP = 2_000;

/** Default / max reading blocks returned in one transcript read. */
export const STENOGRAM_SEGMENT_PAGE_DEFAULT = 500;
export const STENOGRAM_SEGMENT_PAGE_MAX = 2_000;

/** `q` length cap, identical to the speech surfaces' `SPEECH_Q_MAX`. */
export const STENOGRAM_Q_MAX = SPEECH_Q_MAX;

export interface ParliamentStenogramSessionsInput {
  readonly filter: FilterInput;
  readonly page: CursorPageRequest;
  readonly q?: string | null | undefined;
}

/**
 * Canonical sessions, optionally narrowed by a FULL-HISTORY `q` over the canonical
 * transcript search projection.
 *
 * The `q` path is two-stage on purpose: the projection resolves candidate SESSION
 * keys, then the repo re-reads every served fact from `parliament.stenogram_*` under
 * the same keyset order and the same privacy gates. So the index can only affect
 * WHICH sessions are found, never WHAT is served — and a stale or partial index can
 * never publish a restricted row.
 *
 * When the projection is unavailable the call is REFUSED with `SearchUnavailable`.
 * It does not fall back to a title-only match or a bounded legacy ILIKE: both answer
 * a narrower question while looking like a full-history answer.
 */
export const listParliamentStenogramSessions = (
  deps: ParliamentStenogramUsecaseDeps,
  input: ParliamentStenogramSessionsInput
): Promise<
  Result<
    CursorPage<ParliamentStenogramSession> & { total: number; totalEstimated: boolean },
    ParliamentStenogramError
  >
> =>
  (async () => {
    const q = normalizeSpeechQ(input.q);
    if (q !== undefined && q.length > STENOGRAM_Q_MAX) {
      return err(invalidInput(`q must be at most ${String(STENOGRAM_Q_MAX)} characters`, 'q'));
    }
    if (q === undefined) {
      return deps.repo.listStenogramSessions(input.page, input.filter, undefined, undefined);
    }
    if (deps.transcriptSearch === null) {
      return err(
        searchUnavailable(
          'full-history transcript search is not configured on this server; no title-only fallback is offered'
        )
      );
    }
    const probe = await deps.transcriptSearch.available();
    if (!probe.available) {
      // Name WHICH way it is missing: an operator needs to tell "search.documents is
      // unreadable" from "the doc type was never built" (the current state, with the
      // loader's speech mode off). Neither degrades the answer.
      const detail =
        probe.reason === 'relation_unavailable'
          ? 'search.documents is not readable on this database'
          : `doc type ${deps.transcriptSearch.docType} holds no public canonical reading blocks (projection not built)`;
      return err(
        searchUnavailable(
          `full-history transcript search is unavailable: ${detail}; no title-only fallback is offered`,
          deps.transcriptSearch.docType
        )
      );
    }
    const hits = await deps.transcriptSearch.searchSessionKeys(q, STENOGRAM_SEARCH_SESSION_CAP);
    // A transport/DB failure inside the projection propagates as an error — it is
    // never converted into an empty hit set (which would read as "no sitting matched").
    if (hits.isErr()) return err(hits.error);
    const listed = await deps.repo.listStenogramSessions(
      input.page,
      input.filter,
      q,
      hits.value.sessions.map((s) => s.sessionKey)
    );
    if (listed.isErr()) return listed;
    // A truncated SITTING set means the real match count exceeds what we resolved, so
    // the total is an UNDER-count — flag it rather than presenting a cap as exact.
    return ok(hits.value.truncated ? { ...listed.value, totalEstimated: true } : listed.value);
  })();

/**
 * One session plus its ordered PUBLIC reading. Typed outcomes, all three distinct:
 *  - unknown or non-public session  → `NotFound`
 *  - `availability='SOURCE_ONLY'`   → `TranscriptUnavailable{reason:'source_only'}`.
 *    The row is REAL and honest ("we hold the sitting and its official URL and serve
 *    no reading"), so collapsing it into NotFound would misreport the data; it is a
 *    distinct fact and gets a distinct code.
 *  - public blocks all restricted   → `TranscriptUnavailable{reason:'no_public_segments'}`
 *  - projection not deployed        → `TranscriptUnavailable{reason:'projection_unavailable'}`
 *    (raised by the repo probe).
 */
export const getParliamentStenogramSession = (
  deps: ParliamentStenogramUsecaseDeps,
  sessionKey: string,
  slice: { readonly offset?: number; readonly limit?: number } = {}
): Promise<Result<ParliamentStenogramTranscript, ParliamentStenogramError>> =>
  (async () => {
    const key = sessionKey.trim();
    if (key === '') return err(invalidInput('sessionKey is required', 'sessionKey'));
    const offset =
      slice.offset !== undefined && Number.isInteger(slice.offset) && slice.offset >= 0
        ? slice.offset
        : 0;
    const limit =
      slice.limit !== undefined && Number.isInteger(slice.limit) && slice.limit >= 1
        ? Math.min(slice.limit, STENOGRAM_SEGMENT_PAGE_MAX)
        : STENOGRAM_SEGMENT_PAGE_DEFAULT;

    const resolved = await resolveReadableSession(deps, key);
    if (resolved.isErr()) return err(resolved.error);
    const { session, navigation } = resolved.value;

    const segmentsRes = await deps.repo.listStenogramSegments(key, { offset, limit });
    if (segmentsRes.isErr()) return err(segmentsRes.error);
    const { segments, total } = segmentsRes.value;
    const guard = guardPublicSegments(session, navigation, total);
    if (guard.isErr()) return err(guard.error);
    return ok({ session, segments, totalSegments: total, navigation });
  })();

/**
 * Absolute ceiling on the blocks one COMPLETE transcript response may carry. The
 * measured CDep worst case is ~2.4k blocks per sitting (and the canonical count is
 * strictly lower than the legacy over-split one), so this is ~20× headroom. It exists
 * so a corrupt session (a position explosion) cannot turn one request into an
 * unbounded read — and if it ever trips, the answer is an explicit error, NEVER a
 * silently truncated transcript presented as complete.
 */
export const STENOGRAM_TRANSCRIPT_MAX_BLOCKS = 50_000;

/** Chunk size the complete read pages the repo with (an internal detail). */
export const STENOGRAM_TRANSCRIPT_CHUNK = 2_000;

/**
 * The COMPLETE ordered public reading of one sitting, in one value.
 *
 * This is what the REST transcript endpoint serves: a caller asking for "the
 * transcript" must get the whole transcript, not a first page that looks like one. It
 * pages the repo internally in `STENOGRAM_TRANSCRIPT_CHUNK` blocks so a 2,400-block
 * sitting is still bounded per query, and it verifies contiguity as it goes — if the
 * public block count changes mid-read (a concurrent re-parse or privacy flip), the read
 * is retried-free and reported as a Database inconsistency rather than stitched into a
 * transcript with a hole in it.
 *
 * The GraphQL/MCP surfaces keep the SLICED read above: a schema client selecting a
 * sitting should not be forced to materialise thousands of blocks it did not ask for.
 */
export const getParliamentStenogramTranscript = (
  deps: ParliamentStenogramUsecaseDeps,
  sessionKey: string
): Promise<Result<ParliamentStenogramTranscript, ParliamentStenogramError>> =>
  (async () => {
    const key = sessionKey.trim();
    if (key === '') return err(invalidInput('sessionKey is required', 'sessionKey'));

    const resolved = await resolveReadableSession(deps, key);
    if (resolved.isErr()) return err(resolved.error);
    const { session, navigation } = resolved.value;

    const segments: ParliamentStenogramSegment[] = [];
    let total = 0;
    for (let offset = 0; ; offset += STENOGRAM_TRANSCRIPT_CHUNK) {
      const pageRes = await deps.repo.listStenogramSegments(key, {
        offset,
        limit: STENOGRAM_TRANSCRIPT_CHUNK,
      });
      if (pageRes.isErr()) return err(pageRes.error);
      const page = pageRes.value;
      if (offset === 0) {
        total = page.total;
        const guard = guardPublicSegments(session, navigation, total);
        if (guard.isErr()) return err(guard.error);
      } else if (page.total !== total) {
        // The corpus moved under us. Say so — a stitched-together transcript from two
        // different states of the reading would be silently wrong.
        return err(
          databaseError(
            `session '${key}' changed while its transcript was being read (public block count ${String(total)} → ${String(page.total)}); retry`
          )
        );
      }
      if (page.segments.length === 0) break;
      segments.push(...page.segments);
      if (segments.length > STENOGRAM_TRANSCRIPT_MAX_BLOCKS) {
        return err(
          databaseError(
            `session '${key}' exceeds the ${String(STENOGRAM_TRANSCRIPT_MAX_BLOCKS)}-block transcript ceiling; refusing to serve a partial transcript as complete`
          )
        );
      }
      if (segments.length >= total) break;
    }
    if (segments.length !== total) {
      return err(
        databaseError(
          `session '${key}' yielded ${String(segments.length)} of ${String(total)} public blocks; refusing to serve an incomplete transcript`
        )
      );
    }
    return ok({ session, segments, totalSegments: total, navigation });
  })();

/**
 * Resolve a session to a READABLE one, or to the typed refusal that explains why —
 * with the sitting's own metadata attached so a client can still offer the official
 * source. Shared by the sliced and the complete read so the two can never disagree
 * about what "not found" and "unavailable" mean.
 */
const resolveReadableSession = async (
  deps: ParliamentStenogramUsecaseDeps,
  key: string
): Promise<
  Result<
    { session: ParliamentStenogramSession; navigation: ParliamentSittingNavigation },
    ParliamentStenogramError
  >
> => {
  const sessionRes = await deps.repo.findStenogramSession(key);
  // A Database/Upstream failure from the repo propagates AS IS. It must never become
  // NotFound — "we could not read" is not "it does not exist" (requirement: no
  // silent swallowing of transport errors as not-found).
  if (sessionRes.isErr()) return err(sessionRes.error);
  const session = sessionRes.value;
  if (session === null) {
    return err(notFound(`no canonical stenogram session '${key}'`, 'stenogram_session'));
  }
  const navRes = await deps.repo.adjacentSessions({
    sessionKey: session.sessionKey,
    sessionDate: session.sessionDate,
    chamber: session.chamber,
  });
  if (navRes.isErr()) return err(navRes.error);
  const navigation = navRes.value;

  if (session.availability === 'SOURCE_ONLY') {
    // A REAL sitting we hold, whose transcript we do not. The session ref rides along
    // so the client can render "open the official transcript" with the right precision
    // instead of firing a second request that would only fail again.
    return err(
      transcriptUnavailable(
        `sitting '${key}' is known but no usable transcript capture is held (availability SOURCE_ONLY); the official source URL is still available`,
        key,
        'source_only',
        toStenogramSessionRef(session)
      )
    );
  }
  return ok({ session, navigation });
};

/**
 * A session that claims a reading but exposes no PUBLIC block is an explicit refusal,
 * never an empty "transcript". The DB's availability biconditional guarantees a
 * non-SOURCE_ONLY session HAS blocks, so a zero public count here means every block is
 * restricted (or its canonical speech row is) — a privacy outcome, and it is reported
 * as one.
 */
const guardPublicSegments = (
  session: ParliamentStenogramSession,
  _navigation: ParliamentSittingNavigation,
  total: number
): Result<true, ParliamentStenogramError> =>
  total === 0
    ? err(
        transcriptUnavailable(
          `sitting '${session.sessionKey}' has no public reading blocks`,
          session.sessionKey,
          'no_public_segments',
          toStenogramSessionRef(session)
        )
      )
    : ok(true);

/**
 * The canonical context of one contribution, accepting a canonical `canon:` key OR a
 * LEGACY `cdep:` / `senat:` key.
 *
 * LEGACY COMPATIBILITY IS THE POINT. The old speech API keeps working unchanged; this
 * usecase is how a legacy key reaches its canonical reading, via
 * `parliament.speech_redirects`:
 *  - `exact_segment` → the proven block, with its previous/next CONTRIBUTION.
 *  - `session_only`  → the sitting only (`segment` null). The honest coarse answer;
 *    a guessed turn would be worse than none.
 * `null` means "no canonical context" — an unknown key, or a legacy row the canonical
 * lane has not mapped yet. It is never an error and never a throw, so a deep link to
 * an unmapped speech degrades instead of failing.
 */
export const getParliamentSpeechContext = (
  deps: ParliamentStenogramUsecaseDeps,
  speechKey: string
): Promise<Result<ParliamentSpeechContext | null, ParliamentStenogramError>> =>
  (async () => {
    const key = speechKey.trim();
    if (key === '') return err(invalidInput('speechKey is required', 'speechKey'));

    // 1. Canonical key → its own reading block (the preferred path).
    const direct = await deps.repo.findSegmentBySpeechKey(key);
    if (direct.isErr()) return err(direct.error);
    if (direct.value !== null) {
      return buildSpeechContext(deps, key, direct.value.sessionKey, direct.value, null);
    }

    // 2. Legacy key → the redirect row.
    const redirectRes = await deps.repo.findSpeechRedirect(key);
    if (redirectRes.isErr()) return err(redirectRes.error);
    const redirect = redirectRes.value;
    if (redirect === null) return ok(null);

    if (redirect.canonicalSegmentKey === null) {
      // mapping_kind='session_only' — the sitting is resolved, the turn is not. No
      // highlight is fabricated: `segment` stays null so a client cannot render a
      // guessed turn as if the source had proven it.
      return buildSpeechContext(deps, key, redirect.sessionKey, null, redirect);
    }
    // The redirect names a canonical SPEECH row as well as a block, and the two carry
    // INDEPENDENT privacy classes — so gate the speech row before serving the block it
    // points at. Fail-closed: anything other than a proven public row drops the
    // highlight back to a session-only answer.
    if (redirect.canonicalSpeechKey !== null) {
      const speechPublic = await deps.repo.canonicalSpeechIsPublic(redirect.canonicalSpeechKey);
      if (speechPublic.isErr()) return err(speechPublic.error);
      if (!speechPublic.value) {
        return buildSpeechContext(deps, key, redirect.sessionKey, null, redirect);
      }
    }
    const segmentRes = await deps.repo.findSegmentByKey(redirect.canonicalSegmentKey);
    if (segmentRes.isErr()) return err(segmentRes.error);
    // A redirect whose target block is missing or restricted degrades to the sitting
    // rather than 404-ing a legacy key that a client may have deep-linked for years.
    return buildSpeechContext(deps, key, redirect.sessionKey, segmentRes.value, redirect);
  })();

/** Assemble the context: session + segment + the neighbouring CONTRIBUTIONS. */
const buildSpeechContext = async (
  deps: ParliamentStenogramUsecaseDeps,
  speechKey: string,
  sessionKey: string,
  segment: ParliamentStenogramSegment | null,
  redirect: ParliamentSpeechRedirect | null
): Promise<Result<ParliamentSpeechContext | null, ParliamentStenogramError>> => {
  const sessionRes = await deps.repo.findStenogramSession(sessionKey);
  if (sessionRes.isErr()) return err(sessionRes.error);
  const session = sessionRes.value;
  // A restricted/absent session means there is no PUBLIC context to serve — null,
  // not a partial answer that leaks the session's existence.
  if (session === null) return ok(null);
  if (segment === null) {
    return ok({
      speechKey,
      session,
      segment: null,
      previousContribution: null,
      nextContribution: null,
      redirect,
    });
  }
  const adjacent = await deps.repo.adjacentContributions(sessionKey, segment.position);
  if (adjacent.isErr()) return err(adjacent.error);
  return ok({
    speechKey,
    session,
    segment,
    previousContribution: adjacent.value.previous,
    nextContribution: adjacent.value.next,
    redirect,
  });
};

// ── standalone control items list ──────────────────────────────────────────────

export const listControlItems = (
  deps: ParliamentUsecaseDeps,
  filter: FilterInput,
  page: CursorPageRequest
): Promise<Result<CursorPage<ParliamentControlItem>, ApiError>> =>
  (async () => {
    // BOUND guard (§3.2): a standalone control-items list must carry a date window
    // OR a recipient/author bound — there is no item_date index.
    if (!hasControlBound(filter)) {
      return err(
        invalidInput(
          'control-items list requires a date window (from/to) or a recipient/author bound',
          'filter'
        )
      );
    }
    return deps.repo.listControlItems(filter, page);
  })();

// ── lineage (the marquee) ──────────────────────────────────────────────────────

export const DEFAULT_LINEAGE_ROLES = ['final_adoption', 'final_rejection'] as const;
/** Sentinel role: `roles:["all"]` widens lineage to every linked vote (H14). */
export const LINEAGE_ROLE_ALL = 'all';

export interface LineageInput {
  readonly actId: string;
  readonly roles?: readonly string[];
  readonly includeBallots?: boolean;
}

export const getLineageForAct = async (
  deps: ParliamentUsecaseDeps,
  input: LineageInput
): Promise<Result<ParliamentActLineage | null, ApiError>> => {
  // act_id is numeric; validate BEFORE the repo casts it to ::bigint (else a
  // non-numeric id surfaces as a DB 500 instead of a clean InvalidInput — Codex SF).
  if (!/^\d+$/u.test(input.actId))
    return err(invalidInput('actId must be a numeric act_id', 'actId'));
  const requestedRoles =
    input.roles !== undefined && input.roles.length > 0 ? input.roles : [...DEFAULT_LINEAGE_ROLES];
  const showAllRoles = requestedRoles.includes(LINEAGE_ROLE_ALL);
  const [bills, allVotes] = await Promise.all([
    deps.repo.billsForActId(input.actId),
    // Fetch ALL linked votes (no SQL role filter) and apply the role filter in TS, so the
    // omitted non-default-role votes can be REPORTED in caveats (H14/M15) instead of
    // silently disappearing — bill.voteLinks is unfiltered, so the two views now reconcile.
    deps.repo.votesForActId(input.actId, []),
  ]);
  if (bills.isErr()) return err(bills.error);
  if (allVotes.isErr()) return err(allVotes.error);
  const allLinked = allVotes.value;

  // No act mapping at all (no bills, no linked votes) → null so callers can 404 vs empty.
  if (bills.value.length === 0 && allLinked.length === 0) return ok(null);

  // H14: default is final adoption/rejection; roles:["all"] widens to every linked vote.
  const shown = showAllRoles
    ? allLinked
    : allLinked.filter((lv) => requestedRoles.includes(lv.role));

  const votes: ParliamentLineageVote[] = [];
  for (const lv of shown) {
    let ballotsTotal: number | null = null;
    let ballotsResolved: number | null = null;
    if (input.includeBallots === true) {
      const br = await deps.repo.ballotResolution(lv.vote.voteKey);
      if (br.isErr()) return err(br.error);
      ballotsTotal = br.value.total;
      ballotsResolved = br.value.resolved;
    }
    votes.push({
      voteKey: lv.vote.voteKey,
      // H13: report the vote's OWN bill key, not the act-link join's bill key. For a
      // senat-chamber vote the bvl row carries the CDEP twin's bill key (e.g. "17335"),
      // so `lv.billKey` would point a lineage→parliamentBill walk at the wrong (CDEP)
      // bill; the vote's own key ("senat:737-2018") is correct. Fall back to the bvl key
      // only when the vote has no own bill key (374 camera votes — no regression).
      billKey: lv.vote.billKey ?? lv.billKey,
      chamber: lv.vote.chamber,
      voteDate: lv.vote.voteDate,
      role: lv.role,
      outcome: lv.vote.outcome,
      resolutionStatus: lv.resolutionStatus,
      confidenceLabel: lv.confidenceLabel,
      tally: lv.vote.tally,
      ballotsTotal,
      ballotsResolved,
    });
  }

  // M15: caveats now carry real coverage signals (were empty for every act with a
  // lineage). They let a consumer reconcile this view with the unfiltered bill.voteLinks.
  const caveats: string[] = [];
  if (allLinked.length === 0) {
    caveats.push('No vote is linked for this act (lineage covers the dense-vote era ~2016+).');
  } else if (shown.length === 0) {
    caveats.push(
      `${String(allLinked.length)} linked vote(s) exist but none match the requested role(s) (default: final adoption/rejection); pass roles:["all"] to include every linked vote.`
    );
  } else {
    const omitted = allLinked.length - shown.length;
    if (omitted > 0) {
      caveats.push(
        `${String(omitted)} additional linked vote(s) of other roles (e.g. amendment, procedural) are omitted by the role filter; pass roles:["all"] to include them.`
      );
    }
  }
  const lowConfidence = shown.filter((lv) => lv.confidenceLabel === 'low').length;
  if (lowConfidence > 0) {
    caveats.push(
      `${String(lowConfidence)} of the ${String(shown.length)} shown vote-link(s) are low-confidence matches.`
    );
  }
  return ok({ actId: input.actId, bills: bills.value, votes, caveats });
};

// ── cohesion ────────────────────────────────────────────────────────────────────

export interface CohesionInput {
  readonly billKey?: string;
  readonly chamber?: string;
  readonly from?: string;
  readonly to?: string;
  readonly group?: string;
}

export const rankVoteCohesion = async (
  deps: ParliamentUsecaseDeps,
  input: CohesionInput
): Promise<Result<readonly ParliamentGroupCohesion[], ApiError>> => {
  const billMode = input.billKey !== undefined;
  const windowMode =
    input.chamber !== undefined && input.from !== undefined && input.to !== undefined;
  // EXACTLY ONE mode (Codex SHOULD-FIX).
  if (billMode === windowMode) {
    return err(
      invalidInput(
        'cohesion requires EXACTLY ONE of: billKey, or (chamber + from + to)',
        'cohesion'
      )
    );
  }
  if (windowMode && !VOTE_CHAMBER_SET.has(input.chamber as VoteChamber)) {
    return err(
      invalidInput('cohesion chamber must be camera_deputatilor | senat | comun', 'chamber')
    );
  }

  let voteKeys: readonly string[];
  if (input.billKey !== undefined) {
    const r = await deps.repo.voteKeysForBill(input.billKey);
    if (r.isErr()) return err(r.error);
    voteKeys = r.value;
    if (voteKeys.length > COHESION_VOTE_CAP) {
      return err(
        invalidInput(`cohesion vote set exceeds cap (${String(COHESION_VOTE_CAP)})`, 'billKey')
      );
    }
  } else if (input.chamber !== undefined && input.from !== undefined && input.to !== undefined) {
    const r = await deps.repo.voteKeysForWindow(
      input.chamber,
      input.from,
      input.to,
      COHESION_VOTE_CAP
    );
    if (r.isErr()) return err(r.error);
    if (r.value.overflow) {
      return err(
        invalidInput('cohesion vote window too large; narrow the date range (cap 500 votes)', 'to')
      );
    }
    voteKeys = r.value.voteKeys;
  } else {
    // Unreachable (the mode guard above already validated EXACTLY ONE mode).
    return err(
      invalidInput(
        'cohesion requires EXACTLY ONE of: billKey, or (chamber + from + to)',
        'cohesion'
      )
    );
  }
  if (voteKeys.length === 0) return ok([]);
  return deps.repo.cohesionForVoteKeys(voteKeys, input.group);
};

// ── resolve / discovery ──────────────────────────────────────────────────────

export const resolveFilters = async (
  deps: ParliamentUsecaseDeps,
  dim: ParliamentResolveDim,
  q: string,
  legislature: string | undefined,
  limit: number
): Promise<Result<readonly ParliamentResolveHit[], ApiError>> => {
  if (!PARLIAMENT_RESOLVE_DIMS.includes(dim)) {
    return err(invalidInput(`unknown dim '${dim}'`, 'dim'));
  }
  const capped = Math.min(Math.max(Math.floor(limit), 1), 50);
  const folded = foldDiacritics(q);

  switch (dim) {
    case 'group': {
      const r = await deps.repo.resolveGroups(folded, legislature ?? null, capped);
      if (r.isErr()) return err(r.error);
      return ok(
        r.value.map((g) => ({ dim, value: g.value, label: g.label, kind: 'group', score: null }))
      );
    }
    case 'person': {
      const r = await deps.repo.searchPersonsByName(folded, capped);
      if (r.isErr()) return err(r.error);
      return ok(
        r.value.map((p) => ({
          dim,
          value: p.personId,
          label: p.canonicalName,
          kind: 'person',
          score: null,
        }))
      );
    }
    case 'constituency': {
      const r = await deps.repo.resolveConstituencies(folded, capped);
      if (r.isErr()) return err(r.error);
      return ok(
        r.value.map((c) => ({ dim, value: c, label: c, kind: 'constituency', score: null }))
      );
    }
    case 'recipient': {
      const r = await deps.repo.resolveRecipients(folded, capped);
      if (r.isErr()) return err(r.error);
      return ok(r.value.map((c) => ({ dim, value: c, label: c, kind: 'recipient', score: null })));
    }
    case 'control_type':
      // control-population.v2: motion removed from the served enum (2026-07-22).
      return ok(
        [
          'question',
          'interpellation',
          'question_or_interpellation',
          'interpellation_pm',
          'political_declaration',
        ]
          .filter((v) => v.includes(folded))
          .map((v) => ({ dim, value: v, label: v, kind: 'enum', score: null }))
      );
    case 'outcome':
      return ok(
        ['adoptat', 'respins']
          .filter((v) => v.includes(folded))
          .map((v) => ({ dim, value: v, label: v, kind: 'enum', score: null }))
      );
    case 'chamber':
      return ok(
        ['camera_deputatilor', 'senat', 'comun']
          .filter((v) => v.includes(folded))
          .map((v) => ({ dim, value: v, label: v, kind: 'enum', score: null }))
      );
  }
};

// ── data-quality ──────────────────────────────────────────────────────────────

export const dataQualityCandidates = (
  deps: ParliamentUsecaseDeps,
  status: string | undefined,
  page: { page?: number; pageSize?: number }
): Promise<Result<OffsetResult<ParliamentPersonCandidate>, ApiError>> =>
  deps.repo.listPersonCandidates(status, normalizeOffset(page.page, page.pageSize));

// ── data freshness (B4) ────────────────────────────────────────────────────────

export const getDataFreshness = (
  deps: ParliamentUsecaseDeps
): Promise<Result<ParliamentDataFreshness, ApiError>> => deps.repo.dataFreshness();

// ── committees (B2) ─────────────────────────────────────────────────────────────

/** The linked-bills bounded cap for a committee detail (like the ballots 200 cap). */
export const COMMITTEE_LINKED_BILLS_CAP = 200;

export const listCommittees = (
  deps: ParliamentUsecaseDeps,
  chamber: string | undefined,
  legislature: string | undefined,
  page: CursorPageRequest
): Promise<Result<CursorPage<ParliamentCommittee>, ApiError>> =>
  deps.repo.listCommittees(chamber, legislature, page);

export const getCommittee = async (
  deps: ParliamentUsecaseDeps,
  committeeKey: string
): Promise<Result<ParliamentCommitteeDetail | null, ApiError>> => {
  const c = await deps.repo.findCommittee(committeeKey);
  if (c.isErr()) return err(c.error);
  if (c.value === null) return ok(null);

  const [roster, linked, meetings] = await Promise.all([
    deps.repo.listCommitteeRoster(committeeKey),
    deps.repo.listCommitteeLinkedBills(committeeKey, COMMITTEE_LINKED_BILLS_CAP),
    deps.repo.committeeMeetingsCount(committeeKey),
  ]);
  if (roster.isErr()) return err(roster.error);
  if (linked.isErr()) return err(linked.error);
  if (meetings.isErr()) return err(meetings.error);

  return ok({
    committee: c.value,
    members: roster.value,
    linkedBills: linked.value.bills,
    linkedBillsTotal: linked.value.total,
    meetingsCount: meetings.value,
  });
};

// ── member-activity bundle (MCP) ───────────────────────────────────────────────

export interface MemberActivityBundle {
  readonly member: ParliamentMember | null;
  readonly person: ParliamentPerson | null;
  readonly votes: readonly ParliamentMemberVote[];
  readonly control: readonly ParliamentControlItem[];
  readonly speeches: readonly ParliamentSpeech[];
  readonly initiatives: readonly ParliamentInitiative[];
}

export const getMemberActivityBundle = async (
  deps: ParliamentUsecaseDeps,
  args: {
    mandateKey?: string;
    personId?: string;
    kinds?: readonly MemberActivityKind[];
    limit: number;
  }
): Promise<Result<MemberActivityBundle | null, ApiError>> => {
  const kinds =
    args.kinds !== undefined && args.kinds.length > 0
      ? args.kinds
      : (['votes', 'control', 'speeches', 'initiatives'] as const);
  const want = new Set<MemberActivityKind>(kinds);
  const limit = Math.min(Math.max(args.limit, 1), 100);

  // Resolve the mandate set: a single mandate, or ALL the person's mandates.
  let mandateKeys: string[];
  let member: ParliamentMember | null;
  let person: ParliamentPerson | null = null;

  if (args.personId !== undefined) {
    const p = await deps.repo.findPerson(args.personId);
    if (p.isErr()) return err(p.error);
    if (p.value === null) return ok(null);
    person = p.value;
    const ms = await deps.repo.listPersonMandates(args.personId);
    if (ms.isErr()) return err(ms.error);
    mandateKeys = ms.value.map((m) => m.mandateKey);
    member = ms.value[0] ?? null;
  } else if (args.mandateKey !== undefined) {
    const m = await deps.repo.findMember(args.mandateKey);
    if (m.isErr()) return err(m.error);
    if (m.value === null) return ok(null);
    member = m.value;
    mandateKeys = [args.mandateKey];
    if (m.value.personId !== null) {
      const p = await deps.repo.findPerson(m.value.personId);
      if (p.isOk()) person = p.value;
    }
  } else {
    return err(invalidInput('one of mandateKey or personId is required', 'mandateKey'));
  }

  const votes: ParliamentMemberVote[] = [];
  const control: ParliamentControlItem[] = [];
  const speeches: ParliamentSpeech[] = [];
  const initiatives: ParliamentInitiative[] = [];

  for (const mk of mandateKeys) {
    if (want.has('votes') && votes.length < limit) {
      const r = await deps.repo.listMemberVotes(mk, { first: limit - votes.length });
      if (r.isErr()) return err(r.error);
      votes.push(...r.value.items);
    }
    if (want.has('control') && control.length < limit) {
      const r = await deps.repo.listMemberControlItems(mk, {
        page: 1,
        pageSize: limit - control.length,
      });
      if (r.isErr()) return err(r.error);
      control.push(...r.value.rows);
    }
    if (want.has('speeches') && speeches.length < limit) {
      const r = await deps.repo.listMemberSpeeches(mk, {
        page: 1,
        pageSize: limit - speeches.length,
      });
      if (r.isErr()) return err(r.error);
      speeches.push(...r.value.rows);
    }
    if (want.has('initiatives') && initiatives.length < limit) {
      const r = await deps.repo.listMemberInitiatives(mk, {
        page: 1,
        pageSize: limit - initiatives.length,
      });
      if (r.isErr()) return err(r.error);
      initiatives.push(...r.value.rows);
    }
  }
  return ok({ member, person, votes, control, speeches, initiatives });
};
