/**
 * Judicial module — usecases (plan 08 §5). Framework-free, over ports, returning
 * `Result`. GraphQL + MCP both call these (tri-surface equivalence).
 *
 * THE PRIVACY-CRITICAL MERGE lives in `getCaseDetail` (§3.2): the gated
 * `getPublishableNames` lookup enriches publishable company/public metadata in
 * ONE auditable place, while the client-view name remains withheld.
 *
 * A3: the discovery dimension/query/limit, the aggregate dimension and the
 * direct legal-reference case id are validated HERE, before any repo access.
 *
 * API-04: REST joins GraphQL and MCP on these SAME usecases. The stored
 * decision reads validate their ORIGINAL direct IDs, source pair, page and
 * discovery arguments here, before any repo access; the repo re-checks for
 * direct callers. Decisions are served as stored (see core/types.ts).
 */

import { err, ok, type Result } from 'neverthrow';

import {
  invalidInput,
  type ApiError,
  type CursorPage,
  type CursorPageRequest,
  type FilterInput,
  type ResolveHit,
} from '@/modules/shared/index.js';

import {
  JUDICIAL_COURT_LEVELS,
  JUDICIAL_DECISION_LINK_STATUSES,
  JUDICIAL_DECISION_PAGE_DEFAULT,
  JUDICIAL_DECISION_SUBJECT_KINDS,
  JUDICIAL_RESOLVE_LIMIT_DEFAULT,
  JUDICIAL_RESOLVE_LIMIT_MAX,
  isJudicialAggregateGroupBy,
  isJudicialDecisionPageSize,
  isJudicialDecisionResolveDim,
  isJudicialDirectId,
  isJudicialResolveDim,
  isJudicialSignedId,
  type JudicialCase,
  type JudicialCaseAggregate,
  type JudicialCaseCitation,
  type JudicialCaseDetail,
  type JudicialCaseLink,
  type JudicialCompanyLitigation,
  type JudicialCourt,
  type JudicialCourtTree,
  type JudicialCursorItem,
  type JudicialDecision,
  type JudicialDecisionSubjectLink,
  type JudicialIssuingBody,
  type JudicialLegalRef,
  type JudicialLineageEdge,
  type JudicialPartyView,
} from './types.js';

import type {
  CompanyLitigationFilter,
  JudicialAppealRepo,
  JudicialCaseRepo,
  JudicialCompanyLinkRepo,
  JudicialCourtRepo,
  JudicialDecisionRepo,
  JudicialHearingRepo,
  JudicialLegalRefRepo,
  JudicialLineageRepo,
  JudicialPartyRepo,
  PartyDictionaryRepo,
} from './ports.js';

export interface JudicialRepos {
  readonly courts: JudicialCourtRepo;
  readonly cases: JudicialCaseRepo;
  readonly hearings: JudicialHearingRepo;
  readonly appeals: JudicialAppealRepo;
  readonly parties: JudicialPartyRepo;
  readonly dictionary: PartyDictionaryRepo;
  readonly companyLinks: JudicialCompanyLinkRepo;
  readonly legalRefs: JudicialLegalRefRepo;
  readonly lineage: JudicialLineageRepo;
  /** API-04: the three stored decision tables (one repo; served as stored). */
  readonly decisions: JudicialDecisionRepo;
}

// ── courts ─────────────────────────────────────────────────────────────────────

export const listCourts = (
  repos: Pick<JudicialRepos, 'courts'>,
  filter: FilterInput
): Promise<Result<readonly JudicialCourt[], ApiError>> => repos.courts.list({ filter });

export const getCourtTree = async (
  repos: Pick<JudicialRepos, 'courts'>,
  code: string
): Promise<Result<JudicialCourtTree | null, ApiError>> => {
  const courtRes = await repos.courts.getByCode(code);
  if (courtRes.isErr()) return err(courtRes.error);
  const court = courtRes.value;
  if (court === null) return ok(null);
  const childrenRes = await repos.courts.listChildren(code);
  if (childrenRes.isErr()) return err(childrenRes.error);
  return ok({ court, children: childrenRes.value });
};

