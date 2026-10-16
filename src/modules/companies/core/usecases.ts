/**
 * Companies module — usecases (plan §4). Framework-free, over `CompaniesRepository`
 * + the kernel `FlowsRepo` (public-money, payee/`in`) + kernel `MeiliClient`
 * (Meili-primary name resolution). Thin: GraphQL + MCP call the SAME usecase.
 *
 * `makeCompanyProfile` is the single source of truth for the full assembly: it
 * decides presence first via the cheap `core.organizations` (cui) seek (so an
 * unknown CUI 404s without paying the 8-table fan-out), then injects the
 * public-money slice from the kernel `FlowsRepo.getFlowSummary(cui,'in')` +
 * `getTopCounterparties(cui,'in',…)` — NEVER from this module's repo (§4.3/§14.6).
 *
 * Contributor parity (§14.7): the GraphQL `Entity.company` resolver and the
 * entity-360 both resolve through the contributor's `profileSlice`, which runs
 * `makeCompanyEntitySlices` — one path, not two.
 *
 * Registry scope (core/registry.ts): every operation that serves ONRC data
 * pins ONE scope, reads under it, and rechecks before returning
 * (`runPinned`): unchanged publication and access epochs, and no returned CUI
 * with a now non-public organization. Lazy fields reuse their parent's scope.
 */

import { err, ok, type Result } from 'neverthrow';

import {
  MAX_SERVED_CUI_DIGITS,
  isWithheldOrganizationIdentifier,
  normalizeCui,
  type ApiError,
  type Counterparty,
  type FilterInput,
  type FlowsRepo,
  type FlowSummary,
  type MeiliClient,
  type OffsetParams,
} from '@/modules/shared/index.js';

import { selectActivity, type CompanyActivitySelection } from './activity-selection.js';
import { COMPANY_REGISTRY_FILTER_FIELDS } from './filters.js';
import {
  MAIN_HISTORY_DEFAULT_PAGE,
  MAIN_HISTORY_MAX_PAGE,
  MAIN_HISTORY_NOTE,
  MAIN_ACTIVITY_UNAVAILABLE_REASON,
  attachMainFlags,
  decodeHistoryCursor,
  encodeHistoryCursor,
  gateEvidenceEntry,
  gateMainActivity,
  gateOutcome,
  mainActivityMoved,
  mainActivityWitness,
  type CompanyMainActivityFlags,
  type CompanyMainActivityEvidence,
  type CompanyMainActivityHistoryKind,
  type CompanyMainActivityHistoryPage,
  type CompanyMainActivityHistoryRows,
  type CompanyMainActivityRead,
} from './main-activity.js';
import {
  ONRC_CAEN_REVISIONS,
  isPublished,
  isRegistryCapabilityLost,
  registryCriteriaRefusal,
  registryNotPublished,
  registryScopeKey,
  runPinned,
  scopeFromKey,
  type CompanyRegistryEnvelope,
  type Pinned,
} from './registry.js';
import {
  COMPANY_TERRITORY_COVERAGE_NOTE,
  type CaenCodeHit,
  type CompanyCaenActivity,
  type CompanyCountyProfile,
  type CompanyEntitySlice,
  type CompanyHubStats,
  type CompanyFinancialMetric,
  type CompanyFinancials,
  type CompanyFinancialTrajectory,
  type CompanyFinancialYear,
  type CompanyMetricStatus,
  type CompanyGroupBy,
  type CompanyListRow,
  type CompanyNameHit,
  type CompanySnapshot,
  type CompanyFinancialQualityAssessment,
  type CompanyRegistrationChange,
  type CompanyRegistrationDiff,
  type CompanyRegistrationDiffData,
  type CompanyRegistrationEditionSide,
  type CompanyRegistrationField,
  type CompanyRegistryCapabilities,
  type CompanyPublicMoney,
  type CompanyResolveDim,
  type CompanySort,
} from './types.js';

import type { CompaniesRepository, CompanyPresenceCounts, CompanyProfileData } from './ports.js';

const TOP_PAYERS_CAP = 50;
/**
 * Cap on name-resolved CUIs ANDed into a `q` list (keeps the `cui IN (…)`
 * bounded). 50 — the repo clamps `resolveByName` limits to 50 on BOTH the Meili
 * and pg paths, so asking for more silently truncated while this usecase
 * reported the total as exact (defect D6). A full-cap return is treated as
 * possible truncation and disclosed via `totalEstimated` + a caveat.
 */
const NAME_RESOLVE_CAP = 50;

export interface CompanyUsecaseDeps {
  readonly repo: CompaniesRepository;
  readonly flowsRepo: FlowsRepo;
  readonly meili: MeiliClient | null;
}

const invalidCui = (): ApiError => ({
  type: 'InvalidInput',
  message: 'invalid CUI format',
  field: 'cui',
});

/**
 * Served CUIs are at most 10 digits. Longer registry identifiers are CNP-shaped
 * natural-person identifiers (probable personal data — P0 containment,
 * 2026-07-22): every surface refuses them CATEGORICALLY, with the same typed
 * answer whether or not a row exists, so the refusal never confirms existence.
 * Output-side, resolve/name hits carrying such identifiers are dropped until
 * the search-index purge lands.
 *
 * The predicate now lives in the KERNEL (`shared/core/types.ts`) because the
 * identity spine needs the same rule: this module refused a 13-digit identifier
 * while `referenceOrganization` / `entity` still returned its name. One
 * definition, so the two surfaces cannot disagree again. Re-exported under the
 * companies-local name so existing importers are untouched.
 */
export const isWithheldCompanyIdentifier = isWithheldOrganizationIdentifier;

const withheldIdentifier = (): ApiError => ({
  type: 'InvalidInput',
  message: `identifiers longer than ${String(MAX_SERVED_CUI_DIGITS)} digits are not served`,
  field: 'cui',
});

/**
 * The registry CAEN criteria test qualified class observations only (CQA-15):
 * a short token, unknown revision or unlabeled key never matches. A CAEN
 * exclusion also needs complete CAEN coverage, which an unparsed or
 * unknown-revision observation denies. Disclosed on every list such a
 * criterion shapes.
 */
export const CAEN_CLASS_LIST_CAVEAT =
  'CAEN criteria (caenCode, onrcCaen) match qualified ONRC class observations only (four-digit original token, known revision, catalog label). A CAEN exclusion keeps a company only when its CAEN coverage is complete and no qualified class has the code: a short token or unlabeled key with the same digits neither matches nor blocks the exclusion, while an unparsed or unknown-revision observation makes coverage partial, so the company is not kept. No qualified match is not proof that no source observation or activity exists.';

/** The operators each CAEN field compiles to a predicate (registry-sql.ts). */
const CAEN_CRITERION_OPS = {
  caenCode: ['eq', 'in', 'prefix'],
  onrcCaen: ['eq', 'in'],
} as const;

/** The operand shapes `stringValues` (shell/repo/filter-helpers.ts) reads per operator. */
const OPERAND_READ: Readonly<Record<string, (value: unknown) => boolean>> = {
  eq: (value) => typeof value === 'string' || typeof value === 'number',
  in: (value) => Array.isArray(value) && value.length > 0,
  prefix: (value) => typeof value === 'string',
};

const hasOperand = (ff: unknown, ops: readonly string[]): boolean => {
  if (typeof ff !== 'object' || ff === null) return false;
  const record = ff as Readonly<Record<string, unknown>>;
  return ops.some((op) => OPERAND_READ[op]?.(record[op]) === true);
};

/** A CAEN predicate actually applies: an empty `{}` field compiles to none. */
const hasCaenCriterion = (filter: FilterInput): boolean =>
  Object.entries(CAEN_CRITERION_OPS).some(
    ([field, ops]) => hasOperand(filter[field], ops) || hasOperand(filter.exclude?.[field], ops)
  );

/**
 * Reject an empty `in: []` on any field (inclusion or exclude). The kernel
 * composer compiles an empty `in` to NO predicate, so `{ status: { in: [] } }`
 * would silently match ALL companies — a surprising broaden. We fail it as
 * `InvalidInput` so the caller fixes the query. (Kernel-ergonomics gap — flagged.)
 */
