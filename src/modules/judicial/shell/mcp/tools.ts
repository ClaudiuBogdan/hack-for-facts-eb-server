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
  type CursorPageRequest,
  type FilterInput,
  type KernelMcpTool,
  type McpToolOutput,
} from '@/modules/shared/index.js';

import {
  JUDICIAL_MCP_KINDS,
  getCaseLegalReferencesInput,
  getCaseLineageInput,
  getCompanyLitigationInput,
  getCourtCaseloadInput,
  getJudicialCaseInput,
  getJudicialCourtInput,
  getJudicialDecisionBySourceInput,
  getJudicialDecisionInput,
  listCasesCitingActInput,
  listCompanyLitigationCasesInput,
  listJudicialCasesInput,
  listJudicialCourtsInput,
  listJudicialDecisionSubjectLinksInput,
  listJudicialDecisionsInput,
  listJudicialIssuingBodiesInput,
  resolveJudicialDecisionFiltersInput,
  resolveJudicialFiltersInput,
} from './io.js';
import {
  JUDICIAL_DECISION_PAGE_DEFAULT,
  isJudicialAggregateGroupBy,
  isJudicialDecisionPageSize,
  isJudicialDirectId,
} from '../../core/types.js';
import {
  getCaseDetail,
  getCaseLegalRefs,
  getCaseLineage,
  getCompanyLitigation,
  getCourtCaseload,
  getCourtTree,
  getDecision,
  getDecisionBySource,
  listCases,
  listCasesCitingAct,
  listCompanyLitigationCases,
  listCourts,
  listDecisionIssuingBodies,
  listDecisionSubjectLinks,
  listDecisions,
  resolveDecisionFilters,
  resolveJudicialFilters,
  type JudicialRepos,
} from '../../core/usecases.js';
import {
  CASE_FLAT_RULES,
  COURT_FLAT_RULES,
  DECISION_FLAT_RULES,
  DECISION_LINK_FLAT_RULES,
  flatToFilter,
} from '../filters/transport-input.js';
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

/**
 * The ORIGINAL page of a new case-family list tool (direct calls bypass Zod):
 * `first` an integer 1..50 (omitted/null = 20), never clamped; `after` a string.
 */
const pageOf = (
  args: Record<string, unknown>
): { ok: true; page: CursorPageRequest } | { ok: false; error: ApiError } => {
  const first = optionalArg(args, 'first') ?? JUDICIAL_DECISION_PAGE_DEFAULT;
  if (!isJudicialDecisionPageSize(first)) {
    return { ok: false, error: invalidInput('first must be an integer from 1 to 50', 'first') };
  }
  const after = optionalArg(args, 'after');
  if (after !== undefined && typeof after !== 'string') {
    return { ok: false, error: invalidInput('after must be a cursor string', 'after') };
  }
  return { ok: true, page: { first, ...(after !== undefined && { after }) } };
};

/** Echo the arguments without the free-text `q` (discovery/search text is never echoed). */
const withoutQ = (args: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(args).filter(([key]) => key !== 'q'));

