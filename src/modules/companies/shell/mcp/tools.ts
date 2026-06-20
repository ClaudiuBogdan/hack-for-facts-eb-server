/**
 * Companies module — MCP tools (plan §8). Each tool → the SAME usecase the GraphQL
 * resolver calls; output is the kernel `{ ok, kind, query?, link?, item|items?,
 * summary? }` object. Bounded results; the as-of watermark + coverage ride in the
 * output where a count/aggregate is returned. Naming `<verb>_company_<noun>`.
 *
 * The discovery tool `resolve_company_filter` is the §7.4 name→value resolver
 * (name→CUI via Meili, regnum→CUI list two-hop, caen-label→code, county→canonical)
 * — agents call it BEFORE the query tools (catalog Entity Resolution Gate).
 */

import { z } from 'zod';

import { normalizeOffset, type FilterInput, type KernelMcpTool, type McpToolOutput  } from '@/modules/shared/index.js';

import {
  COMPANY_RESOLVE_DIMS,
  COMPANY_SORTS,
  type CompanyGroupBy,
  type CompanyResolveDim,
  type CompanySort,
} from '../../core/types.js';
import {
  makeCompanyCountyProfile,
  makeCompanyFinancials,
  makeCompanyList,
  makeCompanyProfile,
  makeCompanyResolve,
  toCompanyResolveHits,
  type CompanyUsecaseDeps,
} from '../../core/usecases.js';


export interface CompaniesMcpDeps extends CompanyUsecaseDeps {
  readonly clientBaseUrl: string;
}

const strArg = (args: Record<string, unknown>, key: string): string => {
  const v = args[key];
  return typeof v === 'string' ? v : '';
};

const intArg = (args: Record<string, unknown>, key: string, dflt: number): number => {
  const v = args[key];
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? Math.floor(n) : dflt;
};

const filterArg = (args: Record<string, unknown>): FilterInput => {
  const v = args['filter'];
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as FilterInput) : {};
};

const errorOut = (kind: string, message: string): McpToolOutput => ({ ok: false, kind, error: message });
const n = (x: number): string => String(x);

/**
 * Present territory with the SAME matchConfidence casing the GraphQL enum
 * serializes (SAFE/UNMATCHED) so an agent sees one value across both surfaces
 * (audit M13 — MCP emitted the lowercase domain value 'safe' while GraphQL emitted
 * the enum name 'SAFE').
 */
const mcpTerritory = (t: { matchConfidence: 'safe' | 'unmatched' } | null): unknown =>
  t === null ? null : { ...t, matchConfidence: t.matchConfidence.toUpperCase() };