const rejectEmptyIn = (filter: FilterInput): Result<void, ApiError> => {
  const scan = (obj: Readonly<Record<string, unknown>>): ApiError | null => {
    for (const [field, ff] of Object.entries(obj)) {
      if (field === 'exclude') continue;
      if (ff === undefined || typeof ff !== 'object' || ff === null) continue;
      const inV = (ff as Record<string, unknown>)['in'];
      if (Array.isArray(inV) && inV.length === 0) {
        return { type: 'InvalidInput', message: `filter '${field}.in' must not be empty`, field };
      }
    }
    return null;
  };
  const top = scan(filter);
  if (top !== null) return err(top);
  const exclude = filter.exclude;
  if (exclude !== undefined && typeof exclude === 'object') {
    const ex = scan(exclude);
    if (ex !== null) return err(ex);
  }
  return ok(undefined);
};

/**
 * Normalize any `cui` filter values (eq/in, inclusion + exclude) at the usecase
 * boundary so `RO2816464` / formatted CUIs match the same way per-CUI lookups do.
 * An un-normalizable value is rejected with `InvalidInput` rather than silently
 * compiled to a never-matching predicate.
 */
export const normalizeCuiFilter = (filter: FilterInput): Result<FilterInput, ApiError> => {
  const normField = (ff: unknown): Result<unknown, ApiError> => {
    if (ff === undefined || typeof ff !== 'object' || ff === null) return ok(ff);
    const out: Record<string, unknown> = { ...(ff as Record<string, unknown>) };
    if (typeof out['eq'] === 'string') {
      const c = normalizeCui(out['eq']);
      if (c === null) return err(invalidCui());
      if (isWithheldCompanyIdentifier(c)) return err(withheldIdentifier());
      out['eq'] = c;
    }
    if (Array.isArray(out['in'])) {
      const norm: string[] = [];
      for (const v of out['in'] as unknown[]) {
        const c = normalizeCui(String(v));
        if (c === null) return err(invalidCui());
        // A withheld identifier in `exclude.cui.in` would also confirm existence
        // (the total shifts by one) — the categorical reject covers BOTH sides.
        if (isWithheldCompanyIdentifier(c)) return err(withheldIdentifier());
        norm.push(c);
      }
      out['in'] = norm;
    }
    return ok(out);
  };

  const result: Record<string, unknown> = { ...filter };
  if (filter['cui'] !== undefined) {
    const r = normField(filter['cui']);
    if (r.isErr()) return err(r.error);
    result['cui'] = r.value;
  }
  const exclude = filter.exclude;
  if (
    exclude !== undefined &&
    typeof exclude === 'object' &&
    (exclude as Record<string, unknown>)['cui'] !== undefined
  ) {
    const r = normField((exclude as Record<string, unknown>)['cui']);
    if (r.isErr()) return err(r.error);
    result['exclude'] = { ...(exclude as Record<string, unknown>), cui: r.value };
  }
  return ok(result as FilterInput);
};

/**
 * Drop withheld identifiers from an INCLUSION `cui.in` list.
 *
 * A batch `cui.in` is a name RESOLUTION ("give me the rows for these ids"), not
 * a single-identity probe: omitting a withheld id yields a response that is
 * indistinguishable from "no company carries that id", so it discloses nothing
 * the output side does not already withhold (`dropWithheldHits`, and
 * `shell/contributor.ts`, which answer `null` for exactly these ids). This is
 * the "output-side ... dropped" half of the containment note above.
 *
 * Rejecting the whole filter instead meant ONE CNP-shaped supplier CUI inside a
 * 50-id procurement batch blanked an entire page — natural persons legitimately
 * win direct acquisitions, so `ProcurementPartyNames` hits this on the hub's
 * default scope (2026-07-25).
 *
 * `eq`, and EVERY `exclude` branch, keep the categorical reject in
 * `normalizeCuiFilter`: `eq` is the single-identity probe, and an `exclude` list
 * shifts the total by one, which confirms existence. Un-normalizable values are
 * kept here so `normalizeCuiFilter` still fails them as `invalidCui` — this
 * drops withheld input, never malformed input.
 *
 * `emptied` is load-bearing: an empty `in` compiles to NO predicate (see
 * `rejectEmptyIn`), so a batch of ONLY withheld ids must answer an empty page
 * rather than the unfiltered table.
 */
export const dropWithheldCuiInclusion = (
  filter: FilterInput
): { readonly filter: FilterInput; readonly emptied: boolean; readonly dropped: number } => {
  // `unknown`, not the declared FieldFilter: this value arrives from GraphQL /
  // MCP input, so the runtime null check is real even though the static type
  // says it cannot happen.
  const cui: unknown = filter['cui'];
  if (typeof cui !== 'object' || cui === null) {
    return { filter, emptied: false, dropped: 0 };
  }
  const inV = (cui as Record<string, unknown>)['in'];
  if (!Array.isArray(inV)) return { filter, emptied: false, dropped: 0 };

  const kept = (inV as unknown[]).filter((v) => {
    const c = normalizeCui(String(v));
    return c === null || !isWithheldCompanyIdentifier(c);
  });
  const dropped = inV.length - kept.length;
  if (dropped === 0) return { filter, emptied: false, dropped: 0 };

  return {
    filter: { ...filter, cui: { ...(cui as Record<string, unknown>), in: kept } } as FilterInput,
    emptied: kept.length === 0,
    dropped,
  };
};

// ── profile (full assembly + public money) ────────────────────────────────────

/**
 * Build the public-money (payee) slice from the kernel FlowsRepo (grain-gated).
 * Exported as a usecase so the GraphQL `Company.publicMoney` field resolves it
 * LAZILY (only when the client selects it) — it is ~1.2s on a high-degree payee
 * (DEDEMAN: 219k flows), so the common profile path must not pay for it.
 */
export const makeCompanyPublicMoney = async (
  deps: Pick<CompanyUsecaseDeps, 'flowsRepo'>,
  rawCui: string
): Promise<Result<CompanyPublicMoney | null, ApiError>> => {
  const cui = normalizeCui(rawCui);
  if (cui === null) return err(invalidCui());
  if (isWithheldCompanyIdentifier(cui)) return err(withheldIdentifier());
  return buildPublicMoney(deps.flowsRepo, cui);
};

/**
 * Warn-only quality flags for a company's statement years. Lazy field resolver
 * target (`Company.financialQualityFlags`) — the common profile path skips it.
 */
export const makeCompanyFinancialQualityAssessment = async (
  deps: Pick<CompanyUsecaseDeps, 'repo'>,
  rawCui: string
): Promise<Result<CompanyFinancialQualityAssessment, ApiError>> => {
  const cui = normalizeCui(rawCui);
  if (cui === null) return err(invalidCui());
  if (isWithheldCompanyIdentifier(cui)) return err(withheldIdentifier());
  return deps.repo.getFinancialQualityAssessment(cui);
};

const REGISTRATION_DIFF_FIELDS: readonly CompanyRegistrationField[] = [
  'legalName',
  'legalForm',
  'county',
  'locality',
];

/**
 * Pure two-edition diff. Exported for unit tests; no I/O. Compares the SETS
 * of public values per field (exact display text; geography by code); never
 * infers a legal rename, registration or deletion. A first edition (no
 * earlier dated published edition) is never compared and never reports a
 * disappearance; neither are value sets the read could not complete.
 */
export const diffRegistryEditions = (
  data: CompanyRegistrationDiffData
): CompanyRegistrationDiff => {
  const later = data.later;
  const earlier = data.earlier;
  const base = {
    fromEditionId: earlier?.editionId ?? null,
    toEditionId: later?.editionId ?? null,
    fromCaptureDate: earlier?.sourcePublishedAt ?? null,
    toCaptureDate: later?.sourcePublishedAt ?? null,
  };
  const notComparable = (reason: string): CompanyRegistrationDiff => ({
    ...base,
    status: 'not_comparable',
    reason,
    changes: [],
  });
  if (later === null) return notComparable(`registry_${data.registry.state}`);
  if (!later.inEdition && earlier?.inEdition !== true) {
    return notComparable(earlier === null ? 'not_in_edition' : 'not_in_either_edition');
  }
  if (earlier === null) return notComparable('first_edition');
  if (!earlier.inEdition) return { ...base, status: 'appeared', reason: null, changes: [] };
  if (!later.inEdition) return { ...base, status: 'disappeared', reason: null, changes: [] };
  // Presence above is complete on its own; a value comparison needs both
  // complete sets (an unread value is never a missing one).
  if (!earlier.valuesComplete || !later.valuesComplete) {
    return notComparable('evidence_bound_exceeded');
  }
  return compareSides(base, earlier, later);
};

