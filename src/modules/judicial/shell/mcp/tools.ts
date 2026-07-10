/**
 * Judicial module — MCP tools (plan 08 §8). Each tool → the SAME usecase the
 * GraphQL resolver calls; output is the kernel `{ ok, kind, query?, link?,
 * item|items?, summary? }` object. Two families: discovery
 * (`resolve_judicial_filters`) + query.
 *
 * PRIVACY: every `item`/`items` here is a TYPED view model from the usecase layer
 * (JudicialCaseDetail / JudicialCompanyLitigation / JudicialLegalRef / aggregate
 * rows / ResolveHit) — NEVER a raw DB row. None carries a name beyond gated
 * company/public names. No tool returns party rows; person/unknown parties surface
 * ONLY as `personPartyCount` inside `get_judicial_case`. The leak audit (§12)
 * covers the MCP outputs.
 */

import {
  JUDICIAL_MCP_KINDS,
  getCaseLegalReferencesInput,
  getCompanyLitigationInput,
  getCourtCaseloadInput,
  getJudicialCaseInput,
  resolveJudicialFiltersInput,
} from './io.js';
import {
  getCaseDetail,
  getCaseLegalRefs,
  getCompanyLitigation,
  getCourtCaseload,
  resolveJudicialFilters,
  type JudicialRepos,
} from '../../core/usecases.js';

import type { CompanyLitigationFilter } from '../../core/ports.js';
import type { JudicialResolveDim } from '../../core/types.js';
import type { FilterInput, KernelMcpTool, McpToolOutput } from '@/modules/shared/index.js';

export interface JudicialMcpDeps {
  readonly repos: JudicialRepos;
  readonly clientBaseUrl: string;
}

const str = (args: Record<string, unknown>, key: string): string | undefined => {
  const v = args[key];
  return typeof v === 'string' && v !== '' ? v : undefined;
};
const intArg = (args: Record<string, unknown>, key: string): number | undefined => {
  const v = args[key];
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? Math.floor(n) : undefined;
};
const strArray = (args: Record<string, unknown>, key: string): string[] | undefined => {
  const v = args[key];
  return Array.isArray(v) ? v.map((x) => String(x)) : undefined;
};
const errorOut = (kind: string, message: string): McpToolOutput => ({
  ok: false,
  kind,
  error: message,
});
const n = (x: number): string => String(x);

/** Build a kernel FilterInput for the case-aggregate bound args (court/level/category/year). */
const aggregateFilter = (args: Record<string, unknown>): FilterInput => {
  const filter: Record<string, unknown> = {};
  const inst = strArray(args, 'institutionCode');
  if (inst !== undefined) filter['institutionCode'] = { in: inst };
  const lvl = strArray(args, 'courtLevel');
  if (lvl !== undefined) filter['courtLevel'] = { in: lvl };
  const cat = strArray(args, 'category');
  if (cat !== undefined) filter['category'] = { in: cat };
  const yearFrom = intArg(args, 'yearFrom');
  const yearTo = intArg(args, 'yearTo');
  if (yearFrom !== undefined || yearTo !== undefined) {
    filter['year'] = {
      between: {
        ...(yearFrom !== undefined && { from: yearFrom }),
        ...(yearTo !== undefined && { to: yearTo }),
      },
    };
  }
  return filter as FilterInput;
};

const litigationFilter = (args: Record<string, unknown>): CompanyLitigationFilter | undefined => {
  const f: { courtLevels?: string[]; yearFrom?: number; yearTo?: number; categories?: string[] } =
    {};
  const lvl = strArray(args, 'courtLevel');
  if (lvl !== undefined) f.courtLevels = lvl;
  const cat = strArray(args, 'category');
  if (cat !== undefined) f.categories = cat;
  const yearFrom = intArg(args, 'yearFrom');
  if (yearFrom !== undefined) f.yearFrom = yearFrom;
  const yearTo = intArg(args, 'yearTo');
  if (yearTo !== undefined) f.yearTo = yearTo;
  return Object.keys(f).length > 0 ? f : undefined;
};

