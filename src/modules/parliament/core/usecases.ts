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
  foldDiacritics,
  invalidInput,
  normalizeOffset,
  type ApiError,
  type CursorPage,
  type CursorPageRequest,
  type FilterInput,
  type MeiliClient,
} from '@/modules/shared/index.js';

import {
  COHESION_VOTE_CAP,
  PARLIAMENT_RESOLVE_DIMS,
  VOTE_CHAMBERS_OK,
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
  type ParliamentMemberDetail,
  type ParliamentMemberVote,
  type ParliamentMemberVoteActivity,
  type ParliamentPerson,
  type ParliamentPersonCandidate,
  type ParliamentPersonCareer,
  type ParliamentResolveDim,
  type ParliamentResolveHit,
  type ParliamentSpeech,
  type ParliamentVote,
  type ParliamentVoteDetail,
  type VoteChamber,
} from './types.js';

import type { OffsetResult, ParliamentRepo } from './ports.js';

export interface ParliamentUsecaseDeps {
  readonly repo: ParliamentRepo;
  /** Kernel Meili client for name resolution (null → pg fallback only). */
  readonly meili: MeiliClient | null;
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

export const getMember = async (
  deps: ParliamentUsecaseDeps,
  mandateKey: string
): Promise<Result<ParliamentMemberDetail | null, ApiError>> => {
  const m = await deps.repo.findMember(mandateKey);
  if (m.isErr()) return err(m.error);
  if (m.value === null) return ok(null);
  const member = m.value;

  const [person, intervals, counts] = await Promise.all([
    member.personId !== null
      ? deps.repo.findPerson(member.personId)
      : Promise.resolve(ok<ParliamentPerson | null, ApiError>(null)),
    deps.repo.listGroupIntervals(mandateKey),
    activityCounts(deps.repo, mandateKey),
  ]);
  if (person.isErr()) return err(person.error);
  if (intervals.isErr()) return err(intervals.error);
  if (counts.isErr()) return err(counts.error);

  return ok({
    member,
    person: person.value,
    groupIntervals: intervals.value,
    activityCounts: counts.value,
  });
};

const activityCounts = async (
  repo: ParliamentRepo,
  mandateKey: string
): Promise<Result<ParliamentActivityCounts, ApiError>> => {
  // Each count is a bounded, mandate-indexed COUNT(*); the votes count comes from
  // the member-votes total (mandate index slice, cheap).
  const [mv, ci, sp, ini, decl] = await Promise.all([
    repo.listMemberVotes(mandateKey, { first: 1 }),
    repo.listMemberControlItems(mandateKey, { page: 1, pageSize: 1 }),
    repo.listMemberSpeeches(mandateKey, { page: 1, pageSize: 1 }),
    repo.listMemberInitiatives(mandateKey, { page: 1, pageSize: 1 }),
    repo.listMemberDeclarations(mandateKey),
  ]);
  if (mv.isErr()) return err(mv.error);
  if (ci.isErr()) return err(ci.error);
  if (sp.isErr()) return err(sp.error);
  if (ini.isErr()) return err(ini.error);
  if (decl.isErr()) return err(decl.error);
  return ok({
    votes: mv.value.total,
    controlItems: ci.value.total,
    speeches: sp.value.total,
    initiatives: ini.value.total,
    declarations: decl.value.length,
  });
};

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

  // Career totals: sum the bounded per-mandate counts (each mandate ≤ low thousands).
  let votes = 0;
  let initiatives = 0;
  let speeches = 0;
  for (const m of mandates.value) {
    const counts = await activityCounts(deps.repo, m.mandateKey);
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

  const [events, docs, initiators, votes, actLinks, voteLinks] = await Promise.all([
    deps.repo.getBillEvents(billKey),
    deps.repo.getBillDocuments(billKey),
    deps.repo.getBillInitiators(billKey),
    deps.repo.listVotesForBill(billKey),
    deps.repo.getBillActLinks(billKey),
    deps.repo.getBillVoteLinks(billKey),
  ]);
  for (const r of [events, docs, initiators, votes, actLinks, voteLinks]) {
    if (r.isErr()) return err(r.error);
  }
  return ok({
    bill: b.value,
    events: events._unsafeUnwrap(),
    documents: docs._unsafeUnwrap(),
    // H10: pass the full members through (no reduced projection) so initiators expose
    // the same shape as parliamentMember(s) — legislature/normalizedName/constituency/
    // birthDate and the nested group/person/interval resolvers all resolve.
    initiators: initiators._unsafeUnwrap(),
    relatedVotes: votes._unsafeUnwrap(),
    actLinks: actLinks._unsafeUnwrap(),
    voteLinks: voteLinks._unsafeUnwrap(),
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

export const getMemberInitiatives = (
  deps: ParliamentUsecaseDeps,
  mandateKey: string,
  page: { page?: number; pageSize?: number }
): Promise<Result<OffsetResult<ParliamentInitiative>, ApiError>> =>
  deps.repo.listMemberInitiatives(mandateKey, normalizeOffset(page.page, page.pageSize));

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
      return ok(
        [
          'question',
          'interpellation',
          'question_or_interpellation',
          'motion',
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