const compareSides = (
  base: Pick<
    CompanyRegistrationDiff,
    'fromEditionId' | 'toEditionId' | 'fromCaptureDate' | 'toCaptureDate'
  >,
  earlier: CompanyRegistrationEditionSide,
  later: CompanyRegistrationEditionSide
): CompanyRegistrationDiff => {
  const changes: CompanyRegistrationChange[] = [];
  let ambiguous = false;
  for (const field of REGISTRATION_DIFF_FIELDS) {
    const from = earlier.values[field];
    const to = later.values[field];
    // Both sides arrive sorted by key: equal sets are equal key sequences.
    const sameSet = from.length === to.length && from.every((v, i) => v.key === to[i]?.key);
    if (sameSet) continue;
    // Several public values on a side: the sets differ, but no single
    // from→to change can be asserted.
    if (from.length > 1 || to.length > 1) {
      ambiguous = true;
      continue;
    }
    changes.push({ field, from: from[0]?.display ?? null, to: to[0]?.display ?? null });
  }
  if (ambiguous) return { ...base, status: 'ambiguous', reason: null, changes: [] };
  return {
    ...base,
    status: changes.length > 0 ? 'changed' : 'unchanged',
    reason: null,
    changes,
  };
};

/**
 * Two-edition registration diff. Lazy field resolver target
 * (`Company.registrationDiff`): with the parent's `scope` it compares the
 * edition the parent profile was read under and refuses (never re-pins) when
 * that scope no longer holds.
 */
export const makeCompanyRegistrationDiff = async (
  deps: Pick<CompanyUsecaseDeps, 'repo'>,
  rawCui: string,
  scope?: CompanyRegistryEnvelope
): Promise<Result<CompanyRegistrationDiff, ApiError>> => {
  const cui = normalizeCui(rawCui);
  if (cui === null) return err(invalidCui());
  if (isWithheldCompanyIdentifier(cui)) return err(withheldIdentifier());
  const pinned = await runPinned(
    deps.repo,
    (s) => deps.repo.getRegistrationDiffData(cui, s),
    () => [cui],
    scope === undefined ? {} : { scope }
  );
  return pinned.map((p) => diffRegistryEditions(p.value));
};

const buildPublicMoney = async (
  flowsRepo: FlowsRepo,
  cui: string
): Promise<Result<CompanyPublicMoney | null, ApiError>> => {
  const [summaryRes, payersRes] = await Promise.all([
    flowsRepo.getFlowSummary(cui, 'in', true), // include the per-year breakdown (Company.byYear)
    flowsRepo.getTopCounterparties(cui, 'in', TOP_PAYERS_CAP),
  ]);
  if (summaryRes.isErr()) return err(summaryRes.error);
  if (payersRes.isErr()) return err(payersRes.error);
  const summary: FlowSummary = summaryRes.value;
  if (summary.count === 0) return ok(null);

  // byYear is now a real per-(year, flowType) breakdown (audit H4 — `year` was
  // always null because the kernel only grouped by flow_type). byFlowType keeps
  // the year-agnostic rollup the old `byYear` actually carried.
  const byYear = summary.byYear.map((b) => ({
    year: b.year,
    flowType: b.flowType,
    totalRon: b.totalAmountRon,
    count: b.count,
  }));
  const byFlowType = summary.byFlowType.map((b) => ({
    flowType: b.flowType,
    totalRon: b.totalAmountRon,
    count: b.count,
  }));
  const topPayers = payersRes.value.map((c: Counterparty) => ({
    cui: c.cui,
    name: c.name,
    totalRon: c.totalAmountRon,
    count: c.flowCount,
  }));
  return ok({
    totalRon: summary.totalAmountRon,
    flowCount: summary.count,
    byYear,
    byFlowType,
    topPayers,
  });
};

/** One pinned profile read: the profile's own CUI is the recheck's parent probe. */
const pinnedProfile = (repo: CompaniesRepository, cui: string) =>
  runPinned(
    repo,
    (scope) => repo.getProfileData(cui, scope),
    (data) => (data === null ? [] : [data.cui])
  );

/**
 * The profile WITHOUT the public-money slice. The GraphQL `company` query returns
 * this (publicMoney is a separate lazy field resolver, §latency); a `null` result
 * means the CUI does not resolve to a directory company. A company without a
 * profile in the pinned edition is `registry.cuiState = not_in_edition`, never
 * absent; an unpublished/withdrawn/unavailable registry keeps the fiscal and
 * financial sections.
 */
export const makeCompanyProfileData = async (
  deps: Pick<CompanyUsecaseDeps, 'repo'>,
  rawCui: string
): Promise<Result<CompanyProfileData | null, ApiError>> => {
  const cui = normalizeCui(rawCui);
  if (cui === null) return err(invalidCui());
  if (isWithheldCompanyIdentifier(cui)) return err(withheldIdentifier());
  return (await pinnedProfile(deps.repo, cui)).map((p) => p.value);
};

/** The Company parts a response may compose beyond the profile data. */
export interface CompanyCompositionParts {
  readonly publicMoney?: boolean;
  readonly financialQualityAssessment?: boolean;
  readonly registrationDiff?: boolean;
  readonly activitySelection?: boolean;
  /** The ANAF-assumed main activity (the singleton read). */
  readonly mainActivity?: boolean;
  /**
   * The class flags of the activity rows: implies the main read, adds the
   * bounded flag list to the same statement. Never read for a main-only
   * selection.
   */
  readonly mainFlags?: boolean;
}

/**
 * The main-activity part of one owning response: the gated read, the
 * profile's activity rows with their two flags (from the same statement)
 * and the witness the operation-level recheck compares.
 */
export interface CompanyMainActivityPart {
  readonly read: CompanyMainActivityRead;
  readonly caenActivities: readonly (CompanyCaenActivity & CompanyMainActivityFlags)[];
  readonly witness: string;
}

/**
 * The profile and its selected parts, read and rechecked as ONE response.
 * Each part keeps its own Result: an ordinary failure of a part stays that
 * part's (advisory), while access is decided once, for the whole.
 */
export interface CompanyComposition {
  readonly profile: CompanyProfileData;
  readonly publicMoney?: Result<CompanyPublicMoney | null, ApiError>;
  readonly financialQualityAssessment?: Result<CompanyFinancialQualityAssessment, ApiError>;
  readonly registrationDiff?: Result<CompanyRegistrationDiff, ApiError>;
  /** Null without a published edition or a profile of the CUI in it. */
  readonly activitySelection?: Result<CompanyActivitySelection | null, ApiError>;
  readonly mainActivity?: Result<CompanyMainActivityPart, ApiError>;
}

/**
 * Settle the main part AFTER every other part of the response: re-read the
 * company's witness fresh and compare it with what was read. A move (a
 * refresh, a correction, a source or edition withdrawal, a currentness
 * change) re-reads the part once; a second move refuses THIS part
 * (`mainActivityMoved`), never an older payload and never other parts.
 */
const settleMainActivity = async (
  repo: CompaniesRepository,
  profile: CompanyProfileData,
  first: Result<CompanyMainActivityEvidence, ApiError>,
  scope: CompanyRegistryEnvelope,
  options: { readonly flags: boolean }
): Promise<Result<CompanyMainActivityPart, ApiError>> => {
  let evidence = first;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (evidence.isErr()) return err(evidence.error);
    const witness = mainActivityWitness(evidence.value);
    const fresh = await repo.readMainActivityWitness(profile.cui);
    if (fresh.isErr()) return err(fresh.error);
    if (fresh.value === witness) {
      const read = gateMainActivity(evidence.value, scope);
      // Unread, unavailable or past the bound: every flag stays null (unknown).
      const flags = evidence.value.flags.state === 'read' ? evidence.value.flags.flags : [];
      return ok({
        read,
        caenActivities: attachMainFlags(profile.caenActivities, read, flags, scope),
        witness,
      });
    }
    if (attempt === 0) evidence = await repo.getMainActivity(profile.cui, options);
  }
  return err(mainActivityMoved());
};

/**
 * The operation-level decision for main facts ALREADY served with `witness`:
 * ok while the company's main witness is unchanged, else the refusal. No
 * re-read: what was served cannot be replaced.
 */
export const confirmMainActivityServed = async (
  repo: CompaniesRepository,
  cui: string,
  witness: string
): Promise<Result<void, ApiError>> => {
  const fresh = await repo.readMainActivityWitness(cui);
  if (fresh.isErr()) return err(fresh.error);
  return fresh.value === witness ? ok(undefined) : err(mainActivityMoved());
};

