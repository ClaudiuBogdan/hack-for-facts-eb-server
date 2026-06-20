/**
 * Parliament module — repo port (plan 04 §3). `shell/repo` implements this over
 * the typed `ProdDatabase` Kysely instance; every method returns
 * `Result<T, ApiError>` (neverthrow). The ONLY place that reads `parliament.*`.
 *
 * HEAVY-QUERY RULE (§3 contract, BINDING): no method scans `vote_records`
 * unparented — every `vote_records` read is bounded by `vote_key` (PK prefix) or
 * `mandate_key` (vote_records_mandate_idx). The driving index is named per method.
 */

import type {
  ParliamentBallot,
  ParliamentBill,
  ParliamentBillActLink,
  ParliamentBillDocument,
  ParliamentBillEvent,
  ParliamentBillVoteLink,
  ParliamentControlItem,
  ParliamentDeclarationMeta,
  ParliamentGroup,
  ParliamentGroupCohesion,
  ParliamentGroupInterval,
  ParliamentInitiative,
  ParliamentMember,
  ParliamentMemberVote,
  ParliamentPerson,
  ParliamentPersonCandidate,
  ParliamentResolveDim,
  ParliamentSpeech,
  ParliamentVote,
  ParliamentVoteGroupBreakdown,
} from './types.js';
import type {
  ApiError,
  CursorPage,
  CursorPageRequest,
  FilterInput,
  OffsetParams,
} from '@/modules/shared/index.js';
import type { Result } from 'neverthrow';

/** An offset page result (rows + bounded total). */
export interface OffsetResult<T> {
  readonly rows: readonly T[];
  readonly total: number;
  readonly estimated: boolean;
}

/** A vote with its lineage role (the bill_vote_links ⋈ votes lineage row). */
export interface LineageVoteRow {
  readonly vote: ParliamentVote;
  readonly billKey: string | null;
  readonly role: string;
  readonly resolutionStatus: string;
  readonly confidenceLabel: string;
}

/** Per-vote ballot resolution counts (for lineage summary). */
export interface BallotResolution {
  readonly total: number;
  readonly resolved: number;
}

export interface ParliamentRepo {
  // ── members / groups / persons ──────────────────────────────────────────────
  latestLegislature(): Promise<Result<string | null, ApiError>>;
  listMembers(
    filter: FilterInput,
    sort: string,
    page: OffsetParams
  ): Promise<Result<OffsetResult<ParliamentMember>, ApiError>>; // bounded by legislature
  findMember(mandateKey: string): Promise<Result<ParliamentMember | null, ApiError>>; // members_pkey
  // `current` (SC-1) restricts composition counts / roster to currently-seated
  // members; omit/false = ALL mandate rows. Composition/roster ONLY (never attribution).
  listGroupCounts(legislature: string, chamber?: string, current?: boolean): Promise<Result<readonly ParliamentGroup[], ApiError>>;
  listGroupMembers(groupId: string, legislature?: string, current?: boolean): Promise<Result<readonly ParliamentMember[], ApiError>>;
  /**
   * Resolve a single group by its `group_id` slug against the `parliamentary_groups`
   * registry (73 rows; covers historical/migrated groups like POT/PIR that no longer
   * have a current member). Used by the `ParliamentGroupInterval.group` resolver (the
   * interval row carries only the slug). Slug-keyed → unambiguous; null if unknown.
   */
  findGroup(groupId: string): Promise<Result<ParliamentGroup | null, ApiError>>;
  findPerson(personId: string): Promise<Result<ParliamentPerson | null, ApiError>>; // persons_pkey
  listPersonMandates(personId: string): Promise<Result<readonly ParliamentMember[], ApiError>>; // members_person_idx
  listGroupIntervals(mandateKey: string): Promise<Result<readonly ParliamentGroupInterval[], ApiError>>; // pk prefix
  /** Cross-mandate group history for a whole person (union over its mandates). */
  listGroupIntervalsForPerson(personId: string): Promise<Result<readonly ParliamentGroupInterval[], ApiError>>;
  /** persons_normalized_name_idx; qNorm is pre-folded in TS (C-locale, §13-R1). */
  searchPersonsByName(qNorm: string, limit: number): Promise<Result<readonly ParliamentPerson[], ApiError>>;
  /** group_name slugs present in a legislature (resolve dim=group). */
  resolveGroups(qFolded: string, legislature: string | null, limit: number): Promise<Result<readonly { value: string; label: string }[], ApiError>>;
  /** constituency_name values (resolve dim=constituency). */
  resolveConstituencies(qFolded: string, limit: number): Promise<Result<readonly string[], ApiError>>;
  /** recipient strings (resolve dim=recipient). */
  resolveRecipients(qFolded: string, limit: number): Promise<Result<readonly string[], ApiError>>;

