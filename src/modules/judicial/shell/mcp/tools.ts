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
 *
 * A3: handlers forward the ORIGINAL argument values (no Number/String coercion,
 * no flooring or clamping); null at an optional argument means absent; every
 * failure carries the typed `errorType` / `errorCode` beside its message.
 */

import {
  GRAPHQL_ERROR_CODE,
  invalidInput,
  type ApiError,
  type FilterInput,
  type KernelMcpTool,
  type McpToolOutput,
} from '@/modules/shared/index.js';

import {
  JUDICIAL_MCP_KINDS,
  getCaseLegalReferencesInput,
  getCompanyLitigationInput,
  getCourtCaseloadInput,
  getJudicialCaseInput,
  resolveJudicialFiltersInput,
} from './io.js';
import { isJudicialAggregateGroupBy, isJudicialDirectId } from '../../core/types.js';
import {
  getCaseDetail,
  getCaseLegalRefs,
  getCompanyLitigation,
  getCourtCaseload,
  resolveJudicialFilters,
  type JudicialRepos,
} from '../../core/usecases.js';
import { normalizeCompanyLitigationFilter } from '../repo/company-link-repo.js';

export interface JudicialMcpDeps {
  readonly repos: JudicialRepos;
  readonly clientBaseUrl: string;
}

/** An optional argument: null and omitted are both absent; anything else as received. */
const optionalArg = (args: Record<string, unknown>, key: string): unknown => {
  const v = args[key];
  return v === null ? undefined : v;
};

/**
 * An optional STRING argument: absent when omitted, null or empty (the existing
 * empty-string meaning); a present non-string is a typed input error.
 */
const optionalString = (
  args: Record<string, unknown>,
  key: string
): { ok: true; value: string | undefined } | { ok: false; error: ApiError } => {
  const v = optionalArg(args, key);
  if (v === undefined || v === '') return { ok: true, value: undefined };
  if (typeof v !== 'string')
    return { ok: false, error: invalidInput(`${key} must be a string`, key) };
  return { ok: true, value: v };
};

/**
 * An optional DIRECT id argument: absent ONLY when omitted or null. A supplied
 * value (including the empty string) is never dropped: it must pass the exact
 * digit / int8 guard here, before any repo access, so a malformed id can never
 * silently fall back to the natural key.
 */
const optionalDirectId = (
  args: Record<string, unknown>,
  key: string
): { ok: true; value: string | undefined } | { ok: false; error: ApiError } => {
  const v = optionalArg(args, key);
  if (v === undefined) return { ok: true, value: undefined };
  if (!isJudicialDirectId(v)) {
    return {
      ok: false,
      error: invalidInput(
        `${key} must be a decimal digit string of at most 9223372036854775807`,
        key
      ),
    };
  }
  return { ok: true, value: v };
};

/** The typed failure envelope (message + errorType + aligned errorCode). */
const failure = (kind: string, error: ApiError): McpToolOutput => ({
  ok: false,
  kind,
  error: error.message,
  errorType: error.type,
  errorCode: GRAPHQL_ERROR_CODE[error.type],
});
const required = (kind: string, message: string, field: string): McpToolOutput =>
  failure(kind, invalidInput(message, field));
const n = (x: number): string => String(x);

/**
 * Build a kernel FilterInput for the case-aggregate bound args. The ORIGINAL
 * values are forwarded unchanged; the cases repo normalizes and validates them
 * (list shapes and member types, court levels, nonzero 32-bit years) before SQL.
 */