/**
 * The derived activity selection of a profile read under `scope`: the
 * repository's bounded exact evidence through the pure rule
 * (`selectActivity`), with the profile's CAEN coverage and the edition's
 * id and source date. Null without a published edition or a profile of the
 * CUI in it (no coverage to state). An aggregate past its bound is a typed
 * refusal of this part, never a truncated selection.
 */
const readActivitySelection = async (
  repo: CompaniesRepository,
  profile: CompanyProfileData,
  scope: CompanyRegistryEnvelope
): Promise<Result<CompanyActivitySelection | null, ApiError>> => {
  const edition = profile.registry.profile;
  if (!isPublished(scope) || edition === null) return ok(null);
  const evidence = await repo.getActivityEvidence(profile.cui, scope);
  if (evidence.isErr()) return err(evidence.error);
  if (evidence.value === null) return ok(null);
  return selectActivity({
    ...evidence.value,
    caenCoverage: edition.caenCoverage,
    editionId: scope.editionId,
    editionSourceDate: scope.sourcePublishedAt,
  });
};

/**
 * One owning Company response. The profile and every SELECTED part (public
 * money, quality assessment, registration diff) are read inside ONE pin, and
 * the recheck (scope, epochs and the CUI's current core privacy) runs once
 * AFTER all of them: a parent restricted, a publication moved or a registry
 * capability lost while any part is pending re-pins the whole response once,
 * then refuses it. No earlier payload is ever returned. The MCP snapshot and
 * the GraphQL `company` root (with its selected fields) compose through this.
 */
export const makeCompanyComposition = async (
  deps: CompanyUsecaseDeps,
  rawCui: string,
  parts: CompanyCompositionParts
): Promise<Result<CompanyComposition | null, ApiError>> => {
  const cui = normalizeCui(rawCui);
  if (cui === null) return err(invalidCui());
  if (isWithheldCompanyIdentifier(cui)) return err(withheldIdentifier());

  const read = async (
    scope: CompanyRegistryEnvelope
  ): Promise<Result<CompanyComposition | null, ApiError>> => {
    const dataRes = await deps.repo.getProfileData(cui, scope);
    if (dataRes.isErr()) return err(dataRes.error);
    const profile = dataRes.value;
    if (profile === null) return ok(null);
    const [publicMoney, financialQualityAssessment, diffData, activity, main] = await Promise.all([
      parts.publicMoney === true ? buildPublicMoney(deps.flowsRepo, cui) : undefined,
      parts.financialQualityAssessment === true
        ? deps.repo.getFinancialQualityAssessment(cui)
        : undefined,
      parts.registrationDiff === true ? deps.repo.getRegistrationDiffData(cui, scope) : undefined,
      parts.activitySelection === true
        ? readActivitySelection(deps.repo, profile, scope)
        : undefined,
      parts.mainActivity === true || parts.mainFlags === true
        ? deps.repo.getMainActivity(cui, { flags: parts.mainFlags === true })
        : undefined,
    ]);
    // A capability lost by the diff or activity read moves the scope like any other read.
    for (const part of [diffData, activity]) {
      if (part !== undefined && part.isErr() && isRegistryCapabilityLost(part.error)) {
        return err(part.error);
      }
    }
    // Last, after every other part settled: the fresh main recheck.
    const mainActivity =
      main === undefined
        ? undefined
        : await settleMainActivity(deps.repo, profile, main, scope, {
            flags: parts.mainFlags === true,
          });
    return ok({
      profile,
      ...(publicMoney !== undefined && { publicMoney }),
      ...(financialQualityAssessment !== undefined && { financialQualityAssessment }),
      ...(diffData !== undefined && { registrationDiff: diffData.map(diffRegistryEditions) }),
      ...(activity !== undefined && { activitySelection: activity }),
      ...(mainActivity !== undefined && { mainActivity }),
    });
  };
  const pinned = await runPinned(deps.repo, read, (composition) =>
    composition === null ? [] : [composition.profile.cui]
  );
  return pinned.map((p) => p.value);
};

/**
 * The FULL eager snapshot (data + public money + registration diff) of the
 * MCP snapshot, composed as ONE response (`makeCompanyComposition`). Public
 * money is part of the snapshot (its failure fails it); the diff is advisory
 * (H2 parity with the nullable GraphQL field: an ordinary comparison-read
 * failure is null, while access is decided by the single final recheck).
 */
export const makeCompanyProfile = async (
  deps: CompanyUsecaseDeps,
  rawCui: string
): Promise<Result<CompanySnapshot | null, ApiError>> => {
  const composed = await makeCompanyComposition(deps, rawCui, {
    publicMoney: true,
    registrationDiff: true,
    activitySelection: true,
    mainActivity: true,
    mainFlags: true,
  });
  if (composed.isErr()) return err(composed.error);
  const composition = composed.value;
  if (composition === null) return ok(null);
  const money = composition.publicMoney ?? ok(null);
  if (money.isErr()) return err(money.error);
  const activity = composition.activitySelection ?? ok(null);
  const main = composition.mainActivity;
  return ok({
    ...composition.profile,
    // Flags only from the settled main part; null (unknown) when it was refused.
    caenActivities:
      main?.isOk() === true
        ? main.value.caenActivities
        : composition.profile.caenActivities.map((a) => ({
            ...a,
            isMainCaen: null,
            matchesAssumedMainCode: null,
          })),
    publicMoney: money.value,
    registrationDiff: composition.registrationDiff?.unwrapOr(null) ?? null,
    // Advisory like the diff: a refused or failed selection is null with its reason.
    activitySelection: activity.unwrapOr(null),
    activitySelectionRefusal: activity.isErr() ? activity.error.message : null,
    // Advisory like the selection: a refused main part is null with its reason.
    mainActivity: main?.isOk() === true ? main.value.read : null,
    mainActivityRefusal: main?.isErr() === true ? main.error.message : null,
  });
};

// ── ANAF-assumed main activity history ────────────────────────────────────────

export interface CompanyMainActivityHistoryRequest {
  readonly kind?: CompanyMainActivityHistoryKind;
  readonly first?: number;
  readonly after?: string | null;
}

/** A served page with its rows' visibility as served (`null` when nothing was served). */
export type CompanyMainActivityHistoryAnswer = CompanyMainActivityHistoryPage & {
  readonly served: CompanyMainActivityHistoryServed | null;
};

/** The ids and visibility (`<anafWithdrawn>:<onrcWithdrawn>`) of the rows a page serves. */
export interface CompanyMainActivityHistoryServed {
  readonly kind: CompanyMainActivityHistoryKind;
  readonly rows: ReadonlyMap<string, string>;
}

const servedRowsOf = (
  kind: CompanyMainActivityHistoryKind,
  rows: CompanyMainActivityHistoryRows
): CompanyMainActivityHistoryServed => ({
  kind,
  rows: new Map(
    rows.state === 'unavailable'
      ? []
      : kind === 'outcomes'
        ? rows.outcomes.map((o) => [
            o.resolutionId,
            `${String(o.anafWithdrawn)}:${String(o.onrcWithdrawn)}`,
          ])
        : rows.evidence.map((e) => [
            e.supportId,
            `${String(e.anafWithdrawn)}:${String(e.onrcWithdrawn)}`,
          ])
  ),
});

/**
 * Whether the EXACT served rows are still visible as they were served: each
 * row's current ANAF and ONRC withdrawal (an old edition withdrawn, the
 * fiscal row no longer public, the company no longer public) read fresh by
 * id. Rows are append-only, so this is all that can move; a newer row
 * appended meanwhile is not a move of this page.
 */
const historyStillVisible = async (
  repo: CompaniesRepository,
  cui: string,
  served: CompanyMainActivityHistoryServed
): Promise<Result<boolean, ApiError>> => {
  const ids = [...served.rows.keys()];
  if (ids.length === 0) return ok(true);
  const fresh = await repo.readMainActivityHistoryVisibility(cui, served.kind, ids);
  if (fresh.isErr()) return err(fresh.error);
  if (fresh.value === 'unavailable') return ok(false);
  const now = fresh.value;
  return ok(ids.every((id) => now.get(id) === served.rows.get(id)));
};

/**
 * The operation-level decision for a history page ALREADY served: ok while
 * every served row keeps its visibility, else the refusal. No re-read.
 */
export const confirmMainActivityHistoryServed = async (
  repo: CompaniesRepository,
  cui: string,
  served: CompanyMainActivityHistoryServed
): Promise<Result<void, ApiError>> => {
  const still = await historyStillVisible(repo, cui, served);
  if (still.isErr()) return err(still.error);
  return still.value ? ok(undefined) : err(mainActivityMoved());
};