  // ── bills / timeline ────────────────────────────────────────────────────────
  listBills(
    filter: FilterInput,
    sort: string,
    page: OffsetParams
  ): Promise<Result<OffsetResult<ParliamentBill>, ApiError>>;
  findBill(billKey: string): Promise<Result<ParliamentBill | null, ApiError>>; // bills_pkey
  getBillEvents(billKey: string): Promise<Result<readonly ParliamentBillEvent[], ApiError>>;
  getBillDocuments(billKey: string): Promise<Result<readonly ParliamentBillDocument[], ApiError>>;
  // Initiators are surfaced AS ParliamentMember in the SDL; return the FULL member
  // (not a reduced projection) so every ParliamentMember field — legislature,
  // normalizedName, constituencyName, birthDate, and the nested group/person/interval
  // resolvers — is populated regardless of entry path (H10).
  getBillInitiators(billKey: string): Promise<Result<readonly ParliamentMember[], ApiError>>;
  getBillActLinks(billKey: string): Promise<Result<readonly ParliamentBillActLink[], ApiError>>;
  getBillVoteLinks(billKey: string): Promise<Result<readonly ParliamentBillVoteLink[], ApiError>>;

  // ── votes / records ───────────────────────────────────────────────────────────
  // The repo derives the cursor `fhash` from the spec + filter internally (it owns
  // the spec); the usecase passes only the validated filter — no core→shell import.
  listVotes(
    filter: FilterInput,
    sort: string,
    dir: 'asc' | 'desc',
    page: CursorPageRequest
  ): Promise<Result<CursorPage<ParliamentVote>, ApiError>>; // votes_chamber_date_idx
  findVote(voteKey: string): Promise<Result<ParliamentVote | null, ApiError>>; // votes_pkey
  listVotesForBill(billKey: string): Promise<Result<readonly ParliamentVote[], ApiError>>; // votes_bill_idx
  /**
   * vote_records_pkey (vote_key prefix) — a single vote's ballots (low hundreds).
   * The cursor `fhash` is derived INTERNALLY from the parent `voteKey` (Codex
   * BLOCKER #2): a ballots cursor is bound to its vote and is rejected if replayed
   * against a different vote — the caller never supplies the fhash.
   */
  listVoteRecords(
    voteKey: string,
    page: CursorPageRequest
  ): Promise<Result<CursorPage<ParliamentBallot>, ApiError>>;
  voteGroupBreakdown(voteKey: string): Promise<Result<readonly ParliamentVoteGroupBreakdown[], ApiError>>; // pk prefix, group_by
  ballotResolution(voteKey: string): Promise<Result<BallotResolution, ApiError>>; // count(*) + count(mandate_key)

