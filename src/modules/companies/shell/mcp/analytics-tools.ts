/**
 * Companies analytics — MCP tools. Same usecases, same arguments and the same
 * answer objects as GraphQL (`item` is exactly what the GraphQL root returns),
 * so the two surfaces cannot drift. Zod types the transport only; ranges,
 * caps and release rules are validated in core, so both surfaces return the
 * same typed `InvalidInput` (errorType/errorCode/field) for the same input.
 */

import { z } from 'zod';

import {
  GRAPHQL_ERROR_CODE,
  type ApiError,
  type KernelMcpTool,
  type McpToolOutput,
} from '@/modules/shared/index.js';

import {
  COMPANY_ANALYSIS_CAEN_BASES,
  COMPANY_ANALYSIS_COHORT_MODES,
  COMPANY_ANALYSIS_DIMENSIONS,
  COMPANY_ANALYSIS_DIRECTIONS,
  COMPANY_ANALYSIS_FILING,
  COMPANY_ANALYSIS_FLAG_VALUES,
  COMPANY_ANALYSIS_METRICS,
  COMPANY_ANALYSIS_RANKINGS,
  COMPANY_ANALYSIS_RECORD_SORTS,
  COMPANY_ANALYSIS_SIZE_BANDS,
} from '../../core/analytics-types.js';
import {
  companyAnalysisBreakdown,
  companyAnalysisRecords,
  companyAnalysisRelease,
  companyAnalysisSeries,
  companyAnalysisStats,
  type CompanyAnalysisContext,
} from '../../core/analytics-usecases.js';

import type { Result } from 'neverthrow';

export interface CompanyAnalysisMcpDeps {
  readonly analytics: CompanyAnalysisContext;
  readonly clientBaseUrl: string;
}

const keyFilter = z
  .object({ in: z.array(z.string()).optional(), includeUnknown: z.boolean().optional() })
  .strict();