/**
 * Read one history page and settle it: after the read, the exact rows'
 * visibility is read fresh; a withdrawal that landed during the read
 * re-reads the page once, a second move refuses (never a page from before
 * a withdrawal).
 */
const readSettledHistory = async (
  repo: CompaniesRepository,
  cui: string,
  request: { kind: CompanyMainActivityHistoryKind; beforeId: string | null; limit: number }
): Promise<Result<CompanyMainActivityHistoryRows, ApiError>> => {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const rows = await repo.getMainActivityHistory(cui, request);
    if (rows.isErr()) return err(rows.error);
    if (rows.value.state === 'unavailable') return ok(rows.value);
    const still = await historyStillVisible(repo, cui, servedRowsOf(request.kind, rows.value));
    if (still.isErr()) return err(still.error);
    if (still.value) return ok(rows.value);
  }
  return err(mainActivityMoved());
};

/**
 * A bounded, newest-first page of the company's main-activity OUTCOME or
 * EVIDENCE history from the public views, under one pinned registry scope
 * (presence and parent privacy rechecked by `runPinned`). Null when the CUI
 * is not a public directory company. Unreadable views are the typed
 * `unavailable` state. Derivation / source-observation history, never
 * legal effective dates.
 */
export const makeCompanyMainActivityHistory = async (
  deps: Pick<CompanyUsecaseDeps, 'repo'>,
  rawCui: string,
  request: CompanyMainActivityHistoryRequest
): Promise<Result<CompanyMainActivityHistoryAnswer | null, ApiError>> => {
  const cui = normalizeCui(rawCui);
  if (cui === null) return err(invalidCui());
  if (isWithheldCompanyIdentifier(cui)) return err(withheldIdentifier());
  const kind = request.kind ?? 'outcomes';
  const first = request.first ?? MAIN_HISTORY_DEFAULT_PAGE;
  if (!Number.isInteger(first) || first < 1 || first > MAIN_HISTORY_MAX_PAGE) {
    return err({
      type: 'InvalidInput',
      message: `first must be between 1 and ${String(MAIN_HISTORY_MAX_PAGE)}`,
      field: 'first',
    });
  }
  let beforeId: string | null = null;
  if (request.after !== undefined && request.after !== null) {
    beforeId = decodeHistoryCursor(request.after, cui, kind);
    if (beforeId === null) {
      return err({
        type: 'InvalidInput',
        message: 'malformed main-activity history cursor (another company or kind?); restart',
        field: 'after',
      });
    }
  }

  const read = async (
    scope: CompanyRegistryEnvelope
  ): Promise<Result<CompanyMainActivityHistoryAnswer | null, ApiError>> => {
    // Presence by the profile's own public spine seek: never a history of a
    // CUI the directory does not serve.
    const present = await deps.repo.profileSlicesForCuis([cui], scope);
    if (present.isErr()) return err(present.error);
    if (!present.value.has(cui)) return ok(null);
    const rows = await readSettledHistory(deps.repo, cui, {
      kind,
      beforeId,
      limit: first + 1,
    });
    if (rows.isErr()) return err(rows.error);
    const page = rows.value;
    if (page.state === 'unavailable') {
      return ok({
        state: 'unavailable',
        reason: MAIN_ACTIVITY_UNAVAILABLE_REASON,
        kind,
        outcomes: [],
        evidence: [],
        hasNextPage: false,
        endCursor: null,
        registry: scope,
        note: MAIN_HISTORY_NOTE,
        served: null,
      });
    }
    const shown = {
      state: 'read' as const,
      outcomes: page.outcomes.slice(0, first),
      evidence: page.evidence.slice(0, first),
    };
    const outcomes = shown.outcomes.map((o) => gateOutcome(o, scope));
    const evidence = shown.evidence.map((e) => gateEvidenceEntry(e, scope));
    const lastId = kind === 'outcomes' ? outcomes.at(-1)?.resolutionId : evidence.at(-1)?.supportId;
    const hasNextPage = (kind === 'outcomes' ? page.outcomes : page.evidence).length > first;
    return ok({
      state: 'available',
      reason: null,
      kind,
      outcomes,
      evidence,
      hasNextPage,
      endCursor:
        hasNextPage && lastId !== undefined ? encodeHistoryCursor(cui, kind, lastId) : null,
      registry: scope,
      note: MAIN_HISTORY_NOTE,
      // The rows as the view served them: the operation's final decision.
      served: servedRowsOf(kind, shown),
    });
  };
  const pinned = await runPinned(deps.repo, read, (page) => (page === null ? [] : [cui]));
  return pinned.map((p) => p.value);
};

// ── financials (series + latest + trajectory) ─────────────────────────────────

/** A plain decimal as Postgres `numeric::text` writes it; NaN/Infinity/exponents do not match. */
const DECIMAL_TEXT = /^(-?)(\d+)(?:\.(\d+))?$/u;

/** Money keeps two places when the inputs have no more, as the column's 2dp sources do. */
const MIN_MONEY_SCALE = 2;

/**
 * Exact `a − b` over decimal strings of ANY scale. The money columns are
 * unconstrained `numeric`, so a stored third decimal is part of the value: it
 * is neither truncated nor rounded. The result keeps two places for 2dp inputs
 * ('5931214.00') and the larger input scale beyond that ('1.009' − '1.001' =
 * '0.008'). A value that is not a plain decimal (`NaN`, `Infinity`) has no
 * exact difference: null, never a guess and never a throw.
 */
export const exactDecimalDiff = (a: string | null, b: string | null): string | null => {
  if (a === null || b === null) return null;
  const left = DECIMAL_TEXT.exec(a.trim());
  const right = DECIMAL_TEXT.exec(b.trim());
  if (left === null || right === null) return null;
  const leftFrac = left[3] ?? '';
  const rightFrac = right[3] ?? '';
  const scale = Math.max(MIN_MONEY_SCALE, leftFrac.length, rightFrac.length);
  const scaled = (sign: string | undefined, int: string | undefined, frac: string): bigint => {
    const magnitude = BigInt(`${int ?? '0'}${frac.padEnd(scale, '0')}`);
    return sign === '-' ? -magnitude : magnitude;
  };
  const diff = scaled(left[1], left[2], leftFrac) - scaled(right[1], right[2], rightFrac);
  const negative = diff < 0n;
  const digits = (negative ? -diff : diff).toString().padStart(scale + 1, '0');
  const intPart = digits.slice(0, digits.length - scale);
  const fracPart = digits.slice(digits.length - scale);
  return `${negative ? '-' : ''}${intPart}.${fracPart}`;
};

/** A plain integer as Postgres `bigint::text` writes it. */
const INTEGER_TEXT = /^-?\d+$/u;

/** The year's sql-v1 status for one metric; null when not assessed. */
const metricStatus = (
  year: CompanyFinancialYear,
  metric: CompanyFinancialMetric
): CompanyMetricStatus | null =>
  year.qualification.assessment === 'assessed'
    ? (year.qualification.metrics.find((m) => m.metric === metric)?.status ?? null)
    : null;

/**
 * The value a derived figure may use: the original only when the evaluator
 * REPORTED it, and for the net result only the evaluator's own net (never a
 * local profit − loss: a 464d-like profile holds the net while its profit is
 * reported). Null for anything held, missing or unassessed.
 */
export const reportedValue = (
  year: CompanyFinancialYear,
  metric: 'turnover' | 'employees' | 'net_result'
): string | null => {
  if (metricStatus(year, metric) !== 'reported') return null;
  if (metric === 'net_result') return year.qualification.netResult;
  return metric === 'turnover' ? year.turnover : year.employees;
};

/** Two years can be compared only under one policy digest, evaluator and release. */
const sameBasis = (a: CompanyFinancialYear, b: CompanyFinancialYear): boolean =>
  a.qualification.policySha256 === b.qualification.policySha256 &&
  a.qualification.evaluatorVersion === b.qualification.evaluatorVersion &&
  a.qualification.releaseId === b.qualification.releaseId;