export const makeCompaniesMcpTools = (deps: CompaniesMcpDeps): readonly KernelMcpTool[] => {
  const { clientBaseUrl } = deps;
  const companyLink = (cui: string): string => `${clientBaseUrl}/companii/${cui}`;

  const resolveFilter: KernelMcpTool = {
    name: 'resolve_company_filter',
    description:
      'Resolve a free-text company query to a filter value: company name → CUI (Meili-primary), registration number (J##/####/####) → CUI list (one-to-many possible), CAEN label → code, county name → canonical county. Use BEFORE the other company tools.',
    inputShape: {
      dim: z.enum(['name', 'regnum', 'caen', 'county']).describe('Which dimension to resolve.'),
      q: z.string().describe('The free-text query (name, registration number, CAEN label, or county).'),
      limit: z.number().int().min(0).max(50).optional().describe('Max hits (default 10; 0 = no hits).'),
    },
    async handler(args): Promise<McpToolOutput> {
      const dim = strArg(args, 'dim') as CompanyResolveDim;
      if (!COMPANY_RESOLVE_DIMS.includes(dim)) return errorOut('resolution', `unknown dim '${dim}'`);
      const q = strArg(args, 'q');
      const res = await makeCompanyResolve(deps, dim, q, intArg(args, 'limit', 10));
      if (res.isErr()) return errorOut('resolution', res.error.message);
      const r = res.value;
      // Shared mapper — items are structurally identical to GraphQL on every dim,
      // incl. county (audit M14 — county previously returned plain strings here).
      const hits = toCompanyResolveHits(r);
      const top = r.matches[0];
      const summary =
        top !== undefined && (dim === 'name' || dim === 'regnum')
          ? `Resolved "${q}" to CUI ${top.cui ?? top.value} (${top.label}).`
          : `Found ${n(hits.length)} match(es) for "${q}" as ${dim}.`;
      return {
        ok: true,
        kind: 'resolution',
        query: { dim, q },
        items: hits,
        meta: { count: hits.length, degraded: r.degraded },
        summary: r.degraded ? `${summary} (name search degraded — search service unavailable)` : summary,
      };
    },
  };

  const getSnapshot: KernelMcpTool = {
    name: 'get_company_snapshot',
    description:
      'Compact profile for a company by CUI: headline status, fiscal flags, latest financial year, territory, and total public money received (as a payee). For the full financial series use get_company_financials.',
    inputShape: { cui: z.string().describe('The company CUI/CIF (digits only).') },
    async handler(args): Promise<McpToolOutput> {
      const cui = strArg(args, 'cui');
      const res = await makeCompanyProfile(deps, cui);
      if (res.isErr()) return errorOut('company', res.error.message);
      const p = res.value;
      if (p === null) return { ok: true, kind: 'company', query: { cui }, summary: `No company for CUI ${cui}.` };
      const latest = p.financials[0];
      const pm = p.publicMoney;
      const summary =
        `${p.name} (CUI ${p.cui})` +
        (p.address.county !== null ? `, ${p.address.county}` : '') +
        (p.headlineStatus !== null ? `, status ${p.headlineStatus.label}` : '') +
        (p.fiscal?.vatPayer === true ? ', VAT payer' : '') +
        (latest !== undefined ? `; ${String(latest.year)} turnover ${latest.turnover ?? 'n/a'} RON, ${latest.employees ?? 'n/a'} employees` : '') +
        `; received ${pm?.totalRon ?? '0'} RON public money.`;
      return {
        ok: true,
        kind: 'company',
        query: { cui },
        link: companyLink(p.cui),
        item: {
          cui: p.cui,
          name: p.name,
          legalForm: p.legalForm,
          headlineStatus: p.headlineStatus,
          fiscal: p.fiscal,
          territory: mcpTerritory(p.territory),
          latestFinancial: latest ?? null,
          publicMoney: pm,
          asOf: p.asOf,
        },
        summary,
      };
    },
  };

  const getFinancials: KernelMcpTool = {
    name: 'get_company_financials',
    description:
      'Financial-statement (bilanț) year series for a company by CUI, plus computed latest year and a latest-vs-prior trajectory. Values are exact decimal strings; employees is a bigint string.',
    inputShape: { cui: z.string().describe('The company CUI/CIF (digits only).') },
    async handler(args): Promise<McpToolOutput> {
      const cui = strArg(args, 'cui');
      const res = await makeCompanyFinancials(deps, cui);
      if (res.isErr()) return errorOut('financials', res.error.message);
      const f = res.value;
      if (f === null) return { ok: true, kind: 'financials', query: { cui }, summary: `No financials for CUI ${cui}.` };
      return {
        ok: true,
        kind: 'financials',
        query: { cui },
        link: companyLink(cui),
        item: f,
        summary: `${n(f.years.length)} financial year(s) for CUI ${cui}` + (f.latest !== null ? `; latest ${String(f.latest.year)} turnover ${f.latest.turnover ?? 'n/a'} RON.` : '.'),
      };
    },
  };

  const listCompanies: KernelMcpTool = {
    name: 'list_companies',
    description:
      'Filterable company list (bounded). Filter by cui/county/status/caenCode/legalForm/vatPayer/declaredFiscallyInactive/registrationDate; optional q (company name, Meili-primary). Sort by name/registrationDate/cui. Returns rows + bounded total (≤10,000; totalEstimated flags the cap). Resolve names→CUIs with resolve_company_filter first (Entity Resolution Gate).',
    inputShape: {
      filter: z.record(z.string(), z.unknown()).optional().describe('A companies filter object (e.g. { county: { in: ["Cluj"] }, status: { in: ["1084"] } }).'),
      q: z.string().optional().describe('Company-name search (Meili-primary; degrades to a capped pg scan).'),
      sort: z.enum(['name', 'registrationDate', 'cui']).optional().describe('Sort key (default name). Value sorts (turnover/employees) are not offered.'),
      page: z.number().int().min(1).optional().describe('1-based page (default 1).'),
      pageSize: z.number().int().min(1).max(100).optional().describe('Page size (default 20, max 100).'),
    },
    async handler(args): Promise<McpToolOutput> {
      const sortRaw = strArg(args, 'sort');
      const sort: CompanySort = (COMPANY_SORTS as readonly string[]).includes(sortRaw)
        ? (sortRaw as CompanySort)
        : 'name';
      const page = normalizeOffset(intArg(args, 'page', 1), intArg(args, 'pageSize', 20));
      const q = strArg(args, 'q');
      const res = await makeCompanyList(deps, {
        filter: filterArg(args),
        ...(q !== '' && { q }),
        sort,
        page,
      });
      if (res.isErr()) return errorOut('list', res.error.message);
      const { rows, total, totalEstimated, caveats } = res.value;
      return {
        ok: true,
        kind: 'list',
        query: { filter: filterArg(args), sort, page: page.page, pageSize: page.pageSize },
        link: `${clientBaseUrl}/companii`,
        items: rows,
        // Structured totals so an agent can tell a capped estimate (≥10,000) from an
        // exact count without parsing the summary text (audit H6).
        meta: { totalCount: total, totalEstimated, pageCount: rows.length, ...(caveats.length > 0 && { caveats }) },
        summary:
          `${n(rows.length)} company(ies) on page ${n(page.page)}` +
          `; ${totalEstimated ? '≥' : ''}${n(total)} match(es)` +
          (caveats.length > 0 ? `. ${caveats.join('; ')}.` : '.'),
      };
    },
  };

  const countyProfile: KernelMcpTool = {
    name: 'company_county_profile',
    description:
      'Count-ranked company aggregate grouped by county, status, or CAEN division, with a denominator and coverage block. Value-weighted ("biggest by turnover") rankings are NOT offered — no financials rank index/rollup exists (count-only).',
    inputShape: {
      filter: z.record(z.string(), z.unknown()).optional().describe('A companies filter object (e.g. { county: { in: ["Cluj"] } }).'),
      groupBy: z.enum(['county', 'status', 'caenDivision']).describe('Grouping dimension. county requires a selective filter.'),
    },
    async handler(args): Promise<McpToolOutput> {
      const groupBy = strArg(args, 'groupBy') as CompanyGroupBy;
      const res = await makeCompanyCountyProfile(deps, groupBy, filterArg(args));
      if (res.isErr()) return errorOut('aggregate', res.error.message);
      const top = res.value.groups[0];
      return {
        ok: true,
        kind: 'aggregate',
        query: { groupBy, filter: filterArg(args) },
        link: `${clientBaseUrl}/companii`,
        items: res.value.groups,
        // Structured denominator + territory coverage (audit H6 — were summary-only).
        meta: { denominator: res.value.denominator, groupCount: res.value.groups.length, coverage: res.value.coverage },
        summary:
          `${n(res.value.groups.length)} ${groupBy} group(s); ${n(res.value.denominator)} companies` +
          (top !== undefined ? `; top ${top.label ?? top.key} = ${n(top.count)}. ${res.value.coverage.note}` : `. ${res.value.coverage.note}`),
      };
    },
  };

  return [resolveFilter, getSnapshot, listCompanies, getFinancials, countyProfile];
};
