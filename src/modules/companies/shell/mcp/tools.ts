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

import {
  normalizeOffset,
  type FilterInput,
  type KernelMcpTool,
  type McpToolOutput,
} from '@/modules/shared/index.js';

import { registryScopeKey, type CompanyRegistryEnvelope } from '../../core/registry.js';
import {
  COMPANY_RESOLVE_DIMS,
  COMPANY_SORTS,
  type CompanyFinancialYear,
  type CompanyGroupBy,
  type CompanyResolveDim,
  type CompanySort,
  type CompanyRegistrationDiff,
  type CompanyRegistrationDiffStatus,
  type CompanyRegistrationField,
} from '../../core/types.js';
import {
  makeCompanyCountyProfile,
  makeCompanyFinancialQualityAssessment,
  makeCompanyFinancials,
  makeCompanyList,
  makeCompanyProfile,
  makeCompanyRegistry,
  makeCompanyResolve,
  reportedValue,
  toCompanyResolveResult,
  type CompanyUsecaseDeps,
} from '../../core/usecases.js';

import type { HubStatsProvider } from '../hub-stats-cache.js';

export interface CompaniesMcpDeps extends CompanyUsecaseDeps {
  readonly clientBaseUrl: string;
  /** Shared with the GraphQL resolver, so both surfaces read the SAME cached snapshot. */
  readonly hubStats: HubStatsProvider;
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

/**
 * A figure for a summary sentence: the original value only when the evaluator
 * REPORTED it; otherwise the status that keeps it out (a held or unassessed
 * original is never quoted as a fact).
 */
const qualifiedFigure = (
  year: CompanyFinancialYear,
  metric: 'turnover' | 'employees',
  unit: string
): string => {
  const value = reportedValue(year, metric);
  if (value !== null) return `${value}${unit}`;
  const { qualification } = year;
  if (qualification.assessment !== 'assessed') {
    return `n/a (not assessed: ${qualification.reason ?? 'unknown'})`;
  }
  const status = qualification.metrics.find((m) => m.metric === metric)?.status ?? 'unknown';
  return `n/a (${status})`;
};

const errorOut = (kind: string, message: string): McpToolOutput => ({
  ok: false,
  kind,
  error: message,
});
const n = (x: number): string => String(x);

/**
 * Present territory with the SAME matchConfidence casing the GraphQL enum
 * serializes (SAFE/UNMATCHED) so an agent sees one value across both surfaces
 * (audit M13 — MCP emitted the lowercase domain value 'safe' while GraphQL emitted
 * the enum name 'SAFE').
 */
// Same M13 rule as mcpTerritory, for the diff enums: MCP must emit the
// GraphQL enum NAMES (CHANGED / LEGAL_NAME), never the lowercase domain
// values — an agent string-matching GraphQL vocabulary must match here too.
const MCP_DIFF_STATUS: Readonly<Record<CompanyRegistrationDiffStatus, string>> = {
  changed: 'CHANGED',
  unchanged: 'UNCHANGED',
  appeared: 'APPEARED',
  disappeared: 'DISAPPEARED',
  not_comparable: 'NOT_COMPARABLE',
  ambiguous: 'AMBIGUOUS',
};
const MCP_DIFF_FIELD: Readonly<Record<CompanyRegistrationField, string>> = {
  legalName: 'LEGAL_NAME',
  legalForm: 'LEGAL_FORM',
  county: 'COUNTY',
  locality: 'LOCALITY',
};
const mcpRegistrationDiff = (d: CompanyRegistrationDiff): Record<string, unknown> => ({
  fromEditionId: d.fromEditionId,
  toEditionId: d.toEditionId,
  fromCaptureDate: d.fromCaptureDate,
  toCaptureDate: d.toCaptureDate,
  status: MCP_DIFF_STATUS[d.status],
  reason: d.reason,
  changes: d.changes.map((c) => ({ field: MCP_DIFF_FIELD[c.field], from: c.from, to: c.to })),
});

const mcpTerritory = (t: { matchConfidence: 'safe' | 'unmatched' } | null): unknown =>
  t === null ? null : { ...t, matchConfidence: t.matchConfidence.toUpperCase() };

/** The envelope as MCP emits it: GraphQL enum casing for the state, plus the scope key. */
const mcpRegistry = (r: CompanyRegistryEnvelope): Record<string, unknown> => ({
  ...r,
  state: r.state.toUpperCase(),
  scopeKey: registryScopeKey(r),
});

/** One sentence an agent can quote about the registry state of an answer. */
const registrySentence = (r: CompanyRegistryEnvelope): string =>
  r.state === 'published'
    ? `ONRC edition ${r.editionId ?? '?'} (source ${r.sourcePublishedAt ?? 'date unknown'})`
    : `ONRC registry ${r.state} (${r.reason ?? 'no edition'}): registry fields are not available, not zero`;

export const makeCompaniesMcpTools = (deps: CompaniesMcpDeps): readonly KernelMcpTool[] => {
  const { clientBaseUrl } = deps;
  const companyLink = (cui: string): string => `${clientBaseUrl}/companii/${cui}`;

  const resolveFilter: KernelMcpTool = {
    name: 'resolve_company_filter',
    description:
      "Resolve a free-text company query to a filter value: company name → CUI (Meili candidates rehydrated from the public company spine; label = the pinned ONRC edition's qualified name or the directory name, see labelSource), registration number → CUI list (exact match of the pinned edition's normalized identifier key: whitespace removed, upper-cased; no old/new format inference; refused while no edition is published), CAEN label/code → catalog code with its revision and the exact onrcCaen key '<revision>:<code>' (value = bare code for the broad caenCode filter), county name → canonical county. meta carries degraded (name: search engine unavailable, a fallback answered; not the same as zero hits), ambiguous, and for name/regnum the registry scope the hits were read under (meta.registry, meta.registryScope; also for zero hits). CAEN and county are catalog reads: meta.registry and meta.registryScope are null. Pass registryScope (name/regnum only) to bind the answer to a scope you already hold: another or malformed scope is refused, never re-pinned. Use BEFORE the other company tools.",
    inputShape: {
      dim: z.enum(['name', 'regnum', 'caen', 'county']).describe('Which dimension to resolve.'),
      q: z
        .string()
        .describe('The free-text query (name, registration number, CAEN label, or county).'),
      limit: z
        .number()
        .int()
        .min(0)
        .max(50)
        .optional()
        .describe('Max hits (default 10; 0 = no hits).'),
      registryScope: z
        .string()
        .optional()
        .describe(
          'name/regnum only: a registry scope key you hold (meta.registryScope, scopeKey); the answer is bound to it or refused.'
        ),
    },
    async handler(args): Promise<McpToolOutput> {
      const dim = strArg(args, 'dim') as CompanyResolveDim;
      if (!COMPANY_RESOLVE_DIMS.includes(dim))
        return errorOut('resolution', `unknown dim '${dim}'`);
      const q = strArg(args, 'q');
      const expected = args['registryScope'];
      const res = await makeCompanyResolve(
        deps,
        dim,
        q,
        intArg(args, 'limit', 10),
        typeof expected === 'string' ? { expectedScopeKey: expected } : {}
      );
      if (res.isErr()) return errorOut('resolution', res.error.message);
      const r = res.value;
      // Shared mappers — items and metadata are identical to GraphQL
      // companyResolveResult on every dim, incl. county (audit M14).
      const result = toCompanyResolveResult(r);
      const top = r.matches[0];
      const summary =
        top !== undefined && (dim === 'name' || dim === 'regnum')
          ? `Resolved "${q}" to CUI ${top.cui ?? top.value} (${top.label}).`
          : `Found ${n(result.hits.length)} match(es) for "${q}" as ${dim}.`;
      return {
        ok: true,
        kind: 'resolution',
        query: { dim, q },
        items: result.hits,
        meta: {
          count: result.hits.length,
          degraded: result.degraded,
          ambiguous: result.ambiguous,
          registry: result.registry === null ? null : mcpRegistry(result.registry),
          registryScope: result.scopeKey,
        },
        summary: r.degraded
          ? `${summary} (name search degraded — search index unavailable or not current for this registry scope; a bounded fallback answered, so this is not evidence that no such company exists)`
          : summary,
      };
    },
  };

  const getSnapshot: KernelMcpTool = {
    name: 'get_company_snapshot',
    description:
      "Compact profile for a directory company by CUI: the pinned ONRC edition's QUALIFIED values (name/legal form/recorded date/status/territory are null when public observations conflict, are absent or unresolved, or when no edition is published - registry.state says which), fiscal flags, latest financial year, and total public money received (as a payee). registry carries the envelope (state, edition, epochs), cuiState (NOT_IN_EDITION = no qualified public profile in that edition, never 'not legally registered'), the qualified profile with bases, and the identifier groups; the full observation lists are on the GraphQL company query. registrationDate is the date ONRC RECORDED, never a founding date or age. headlineStatus is a complete consensus only (label from the API nomenclature, never an ONRC-observed label); an ONRC 1048 observation and ANAF declaredFiscallyInactive=false are different facts, never merge them. asOf carries SOURCE dates: onrc = the pinned edition's source date, anaf = ANAF state date (null = unknown). The latest financial year keeps its exact ORIGINAL source values and carries `qualification` (assessment, policy version/digest/approval date, 21 metric statuses) and `source` (publisher URL): quote or compare a value only when its status is reported; a held or not-assessed value is a source observation, never a fact to repeat. For the full financial series use get_company_financials: FY2019+ is published by ANAF and FY2008-2018 by MFP (different publishers; each year carries sourceSystem), and its quality flags are dated advisories - a figure without a flag is unassessed, not verified.",
    inputShape: { cui: z.string().describe('The company CUI/CIF (digits only).') },
    async handler(args): Promise<McpToolOutput> {
      const cui = strArg(args, 'cui');
      const res = await makeCompanyProfile(deps, cui);
      if (res.isErr()) return errorOut('company', res.error.message);
      const p = res.value;
      if (p === null)
        return { ok: true, kind: 'company', query: { cui }, summary: `No company for CUI ${cui}.` };
      const latest = p.financials[0];
      const pm = p.publicMoney;
      const evidence = p.registry;
      const summary =
        `${p.name} (CUI ${p.cui}${p.nameSource === 'core_organization' ? ', directory name' : ''})` +
        (p.territory?.countyName !== null && p.territory?.countyName !== undefined
          ? `, ${p.territory.countyName}`
          : '') +
        (p.headlineStatus !== null ? `, ONRC status ${p.headlineStatus.label}` : '') +
        (p.fiscal?.vatPayer === true ? ', VAT payer' : '') +
        (latest !== undefined
          ? `; ${String(latest.year)} turnover ${qualifiedFigure(latest, 'turnover', ' RON')}, employees ${qualifiedFigure(latest, 'employees', '')}`
          : '') +
        `; received ${pm?.totalRon ?? '0'} RON public money. ${registrySentence(evidence.registry)}; CUI ${evidence.cuiState.replace(/_/gu, ' ')}.`;
      // The diff was read inside the snapshot's pin and covered by its single
      // recheck: an access or scope move refused the whole snapshot above.
      const diff = p.registrationDiff;
      return {
        ok: true,
        kind: 'company',
        query: { cui },
        link: companyLink(p.cui),
        item: {
          cui: p.cui,
          name: p.name,
          nameSource: p.nameSource,
          legalForm: p.legalForm,
          registrationDate: p.registrationDate,
          headlineStatus: p.headlineStatus,
          fiscal: p.fiscal,
          territory: mcpTerritory(p.territory),
          latestFinancial: latest ?? null,
          publicMoney: pm,
          registry: {
            registry: mcpRegistry(evidence.registry),
            cuiState: evidence.cuiState.toUpperCase(),
            profile: evidence.profile,
            identifiers: evidence.identifiers,
            observationCounts: {
              identity: evidence.identityObservations.length,
              caen: evidence.caenObservations.length,
              status: evidence.statusObservations.length,
              truncated: evidence.observationsTruncated,
            },
          },
          registrationDiff: diff === null ? null : mcpRegistrationDiff(diff),
          asOf: p.asOf,
        },
        summary,
      };
    },
  };

  const getFinancials: KernelMcpTool = {
    name: 'get_company_financials',
    description:
      "Financial-statement (bilanț) year series by CUI, plus computed latest year and a latest-vs-prior trajectory (exact decimals at the inputs' own scale). Source observations by CUI, not company membership: the CUI may have no directory company (no core organization, or a public NGO/public body) - do not infer that it is a company. Statements are withheld when a known organization for the CUI is non-public. Values are the exact ORIGINAL source strings; employees is a bigint string. Each year carries sourceSystem (anaf FY2019+, mfp FY2008-2018), source (the publisher URL, never guessed) and qualification under the active published admission policy: assessment (not_assessed never means reported), policy version/digest/approval date, 21 metric statuses and the evaluator's netResult. Use, sum or compare a value only when its status is reported (the net result only via qualification.netResult); held values stay visible with their status and hold reason. trajectory deltas use reported values only and name the reason when null. qualityAssessment carries dated, warn-only legacy anomaly flags plus assessedYears (years with any flag corpus-wide, context only): advisory context, not admission. A missing flag is NOT an assessment: never present a statement without a flag as checked or clean, in any year.",
    inputShape: { cui: z.string().describe('The company CUI/CIF (digits only).') },
    async handler(args): Promise<McpToolOutput> {
      const cui = strArg(args, 'cui');
      const res = await makeCompanyFinancials(deps, cui);
      if (res.isErr()) return errorOut('financials', res.error.message);
      const f = res.value;
      if (f === null)
        return {
          ok: true,
          kind: 'financials',
          query: { cui },
          summary: `No financials for CUI ${cui}.`,
        };
      // Advisory parity with GraphQL Company.financialQualityAssessment: an
      // assessment failure must not take down the financials payload (H2).
      const qa = await makeCompanyFinancialQualityAssessment(deps, cui);
      return {
        ok: true,
        kind: 'financials',
        query: { cui },
        link: companyLink(cui),
        item: { ...f, qualityAssessment: qa.isOk() ? qa.value : null },
        summary:
          `${n(f.years.length)} financial year(s) for CUI ${cui}` +
          (f.latest !== null
            ? `; latest ${String(f.latest.year)} turnover ${qualifiedFigure(f.latest, 'turnover', ' RON')}.`
            : '.'),
      };
    },
  };

  const listCompanies: KernelMcpTool = {
    name: 'list_companies',
    description:
      "Filterable directory company list (bounded), pinned to ONE ONRC edition (meta.registry). Registry criteria status/county/caenCode/onrcCaen must all hold on the SAME resolved identifier: status = ANY public original observation with that code (1048 matches even next to a conflicting code), county = the identifier's derived-geography county (code like CJ or name), caenCode = broad CURRENT ONRC observation of that code in ANY revision (no older editions, no ANAF main activity), onrcCaen = exact '<revision>:<code>' (rev0..rev3). legalForm and registrationDate (the date ONRC RECORDED, never founding) use the CUI's qualified values. exclude/absence forms need complete evidence: unknown, partial or unresolved never counts as absence. ANAF fields (vatPayer, declaredFiscallyInactive, mainCaenCode) are independent; declaredFiscallyInactive=false is only ANAF's list state, not an ONRC status. Registry criteria and the registrationDate sort are refused while no edition is published (an error, not an empty list). Sort by name (directory name)/registrationDate/cui. Returns rows + bounded total (≤10,000; totalEstimated flags the cap) + meta.registryScope: pass it back as registryScope for the next page; a changed scope refuses the page (restart at page 1). Resolve names→CUIs with resolve_company_filter first (Entity Resolution Gate).",
    inputShape: {
      filter: z
        .record(z.string(), z.unknown())
        .optional()
        .describe(
          'A companies filter object (e.g. { county: { in: ["CJ"] }, status: { in: ["1048"] }, onrcCaen: { eq: "rev2:6201" } }).'
        ),
      registryScope: z
        .string()
        .optional()
        .describe(
          'meta.registryScope of the previous page; binds this page to the same edition/epochs or refuses it.'
        ),
      q: z
        .string()
        .optional()
        .describe('Company-name search (Meili-primary; degrades to a capped pg scan).'),
      sort: z
        .enum(['name', 'registrationDate', 'cui'])
        .optional()
        .describe('Sort key (default name). Value sorts (turnover/employees) are not offered.'),
      page: z.number().int().min(1).optional().describe('1-based page (default 1).'),
      pageSize: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe('Page size (default 20, max 100).'),
    },
    async handler(args): Promise<McpToolOutput> {
      const sortRaw = strArg(args, 'sort');
      const sort: CompanySort = (COMPANY_SORTS as readonly string[]).includes(sortRaw)
        ? (sortRaw as CompanySort)
        : 'name';
      const page = normalizeOffset(intArg(args, 'page', 1), intArg(args, 'pageSize', 20));
      const q = strArg(args, 'q');
      const registryScope = strArg(args, 'registryScope');
      const res = await makeCompanyList(deps, {
        filter: filterArg(args),
        ...(q !== '' && { q }),
        sort,
        page,
        ...(registryScope !== '' && { expectedScopeKey: registryScope }),
      });
      if (res.isErr()) return errorOut('list', res.error.message);
      const { rows, total, totalEstimated, caveats, registry, scopeKey } = res.value;
      return {
        ok: true,
        kind: 'list',
        query: { filter: filterArg(args), sort, page: page.page, pageSize: page.pageSize },
        link: `${clientBaseUrl}/companii`,
        items: rows,
        // Structured totals so an agent can tell a capped estimate (≥10,000) from an
        // exact count without parsing the summary text (audit H6).
        meta: {
          totalCount: total,
          totalEstimated,
          pageCount: rows.length,
          registry: mcpRegistry(registry),
          registryScope: scopeKey,
          ...(caveats.length > 0 && { caveats }),
        },
        summary:
          `${n(rows.length)} company(ies) on page ${n(page.page)}` +
          `; ${totalEstimated ? '≥' : ''}${n(total)} match(es)` +
          (caveats.length > 0 ? `. ${caveats.join('; ')}` : '') +
          `. ${registrySentence(registry)}.`,
      };
    },
  };

  const countyProfile: KernelMcpTool = {
    name: 'company_county_profile',
    description:
      "Count-ranked company aggregate over EXACTLY the list_companies predicates and one pinned ONRC edition (meta.registry), with the filtered population as denominator and a coverage block. county/status: each company counts once, under its complete consensus value (county key = county code, label = canonical name; status label = API nomenclature) or an explicit basis bucket ((multiple_values), (partial_observations), (missing), (unresolved), (not_in_edition)) - never coerced into a value. caenDivision: buckets '<revision>:<division>' ('unknown:' for an unknown revision) of the public ONRC observations on identifiers that satisfy the filter's same-identifier criteria; a company counts once per bucket and buckets overlap, so they do not sum to the population. Refused while no edition is published (an error, never zeros). Value-weighted (\"biggest by turnover\") rankings are NOT offered (count-only).",
    inputShape: {
      filter: z
        .record(z.string(), z.unknown())
        .optional()
        .describe('A companies filter object (e.g. { county: { in: ["Cluj"] } }).'),
      groupBy: z
        .enum(['county', 'status', 'caenDivision'])
        .describe('Grouping dimension. county requires a selective filter.'),
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
        meta: {
          denominator: res.value.denominator,
          groupCount: res.value.groups.length,
          coverage: res.value.coverage,
          registry: mcpRegistry(res.value.registry),
        },
        summary:
          `${n(res.value.groups.length)} ${groupBy} group(s); ${n(res.value.denominator)} companies` +
          (top !== undefined
            ? `; top ${top.label ?? top.key} = ${n(top.count)}. ${res.value.coverage.note}`
            : `. ${res.value.coverage.note}`) +
          ` ${registrySentence(res.value.registry)}.`,
      };
    },
  };