export const makeJudicialMcpTools = (deps: JudicialMcpDeps): readonly KernelMcpTool[] => {
  const { repos, clientBaseUrl } = deps;
  const caseLink = (caseId: string): string => `${clientBaseUrl}/judicial/cases/${caseId}`;

  const resolveFilters: KernelMcpTool = {
    name: 'resolve_judicial_filters',
    description:
      'Resolve a free-text judicial query to a filter value: court name → institution_code, level label → courtLevel, company name → name_key_id (company/public dictionary ONLY — a person name returns zero rows), category label → code. Use before querying other judicial tools.',
    inputShape: resolveJudicialFiltersInput,
    async handler(args): Promise<McpToolOutput> {
      const dim = str(args, 'dim') as JudicialResolveDim | undefined;
      if (dim === undefined) return errorOut(JUDICIAL_MCP_KINDS.resolve, 'dim is required');
      const q = str(args, 'q') ?? '';
      const res = await resolveJudicialFilters(repos, dim, q, intArg(args, 'limit') ?? 10);
      if (res.isErr()) return errorOut(JUDICIAL_MCP_KINDS.resolve, res.error.message);
      // PRIVACY (S1, codex P0): NEVER echo the raw query `q` back on the output —
      // for dim='companyName' a person-name query reflected into the envelope would
      // itself be a leak. The output carries ONLY matched dictionary values (which
      // are company/public by construction) + the dim + the match count.
      return {
        ok: true,
        kind: JUDICIAL_MCP_KINDS.resolve,
        query: { dim },
        items: res.value,
        summary: `Resolved to ${n(res.value.length)} ${dim} value(s).`,
      };
    },
  };

  const getJudicialCase: KernelMcpTool = {
    name: 'get_judicial_case',
    description:
      'Get a case by numeric caseId OR natural key (institutionCode + caseNumber): the case, hearings (NO solution/solution_summary), appeals, name-gated parties (company/public names and keys only; withheld identities contribute only to personPartyCount), legal references, and lineage candidates.',
    inputShape: getJudicialCaseInput,
    async handler(args): Promise<McpToolOutput> {
      const caseId = str(args, 'caseId');
      const institutionCode = str(args, 'institutionCode');
      const caseNumber = str(args, 'caseNumber');
      if (caseId === undefined && (institutionCode === undefined || caseNumber === undefined)) {
        return errorOut(
          JUDICIAL_MCP_KINDS.caseDetail,
          'caseId or (institutionCode + caseNumber) is required'
        );
      }
      const res = await getCaseDetail(repos, {
        ...(caseId !== undefined && { caseId }),
        ...(institutionCode !== undefined && { institutionCode }),
        ...(caseNumber !== undefined && { caseNumber }),
      });
      if (res.isErr()) return errorOut(JUDICIAL_MCP_KINDS.caseDetail, res.error.message);
      const detail = res.value;
      if (detail === null) {
        return {
          ok: true,
          kind: JUDICIAL_MCP_KINDS.caseDetail,
          query: args,
          summary: 'No matching case.',
        };
      }
      return {
        ok: true,
        kind: JUDICIAL_MCP_KINDS.caseDetail,
        query: { caseId, institutionCode, caseNumber },
        link: caseLink(detail.case.caseId),
        item: detail,
        summary: `Case ${detail.case.caseNumber} at ${detail.case.institutionCode}: ${detail.case.stageName ?? detail.case.stage ?? 'n/a'}, ${n(detail.hearings.length)} hearings, ${n(detail.personPartyCount)} private-person parties (names withheld).`,
      };
    },
  };

  const getCourtCaseloadTool: KernelMcpTool = {
    name: 'get_court_caseload',
    description:
      'Court caseload analytics (JD-2): case counts grouped by court/category/year/courtLevel. Deterministic SQL; REQUIRES a court/level/period bound (else InvalidInput). Returns groups + denominator + coverage.',
    inputShape: getCourtCaseloadInput,
    async handler(args): Promise<McpToolOutput> {
      const groupBy = str(args, 'groupBy') as
        | 'court'
        | 'category'
        | 'year'
        | 'courtLevel'
        | undefined;
      if (groupBy === undefined)
        return errorOut(JUDICIAL_MCP_KINDS.caseload, 'groupBy is required');
      const res = await getCourtCaseload(repos, groupBy, aggregateFilter(args));
      if (res.isErr()) return errorOut(JUDICIAL_MCP_KINDS.caseload, res.error.message);
      const agg = res.value;
      return {
        ok: true,
        kind: JUDICIAL_MCP_KINDS.caseload,
        query: { groupBy },
        link: `${clientBaseUrl}/judicial/cases/aggregate`,
        items: agg.groups,
        item: agg,
        summary: `${n(agg.groups.length)} ${groupBy} group(s); ${n(agg.denominator)} cases (coverage ${(agg.coverage * 100).toFixed(0)}%).`,
      };
    },
  };

  const getCompanyLitigationTool: KernelMcpTool = {
    name: 'get_company_litigation',
    description:
      'Company litigation summary (JD-1) for a CUI: published-only case count + court-level + year breakdowns + coverage. EMPTY in v1 (no published links) — returns caseCount 0 + a caveat. Never returns person data.',
    inputShape: getCompanyLitigationInput,
    async handler(args): Promise<McpToolOutput> {
      const cui = str(args, 'cui');
      if (cui === undefined)
        return errorOut(JUDICIAL_MCP_KINDS.companyLitigation, 'cui is required');
      const res = await getCompanyLitigation(repos, cui, litigationFilter(args));
      if (res.isErr()) return errorOut(JUDICIAL_MCP_KINDS.companyLitigation, res.error.message);
      const s = res.value;
      return {
        ok: true,
        kind: JUDICIAL_MCP_KINDS.companyLitigation,
        query: { cui },
        link: `${clientBaseUrl}/judicial/companies/${cui}/litigation`,
        item: s,
        summary: `Company ${cui}: ${n(s.caseCount)} published case links (coverage ${(s.coverage * 100).toFixed(0)}%).${s.caveats.length > 0 ? ` ${s.caveats.join(' ')}` : ''}`,
      };
    },
  };

  const getCaseLegalReferencesTool: KernelMcpTool = {
    name: 'get_case_legal_references',
    description:
      'Legal-act citations referenced in a case (JD-3): act_type/number/year + resolution status. Safe (no PII; solution_summary spans excluded). Empty until gate #11.',
    inputShape: getCaseLegalReferencesInput,
    async handler(args): Promise<McpToolOutput> {
      const caseId = str(args, 'caseId');
      if (caseId === undefined) return errorOut(JUDICIAL_MCP_KINDS.legalRefs, 'caseId is required');
      const res = await getCaseLegalRefs(repos, caseId);
      if (res.isErr()) return errorOut(JUDICIAL_MCP_KINDS.legalRefs, res.error.message);
      const refs = res.value;
      const resolved = refs.filter((r) => r.resolutionStatus === 'unique').length;
      return {
        ok: true,
        kind: JUDICIAL_MCP_KINDS.legalRefs,
        query: { caseId },
        link: caseLink(caseId),
        items: refs,
        summary: `Case ${caseId} cites ${n(refs.length)} act(s) (${n(resolved)} uniquely resolved).`,
      };
    },
  };

  return [
    resolveFilters,
    getJudicialCase,
    getCourtCaseloadTool,
    getCompanyLitigationTool,
    getCaseLegalReferencesTool,
  ];
};