const computeTrajectory = (
  years: readonly CompanyFinancialYear[]
): CompanyFinancialTrajectory | null => {
  if (years.length < 2) return null;
  // years arrive DESC; [0] = latest, [1] = prior.
  const latest = years[0];
  const prior = years[1];
  if (latest === undefined || prior === undefined) return null;

  const intDiff = (a: string, b: string): string | null =>
    INTEGER_TEXT.test(a) && INTEGER_TEXT.test(b) ? (BigInt(a) - BigInt(b)).toString() : null;
  // One delta per metric, from REPORTED values of that metric in both years
  // under one basis; a held metric removes only its own delta.
  const delta = (
    metric: 'turnover' | 'employees' | 'net_result',
    diff: (a: string, b: string) => string | null
  ): { value: string | null; reason: string | null } => {
    if (
      latest.qualification.assessment !== 'assessed' ||
      prior.qualification.assessment !== 'assessed'
    ) {
      return { reason: 'not_assessed', value: null };
    }
    if (!sameBasis(latest, prior)) return { reason: 'policy_incompatible', value: null };
    const now = reportedValue(latest, metric);
    if (now === null) return { reason: 'latest_not_reported', value: null };
    const before = reportedValue(prior, metric);
    if (before === null) return { reason: 'prior_not_reported', value: null };
    const value = diff(now, before);
    return value === null ? { reason: 'not_exact', value: null } : { reason: null, value };
  };
  const turnover = delta('turnover', exactDecimalDiff);
  const net = delta('net_result', exactDecimalDiff);
  const employees = delta('employees', intDiff);
  return {
    fromYear: prior.year,
    toYear: latest.year,
    turnoverDelta: turnover.value,
    netResultDelta: net.value,
    employeesDelta: employees.value,
    turnoverDeltaReason: turnover.reason,
    netResultDeltaReason: net.reason,
    employeesDeltaReason: employees.reason,
  };
};

/**
 * Financial statements by CUI (CD-08, user decision 2026-10-03): attributed
 * source observations, NOT company membership. The repo serves public rows
 * whether the CUI has no core organization or a public non-company one, and
 * withholds them only under a known non-public organization. No kind gate.
 *
 * The standard typed history (`years`, `latest`, `trajectory`) is unchanged;
 * long-format-only statements ride alongside as metadata. The answer is null
 * only when BOTH are known to be empty: a CUI with only long-format statements
 * answers `years: []` with them, and an unreadable ledger stays visible as
 * `longFormOnly: null` (unknown), never as "no statement".
 */
export const makeCompanyFinancials = async (
  deps: CompanyUsecaseDeps,
  rawCui: string
): Promise<Result<CompanyFinancials | null, ApiError>> => {
  const cui = normalizeCui(rawCui);
  if (cui === null) return err(invalidCui());
  if (isWithheldCompanyIdentifier(cui)) return err(withheldIdentifier());
  const [res, longForm] = await Promise.all([
    deps.repo.getFinancials(cui),
    deps.repo.getLongFormOnlyStatements(cui),
  ]);
  if (res.isErr()) return err(res.error);
  if (longForm.isErr()) return err(longForm.error);
  const years = res.value;
  const longFormOnly = longForm.value;
  if (years.length === 0 && longFormOnly !== null && longFormOnly.length === 0) return ok(null);
  return ok({
    years,
    latest: years[0] ?? null,
    trajectory: computeTrajectory(years),
    longFormOnly,
  });
};

// ── list (Meili-resolved name path; else filter list) ─────────────────────────

export interface CompanyListResponse {
  readonly rows: readonly CompanyListRow[];
  readonly total: number;
  /** `countCapped || nameCandidateCapped`: `total` may not be the complete match count. */
  readonly totalEstimated: boolean;
  /** The bounded count hit its cap: rows continue past `total`. */
  readonly countCapped: boolean;
  /**
   * `q` reached the name-candidate cap: more companies may match, the list
   * covers only those candidates, and paging cannot reach others — only a
   * refined name can.
   */
  readonly nameCandidateCapped: boolean;
  readonly caveats: readonly string[];
  /** The scope every row and the total were read under (empty pages included). */
  readonly registry: CompanyRegistryEnvelope;
  /** Binds the next page: a different scope refuses it ("restart pagination"). */
  readonly scopeKey: string;
}

interface ListPage {
  readonly rows: readonly CompanyListRow[];
  readonly total: number;
  readonly totalEstimated: boolean;
  readonly countCapped: boolean;
  readonly nameCandidateCapped: boolean;
  readonly caveats: readonly string[];
}

export const makeCompanyList = async (
  deps: CompanyUsecaseDeps,
  args: {
    filter: FilterInput;
    q?: string;
    sort: CompanySort;
    page: OffsetParams;
    /** The scope key of the page this one continues (cursor / MCP binding). */
    expectedScopeKey?: string;
  }
): Promise<Result<CompanyListResponse, ApiError>> => {
  const emptyIn = rejectEmptyIn(args.filter);
  if (emptyIn.isErr()) return err(emptyIn.error);
  // Runs BEFORE normalizeCuiFilter, whose categorical reject stays as the
  // backstop for `eq` / `exclude`. Disclosed as a caveat rather than dropped
  // silently — the caller sent those ids and is owed the accounting.
  const withheld = dropWithheldCuiInclusion(args.filter);
  const baseCaveats: string[] =
    withheld.dropped > 0
      ? [`${String(withheld.dropped)} requested identifier(s) are not served and were omitted`]
      : [];
  if (hasCaenCriterion(args.filter)) baseCaveats.push(CAEN_CLASS_LIST_CAVEAT);
  // Validate BEFORE the emptied shortcut. Returning early on an emptied `in`
  // would skip `normalizeCuiFilter` entirely, so a filter that ALSO carries a
  // withheld `eq` or `exclude` — reachable through MCP, which does not
  // pre-normalize the way the GraphQL resolver does — would get a successful
  // empty page instead of the categorical refusal those branches promise.
  // Same policy on every transport.
  const normFilter = normalizeCuiFilter(withheld.filter);
  if (normFilter.isErr()) return err(normFilter.error);

  // Name resolution and the page read share ONE pinned scope.
  const read = async (scope: CompanyRegistryEnvelope): Promise<Result<ListPage, ApiError>> => {
    // Registry criteria under a non-published scope are refused BEFORE every
    // empty shortcut below (all withheld, no name hit, disjoint CUI sets): a
    // non-published registry never answers them as a successful empty list.
    // Input validation above still runs first.
    const refusal = registryCriteriaRefusal(normFilter.value, args.sort, scope);
    if (refusal !== null) return err(refusal);
    const caveats = [...baseCaveats];
    const empty = (nameCapped: boolean): Result<ListPage, ApiError> =>
      ok({
        rows: [],
        total: 0,
        totalEstimated: nameCapped,
        countCapped: false,
        nameCandidateCapped: nameCapped,
        caveats,
      });
    if (withheld.emptied) return empty(false);
    let filter = normFilter.value;

    // A `q` (name) resolves through Meili first (instant prefix/typo), then the
    // resolved CUI set is ANDed into the filter as `cui.in` (intersecting any
    // existing cui constraint) and the NORMAL `listCompanies` path runs — so the
    // other filters (county/status/…) AND pagination both apply. It never does an
    // in-DB name LIKE on the list path.
    let nameTruncated = false;
    if (args.q !== undefined && args.q.trim() !== '') {
      const resolved = await deps.repo.resolveByName(args.q, NAME_RESOLVE_CAP, deps.meili, scope);
      if (resolved.isErr()) return err(resolved.error);
      // A full-cap return means the name may match MORE companies than were
      // resolved — the list below then covers only the top candidates, so its
      // total must not be presented as exact (defect D6).
      nameTruncated = resolved.value.hits.length >= NAME_RESOLVE_CAP;
      if (nameTruncated) {
        caveats.push(
          `name search reached the ${String(NAME_RESOLVE_CAP)}-candidate cap: more companies may match; results and totals cover only these top candidates — refine the name to change them (filters apply after the cap)`
        );
      }
      const nameCuis = resolved.value.hits
        .map((h) => h.cui)
        .filter((c): c is string => c !== null && !isWithheldCompanyIdentifier(c));
      if (resolved.value.degraded)
        caveats.push(
          'name search degraded (search index unavailable or not current for this registry scope; a bounded fallback answered)'
        );
      if (nameCuis.length === 0) return empty(nameTruncated);
      const existing =
        (filter['cui'] as { in?: readonly string[]; eq?: string } | undefined) ?? undefined;
      const prior = existing?.in ?? (existing?.eq !== undefined ? [existing.eq] : undefined);
      const intersected =
        prior !== undefined ? nameCuis.filter((c) => prior.includes(c)) : nameCuis;
      if (intersected.length === 0) return empty(nameTruncated);
      filter = { ...filter, cui: { in: intersected } };
    }

    const res = await deps.repo.listCompanies(filter, args.sort, args.page, scope);
    if (res.isErr()) return err(res.error);
    // Two different estimates: a capped count means rows continue past
    // `total`; a capped name resolution means `total` is exact for the
    // resolved candidates but other companies may match the name (CQA-17).
    return ok({
      rows: res.value.rows,
      total: res.value.total,
      totalEstimated: res.value.estimated || nameTruncated,
      countCapped: res.value.estimated,
      nameCandidateCapped: nameTruncated,
      caveats,
    });
  };

  const pinned = await runPinned(
    deps.repo,
    read,
    (page) => page.rows.map((r) => r.cui),
    args.expectedScopeKey === undefined ? {} : { expectedKey: args.expectedScopeKey }
  );
  return pinned.map(({ value, scope }) => ({
    ...value,
    registry: scope,
    scopeKey: registryScopeKey(scope),
  }));
};