  const hubStats: KernelMcpTool = {
    name: 'company_hub_stats',
    description:
      "CUI directory-spine company overview under the CURRENT ONRC edition (NOT the whole ONRC registry): total spine companies; activeCompanies = companies with ANY public original 1048 observation (counted on its own; a company with a conflicting code is active here and in the (multiple_values) status bucket); the status consensus mix with explicit basis buckets; the top 10 county consensus buckets among active companies; and '<revision>:<division>' CAEN buckets of active companies (overlapping). Takes no arguments. Cached per registry scope: every call rechecks the current scope, never serves figures of another edition, and errors (never zeros) when no edition is published. computedAt says when the legs ran.",
    inputShape: {},
    async handler(): Promise<McpToolOutput> {
      const res = await deps.hubStats.get();
      if (res.isErr()) return errorOut('aggregate', res.error.message);
      const s = res.value;
      const topCounty = s.topCounties[0];
      return {
        ok: true,
        kind: 'aggregate',
        link: `${clientBaseUrl}/companii`,
        item: { ...s, registry: mcpRegistry(s.registry) },
        // Structured totals + as-of so an agent never parses the summary text (audit H6).
        meta: {
          totalCompanies: s.totalCompanies,
          activeCompanies: s.activeCompanies,
          computedAt: s.computedAt,
          coverage: s.coverage,
          registry: mcpRegistry(s.registry),
        },
        summary:
          `${n(s.totalCompanies)} companies on the directory spine; ${n(s.activeCompanies)} with an ONRC 1048 (funcțiune) observation` +
          (topCounty !== undefined
            ? `; most active in ${topCounty.label ?? topCounty.key} (${n(topCounty.count)})`
            : '') +
          `; ${n(s.caenDivisions.length)} CAEN bucket(s). Computed ${s.computedAt}. ${registrySentence(s.registry)}. ${s.coverage.note}`,
      };
    },
  };

  const registry: KernelMcpTool = {
    name: 'get_company_registry',
    description:
      'The current ONRC registry envelope (state PUBLISHED / UNPUBLISHED / WITHDRAWN / UNAVAILABLE, edition, source date, interpretation/dimension/eligibility versions, publication and access epochs), its scope key, the accessible published editions, the edition-bound filter fields and the known CAEN revisions. Read fresh. A non-published state means registry facts are unavailable, never zero. Takes no arguments.',
    inputShape: {},
    async handler(): Promise<McpToolOutput> {
      const res = await makeCompanyRegistry(deps);
      if (res.isErr()) return errorOut('registry', res.error.message);
      const r = res.value;
      return {
        ok: true,
        kind: 'registry',
        item: { ...r, registry: mcpRegistry(r.registry) },
        summary: `${registrySentence(r.registry)}; ${n(r.editions.length)} accessible published edition(s).`,
      };
    },
  };

  return [
    resolveFilter,
    getSnapshot,
    listCompanies,
    getFinancials,
    countyProfile,
    hubStats,
    registry,
  ];
};