const cursorMeta = (next: string | null): Readonly<Record<string, unknown>> => ({
  cursor: { next },
});

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
      'Company litigation summary (JD-1) for a CUI: published-only case count + court-level + year breakdowns (session calendar years of the source-dependent case date) + coverage. Published-only company litigation; results depend on stored published links (no matching published link returns caseCount 0 + a caveat). Never returns person data.',
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

  // ── API-04: thin tools over the SAME usecases (no new client deep links) ─────

  const listCourtsTool: KernelMcpTool = {
    name: 'list_judicial_courts',
    description:
      'List the courts of the justice reference hierarchy (Portal Just courts plus the ICCJ), ordered by ordinal. Optional flat filters: level, countyCode (countySiruta is a deprecated alias of the same county abbreviation), specialization, specializationContains, q (locality contains). The complete filtered list.',
    inputShape: listJudicialCourtsInput,
    strictInput: true,
    async handler(args): Promise<McpToolOutput> {
      const res = await listCourts(repos, flatToFilter(COURT_FLAT_RULES, args));
      if (res.isErr()) return failure(JUDICIAL_MCP_KINDS.courts, res.error);
      return {
        ok: true,
        kind: JUDICIAL_MCP_KINDS.courts,
        query: withoutQ(args),
        items: res.value,
        meta: { count: res.value.length },
        summary: `${n(res.value.length)} court(s).`,
      };
    },
  };

  const getCourtTool: KernelMcpTool = {
    name: 'get_judicial_court',
    description:
      'Get one court by exact institution code, with its direct child courts. Returns no item when the code matches no court.',
    inputShape: getJudicialCourtInput,
    strictInput: true,
    async handler(args): Promise<McpToolOutput> {
      const code = args['institutionCode'];
      if (typeof code !== 'string' || code === '') {
        return required(JUDICIAL_MCP_KINDS.court, 'institutionCode is required', 'institutionCode');
      }
      const res = await getCourtTree(repos, code);
      if (res.isErr()) return failure(JUDICIAL_MCP_KINDS.court, res.error);
      if (res.value === null) {
        return {
          ok: true,
          kind: JUDICIAL_MCP_KINDS.court,
          query: { institutionCode: code },
          summary: 'No matching court.',
        };
      }
      return {
        ok: true,
        kind: JUDICIAL_MCP_KINDS.court,
        query: { institutionCode: code },
        item: res.value,
        summary: `Court ${code}: ${n(res.value.children.length)} direct child court(s).`,
      };
    },
  };

  const listCasesTool: KernelMcpTool = {
    name: 'list_judicial_cases',
    description:
      'List cases (the current latest-known projection), cursor-paged. REQUIRES a court or period bound: institutionCode, courtLevel, a year bound (session calendar year of the source-dependent sourceOpenedAt; nonzero) or a modified bound. sort modifiedAt (default) or openedAt, dir DESC (default) or ASC; first 1 to 50 (default 20); after = meta.cursor.next.',
    inputShape: listJudicialCasesInput,
    strictInput: true,
    async handler(args): Promise<McpToolOutput> {
      const sortArg = optionalArg(args, 'sort') ?? 'modifiedAt';
      if (sortArg !== 'modifiedAt' && sortArg !== 'openedAt') {
        return required(JUDICIAL_MCP_KINDS.cases, 'sort must be modifiedAt or openedAt', 'sort');
      }
      const dirArg = optionalArg(args, 'dir') ?? 'DESC';
      if (dirArg !== 'ASC' && dirArg !== 'DESC') {
        return required(JUDICIAL_MCP_KINDS.cases, 'dir must be ASC or DESC', 'dir');
      }
      const page = pageOf(args);
      if (!page.ok) return failure(JUDICIAL_MCP_KINDS.cases, page.error);
      const res = await listCases(repos, {
        filter: flatToFilter(CASE_FLAT_RULES, args),
        sort: sortArg,
        dir: dirArg === 'ASC' ? 'asc' : 'desc',
        page: page.page,
      });
      if (res.isErr()) return failure(JUDICIAL_MCP_KINDS.cases, res.error);
      const items = res.value.items.map((item) => item.node);
      return {
        ok: true,
        kind: JUDICIAL_MCP_KINDS.cases,
        query: withoutQ(args),
        items,
        meta: cursorMeta(res.value.next),
        summary: `${n(items.length)} case(s)${res.value.next === null ? '' : '; more available (meta.cursor.next)'}.`,
      };
    },
  };

  const getCaseLineageTool: KernelMcpTool = {
    name: 'get_case_lineage',
    description:
      'Candidate lineage edges of one case (either endpoint), as stored: candidates, never facts; toCaseId is null for an unresolved candidate.',
    inputShape: getCaseLineageInput,
    strictInput: true,
    async handler(args): Promise<McpToolOutput> {
      const caseId = args['caseId'];
      if (typeof caseId !== 'string' || caseId === '') {
        return required(JUDICIAL_MCP_KINDS.lineage, 'caseId is required', 'caseId');
      }
      const res = await getCaseLineage(repos, caseId);
      if (res.isErr()) return failure(JUDICIAL_MCP_KINDS.lineage, res.error);
      return {
        ok: true,
        kind: JUDICIAL_MCP_KINDS.lineage,
        query: { caseId },
        items: res.value,
        meta: { count: res.value.length },
        summary: `Case ${caseId}: ${n(res.value.length)} lineage candidate edge(s).`,
      };
    },
  };

  const listCompanyCasesTool: KernelMcpTool = {
    name: 'list_company_litigation_cases',
    description:
      'Cases linked to a company CUI through PUBLISHED company-litigation links only (results depend on stored published links), cursor-paged by case id. Optional courtLevel/category/yearFrom/yearTo narrowing as get_company_litigation; first 1 to 50 (default 20); after = meta.cursor.next.',
    inputShape: listCompanyLitigationCasesInput,
    strictInput: true,
    async handler(args): Promise<McpToolOutput> {
      const cui = args['cui'];
      if (typeof cui !== 'string' || cui === '') {
        return required(JUDICIAL_MCP_KINDS.companyCases, 'cui is required', 'cui');
      }
      const filter = normalizeCompanyLitigationFilter({
        courtLevel: args['courtLevel'],
        category: args['category'],
        yearFrom: args['yearFrom'],
        yearTo: args['yearTo'],
      });
      if (filter.isErr()) return failure(JUDICIAL_MCP_KINDS.companyCases, filter.error);
      const page = pageOf(args);
      if (!page.ok) return failure(JUDICIAL_MCP_KINDS.companyCases, page.error);
      const res = await listCompanyLitigationCases(repos, cui, page.page, filter.value);
      if (res.isErr()) return failure(JUDICIAL_MCP_KINDS.companyCases, res.error);
      return {
        ok: true,
        kind: JUDICIAL_MCP_KINDS.companyCases,
        query: { cui },
        items: res.value.items,
        meta: cursorMeta(res.value.next),
        summary: `Company ${cui}: ${n(res.value.items.length)} published case link(s) on this page.`,
      };
    },
  };

  const listCasesCitingActTool: KernelMcpTool = {
    name: 'list_cases_citing_act',
    description:
      'Stored citation rows linking cases to one legal act, ordered by reference id: one item per stored citation (not deduplicated into cases); solution_summary citations excluded. first 1 to 50 (default 20); after = meta.cursor.next.',
    inputShape: listCasesCitingActInput,
    strictInput: true,
    async handler(args): Promise<McpToolOutput> {
      const targetActId = args['targetActId'];
      if (typeof targetActId !== 'string' || targetActId === '') {
        return required(JUDICIAL_MCP_KINDS.citingAct, 'targetActId is required', 'targetActId');
      }
      const page = pageOf(args);
      if (!page.ok) return failure(JUDICIAL_MCP_KINDS.citingAct, page.error);
      const res = await listCasesCitingAct(repos, targetActId, page.page);
      if (res.isErr()) return failure(JUDICIAL_MCP_KINDS.citingAct, res.error);
      const items = res.value.items.map((item) => item.node);
      return {
        ok: true,
        kind: JUDICIAL_MCP_KINDS.citingAct,
        query: { targetActId },
        items,
        meta: cursorMeta(res.value.next),
        summary: `${n(items.length)} stored citation row(s) for act ${targetActId} on this page.`,
      };
    },
  };

  const listIssuingBodiesTool: KernelMcpTool = {
    name: 'list_judicial_issuing_bodies',
    description:
      'The complete stored issuing-body reference list (the authorities behind stored decisions), ordered by key. Keys are table data, not a fixed enum.',
    inputShape: listJudicialIssuingBodiesInput,
    strictInput: true,
    async handler(): Promise<McpToolOutput> {
      const res = await listDecisionIssuingBodies(repos);
      if (res.isErr()) return failure(JUDICIAL_MCP_KINDS.issuingBodies, res.error);
      return {
        ok: true,
        kind: JUDICIAL_MCP_KINDS.issuingBodies,
        items: res.value,
        meta: { count: res.value.length },
        summary: `${n(res.value.length)} issuing bod(ies).`,
      };
    },
  };

  const listDecisionsTool: KernelMcpTool = {
    name: 'list_judicial_decisions',
    description:
      'List stored decisions as stored (both privacy classes; dedicated privacy work is deferred), decisionId DESC (a surrogate-key order, not recency), cursor-paged. REQUIRES sourceSystem or issuingBody (exact text). Optional exact-text/presence filters (decisionNo, decisionKind, outcomeNormalized, ecli, applicationNo, <field>IsNull), decisionYear (the stored smallint; 0 and negative allowed) with From/To/Gte/Lte/IsNull, decisionDateIsNull, privacyClass. first 1 to 50 (default 20); after = meta.cursor.next.',
    inputShape: listJudicialDecisionsInput,
    strictInput: true,
    async handler(args): Promise<McpToolOutput> {
      const res = await listDecisions(repos, {
        filter: flatToFilter(DECISION_FLAT_RULES, args),
        first: args['first'],
        after: args['after'],
      });
      if (res.isErr()) return failure(JUDICIAL_MCP_KINDS.decisions, res.error);
      const items = res.value.items.map((item) => item.node);
      return {
        ok: true,
        kind: JUDICIAL_MCP_KINDS.decisions,
        query: args,
        items,
        meta: cursorMeta(res.value.next),
        summary: `${n(items.length)} stored decision(s)${res.value.next === null ? '' : '; more available (meta.cursor.next)'}.`,
      };
    },
  };

  const getDecisionTool: KernelMcpTool = {
    name: 'get_judicial_decision',
    description:
      'Get one stored decision by native decisionId (a canonical signed int8 decimal string), every field as stored. Returns no item when no row has that id.',
    inputShape: getJudicialDecisionInput,
    strictInput: true,
    async handler(args): Promise<McpToolOutput> {
      const res = await getDecision(repos, args['decisionId']);
      if (res.isErr()) return failure(JUDICIAL_MCP_KINDS.decision, res.error);
      const query = { decisionId: args['decisionId'] };
      if (res.value === null) {
        return {
          ok: true,
          kind: JUDICIAL_MCP_KINDS.decision,
          query,
          summary: 'No matching decision.',
        };
      }
      return {
        ok: true,
        kind: JUDICIAL_MCP_KINDS.decision,
        query,
        item: res.value,
        summary: `Decision ${res.value.decisionId} (${res.value.sourceSystem}).`,
      };
    },
  };

  const getDecisionBySourceTool: KernelMcpTool = {
    name: 'get_judicial_decision_by_source',
    description:
      'Get one stored decision by its exact unique source identity: sourceSystem AND sourceRef, both exact text (no trimming; ECLI/application numbers are not lookup keys). Returns no item when absent.',
    inputShape: getJudicialDecisionBySourceInput,
    strictInput: true,
    async handler(args): Promise<McpToolOutput> {
      const res = await getDecisionBySource(repos, args['sourceSystem'], args['sourceRef']);
      if (res.isErr()) return failure(JUDICIAL_MCP_KINDS.decision, res.error);
      const query = { sourceSystem: args['sourceSystem'], sourceRef: args['sourceRef'] };
      if (res.value === null) {
        return {
          ok: true,
          kind: JUDICIAL_MCP_KINDS.decision,
          query,
          summary: 'No matching decision.',
        };
      }
      return {
        ok: true,
        kind: JUDICIAL_MCP_KINDS.decision,
        query,
        item: res.value,
        summary: `Decision ${res.value.decisionId} (${res.value.sourceSystem}).`,
      };
    },
  };

  const listDecisionLinksTool: KernelMcpTool = {
    name: 'list_judicial_decision_subject_links',
    description:
      'Stored decision-to-subject link rows as stored (one item per link; statuses are recorded labels, not verification; subject references are exact text with no identity resolution), linkId DESC, cursor-paged. REQUIRES exactly one anchor: decisionId, or subjectKind with subjectRef. Optional validationStatus list. first 1 to 50 (default 20); after = meta.cursor.next.',
    inputShape: listJudicialDecisionSubjectLinksInput,
    strictInput: true,
    async handler(args): Promise<McpToolOutput> {
      const res = await listDecisionSubjectLinks(repos, {
        filter: flatToFilter(DECISION_LINK_FLAT_RULES, args),
        first: args['first'],
        after: args['after'],
      });
      if (res.isErr()) return failure(JUDICIAL_MCP_KINDS.decisionLinks, res.error);
      const items = res.value.items.map((item) => item.node);
      return {
        ok: true,
        kind: JUDICIAL_MCP_KINDS.decisionLinks,
        query: args,
        items,
        meta: cursorMeta(res.value.next),
        summary: `${n(items.length)} stored link row(s)${res.value.next === null ? '' : '; more available (meta.cursor.next)'}.`,
      };
    },
  };

  const resolveDecisionFiltersTool: KernelMcpTool = {
    name: 'resolve_judicial_decision_filters',
    description:
      'Resolve a decision filter value: issuingBody (stored bodies by key/label), sourceSystem (distinct stored values), subjectKind (the five kinds), validationStatus (the four recorded status labels, not approvals). Use before list_judicial_decisions / list_judicial_decision_subject_links.',
    inputShape: resolveJudicialDecisionFiltersInput,
    strictInput: true,
    async handler(args): Promise<McpToolOutput> {
      const dim = args['dim'];
      const res = await resolveDecisionFilters(repos, dim, args['q'], args['limit']);
      if (res.isErr()) return failure(JUDICIAL_MCP_KINDS.resolve, res.error);
      // The query text is never echoed (same rule as resolve_judicial_filters).
      return {
        ok: true,
        kind: JUDICIAL_MCP_KINDS.resolve,
        query: { dim },
        items: res.value,
        summary: `Resolved to ${n(res.value.length)} ${String(dim)} value(s).`,
      };
    },
  };

  return [
    resolveFilters,
    getJudicialCase,
    getCourtCaseloadTool,
    getCompanyLitigationTool,
    getCaseLegalReferencesTool,
    listCourtsTool,
    getCourtTool,
    listCasesTool,
    getCaseLineageTool,
    listCompanyCasesTool,
    listCasesCitingActTool,
    listIssuingBodiesTool,
    listDecisionsTool,
    getDecisionTool,
    getDecisionBySourceTool,
    listDecisionLinksTool,
    resolveDecisionFiltersTool,
  ];
};