// ── case detail — THE PRIVACY-CRITICAL NAME MERGE (§3.2) ───────────────────────

export interface CaseRef {
  readonly caseId?: string;
  readonly institutionCode?: string;
  readonly caseNumber?: string;
}

export const getCaseDetail = async (
  repos: JudicialRepos,
  ref: CaseRef
): Promise<Result<JudicialCaseDetail | null, ApiError>> => {
  // Resolve the case by id or natural key.
  let caseRes: Result<JudicialCase | null, ApiError>;
  if (ref.caseId !== undefined) {
    caseRes = await repos.cases.getById(ref.caseId);
  } else if (ref.institutionCode !== undefined && ref.caseNumber !== undefined) {
    caseRes = await repos.cases.getByNaturalKey(ref.institutionCode, ref.caseNumber);
  } else {
    return ok(null);
  }
  if (caseRes.isErr()) return err(caseRes.error);
  const theCase = caseRes.value;
  if (theCase === null) return ok(null);
  const caseId = theCase.caseId;

  const [hearingsRes, appealsRes, partiesRes, refsRes, lineageRes, asOfRes] = await Promise.all([
    repos.hearings.listForCase(caseId),
    repos.appeals.listForCase(caseId),
    repos.parties.listForCase(caseId),
    repos.legalRefs.listForCase(caseId),
    repos.lineage.lineageForCase(caseId),
    // As-of is scoped to the RESOLVED case's source (A2), never a global maximum.
    repos.cases.getAsOf(theCase.sourceSlug),
  ]);
  if (hearingsRes.isErr()) return err(hearingsRes.error);
  if (appealsRes.isErr()) return err(appealsRes.error);
  if (partiesRes.isErr()) return err(partiesRes.error);
  if (refsRes.isErr()) return err(refsRes.error);
  if (lineageRes.isErr()) return err(lineageRes.error);
  if (asOfRes.isErr()) return err(asOfRes.error);

  const parties = partiesRes.value;

  // THE ONE GATED DICTIONARY JOIN (defence-in-depth — §3.1). A party gets
  // publishable metadata ONLY when:
  //   (a) THIS party row is itself publishable (party.publishable — per-row
  //       party_kind/classifier_rule/version, computed in the repo), AND
  //   (b) the gated dictionary returns a publishable company/public name for its key.
  // Requiring BOTH means a person/unknown party that merely SHARES a name-key with a
  // company elsewhere in the corpus can NEVER inherit that company's name — the
  // dictionary `exists(...)` gate alone would not catch that, this per-row flag does.
  const nameKeyIds = parties
    .map((p) => (p.publishable ? p.nameKeyId : null))
    .filter((id): id is string => id !== null);
  const namesRes = await repos.dictionary.getPublishableNames(nameKeyIds);
  if (namesRes.isErr()) return err(namesRes.error);
  const names = namesRes.value;

  let personPartyCount = 0;
  const partyViews: JudicialPartyView[] = parties.map((p) => {
    // Only rows that pass BOTH publication gates may expose an identity key or
    // legal form. A stable key on a person/unknown/declined row would permit
    // cross-case correlation even when its display name is withheld.
    const pub = p.publishable && p.nameKeyId !== null ? names.get(p.nameKeyId) : undefined;
    if (p.partyKind === 'person' || p.partyKind === 'unknown') personPartyCount += 1;
    return {
      partyIndex: p.partyIndex,
      partyKind: p.partyKind,
      roleNormalized: p.roleNormalized,
      nameKeyId: pub?.nameKeyId ?? null,
      // TEMPORARY POLICY: Withhold until the judicial permission layer exists.
      // Keep the gated PublishableName lookup for key/form; restore its displayName
      // here only after that authorization is enforced.
      name: null,
      legalForm: pub?.legalForm ?? null,
    };
  });

  return ok({
    case: theCase,
    hearings: hearingsRes.value,
    appeals: appealsRes.value,
    parties: partyViews,
    personPartyCount,
    legalReferences: refsRes.value,
    lineage: lineageRes.value,
    asOf: asOfRes.value,
  });
};

