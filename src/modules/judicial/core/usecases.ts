/**
 * Judicial module — usecases (plan 08 §5). Framework-free, over ports, returning
 * `Result`. GraphQL + MCP both call these (tri-surface equivalence).
 *
 * THE PRIVACY-CRITICAL MERGE lives in `getCaseDetail` (§3.2): the gated
 * `getPublishableNames` lookup enriches publishable company/public metadata in
 * ONE auditable place, while the client-view name remains withheld.
 */

import { err, ok, type Result } from 'neverthrow';

import type {
  CompanyLitigationFilter,
  JudicialAppealRepo,
  JudicialCaseRepo,
  JudicialCompanyLinkRepo,
  JudicialCourtRepo,
  JudicialHearingRepo,
  JudicialLegalRefRepo,
  JudicialLineageRepo,
  JudicialPartyRepo,
  PartyDictionaryRepo,
} from './ports.js';
import type {
  JudicialCase,
  JudicialCaseAggregate,
  JudicialCaseCitation,
  JudicialCaseDetail,
  JudicialCaseLink,
  JudicialCompanyLitigation,
  JudicialCourt,
  JudicialCourtTree,
  JudicialLegalRef,
  JudicialLineageEdge,
  JudicialPartyView,
  JudicialResolveDim,
} from './types.js';
import type {
  ApiError,
  CursorPage,
  CursorPageRequest,
  FilterInput,
  ResolveHit,
} from '@/modules/shared/index.js';

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
    repos.cases.getAsOf(),
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
): Promise<Result<CursorPage<JudicialCase>, ApiError>> => repos.cases.listCursor(input);

export const getCourtCaseload = (
  repos: Pick<JudicialRepos, 'cases'>,
  groupBy: 'court' | 'category' | 'year' | 'courtLevel',
  filter: FilterInput
): Promise<Result<JudicialCaseAggregate, ApiError>> => repos.cases.aggregate({ groupBy, filter });

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

export const getCaseLegalRefs = (
  repos: Pick<JudicialRepos, 'legalRefs'>,
  caseId: string
): Promise<Result<readonly JudicialLegalRef[], ApiError>> => repos.legalRefs.listForCase(caseId);

export const listCasesCitingAct = (
  repos: Pick<JudicialRepos, 'legalRefs'>,
  targetActId: string,
  page: CursorPageRequest
): Promise<Result<CursorPage<JudicialCaseCitation>, ApiError>> =>
  repos.legalRefs.casesCitingAct(targetActId, page);

export const getCaseLineage = (
  repos: Pick<JudicialRepos, 'lineage'>,
  caseId: string
): Promise<Result<readonly JudicialLineageEdge[], ApiError>> =>
  repos.lineage.lineageForCase(caseId);

// ── resolve / discovery (§7.4) ─────────────────────────────────────────────────

export const resolveJudicialFilters = async (
  repos: Pick<JudicialRepos, 'courts' | 'dictionary'>,
  dim: JudicialResolveDim,
  q: string,
  limit: number
): Promise<Result<readonly ResolveHit[], ApiError>> => {
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
      const levels = [
        'judecatorie',
        'tribunal',
        'tribunal_militar',
        'curte_de_apel',
        'curte_militara_apel',
      ];
      const hits = levels
        .filter((l) => needle === '' || l.includes(needle))
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