// ── resolve (name→CUI, regnum→CUIs, caen-label→code, county→canonical) ─────────

export interface CompanyResolveResponse {
  readonly dim: CompanyResolveDim;
  readonly q: string;
  readonly matches: readonly CompanyNameHit[];
  readonly caenMatches: readonly CaenCodeHit[];
  readonly countyMatches: readonly string[];
  readonly ambiguous: boolean;
  readonly degraded: boolean;
  /** The scope name/regnum hits were labelled and validated under; null for catalog dims. */
  readonly registry: CompanyRegistryEnvelope | null;
}

/** Drop resolve hits whose CUI is a withheld identifier (fail-closed output side). */
const dropWithheldHits = (hits: readonly CompanyNameHit[]): readonly CompanyNameHit[] =>
  hits.filter((h) => h.cui === null || !isWithheldCompanyIdentifier(h.cui));

/** `registryScope` is not a scope key this API issued (refused before any read). */
export const RESOLVE_SCOPE_MALFORMED_MESSAGE =
  'registryScope is not a registry scope key issued by this API; pass the scopeKey of a companies response, or omit it';

/** The pinned scope is not the expected one (refused before the resolve read). */
export const RESOLVE_SCOPE_CHANGED_MESSAGE =
  'company registry scope changed (publication, rollback, withdrawal or access) since registryScope was issued; read the current scope and resolve again';

/** CAEN and COUNTY read independent catalogs: there is no registry scope to bind. */
export const RESOLVE_SCOPE_NOT_APPLICABLE_MESSAGE =
  'registryScope applies to NAME and REGNUM only: CAEN and COUNTY are catalog reads with no registry scope';

const resolveScopeRefusal = (message: string): ApiError => ({
  type: 'InvalidInput',
  message,
  field: 'registryScope',
});

export interface CompanyResolveOptions {
  /**
   * The scope key the caller's page is bound to (NAME/REGNUM only). Checked
   * inside the pin before the read: a key this API never issues, or another
   * scope, is refused (`InvalidInput`, field `registryScope`), never re-pinned.
   */
  readonly expectedScopeKey?: string;
}

export const makeCompanyResolve = async (
  deps: CompanyUsecaseDeps,
  dim: CompanyResolveDim,
  q: string,
  limit: number,
  options: CompanyResolveOptions = {}
): Promise<Result<CompanyResolveResponse, ApiError>> => {
  const base = {
    dim,
    q,
    matches: [] as readonly CompanyNameHit[],
    caenMatches: [] as readonly CaenCodeHit[],
    countyMatches: [] as readonly string[],
    degraded: false,
    registry: null,
  };
  // limit ≤ 0 means "no hits" — honor it rather than letting the repo floor it to 1 (M10).
  // NAME/REGNUM answer it inside their pin (scoped, rechecked); catalogs at once.
  const noHits = Math.floor(limit) <= 0;
  const expected = options.expectedScopeKey;
  const hitCuis = (hits: readonly CompanyNameHit[]) =>
    hits.flatMap((h) => (h.cui === null ? [] : [h.cui]));
  /**
   * The NAME/REGNUM read under one pin: the expected scope is compared with
   * the pinned one first (a second attempt after a moved recheck compares the
   * new pin, so a moved scope is refused rather than switched), then the
   * repository is read unless no hit was asked for.
   */
  const pinnedRead = async <T>(
    read: (scope: CompanyRegistryEnvelope) => Promise<Result<T, ApiError>>,
    empty: T,
    cuisOf: (value: T) => readonly string[]
  ): Promise<Result<Pinned<T>, ApiError>> => {
    if (expected !== undefined && scopeFromKey(expected) === null) {
      return err(resolveScopeRefusal(RESOLVE_SCOPE_MALFORMED_MESSAGE));
    }
    return runPinned(
      deps.repo,
      async (scope) => {
        if (expected !== undefined && registryScopeKey(scope) !== expected) {
          return err(resolveScopeRefusal(RESOLVE_SCOPE_CHANGED_MESSAGE));
        }
        return noHits ? ok(empty) : read(scope);
      },
      cuisOf
    );
  };
  const catalogRefusal = (): Result<never, ApiError> | null =>
    expected === undefined ? null : err(resolveScopeRefusal(RESOLVE_SCOPE_NOT_APPLICABLE_MESSAGE));
  switch (dim) {
    case 'name': {
      // Candidates are rehydrated under one pinned scope and rechecked.
      const res = await pinnedRead(
        (scope) => deps.repo.resolveByName(q, limit, deps.meili, scope),
        { hits: [], degraded: false },
        (value) => hitCuis(value.hits)
      );
      if (res.isErr()) return err(res.error);
      const matches = dropWithheldHits(res.value.value.hits);
      return ok({
        ...base,
        matches,
        degraded: res.value.value.degraded,
        ambiguous: matches.length > 1,
        registry: res.value.scope,
      });
    }
    case 'regnum': {
      const res = await pinnedRead(
        (scope) => deps.repo.findByRegistrationNumber(q, scope),
        [] as readonly CompanyNameHit[],
        hitCuis
      );
      if (res.isErr()) return err(res.error);
      const matches = dropWithheldHits(res.value.value);
      return ok({ ...base, matches, ambiguous: matches.length > 1, registry: res.value.scope });
    }
    case 'caen': {
      const refused = catalogRefusal();
      if (refused !== null) return refused;
      if (noHits) return ok({ ...base, ambiguous: false });
      const res = await deps.repo.resolveCaen(q, limit);
      if (res.isErr()) return err(res.error);
      return ok({ ...base, caenMatches: res.value, ambiguous: res.value.length > 1 });
    }
    case 'county': {
      const refused = catalogRefusal();
      if (refused !== null) return refused;
      if (noHits) return ok({ ...base, ambiguous: false });
      const res = await deps.repo.resolveCounty(q);
      if (res.isErr()) return err(res.error);
      return ok({ ...base, countyMatches: res.value, ambiguous: res.value.length > 1 });
    }
    default:
      return err({
        type: 'InvalidInput',
        message: `unknown resolve dim '${String(dim)}'`,
        field: 'dim',
      });
  }
};

/**
 * Flatten a resolve response into the uniform hit shape both surfaces emit. The
 * GraphQL resolver AND the MCP tool call this so the two never structurally drift
 * (audit M14 — MCP's COUNTY dim returned plain strings while every other dim and
 * the whole GraphQL surface returned `{dim,value,label,cui,confidence}`).
 */
export interface CompanyResolveHitOut {
  readonly dim: 'NAME' | 'REGNUM' | 'CAEN' | 'COUNTY';
  /** NAME/REGNUM: the CUI; CAEN: the bare code (broad caenCode); COUNTY: the canonical name. */
  readonly value: string;
  readonly label: string;
  readonly cui: string | null;
  readonly confidence: number | null;
  /** CAEN: the catalog revision (rev0..rev3); null otherwise. */
  readonly revision: string | null;
  /** CAEN: the exact `onrcCaen` selector `<revision>:<code>`; null otherwise. */
  readonly key: string | null;
  /** NAME/REGNUM: onrc_edition | core_organization; CAEN: current_db_catalog; COUNTY: territory_hub. */
  readonly labelSource: string | null;
}