// ── case list + aggregate ──────────────────────────────────────────────────────

export interface ListCasesInput {
  readonly filter: FilterInput;
  readonly sort: 'modifiedAt' | 'openedAt';
  readonly dir: 'asc' | 'desc';
  readonly page: CursorPageRequest;
}

export const listCases = (
  repos: Pick<JudicialRepos, 'cases'>,
  input: ListCasesInput
): Promise<Result<CursorPage<JudicialCursorItem<JudicialCase>>, ApiError>> =>
  repos.cases.listCursor(input);

export const getCourtCaseload = async (
  repos: Pick<JudicialRepos, 'cases'>,
  groupBy: unknown,
  filter: FilterInput
): Promise<Result<JudicialCaseAggregate, ApiError>> => {
  // An unknown dimension is an input error, never a silent year aggregate.
  if (!isJudicialAggregateGroupBy(groupBy)) {
    return err(invalidInput('groupBy must be one of court, category, year, courtLevel', 'groupBy'));
  }
  return repos.cases.aggregate({ groupBy, filter });
};

// ── company litigation (JD-1; published-only; empty in v1) ─────────────────────

export const getCompanyLitigation = (
  repos: Pick<JudicialRepos, 'companyLinks'>,
  cui: string,
  filter?: CompanyLitigationFilter
): Promise<Result<JudicialCompanyLitigation, ApiError>> =>
  repos.companyLinks.summaryForCui(cui, filter);

export const listCompanyLitigationCases = (
  repos: Pick<JudicialRepos, 'companyLinks'>,
  cui: string,
  page: CursorPageRequest,
  filter?: CompanyLitigationFilter
): Promise<Result<CursorPage<JudicialCaseLink>, ApiError>> =>
  repos.companyLinks.listCasesForCui(cui, page, filter);

// ── legal refs (JD-3) + lineage (JD-4) ─────────────────────────────────────────

export const getCaseLegalRefs = async (
  repos: Pick<JudicialRepos, 'legalRefs'>,
  caseId: string
): Promise<Result<readonly JudicialLegalRef[], ApiError>> => {
  // The DIRECT entry: a negative, malformed or overflowing id is a caller
  // mistake (the repo read is shared with the case-detail child read).
  if (!isJudicialDirectId(caseId)) {
    return err(
      invalidInput('caseId must be a decimal digit string of at most 9223372036854775807', 'caseId')
    );
  }
  return repos.legalRefs.listForCase(caseId);
};

export const listCasesCitingAct = (
  repos: Pick<JudicialRepos, 'legalRefs'>,
  targetActId: string,
  page: CursorPageRequest
): Promise<Result<CursorPage<JudicialCursorItem<JudicialCaseCitation>>, ApiError>> =>
  repos.legalRefs.casesCitingAct(targetActId, page);

export const getCaseLineage = async (
  repos: Pick<JudicialRepos, 'lineage'>,
  caseId: unknown
): Promise<Result<readonly JudicialLineageEdge[], ApiError>> => {
  // The DIRECT entry (API-04): the same range/type rule as every case id. The
  // repo read is shared with the case-detail child read and keeps its own rule.
  if (!isJudicialDirectId(caseId)) {
    return err(
      invalidInput('caseId must be a decimal digit string of at most 9223372036854775807', 'caseId')
    );
  }
  return repos.lineage.lineageForCase(caseId);
};

// ── resolve / discovery (§7.4) ─────────────────────────────────────────────────

/**
 * Resolve a free-text query. The ORIGINAL inputs are validated before dispatch
 * and before any repo access: `dim` one of the four dimensions, `q` a string,
 * `limit` omitted/null (default 10) or an integer 1..50 (no coercion, no
 * clamping). Errors never echo the query or name text.
 */