const aggregateFilter = (args: Record<string, unknown>): FilterInput => {
  const filter: Record<string, unknown> = {};
  for (const key of ['institutionCode', 'courtLevel', 'category'] as const) {
    const v = optionalArg(args, key);
    if (v !== undefined) filter[key] = { in: v };
  }
  const yearFrom = optionalArg(args, 'yearFrom');
  const yearTo = optionalArg(args, 'yearTo');
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

export const makeJudicialMcpTools = (deps: JudicialMcpDeps): readonly KernelMcpTool[] => {
  const { repos, clientBaseUrl } = deps;
  const caseLink = (caseId: string): string => `${clientBaseUrl}/judicial/cases/${caseId}`;

  const resolveFilters: KernelMcpTool = {
    name: 'resolve_judicial_filters',
    description:
      'Resolve a free-text judicial query to a filter value: court name → institution_code, level label → courtLevel, company name → name_key_id (company/public dictionary ONLY — a person name returns zero rows), category label → code. Use before querying other judicial tools.',
    inputShape: resolveJudicialFiltersInput,
    async handler(args): Promise<McpToolOutput> {
      // The usecase validates dim / q / limit before any repo access.
      const dim = args['dim'];
      const res = await resolveJudicialFilters(repos, dim, args['q'], args['limit']);
      if (res.isErr()) return failure(JUDICIAL_MCP_KINDS.resolve, res.error);
      // PRIVACY (S1, codex P0): NEVER echo the raw query `q` back on the output —
      // for dim='companyName' a person-name query reflected into the envelope would
      // itself be a leak. The output carries ONLY matched dictionary values (which
      // are company/public by construction) + the dim + the match count.
      return {
        ok: true,
        kind: JUDICIAL_MCP_KINDS.resolve,
        query: { dim },
        items: res.value,
        summary: `Resolved to ${n(res.value.length)} ${String(dim)} value(s).`,
      };
    },
  };

  const getJudicialCase: KernelMcpTool = {
    name: 'get_judicial_case',
    description:
      'Get a case by numeric caseId OR natural key (institutionCode + caseNumber): the case (sourceOpenedAt is a source-dependent date, explained by sourceOpenedAtBasis), hearings (NO solution/solution_summary), appeals, name-gated parties (company/public names and keys only; withheld identities contribute only to personPartyCount), legal references, lineage candidates, and asOf: the stored source-modified maximum of the source of that case (null when that source stores none), not dataset freshness.',
    inputShape: getJudicialCaseInput,
    async handler(args): Promise<McpToolOutput> {
      const caseIdArg = optionalDirectId(args, 'caseId');
      if (!caseIdArg.ok) return failure(JUDICIAL_MCP_KINDS.caseDetail, caseIdArg.error);
      const institutionArg = optionalString(args, 'institutionCode');
      if (!institutionArg.ok) return failure(JUDICIAL_MCP_KINDS.caseDetail, institutionArg.error);
      const numberArg = optionalString(args, 'caseNumber');
      if (!numberArg.ok) return failure(JUDICIAL_MCP_KINDS.caseDetail, numberArg.error);
      const caseId = caseIdArg.value;
      const institutionCode = institutionArg.value;
      const caseNumber = numberArg.value;
      if (caseId === undefined && (institutionCode === undefined || caseNumber === undefined)) {
        return required(
          JUDICIAL_MCP_KINDS.caseDetail,
          'caseId or (institutionCode + caseNumber) is required',
          'caseId'
        );
      }
      const res = await getCaseDetail(repos, {
        ...(caseId !== undefined && { caseId }),
        ...(institutionCode !== undefined && { institutionCode }),
        ...(caseNumber !== undefined && { caseNumber }),
      });
      if (res.isErr()) return failure(JUDICIAL_MCP_KINDS.caseDetail, res.error);
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
      'Court caseload analytics (JD-2): case counts grouped by court/category/year/courtLevel. Year is the session calendar year of the source-dependent sourceOpenedAt (counts over several sources combine different source clocks). Deterministic SQL; REQUIRES a court/level/period bound (else InvalidInput). Returns groups + denominator + coverage.',
    inputShape: getCourtCaseloadInput,
    async handler(args): Promise<McpToolOutput> {
      const groupBy = args['groupBy'];
      if (!isJudicialAggregateGroupBy(groupBy)) {
        return required(
          JUDICIAL_MCP_KINDS.caseload,
          'groupBy must be one of court, category, year, courtLevel',
          'groupBy'
        );
      }
      const res = await getCourtCaseload(repos, groupBy, aggregateFilter(args));
      if (res.isErr()) return failure(JUDICIAL_MCP_KINDS.caseload, res.error);
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
      'Company litigation summary (JD-1) for a CUI: published-only case count + court-level + year breakdowns (session calendar years of the source-dependent case date) + coverage. EMPTY in v1 (no published links) — returns caseCount 0 + a caveat. Never returns person data.',
    inputShape: getCompanyLitigationInput,
    async handler(args): Promise<McpToolOutput> {
      const cuiArg = args['cui'];
      if (typeof cuiArg !== 'string' || cuiArg === '') {
        return required(JUDICIAL_MCP_KINDS.companyLitigation, 'cui is required', 'cui');
      }
      const cui = cuiArg;
      const filter = normalizeCompanyLitigationFilter({
        courtLevel: args['courtLevel'],
        category: args['category'],
        yearFrom: args['yearFrom'],
        yearTo: args['yearTo'],
      });
      if (filter.isErr()) return failure(JUDICIAL_MCP_KINDS.companyLitigation, filter.error);
      const res = await getCompanyLitigation(repos, cui, filter.value);
      if (res.isErr()) return failure(JUDICIAL_MCP_KINDS.companyLitigation, res.error);
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
      'Legal-act citations extracted from a case (JD-3): each citation is the exact stored token with its source field (object or a hearing field) and hearing anchor, plus act_type/number/year and resolution status; identity and resolution fields are returned as stored, including nulls. Safe (no PII; solution_summary citations excluded).',
    inputShape: getCaseLegalReferencesInput,
    async handler(args): Promise<McpToolOutput> {
      const caseIdArg = args['caseId'];
      if (typeof caseIdArg !== 'string' || caseIdArg === '') {
        return required(JUDICIAL_MCP_KINDS.legalRefs, 'caseId is required', 'caseId');
      }
      const caseId = caseIdArg;
      // The usecase rejects a negative, malformed or overflowing id before SQL.
      const res = await getCaseLegalRefs(repos, caseId);
      if (res.isErr()) return failure(JUDICIAL_MCP_KINDS.legalRefs, res.error);
      const refs = res.value;
      const resolved = refs.filter((r) => r.resolutionStatus === 'unique').length;
      return {
        ok: true,
        kind: JUDICIAL_MCP_KINDS.legalRefs,
        query: { caseId },
        link: caseLink(caseId),
        items: refs,
        summary: `Case ${caseId} has ${n(refs.length)} legal citation(s) (${n(resolved)} uniquely resolved).`,
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