  // ── member activity (always parented by mandate_key) ──────────────────────────
  /**
   * vote_records_mandate_idx ⋈ votes; materialize the member's bounded set +
   * in-memory sort by `(vote_date desc, vote_key desc, row_index)` (§3.1.1 — the
   * mandate index carries ONLY mandate_key, so this is NOT an index seek). `total`
   * is an EXACT count over the member's slice of the mandate index (cheap). The
   * cursor `fhash` is derived INTERNALLY from `mandateKey` (parent-bound; #2).
   */
  listMemberVotes(
    mandateKey: string,
    page: CursorPageRequest
  ): Promise<Result<CursorPage<ParliamentMemberVote> & { total: number }, ApiError>>;
  listMemberControlItems(mandateKey: string, page: OffsetParams): Promise<Result<OffsetResult<ParliamentControlItem>, ApiError>>;
  listMemberSpeeches(mandateKey: string, page: OffsetParams): Promise<Result<OffsetResult<ParliamentSpeech>, ApiError>>;
  listMemberInitiatives(mandateKey: string, page: OffsetParams): Promise<Result<OffsetResult<ParliamentInitiative>, ApiError>>;
  listMemberDeclarations(mandateKey: string): Promise<Result<readonly ParliamentDeclarationMeta[], ApiError>>;

  // ── control items list (standalone; bounded — §3.2) ───────────────────────────
  // fhash derived internally from the spec + filter (repo owns the spec).
  listControlItems(
    filter: FilterInput,
    page: CursorPageRequest
  ): Promise<Result<CursorPage<ParliamentControlItem>, ApiError>>;

  // ── lineage (the marquee path) ────────────────────────────────────────────────
  /** bill_act_links_target_idx → bill_vote_links_bill_idx → votes_pkey. All small, indexed. */
  votesForActId(actId: string, roles: readonly string[]): Promise<Result<readonly LineageVoteRow[], ApiError>>;
  billsForActId(actId: string): Promise<Result<readonly ParliamentBill[], ApiError>>;

  // ── cohesion (bounded vote set → group_by; HARD-CAP 500 votes) ────────────────
  // The cap is enforced in the usecase (§7.7): voteKeysForWindow reports overflow
  // (Codex BLOCKER #1) and the usecase returns InvalidInput BEFORE any vote_records
  // fan-in. voteKeysForBill is naturally bounded (a bill has ≤ a handful of votes).
  /** Resolve the vote_key set for a bill (votes_bill_idx). */
  voteKeysForBill(billKey: string): Promise<Result<readonly string[], ApiError>>;
  /**
   * Resolve the vote_key set for a (chamber, from, to) window (votes_chamber_date_idx),
   * fetching at most `cap+1` keys. `overflow:true` means the bounded range exceeds
   * the cap — the usecase rejects with InvalidInput and never fans into vote_records.
   */
  voteKeysForWindow(
    chamber: string,
    from: string,
    to: string,
    cap: number
  ): Promise<Result<{ voteKeys: readonly string[]; overflow: boolean }, ApiError>>;
  /**
   * GROUP BY group_name, choice across a bounded vote_key set → cohesion. The
   * caller MUST have already capped the set at ≤ COHESION_VOTE_CAP; this method
   * defensively rejects an over-cap set (InvalidInput) rather than scanning.
   */
  cohesionForVoteKeys(voteKeys: readonly string[], group?: string): Promise<Result<readonly ParliamentGroupCohesion[], ApiError>>;

  // ── data-quality / correlation surface (api-key gated; lean projection) ───────
  listPersonCandidates(
    status: string | undefined,
    page: OffsetParams
  ): Promise<Result<OffsetResult<ParliamentPersonCandidate>, ApiError>>; // person_candidates_status_idx

  // ── contributor support (deferred until recipient→CUI canonicalization) ───────
  controlPresenceForRecipient(cui: string): Promise<Result<ParliamentControlSummaryCount | null, ApiError>>;

  // ── freshness watermark ───────────────────────────────────────────────────────
  loaderWatermark(): Promise<Result<string | null, ApiError>>;
}

/** Internal count shape backing the (deferred) recipient→CUI contributor. */
export interface ParliamentControlSummaryCount {
  readonly count: number;
  readonly lastDate: string | null;
  readonly topRecipient: string | null;
}

/** The dimensions `resolveFilters` accepts (mirrors ParliamentResolveDim). */
export type ResolveDim = ParliamentResolveDim;