export const resolveJudicialFilters = async (
  repos: Pick<JudicialRepos, 'courts' | 'dictionary'>,
  dim: unknown,
  q: unknown,
  limitInput?: unknown
): Promise<Result<readonly ResolveHit[], ApiError>> => {
  if (!isJudicialResolveDim(dim)) {
    return err(invalidInput('dim must be one of court, courtLevel, companyName, category', 'dim'));
  }
  if (typeof q !== 'string') return err(invalidInput('q must be a string', 'q'));
  const limit = limitInput ?? JUDICIAL_RESOLVE_LIMIT_DEFAULT;
  if (
    typeof limit !== 'number' ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > JUDICIAL_RESOLVE_LIMIT_MAX
  ) {
    return err(invalidInput('limit must be an integer from 1 to 50', 'limit'));
  }
  switch (dim) {
    case 'court': {
      const res = await repos.courts.resolveCourt(q, limit);
      if (res.isErr()) return err(res.error);
      return ok(
        res.value.map((c) => ({
          kind: 'court',
          value: c.institutionCode,
          label: c.locality ?? c.institutionCode,
          hint: c.courtLevel,
        }))
      );
    }
    case 'courtLevel': {
      // Static enum match — case-insensitive contains over the level codes.
      const needle = q.trim().toLowerCase();
      const hits = JUDICIAL_COURT_LEVELS.filter((l) => needle === '' || l.includes(needle))
        .slice(0, limit)
        .map((l) => ({ kind: 'courtLevel', value: l, label: l }));
      return ok(hits);
    }
    case 'companyName': {
      // The dictionary holds NO person names (CHECK). A person query → zero rows.
      // The result carries the matched display_name, NEVER the query string (S1).
      const res = await repos.dictionary.resolveCompanyName(q, limit);
      if (res.isErr()) return err(res.error);
      return ok(
        res.value.map((p) => ({
          kind: 'companyName',
          value: p.nameKeyId,
          label: p.displayName,
          ...(p.legalForm !== null && { hint: p.legalForm }),
        }))
      );
    }
    case 'category': {
      const res = await repos.courts.resolveCategory(q, limit);
      if (res.isErr()) return err(res.error);
      return ok(
        res.value.map((c) => ({
          kind: 'category',
          value: c.value,
          label: c.label ?? c.value,
        }))
      );
    }
  }
};

// ── stored decisions (API-04; served as stored) ────────────────────────────────

const DECISION_ID_MESSAGE =
  'decisionId must be a canonical signed int8 decimal string (no leading zeros, no -0)';

/** The original page of a new decision/link list: `first` 1..50 (null/omitted = 20). */
export interface DecisionPageInput {
  readonly first?: unknown;
  readonly after?: unknown;
}

const decisionPage = (input: DecisionPageInput): Result<CursorPageRequest, ApiError> => {
  const first = input.first ?? JUDICIAL_DECISION_PAGE_DEFAULT;
  if (!isJudicialDecisionPageSize(first)) {
    return err(invalidInput('first must be an integer from 1 to 50', 'first'));
  }
  const after = input.after ?? undefined;
  if (after !== undefined && typeof after !== 'string') {
    return err(invalidInput('after must be a cursor string', 'after'));
  }
  return ok({ first, ...(after !== undefined && { after }) });
};

export const listDecisionIssuingBodies = (
  repos: Pick<JudicialRepos, 'decisions'>
): Promise<Result<readonly JudicialIssuingBody[], ApiError>> => repos.decisions.listIssuingBodies();

/** A stored decision by native id; a valid absent id is null (not an error). */
export const getDecision = async (
  repos: Pick<JudicialRepos, 'decisions'>,
  decisionId: unknown
): Promise<Result<JudicialDecision | null, ApiError>> => {
  if (!isJudicialSignedId(decisionId)) return err(invalidInput(DECISION_ID_MESSAGE, 'decisionId'));
  return repos.decisions.getById(decisionId);
};