const onrcFilter = z
  .object({
    status: z.array(z.string()).optional(),
    county: z.array(z.string()).optional(),
    caenCode: z.array(z.string()).optional(),
    onrcCaen: z.array(z.string()).optional(),
    exclude: z
      .object({
        status: z.array(z.string()).optional(),
        caenCode: z.array(z.string()).optional(),
        county: z.array(z.string()).optional(),
        legalForm: z.array(z.string()).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

/** Field names equal `CompanyAnalysisScopeInput` (parity test). */
export const COMPANY_ANALYSIS_SCOPE_ZOD_SHAPE = {
  fiscalYear: z
    .number()
    .optional()
    .describe('Defaults to the release default year (2024 when offered).'),
  cuis: z
    .array(z.string())
    .optional()
    .describe('Selected CUIs (resolve names with resolve_company_filter first).'),
  county: keyFilter
    .optional()
    .describe(
      'County CONSENSUS bucket of the pinned ONRC edition: { in: [county code… or "(multiple_values)", "(partial_observations)", "(missing)", "(unresolved)"], includeUnknown = every basis bucket }'
    ),
  uat: keyFilter
    .optional()
    .describe('UAT consensus bucket: { in: [SIRUTA… or "(<basis>)"], includeUnknown }'),
  legalForms: z.array(z.string()).optional(),
  observedStatus: keyFilter
    .optional()
    .describe(
      'Complete status CONSENSUS bucket (status code or "(<basis>)"); not "currently active" and not an observation filter (use onrc.status).'
    ),
  onrc: onrcFilter
    .optional()
    .describe(
      'ONRC observation filters on ONE public identifier: status, county, caenCode (any revision), onrcCaen ("rev2:6201", exact). exclude { status, caenCode, county, legalForm } needs complete evidence; exclude.onrcCaen is refused.'
    ),
  vatPayer: z.array(z.enum(COMPANY_ANALYSIS_FLAG_VALUES)).optional(),
  fiscallyInactive: z.array(z.enum(COMPANY_ANALYSIS_FLAG_VALUES)).optional(),
  mainCaen: z
    .array(z.object({ code: z.string(), revision: z.string().optional() }).strict())
    .optional()
    .describe('Omit revision for codes whose revision ANAF did not publish.'),
  mainCaenBasis: z.array(z.enum(COMPANY_ANALYSIS_CAEN_BASES)).optional(),
  filing: z.enum(COMPANY_ANALYSIS_FILING).optional(),
  financialRanges: z
    .array(
      z
        .object({
          metric: z.enum(COMPANY_ANALYSIS_METRICS),
          min: z.string().optional(),
          max: z.string().optional(),
        })
        .strict()
    )
    .optional()
    .describe(
      'Bounds on REPORTED values of the fiscal year (decimal strings; integers for EMPLOYEES).'
    ),
  employeeSizeBands: z.array(z.enum(COMPANY_ANALYSIS_SIZE_BANDS)).optional(),
} as const;

const release = z
  .union([z.string(), z.number()])
  .optional()
  .describe(
    'Pin a release id an earlier answer carried; an unavailable pin is refused, never switched.'
  );

const errorOut = (kind: string, error: ApiError): McpToolOutput => ({
  ok: false,
  kind: error.type === 'Timeout' ? 'timeout' : kind,
  errorType: error.type,
  errorCode: GRAPHQL_ERROR_CODE[error.type],
  error: error.message,
  ...(error.type === 'InvalidInput' &&
    error.field !== undefined && { meta: { field: error.field } }),
});

const pick = (args: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> =>
  Object.fromEntries(keys.filter((key) => args[key] !== undefined).map((key) => [key, args[key]]));

const SHAPE_ARGS = {
  stats: ['release', 'scope', 'metrics'],
  breakdown: ['release', 'scope', 'dimension', 'metric', 'rankBy', 'topN'],
  series: ['release', 'scope', 'metric', 'cohortMode', 'fromYear', 'toYear'],
  records: ['release', 'scope', 'sort', 'sortMetric', 'direction', 'metrics', 'first', 'after'],
} as const;
type Shape = keyof typeof SHAPE_ARGS;

export const makeCompanyAnalysisMcpTools = (
  deps: CompanyAnalysisMcpDeps
): readonly KernelMcpTool[] => {
  const link = `${deps.clientBaseUrl}/companii`;

  const respond = <T extends { readonly release: { readonly releaseId: string } }>(
    kind: string,
    query: Record<string, unknown>,
    result: Result<T, ApiError>,
    summary: (value: T) => string,
    meta: (value: T) => Record<string, unknown> = () => ({})
  ): McpToolOutput => {
    if (result.isErr()) return errorOut(kind, result.error);
    return {
      ok: true,
      kind,
      query,
      link,
      item: result.value,
      meta: { releaseId: result.value.release.releaseId, ...meta(result.value) },
      summary: summary(result.value),
    };
  };

  const releaseTool: KernelMcpTool = {
    name: 'get_company_analysis_release',
    description:
      'Companies analytics capabilities: the active (or pinned) release id, the ONRC edition its company dimensions were exported from (release.source: edition, publication epoch, snapshot, source date, versions), fiscal years 2008–2025 with per-metric coverage (reported/missing/held counts), the metric-specific years on offer, dimensions, defaults (FY2024 when offered), limits and the input as-of line. Only schema companies-analytics-ch-v2 is served. Call first and pin release in every aggregate_companies call.',
    strictInput: true,
    inputShape: { release },
    async handler(args): Promise<McpToolOutput> {
      const result = await companyAnalysisRelease(deps.analytics, pick(args, ['release']));
      return respond(
        'company_analysis_release',
        pick(args, ['release']),
        result,
        (r) =>
          `Release ${r.release.releaseId}: ${r.companies} companies, ${r.companyYears} statements, fiscal years ${String(r.fiscalYears[0] ?? '')}–${String(r.fiscalYears.at(-1) ?? '')}; default FY${String(r.defaults.fiscalYear)} ${r.defaults.metric}.`
      );
    },
  };

  const aggregateTool: KernelMcpTool = {
    name: 'aggregate_companies',
    description:
      'Exact companies analytics over ONE scope (OR within a field, AND across fields) on a pinned release: shape=stats (population, filers, metric sums/contributors/coverage), breakdown (top groups + other + unknown = stats; COUNTY/UAT/OBSERVED_STATUS groups are the edition consensus value or an explicit basis group such as "(multiple_values)", each company once), series (annual points, cohortMode EACH_YEAR or REFERENCE_YEAR, gaps named), records (matching companies ranked by a metric, NULLS LAST, cursor pages; onrcRecordedDate is the date ONRC recorded, never a founding date). Money is exact RON decimal strings; EMPLOYEES are summed reported average headcounts (not people); balances/headcounts are never added across years. Company keys are release-snapshot attributes of one pinned ONRC edition, not fiscal-year history; MAIN_CAEN/mainCaen is ANAF.',
    strictInput: true,
    inputShape: {
      shape: z.enum(['stats', 'breakdown', 'series', 'records']),
      release,
      scope: z.object(COMPANY_ANALYSIS_SCOPE_ZOD_SHAPE).strict().optional(),
      metrics: z
        .array(z.enum(COMPANY_ANALYSIS_METRICS))
        .optional()
        .describe('stats/records: metrics to return.'),
      dimension: z.enum(COMPANY_ANALYSIS_DIMENSIONS).optional().describe('Required for breakdown.'),
      metric: z.enum(COMPANY_ANALYSIS_METRICS).optional().describe('breakdown/series metric.'),
      rankBy: z.enum(COMPANY_ANALYSIS_RANKINGS).optional(),
      topN: z.number().optional().describe('breakdown: 1–100, default 10.'),
      cohortMode: z.enum(COMPANY_ANALYSIS_COHORT_MODES).optional(),
      fromYear: z.number().optional(),
      toYear: z.number().optional(),
      sort: z.enum(COMPANY_ANALYSIS_RECORD_SORTS).optional(),
      sortMetric: z.enum(COMPANY_ANALYSIS_METRICS).optional(),
      direction: z.enum(COMPANY_ANALYSIS_DIRECTIONS).optional(),
      first: z.number().optional().describe('records: 1–100, default 25.'),
      after: z.string().optional().describe('records: the endCursor of the previous page.'),
    },
    async handler(args): Promise<McpToolOutput> {
      const rawShape = args['shape'];
      if (typeof rawShape !== 'string' || !Object.hasOwn(SHAPE_ARGS, rawShape))
        return errorOut('company_analysis', {
          type: 'InvalidInput',
          message: 'shape must be one of stats, breakdown, series, records',
          field: 'shape',
        });
      const shape = rawShape as Shape;
      const input = pick(args, SHAPE_ARGS[shape]);
      const kind = `company_analysis_${shape}`;
      const query = { shape, ...input };
      switch (shape) {
        case 'stats':
          return respond(
            kind,
            query,
            await companyAnalysisStats(deps.analytics, input),
            (s) =>
              `FY${String(s.fiscalYear)}: ${s.companies} companies in scope, ${s.filers} with a statement` +
              s.metrics
                .map(
                  (m) =>
                    `; ${m.metric} ${m.sum ?? 'n/a'} ${m.unit} over ${m.contributors} contributors`
                )
                .join('') +
              '.',
            (s) => ({ scopeHash: s.scopeHash })
          );
        case 'breakdown':
          return respond(
            kind,
            query,
            await companyAnalysisBreakdown(deps.analytics, input),
            (b) => {
              const top = b.groups[0];
              return (
                `${String(b.groupCount)} ${b.dimension} group(s), ranked by ${b.rankedBy}` +
                (top === undefined
                  ? ''
                  : `; top ${top.label ?? top.key ?? ''} (${top.companies} companies)`) +
                `; unknown ${b.unknown.companies}, other ${b.other.companies}.`
              );
            },
            (b) => ({ scopeHash: b.scopeHash, groupCount: b.groupCount })
          );
        case 'series':
          return respond(
            kind,
            query,
            await companyAnalysisSeries(deps.analytics, input),
            (s) => {
              const gaps = s.points.filter((p) => !p.available);
              return (
                `${s.metric} ${String(s.fromYear)}–${String(s.toYear)} (${s.cohortMode}): ${String(s.points.length)} point(s), ${String(gaps.length)} gap(s)` +
                (gaps.length === 0
                  ? '.'
                  : ` (${gaps.map((p) => `${String(p.fiscalYear)} ${p.gapReason ?? ''}`).join(', ')}); a gap has no figure, never a zero.`)
              );
            },
            (s) => ({
              scopeHash: s.scopeHash,
              gaps: s.points
                .filter((p) => !p.available)
                .map((p) => ({ fiscalYear: p.fiscalYear, gapReason: p.gapReason })),
            })
          );
        case 'records':
          return respond(
            kind,
            query,
            await companyAnalysisRecords(deps.analytics, input),
            (r) =>
              `${String(r.edges.length)} of ${r.totalCount} companies` +
              (r.pageInfo.hasNextPage
                ? '; more available (pass after = pageInfo.endCursor).'
                : '.'),
            (r) => ({
              scopeHash: r.scopeHash,
              totalCount: r.totalCount,
              endCursor: r.pageInfo.endCursor,
              hasNextPage: r.pageInfo.hasNextPage,
            })
          );
      }
    },
  };

  return [releaseTool, aggregateTool];
};