export const toCompanyResolveHits = (res: CompanyResolveResponse): CompanyResolveHitOut[] => {
  switch (res.dim) {
    case 'caen':
      return res.caenMatches.map((c) => ({
        dim: 'CAEN' as const,
        value: c.code,
        // A catalog row without a label shows its composite key, never a bare code alone.
        label: c.label ?? c.key,
        cui: null,
        confidence: null,
        revision: c.rev,
        key: c.key,
        labelSource: c.label === null ? null : 'current_db_catalog',
      }));
    case 'county':
      return res.countyMatches.map((c) => ({
        dim: 'COUNTY' as const,
        value: c,
        label: c,
        cui: null,
        confidence: null,
        revision: null,
        key: null,
        labelSource: 'territory_hub',
      }));
    case 'regnum':
      return res.matches.map((m) => ({
        dim: 'REGNUM' as const,
        value: m.value,
        label: m.label,
        cui: m.cui,
        confidence: m.confidence,
        revision: null,
        key: null,
        labelSource: m.labelSource,
      }));
    case 'name':
    default:
      return res.matches.map((m) => ({
        dim: 'NAME' as const,
        value: m.value,
        label: m.label,
        cui: m.cui,
        confidence: m.confidence,
        revision: null,
        key: null,
        labelSource: m.labelSource,
      }));
  }
};

/**
 * The resolve answer with its metadata, as both surfaces emit it: the hits
 * of `toCompanyResolveHits`, the flags, and the registry scope NAME/REGNUM
 * hits were read and rechecked under (also for zero hits). CAEN and COUNTY
 * read independent catalogs: their registry and scope key are null, never an
 * ONRC provenance for catalog labels.
 */
export interface CompanyResolveResult {
  readonly hits: readonly CompanyResolveHitOut[];
  /**
   * NAME: the search engine was unavailable or its generation was not
   * witnessed current for the pinned scope (a bounded fallback answered);
   * never "zero hits".
   */
  readonly degraded: boolean;
  readonly ambiguous: boolean;
  readonly registry: CompanyRegistryEnvelope | null;
  readonly scopeKey: string | null;
}

export const toCompanyResolveResult = (res: CompanyResolveResponse): CompanyResolveResult => ({
  hits: toCompanyResolveHits(res),
  degraded: res.degraded,
  ambiguous: res.ambiguous,
  registry: res.registry,
  scopeKey: res.registry === null ? null : registryScopeKey(res.registry),
});

// ── aggregate (count-ranked; value-ranked NOT offered §13-R3) ──────────────────

export const makeCompanyCountyProfile = async (
  deps: CompanyUsecaseDeps,
  groupBy: CompanyGroupBy,
  rawFilter: FilterInput
): Promise<Result<CompanyCountyProfile, ApiError>> => {
  const emptyIn = rejectEmptyIn(rawFilter);
  if (emptyIn.isErr()) return err(emptyIn.error);
  const normFilter = normalizeCuiFilter(rawFilter);
  if (normFilter.isErr()) return err(normFilter.error);
  // Aggregates return no CUIs: the recheck is the scope (epochs) alone, and
  // the views check parent privacy at statement time.
  const res = await runPinned(
    deps.repo,
    (scope) => deps.repo.countBy(groupBy, normFilter.value, scope),
    () => []
  );
  if (res.isErr()) return err(res.error);
  return ok({
    groupBy,
    groups: res.value.value.groups,
    denominator: res.value.value.denominator,
    coverage: res.value.value.coverage,
    registry: res.value.scope,
  });
};

// ── hub stats (the cached /companies landing aggregate) ───────────────────────

/** The original ONRC status code the active filter matches (any public observation). */
const STATUS_ACTIVE = '1048';
const TOP_COUNTIES_CAP = 10;

/** Core half of `CompanyHubStats` — everything but the shell-stamped `computedAt`. */
export type CompanyHubStatsData = Omit<CompanyHubStats, 'computedAt'>;

/**
 * Compose the /companies hub aggregate under ONE given scope, SEQUENTIALLY.
 *
 * Sequential is deliberate (audit M7): each leg is a multi-second full-population
 * scan, and firing them concurrently saturates the read pool for every other
 * request — which is why only the cached provider ever calls this.
 *
 * `activeCompanies` is its own count (any public original 1048 on a resolved
 * identifier: the list's `status` filter), never the consensus `1048` bucket
 * of the status mix. Not published → `ServiceUnavailable` (never zeros). The
 * scope is rechecked after the legs; a moved scope is an error (never cached).
 * Fail-fast: the first `err` wins; a partial hub is never returned.
 */
export const makeCompanyHubStats = async (
  deps: Pick<CompanyUsecaseDeps, 'repo'>,
  scope: CompanyRegistryEnvelope
): Promise<Result<CompanyHubStatsData, ApiError>> => {
  if (!isPublished(scope)) return err(registryNotPublished(scope, 'company hub statistics'));
  const res = await runPinned(
    deps.repo,
    async (s) => {
      const filterActive: FilterInput = { status: { eq: STATUS_ACTIVE } };
      // Leg 1 — unfiltered STATUS consensus. Its denominator IS the spine.
      const statusRes = await deps.repo.countBy('status', {}, s);
      if (statusRes.isErr()) return err(statusRes.error);
      // Leg 2 — the ACTIVE population, counted on its own.
      const activeRes = await deps.repo.countCompanies(filterActive, s);
      if (activeRes.isErr()) return err(activeRes.error);
      // Leg 3 — COUNTY consensus over the active population.
      const countyRes = await deps.repo.countBy('county', filterActive, s);
      if (countyRes.isErr()) return err(countyRes.error);
      // Leg 4 — (revision, division) over the active identifiers' observations.
      const caenRes = await deps.repo.countBy('caenDivision', filterActive, s);
      if (caenRes.isErr()) return err(caenRes.error);
      return ok({
        totalCompanies: statusRes.value.denominator,
        activeCompanies: activeRes.value,
        statusMix: statusRes.value.groups,
        // Basis buckets (multiple/partial/missing/unresolved/not_in_edition)
        // are not counties; their mass is in `coverage`.
        topCounties: countyRes.value.groups
          .filter((g) => g.basis === null)
          .slice(0, TOP_COUNTIES_CAP),
        caenDivisions: caenRes.value.groups,
        coverage: countyRes.value.coverage,
      });
    },
    () => [],
    { scope }
  );
  return res.map(({ value, scope: s }) => ({ ...value, registry: s }));
};

// ── registry capabilities (client pinning) ────────────────────────────────────

/**
 * The compact, FRESH registry read a client pins against: envelope, scope
 * key, accessible published editions, the edition-bound filter fields and the
 * known CAEN revisions. Metadata only: never an authorization for cached data.
 */
export const makeCompanyRegistry = async (
  deps: Pick<CompanyUsecaseDeps, 'repo'>
): Promise<Result<CompanyRegistryCapabilities, ApiError>> => {
  const res = await runPinned(
    deps.repo,
    (scope) => deps.repo.publishedEditions(scope),
    () => []
  );
  return res.map(({ value, scope }) => ({
    registry: scope,
    scopeKey: registryScopeKey(scope),
    editions: value,
    registryFilterFields: [...COMPANY_REGISTRY_FILTER_FIELDS],
    caenRevisions: [...ONRC_CAEN_REVISIONS],
  }));
};

// ── contributor (entity-360 presence + slices) ────────────────────────────────

/** Presence for entity-360 badges, pinned and rechecked like the profile. */
export const makeCompanyPresence = async (
  deps: Pick<CompanyUsecaseDeps, 'repo'>,
  rawCui: string
): Promise<
  Result<{ presence: CompanyPresenceCounts | null; registry: CompanyRegistryEnvelope }, ApiError>
> => {
  const cui = normalizeCui(rawCui);
  if (cui === null) return err(invalidCui());
  if (isWithheldCompanyIdentifier(cui)) return err(withheldIdentifier());
  const res = await runPinned(
    deps.repo,
    (scope) => deps.repo.presenceCounts(cui, scope),
    (p) => (p === null ? [] : [p.cui])
  );
  return res.map(({ value, scope }) => ({ presence: value, registry: scope }));
};

/** Entity slices (one batch, one pinned scope, rechecked for every returned CUI). */
export const makeCompanyEntitySlices = async (
  deps: Pick<CompanyUsecaseDeps, 'repo'>,
  cuis: readonly string[]
): Promise<Result<ReadonlyMap<string, CompanyEntitySlice>, ApiError>> => {
  const served = cuis.filter((c) => {
    const n = normalizeCui(c);
    return n !== null && !isWithheldCompanyIdentifier(n);
  });
  if (served.length === 0) return ok(new Map());
  const res = await runPinned(
    deps.repo,
    (scope) => deps.repo.profileSlicesForCuis(served, scope),
    (slices) => [...slices.keys()]
  );
  return res.map(({ value }) => value);
};

export { COMPANY_TERRITORY_COVERAGE_NOTE };