/** A stored decision by its exact unique source pair (BOTH strings required, as given). */
export const getDecisionBySource = async (
  repos: Pick<JudicialRepos, 'decisions'>,
  sourceSystem: unknown,
  sourceRef: unknown
): Promise<Result<JudicialDecision | null, ApiError>> => {
  if (typeof sourceSystem !== 'string') {
    return err(invalidInput('sourceSystem is required (exact text)', 'sourceSystem'));
  }
  if (typeof sourceRef !== 'string') {
    return err(invalidInput('sourceRef is required (exact text)', 'sourceRef'));
  }
  return repos.decisions.getBySource(sourceSystem, sourceRef);
};

export interface ListDecisionsInput extends DecisionPageInput {
  readonly filter: unknown;
}

export const listDecisions = async (
  repos: Pick<JudicialRepos, 'decisions'>,
  input: ListDecisionsInput
): Promise<Result<CursorPage<JudicialCursorItem<JudicialDecision>>, ApiError>> => {
  const page = decisionPage(input);
  if (page.isErr()) return err(page.error);
  return repos.decisions.list({ filter: (input.filter ?? {}) as FilterInput, page: page.value });
};

/** Link rows (one item per link) under EXACTLY one anchor; the repo enforces it. */
export const listDecisionSubjectLinks = async (
  repos: Pick<JudicialRepos, 'decisions'>,
  input: ListDecisionsInput
): Promise<Result<CursorPage<JudicialCursorItem<JudicialDecisionSubjectLink>>, ApiError>> => {
  const page = decisionPage(input);
  if (page.isErr()) return err(page.error);
  return repos.decisions.listSubjectLinks({
    filter: (input.filter ?? {}) as FilterInput,
    page: page.value,
  });
};

/**
 * Decision discovery (separate from the four case dimensions). The ORIGINAL
 * `dim`, `q` and `limit` are validated before any repo access; errors never
 * echo the query. Status hits are recorded labels, not approval facts.
 */
export const resolveDecisionFilters = async (
  repos: Pick<JudicialRepos, 'decisions'>,
  dim: unknown,
  q: unknown,
  limitInput?: unknown
): Promise<Result<readonly ResolveHit[], ApiError>> => {
  if (!isJudicialDecisionResolveDim(dim)) {
    return err(
      invalidInput(
        'dim must be one of issuingBody, sourceSystem, subjectKind, validationStatus',
        'dim'
      )
    );
  }
  if (typeof q !== 'string') return err(invalidInput('q must be a string', 'q'));
  const limit = limitInput ?? JUDICIAL_RESOLVE_LIMIT_DEFAULT;
  if (
    typeof limit !== 'number' ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > JUDICIAL_RESOLVE_LIMIT_MAX
  ) {
    return err(invalidInput('limit must be an integer from 1 to 50', 'limit'));
  }
  const needle = q.trim().toLowerCase();
  switch (dim) {
    case 'issuingBody': {
      const res = await repos.decisions.resolveIssuingBodies(q, limit);
      if (res.isErr()) return err(res.error);
      return ok(
        res.value.map((b) => ({
          kind: 'issuingBody',
          value: b.issuingBody,
          label: b.label,
          hint: b.kind,
        }))
      );
    }
    case 'sourceSystem': {
      const res = await repos.decisions.resolveSourceSystems(q, limit);
      if (res.isErr()) return err(res.error);
      return ok(res.value.map((value) => ({ kind: 'sourceSystem', value, label: value })));
    }
    case 'subjectKind':
      return ok(
        JUDICIAL_DECISION_SUBJECT_KINDS.filter((k) => needle === '' || k.includes(needle))
          .slice(0, limit)
          .map((k) => ({ kind: 'subjectKind', value: k, label: k }))
      );
    case 'validationStatus':
      return ok(
        JUDICIAL_DECISION_LINK_STATUSES.filter((s) => needle === '' || s.includes(needle))
          .slice(0, limit)
          .map((s) => ({
            kind: 'validationStatus',
            value: s,
            label: s,
            hint: 'recorded status label (not a verification)',
          }))
      );
  }
};
