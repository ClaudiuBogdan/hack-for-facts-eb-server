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

import { normalizeCui,
  type ApiError,
  type Counterparty,
  type FilterInput,
  type FlowsRepo,
  type FlowSummary,
  type MeiliClient,
  type OffsetParams } from '@/modules/shared/index.js';

import { COMPANY_TERRITORY_COVERAGE_NOTE,
  type CaenCodeHit,
  type CompanyCountyProfile,
  type CompanyFinancials,
  type CompanyFinancialTrajectory,
  type CompanyFinancialYear,
  type CompanyGroupBy,
  type CompanyListRow,
  type CompanyNameHit,
  type CompanyProfile,
  type CompanyPublicMoney,
  type CompanyResolveDim,
  type CompanySort } from './types.js';

import type { CompaniesRepository, CompanyProfileData } from './ports.js';

const TOP_PAYERS_CAP = 50;
/** Cap on name-resolved CUIs ANDed into a `q` list (keeps the `cui IN (…)` bounded). */
const NAME_RESOLVE_CAP = 100;

export interface CompanyUsecaseDeps {
  readonly repo: CompaniesRepository;
  readonly flowsRepo: FlowsRepo;
  readonly meili: MeiliClient | null;
}

const invalidCui = (): ApiError => ({ type: 'InvalidInput', message: 'invalid CUI format', field: 'cui' });

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
      out['eq'] = c;
    }
    if (Array.isArray(out['in'])) {
      const norm: string[] = [];
      for (const v of out['in'] as unknown[]) {
        const c = normalizeCui(String(v));
        if (c === null) return err(invalidCui());
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
  if (exclude !== undefined && typeof exclude === 'object' && (exclude as Record<string, unknown>)['cui'] !== undefined) {
    const r = normField((exclude as Record<string, unknown>)['cui']);
    if (r.isErr()) return err(r.error);
    result['exclude'] = { ...(exclude as Record<string, unknown>), cui: r.value };
  }
  return ok(result as FilterInput);
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
  return buildPublicMoney(deps.flowsRepo, cui);
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
  return ok({ totalRon: summary.totalAmountRon, flowCount: summary.count, byYear, byFlowType, topPayers });
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
    y.netProfit === null && y.netLoss === null ? null : decDiff(y.netProfit ?? '0', y.netLoss ?? '0');
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
  const normFilter = normalizeCuiFilter(args.filter);
  if (normFilter.isErr()) return err(normFilter.error);
  let filter = normFilter.value;
  const caveats: string[] = [];

  // A `q` (name) resolves through Meili first (instant prefix/typo), then the
  // resolved CUI set is ANDed into the filter as `cui.in` (intersecting any
  // existing cui constraint) and the NORMAL `listCompanies` path runs — so the
  // other filters (county/status/…) AND pagination both apply. It never does an
  // in-DB name LIKE on the list path.
  if (args.q !== undefined && args.q.trim() !== '') {
    const resolved = await deps.repo.resolveByName(args.q, NAME_RESOLVE_CAP, deps.meili);
    if (resolved.isErr()) return err(resolved.error);
    const nameCuis = resolved.value.hits.map((h) => h.cui).filter((c): c is string => c !== null);
    if (resolved.value.degraded) caveats.push('name search degraded (search service unavailable)');
    if (nameCuis.length === 0) {
      return ok({ rows: [], total: 0, totalEstimated: false, caveats });
    }
    const existing = (filter['cui'] as { in?: readonly string[]; eq?: string } | undefined) ?? undefined;
    const prior = existing?.in ?? (existing?.eq !== undefined ? [existing.eq] : undefined);
    const intersected = prior !== undefined ? nameCuis.filter((c) => prior.includes(c)) : nameCuis;
    if (intersected.length === 0) {
      return ok({ rows: [], total: 0, totalEstimated: false, caveats });
    }
    filter = { ...filter, cui: { in: intersected } };
  }

  const res = await deps.repo.listCompanies(filter, args.sort, args.page);
  if (res.isErr()) return err(res.error);
  return ok({
    rows: res.value.rows,
    total: res.value.total,
    totalEstimated: res.value.estimated,
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

export const makeCompanyResolve = async (
  deps: CompanyUsecaseDeps,
  dim: CompanyResolveDim,
  q: string,
  limit: number
): Promise<Result<CompanyResolveResponse, ApiError>> => {
  const base = { dim, q, matches: [] as readonly CompanyNameHit[], caenMatches: [] as readonly CaenCodeHit[], countyMatches: [] as readonly string[], degraded: false };
  // limit ≤ 0 means "no hits" — honor it rather than letting the repo floor it to 1 (M10).
  if (Math.floor(limit) <= 0) return ok({ ...base, ambiguous: false });
  switch (dim) {
    case 'name': {
      const res = await deps.repo.resolveByName(q, limit, deps.meili);
      if (res.isErr()) return err(res.error);
      return ok({ ...base, matches: res.value.hits, degraded: res.value.degraded, ambiguous: res.value.hits.length > 1 });
    }
    case 'regnum': {
      const res = await deps.repo.findByRegistrationNumber(q);
      if (res.isErr()) return err(res.error);
      return ok({ ...base, matches: res.value, ambiguous: res.value.length > 1 });
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
      return err({ type: 'InvalidInput', message: `unknown resolve dim '${String(dim)}'`, field: 'dim' });
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
      return res.caenMatches.map((c) => ({ dim: 'CAEN' as const, value: c.code, label: c.label ?? c.code, cui: null, confidence: null }));
    case 'county':
      return res.countyMatches.map((c) => ({ dim: 'COUNTY' as const, value: c, label: c, cui: null, confidence: null }));
    case 'regnum':
      return res.matches.map((m) => ({ dim: 'REGNUM' as const, value: m.value, label: m.label, cui: m.cui, confidence: m.confidence }));
    case 'name':
    default:
      return res.matches.map((m) => ({ dim: 'NAME' as const, value: m.value, label: m.label, cui: m.cui, confidence: m.confidence }));
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

export { COMPANY_TERRITORY_COVERAGE_NOTE };
