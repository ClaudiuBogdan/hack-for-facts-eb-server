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
 * Contributor parity (§14.7): the GraphQL `Entity.company` resolver and the REST
 * entity-360 both resolve through `repo.profileSlice` — one path, not two.
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

import { COMPANY_STATUS_NOMENCLATURE } from './filters.js';
import {
  COMPANY_TERRITORY_COVERAGE_NOTE,
  type CaenCodeHit,
  type CompanyCountyProfile,
  type CompanyHubStats,
  type CompanyFinancials,
  type CompanyFinancialTrajectory,
  type CompanyFinancialYear,
  type CompanyGroupBy,
  type CompanyListRow,
  type CompanyNameHit,
  type CompanyProfile,
  type CompanyFinancialQualityFlag,
  type CompanyPublicMoney,
  type CompanyResolveDim,
  type CompanySort,
} from './types.js';

import type { CompaniesRepository, CompanyProfileData } from './ports.js';

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
export const makeCompanyFinancialQualityFlags = async (
  deps: Pick<CompanyUsecaseDeps, 'repo'>,
  rawCui: string
): Promise<Result<readonly CompanyFinancialQualityFlag[], ApiError>> => {
  const cui = normalizeCui(rawCui);
  if (cui === null) return err(invalidCui());
  if (isWithheldCompanyIdentifier(cui)) return err(withheldIdentifier());
  return deps.repo.getFinancialQualityFlags(cui);
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

/**
 * The profile WITHOUT the public-money slice. The GraphQL `company` query returns
 * this (publicMoney is a separate lazy field resolver, §latency); a `null` result
 * means the CUI does not resolve to a company.
 */
export const makeCompanyProfileData = async (
  deps: Pick<CompanyUsecaseDeps, 'repo'>,
  rawCui: string
): Promise<Result<CompanyProfileData | null, ApiError>> => {
  const cui = normalizeCui(rawCui);
  if (cui === null) return err(invalidCui());
  if (isWithheldCompanyIdentifier(cui)) return err(withheldIdentifier());
  return deps.repo.getProfileData(cui);
};

/**
 * The FULL eager profile (data + public money). Used by the MCP snapshot, which
 * returns the whole thing in one call. The GraphQL path uses
 * `makeCompanyProfileData` + the lazy `makeCompanyPublicMoney` field instead.
 */
export const makeCompanyProfile = async (
  deps: CompanyUsecaseDeps,
  rawCui: string
): Promise<Result<CompanyProfile | null, ApiError>> => {
  const cui = normalizeCui(rawCui);
  if (cui === null) return err(invalidCui());
  if (isWithheldCompanyIdentifier(cui)) return err(withheldIdentifier());

  const dataRes = await deps.repo.getProfileData(cui);
  if (dataRes.isErr()) return err(dataRes.error);
  if (dataRes.value === null) return ok(null);

  const pmRes = await buildPublicMoney(deps.flowsRepo, cui);
  if (pmRes.isErr()) return err(pmRes.error);

  return ok({ ...dataRes.value, publicMoney: pmRes.value });
};

// ── financials (series + latest + trajectory) ─────────────────────────────────

const computeTrajectory = (
  years: readonly CompanyFinancialYear[]
): CompanyFinancialTrajectory | null => {
  if (years.length < 2) return null;
  // years arrive DESC; [0] = latest, [1] = prior.
  const latest = years[0];
  const prior = years[1];
  if (latest === undefined || prior === undefined) return null;

  // Exact decimal subtraction (numeric(18,2)) without a float: scale to 2dp ints.
  const scaleTo2dp = (s: string): bigint => {
    const neg = s.startsWith('-');
    const [intPart = '0', fracRaw = ''] = s.replace(/^-/u, '').split('.');
    const frac = (fracRaw + '00').slice(0, 2); // always exactly 2 digits
    const v = BigInt(intPart) * 100n + BigInt(frac);
    return neg ? -v : v;
  };
  const decDiff = (a: string | null, b: string | null): string | null => {
    if (a === null || b === null) return null;
    const d = scaleTo2dp(a) - scaleTo2dp(b);
    const neg = d < 0n;
    const abs = neg ? -d : d;
    const frac = (abs % 100n).toString().padStart(2, '0');
    return `${neg ? '-' : ''}${(abs / 100n).toString()}.${frac}`;
  };
  const intDiff = (a: string | null, b: string | null): string | null =>
    a === null || b === null ? null : (BigInt(a) - BigInt(b)).toString();
  // Net result = profit − loss. ANAF stores `net_profit = 0` (NOT null) in a loss
  // year, so `netProfit ?? -netLoss` returned 0 and the delta dropped the loss
  // entirely (audit H1: 951,172 / 951,194 loss rows carry net_profit = 0). Subtract
  // explicitly, treating a missing side as 0; null only when BOTH sides are absent.
  const netResult = (y: CompanyFinancialYear): string | null =>
    y.netProfit === null && y.netLoss === null
      ? null
      : decDiff(y.netProfit ?? '0', y.netLoss ?? '0');
  return {
    fromYear: prior.year,
    toYear: latest.year,
    turnoverDelta: decDiff(latest.turnover, prior.turnover),
    netResultDelta: decDiff(netResult(latest), netResult(prior)),
    employeesDelta: intDiff(latest.employees, prior.employees),
  };
};

export const makeCompanyFinancials = async (
  deps: CompanyUsecaseDeps,
  rawCui: string
): Promise<Result<CompanyFinancials | null, ApiError>> => {
  const cui = normalizeCui(rawCui);
  if (cui === null) return err(invalidCui());
  if (isWithheldCompanyIdentifier(cui)) return err(withheldIdentifier());
  const res = await deps.repo.getFinancials(cui);
  if (res.isErr()) return err(res.error);
  const years = res.value;
  if (years.length === 0) return ok(null);
  return ok({ years, latest: years[0] ?? null, trajectory: computeTrajectory(years) });
};

// ── list (Meili-resolved name path; else filter list) ─────────────────────────

export interface CompanyListResponse {
  readonly rows: readonly CompanyListRow[];
  readonly total: number;
  readonly totalEstimated: boolean;
  readonly caveats: readonly string[];
}

export const makeCompanyList = async (
  deps: CompanyUsecaseDeps,
  args: {
    filter: FilterInput;
    q?: string;
    sort: CompanySort;
    page: OffsetParams;
  }
): Promise<Result<CompanyListResponse, ApiError>> => {
  const emptyIn = rejectEmptyIn(args.filter);
  if (emptyIn.isErr()) return err(emptyIn.error);
  // Runs BEFORE normalizeCuiFilter, whose categorical reject stays as the
  // backstop for `eq` / `exclude`. Disclosed as a caveat rather than dropped
  // silently — the caller sent those ids and is owed the accounting.
  const withheld = dropWithheldCuiInclusion(args.filter);
  const caveats: string[] =
    withheld.dropped > 0
      ? [`${String(withheld.dropped)} requested identifier(s) are not served and were omitted`]
      : [];
  // Validate BEFORE the emptied shortcut. Returning early on an emptied `in`
  // would skip `normalizeCuiFilter` entirely, so a filter that ALSO carries a
  // withheld `eq` or `exclude` — reachable through MCP, which does not
  // pre-normalize the way the GraphQL resolver does — would get a successful
  // empty page instead of the categorical refusal those branches promise.
  // Same policy on every transport.
  const normFilter = normalizeCuiFilter(withheld.filter);
  if (normFilter.isErr()) return err(normFilter.error);
  if (withheld.emptied) return ok({ rows: [], total: 0, totalEstimated: false, caveats });
  let filter = normFilter.value;

  // A `q` (name) resolves through Meili first (instant prefix/typo), then the
  // resolved CUI set is ANDed into the filter as `cui.in` (intersecting any
  // existing cui constraint) and the NORMAL `listCompanies` path runs — so the
  // other filters (county/status/…) AND pagination both apply. It never does an
  // in-DB name LIKE on the list path.
  let nameTruncated = false;
  if (args.q !== undefined && args.q.trim() !== '') {
    const resolved = await deps.repo.resolveByName(args.q, NAME_RESOLVE_CAP, deps.meili);
    if (resolved.isErr()) return err(resolved.error);
    // A full-cap return means the name may match MORE companies than were
    // resolved — the list below then covers only the top candidates, so its
    // total must not be presented as exact (defect D6).
    nameTruncated = resolved.value.hits.length >= NAME_RESOLVE_CAP;
    if (nameTruncated) {
      caveats.push(
        `name matched more companies than the ${String(NAME_RESOLVE_CAP)}-candidate cap; results and totals cover only the top candidates — refine the name or add filters`
      );
    }
    const nameCuis = resolved.value.hits
      .map((h) => h.cui)
      .filter((c): c is string => c !== null && !isWithheldCompanyIdentifier(c));
    if (resolved.value.degraded) caveats.push('name search degraded (search service unavailable)');
    if (nameCuis.length === 0) {
      return ok({ rows: [], total: 0, totalEstimated: nameTruncated, caveats });
    }
    const existing =
      (filter['cui'] as { in?: readonly string[]; eq?: string } | undefined) ?? undefined;
    const prior = existing?.in ?? (existing?.eq !== undefined ? [existing.eq] : undefined);
    const intersected = prior !== undefined ? nameCuis.filter((c) => prior.includes(c)) : nameCuis;
    if (intersected.length === 0) {
      return ok({ rows: [], total: 0, totalEstimated: nameTruncated, caveats });
    }
    filter = { ...filter, cui: { in: intersected } };
  }

  const res = await deps.repo.listCompanies(filter, args.sort, args.page);
  if (res.isErr()) return err(res.error);
  return ok({
    rows: res.value.rows,
    total: res.value.total,
    totalEstimated: res.value.estimated || nameTruncated,
    caveats,
  });
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
}

/** Drop resolve hits whose CUI is a withheld identifier (fail-closed output side). */
const dropWithheldHits = (hits: readonly CompanyNameHit[]): readonly CompanyNameHit[] =>
  hits.filter((h) => h.cui === null || !isWithheldCompanyIdentifier(h.cui));

export const makeCompanyResolve = async (
  deps: CompanyUsecaseDeps,
  dim: CompanyResolveDim,
  q: string,
  limit: number
): Promise<Result<CompanyResolveResponse, ApiError>> => {
  const base = {
    dim,
    q,
    matches: [] as readonly CompanyNameHit[],
    caenMatches: [] as readonly CaenCodeHit[],
    countyMatches: [] as readonly string[],
    degraded: false,
  };
  // limit ≤ 0 means "no hits" — honor it rather than letting the repo floor it to 1 (M10).
  if (Math.floor(limit) <= 0) return ok({ ...base, ambiguous: false });
  switch (dim) {
    case 'name': {
      const res = await deps.repo.resolveByName(q, limit, deps.meili);
      if (res.isErr()) return err(res.error);
      const matches = dropWithheldHits(res.value.hits);
      return ok({
        ...base,
        matches,
        degraded: res.value.degraded,
        ambiguous: matches.length > 1,
      });
    }
    case 'regnum': {
      const res = await deps.repo.findByRegistrationNumber(q);
      if (res.isErr()) return err(res.error);
      const matches = dropWithheldHits(res.value);
      return ok({ ...base, matches, ambiguous: matches.length > 1 });
    }
    case 'caen': {
      const res = await deps.repo.resolveCaen(q, limit);
      if (res.isErr()) return err(res.error);
      return ok({ ...base, caenMatches: res.value, ambiguous: res.value.length > 1 });
    }
    case 'county': {
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
  readonly value: string;
  readonly label: string;
  readonly cui: string | null;
  readonly confidence: number | null;
}

export const toCompanyResolveHits = (res: CompanyResolveResponse): CompanyResolveHitOut[] => {
  switch (res.dim) {
    case 'caen':
      return res.caenMatches.map((c) => ({
        dim: 'CAEN' as const,
        value: c.code,
        label: c.label ?? c.code,
        cui: null,
        confidence: null,
      }));
    case 'county':
      return res.countyMatches.map((c) => ({
        dim: 'COUNTY' as const,
        value: c,
        label: c,
        cui: null,
        confidence: null,
      }));
    case 'regnum':
      return res.matches.map((m) => ({
        dim: 'REGNUM' as const,
        value: m.value,
        label: m.label,
        cui: m.cui,
        confidence: m.confidence,
      }));
    case 'name':
    default:
      return res.matches.map((m) => ({
        dim: 'NAME' as const,
        value: m.value,
        label: m.label,
        cui: m.cui,
        confidence: m.confidence,
      }));
  }
};

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
  const res = await deps.repo.countBy(groupBy, normFilter.value);
  if (res.isErr()) return err(res.error);
  return ok({
    groupBy,
    groups: res.value.groups,
    denominator: res.value.denominator,
    coverage: res.value.coverage,
  });
};

// ── hub stats (the cached /companies landing aggregate) ───────────────────────

/** ONRC lifecycle status meaning "in operation". The hub's `activeCompanies`. */
const STATUS_ACTIVE = '1048';
/** The repo's placeholder key for a NULL group value. Not a real county. */
const GROUP_KEY_NONE = '(none)';
const TOP_COUNTIES_CAP = 10;

/** Core half of `CompanyHubStats` — everything but the shell-stamped `computedAt`. */
export type CompanyHubStatsData = Omit<CompanyHubStats, 'computedAt'>;

/**
 * Compose the /companies hub aggregate from three `countBy` legs, SEQUENTIALLY.
 *
 * Sequential is deliberate (audit M7): each leg is a multi-second full-population
 * scan, and firing them concurrently saturates the read pool for every other
 * request. Total ≈30s — which is why only the cached provider ever calls this.
 *
 * Fail-fast: the first `err` wins; a partial hub is never returned (and never
 * cached).
 */
export const makeCompanyHubStats = async (
  deps: Pick<CompanyUsecaseDeps, 'repo'>
): Promise<Result<CompanyHubStatsData, ApiError>> => {
  const filterActive: FilterInput = { status: { eq: STATUS_ACTIVE } };
  // Leg 1 — unfiltered STATUS. Legal without a driving predicate: the repo's
  // aggregate gate applies to `groupBy=county` only. Its denominator IS the spine.
  const statusRes = await deps.repo.countBy('status', {});
  if (statusRes.isErr()) return err(statusRes.error);

  // Leg 2 — COUNTY over the active population (`status` is a driving field).
  const countyRes = await deps.repo.countBy('county', filterActive);
  if (countyRes.isErr()) return err(countyRes.error);

  // Leg 3 — CAEN_DIVISION over the active population. The 23.6s leg.
  const caenRes = await deps.repo.countBy('caenDivision', filterActive);
  if (caenRes.isErr()) return err(caenRes.error);

  const statusMix = statusRes.value.groups.map((g) => ({
    key: g.key,
    // The registry label is authoritative; the nomenclature is the fallback for
    // codes whose `onrc_lifecycle_status_label` is NULL in the source rows.
    label: g.label ?? COMPANY_STATUS_NOMENCLATURE[g.key] ?? null,
    count: g.count,
  }));
  const active = statusMix.find((g) => g.key === STATUS_ACTIVE);

  const topCounties = countyRes.value.groups
    .filter((g) => g.key !== GROUP_KEY_NONE)
    .slice(0, TOP_COUNTIES_CAP);

  // 239,950 `caen_profile` rows carry an EMPTY caen_code, so the repo's
  // `left(caen_code, 2)` yields a '' key. An empty string is not a division —
  // drop it, exactly as `(none)` is dropped from topCounties.
  const caenDivisions = caenRes.value.groups.filter((g) => g.key.trim() !== '');

  return ok({
    totalCompanies: statusRes.value.denominator,
    activeCompanies: active?.count ?? 0,
    statusMix,
    topCounties,
    caenDivisions,
    // The county leg's coverage: it describes the ACTIVE population that
    // `topCounties` ranks. (The caenDivision leg reports null coverage by design.)
    coverage: countyRes.value.coverage,
  });
};

export { COMPANY_TERRITORY_COVERAGE_NOTE };
