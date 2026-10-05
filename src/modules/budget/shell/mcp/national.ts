/**
 * National budget — MCP tools over the same usecases as the GraphQL roots.
 *
 * Each tool returns the exact public payload (`item`) the GraphQL root
 * returns, so both transports share validation, projection and exclusions.
 * The `input` schemas are STRUCTURAL (published in tools/list): field names,
 * required members, `@oneOf` alternatives as strict single-key objects, enum
 * vocabularies from the core and the core's list bounds. The core validator
 * stays the semantic authority (label formats, cross-field rules, UUID case
 * normalisation), exactly as for GraphQL. A changed lane keeps `reason` and
 * `currentSnapshot` in `meta` (local adapter, no kernel change).
 */

import { z } from 'zod';

import {
  GRAPHQL_ERROR_CODE,
  type ApiError,
  type KernelMcpTool,
  type McpToolOutput,
} from '@/modules/shared/index.js';

import {
  MAX_AUTHORITY_CODES,
  MAX_CAPITOLS,
  MAX_EDITION_IDS,
  MAX_SERIES_YEARS,
  MAX_TARGET_YEARS,
  MAX_TOTAL_KEYS,
} from '../../core/national/approved-inputs.js';
import { isSnapshotChanged } from '../../core/national/errors.js';
import {
  DEFAULT_PAGE_SIZE,
  MAX_COMPONENTS,
  MAX_LINE_ITEMS,
  MAX_OBSERVATION_ITEM_IDS,
  MAX_OBSERVATION_MONTHS,
  MAX_PAGE_SIZE,
  MAX_RELEASE_CELLS,
  MAX_RELEASE_MONTHS,
  MAX_REVISIONS_PER_MONTH,
  MAX_SELECTION_IDS,
  MAX_SERIES_ITEMS,
  MAX_SERIES_LABELS,
} from '../../core/national/execution-inputs.js';
import { MAX_YEAR, MIN_YEAR } from '../../core/national/input-rules.js';
import {
  budgetApprovedRecords,
  budgetApprovedSeries,
  budgetApprovedTotals,
  budgetExecutionObservations,
  budgetExecutionReleases,
  budgetNationalCatalog,
  budgetNationalExecutionSeries,
  type NationalUsecaseDeps,
} from '../../core/national/usecases.js';
import {
  APPROVED_FORMS,
  APPROVED_MEASURES,
  APPROVED_UNITS,
  BUDGET_FUNDS,
  CREDIT_TYPES,
  EXECUTION_INPUTS,
  EXECUTION_MEASURES,
  EXECUTION_SECTIONS,
  OBSERVATION_DISPOSITIONS,
  PERIOD_ROLES,
  ROW_ROLES,
  SERIES_BASES,
  TOTAL_KEYS,
  type PeriodType,
} from '../../core/national/vocabulary.js';

import type { Result } from 'neverthrow';

const optional = <S extends z.ZodType>(schema: S) => schema.nullable().optional();

/**
 * A list input. GraphQL coerces a single value to a one-element list, and the
 * core applies the same coercion, so the single-value form is a published
 * alternative here too (same accept/reject verdicts on both transports).
 */
const listOf = <S extends z.ZodType>(item: S, max: number) =>
  z.union([z.array(item).min(1).max(max), item]);

const list = <S extends z.ZodType>(item: S, max: number, what: string) =>
  listOf(item, max).describe(`${what} (1–${String(max)}; omit for the default scope).`);

const year = z.number().int().min(MIN_YEAR).max(MAX_YEAR);

const periodLabel = z
  .string()
  .describe('A label of the declared type: MONTH "YYYY-MM", QUARTER "YYYY-QN", YEAR "YYYY".');

/** The common `ReportPeriodInput`: a type and exactly one of interval or dates. */
const reportPeriod = (types: readonly [PeriodType, ...PeriodType[]], maxLabels: number) =>
  z
    .object({
      type: z.enum(types),
      selection: z
        .union([
          z
            .object({ interval: z.object({ start: periodLabel, end: periodLabel }).strict() })
            .strict(),
          z
            .object({
              dates: listOf(periodLabel, maxLabels).describe('Unique, ascending labels.'),
            })
            .strict(),
        ])
        .describe('Exactly one of { interval: { start, end } } or { dates: [...] } (@oneOf).'),
    })
    .strict()
    .describe(`Report period (${types.join('/')}, at most ${String(maxLabels)} labels).`);

const editionId = z.string().describe('Edition ID "<budgetYear>:<publication>" from the catalog.');

const totalsInput = z
  .object({
    totals: listOf(z.enum(TOTAL_KEYS), MAX_TOTAL_KEYS).describe('Named totals (1–5).'),
    creditTypes: optional(
      list(
        z.enum(CREDIT_TYPES),
        CREDIT_TYPES.length,
        'Required iff a credit total is requested; forbidden revenue-only'
      )
    ),
    editionIds: optional(list(editionId, MAX_EDITION_IDS, 'Editions')),
    funds: optional(list(z.enum(BUDGET_FUNDS), BUDGET_FUNDS.length, 'Funds')),
    measureYears: optional(list(year, MAX_TARGET_YEARS, 'Target years')),
    measures: optional(list(z.enum(APPROVED_MEASURES), APPROVED_MEASURES.length, 'Measures')),
    authorityCodes: optional(
      list(
        z.string().max(8),
        MAX_AUTHORITY_CODES,
        'Printed authority codes (AUTHORITY_EXPENDITURE_5001 only; never 999)'
      )
    ),
    unit: optional(z.enum(APPROVED_UNITS)).describe('THOUSAND_LEI (default) or RON (exact ×1000).'),
  })
  .strict();

const seriesAxis = z
  .union([
    z.object({ targetYearsOfEdition: editionId }).strict(),
    z
      .object({
        editionsForTarget: z
          .object({
            targetYear: year,
            editionIds: optional(
              list(editionId, MAX_EDITION_IDS, 'Candidate editions, one per budget year')
            ),
          })
          .strict(),
      })
      .strict(),
    z
      .object({
        ownYearApprovals: z
          .object({
            editionIds: optional(
              list(editionId, MAX_EDITION_IDS, 'Candidate editions, one per budget year')
            ),
          })
          .strict(),
      })
      .strict(),
  ])
  .describe(
    'Exactly one axis (@oneOf): targetYearsOfEdition | editionsForTarget | ownYearApprovals.'
  );

const seriesInput = z
  .object({
    axis: seriesAxis,
    fund: z.enum(BUDGET_FUNDS),
    total: z.enum(TOTAL_KEYS),
    creditType: optional(z.enum(CREDIT_TYPES)).describe(
      'Required for credit totals, forbidden for revenue.'
    ),
    authorityCode: optional(z.string().max(8)).describe(
      'Required only for AUTHORITY_EXPENDITURE_5001 (targetYearsOfEdition axis).'
    ),
    period: reportPeriod(['YEAR'], MAX_SERIES_YEARS),
    unit: optional(z.enum(APPROVED_UNITS)),
  })
  .strict();

const recordsInput = z
  .object({
    source: z
      .union([
        z
          .object({ edition: z.object({ editionId, form: z.enum(APPROVED_FORMS) }).strict() })
          .strict(),
        z
          .object({
            interpretationId: z.string().describe('Pinned interpretation ID (immutable cursor).'),
          })
          .strict(),
      ])
      .describe(
        'Exactly one source (@oneOf): { edition: { editionId, form } } or { interpretationId }.'
      ),
    authorityCode: optional(z.string().max(8)).describe(
      'STATE_BUDGET_AUTHORITY_DETAIL records only.'
    ),
    rowRoles: optional(list(z.enum(ROW_ROLES), ROW_ROLES.length, 'Row roles')),
    creditTypes: optional(list(z.enum(CREDIT_TYPES), CREDIT_TYPES.length, 'Credit types')),
    capitols: optional(list(z.string().max(16), MAX_CAPITOLS, 'Printed capitol codes')),
  })
  .strict();

const releasesInput = z
  .object({
    months: reportPeriod(['MONTH'], MAX_RELEASE_MONTHS),
    revisionsPerMonth: optional(z.number().int().min(1).max(MAX_REVISIONS_PER_MONTH)).describe(
      `Newest revisions per month (default 1; months × revisions ≤ ${String(MAX_RELEASE_CELLS)}).`
    ),
  })
  .strict();

const observationsInput = z
  .object({
    source: z
      .union([
        z.object({ months: reportPeriod(['MONTH'], MAX_OBSERVATION_MONTHS) }).strict(),
        z
          .object({
            selectionIds: listOf(
              z.string().describe('Selection UUID (any case).'),
              MAX_SELECTION_IDS
            ),
          })
          .strict(),
      ])
      .describe(
        'Exactly one source (@oneOf): { months: ReportPeriod } or { selectionIds: [...] }.'
      ),
    inputs: optional(list(z.enum(EXECUTION_INPUTS), EXECUTION_INPUTS.length, 'Bulletin inputs')),
    components: optional(list(z.string().max(100), MAX_COMPONENTS, 'Printed components')),
    sections: optional(list(z.enum(EXECUTION_SECTIONS), EXECUTION_SECTIONS.length, 'Sections')),
    lineItems: optional(list(z.string().max(200), MAX_LINE_ITEMS, 'Printed line items')),
    itemIds: optional(list(z.string(), MAX_OBSERVATION_ITEM_IDS, 'Catalog item IDs (BGC only)')),
    measures: optional(list(z.enum(EXECUTION_MEASURES), EXECUTION_MEASURES.length, 'Measures')),
    periodRoles: optional(list(z.enum(PERIOD_ROLES), PERIOD_ROLES.length, 'Period roles')),
    dispositions: optional(
      list(
        z.enum(OBSERVATION_DISPOSITIONS),
        OBSERVATION_DISPOSITIONS.length,
        'Default [FACT]; others need one resolved selection'
      )
    ),
  })
  .strict();

const executionSeriesInput = z
  .object({
    itemIds: listOf(z.string(), MAX_SERIES_ITEMS).describe(
      'Catalog item IDs; results keep this order.'
    ),
    period: reportPeriod(['MONTH', 'QUARTER', 'YEAR'], MAX_SERIES_LABELS),
    basis: z
      .enum(SERIES_BASES)
      .describe('YTD or PERIOD_DIFFERENCE with MONTH/QUARTER; FULL_YEAR with YEAR.'),
  })
  .strict();

const expectedSnapshot = optional(z.string()).describe(
  'Optional lane snapshot precondition; a moved lane fails with reason SNAPSHOT_CHANGED.'
);
const first = optional(z.number().int().min(1).max(MAX_PAGE_SIZE)).describe(
  `Page size 1–${String(MAX_PAGE_SIZE)}, default ${String(DEFAULT_PAGE_SIZE)}.`
);
const after = optional(z.string()).describe(
  'endCursor of the previous page; resend the identical input.'
);

const pick = (args: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> =>
  Object.fromEntries(keys.filter((key) => args[key] !== undefined).map((key) => [key, args[key]]));

export const nationalErrorOutput = (kind: string, error: ApiError): McpToolOutput => ({
  ok: false,
  kind,
  errorType: error.type,
  errorCode: GRAPHQL_ERROR_CODE[error.type],
  error: error.message,
  meta: {
    ...(error.type === 'InvalidInput' && error.field !== undefined ? { field: error.field } : {}),
    ...(isSnapshotChanged(error)
      ? { reason: error.reason, currentSnapshot: error.currentSnapshot }
      : {}),
  },
});

const respond = <T>(
  kind: string,
  query: Record<string, unknown>,
  result: Result<T, ApiError>,
  meta: (value: T) => Record<string, unknown>
): McpToolOutput =>
  result.isErr()
    ? nationalErrorOutput(kind, result.error)
    : { ok: true, kind, query, item: result.value, meta: meta(result.value) };

const COMMON =
  'Exact decimal strings (never floats); null is no value, "0" is a printed zero. Never sum rows, funds, credit types, authorities, YTD periods or law with execution. Law document URLs are null until a reviewed source link exists (SOURCE LINK PENDING).';

export const makeNationalMcpTools = (deps: NationalUsecaseDeps): readonly KernelMcpTool[] => [
  {
    name: 'get_budget_national_catalog',
    description: `National budget discovery: loaded law editions (budget year + publication) with their slots and forms, the five named law totals, execution coverage/missing months and the reviewed national series items, plus the approved and execution lane snapshots. Call first. ${COMMON}`,
    strictInput: true,
    inputShape: {},
    async handler(): Promise<McpToolOutput> {
      const result = await budgetNationalCatalog(deps);
      return respond('budget_national_catalog', {}, result, (value) => ({
        snapshots: value.snapshots,
      }));
    },
  },
  {
    name: 'get_budget_approved_totals',
    description: `Named approved-law totals (REVENUE_TOTAL, EXPENDITURE_5000/5001/5005, AUTHORITY_EXPENDITURE_5001) per edition, fund, slot and credit type; each cell has a status (AVAILABLE, SLOT_WITHOUT_VALUE, NO_MATCHING_RECORD, AMBIGUOUS, FORM_NOT_LOADED) and its source line. creditTypes are required iff a credit total is requested. Unit THOUSAND_LEI (default) or RON (exact ×1000). At most 100 cells. ${COMMON} Example: {"input":{"totals":["EXPENDITURE_5001_STATE_BUDGET"],"creditTypes":["BUDGET_CREDITS"],"editionIds":["2025:law_2025_as_sent_to_monitorul_oficial"],"measureYears":[2025],"unit":"RON"}}`,
    strictInput: true,
    inputShape: { input: totalsInput, expectedSnapshot },
    async handler(args): Promise<McpToolOutput> {
      const query = pick(args, ['input', 'expectedSnapshot']);
      const result = await budgetApprovedTotals(deps, query);
      return respond('budget_approved_totals', query, result, (value) => ({
        snapshot: value.snapshot,
        cells: value.cells.length,
      }));
    },
  },
  {
    name: 'get_budget_approved_series',
    description: `One named law total as the common DataSeries over YEAR labels on one axis: targetYearsOfEdition (one law's approval and forecasts), editionsForTarget (successive laws for one target year) or ownYearApprovals. Periods keep chart date, budgetYear and measureYear (target) distinct; only AVAILABLE periods have a DataPoint. ${COMMON} Example: {"input":{"axis":{"editionsForTarget":{"targetYear":2025}},"fund":"STATE_BUDGET","total":"EXPENDITURE_5001_STATE_BUDGET","creditType":"BUDGET_CREDITS","period":{"type":"YEAR","selection":{"interval":{"start":"2022","end":"2025"}}}}}`,
    strictInput: true,
    inputShape: { input: seriesInput, expectedSnapshot },
    async handler(args): Promise<McpToolOutput> {
      const query = pick(args, ['input', 'expectedSnapshot']);
      const result = await budgetApprovedSeries(deps, query);
      return respond('budget_approved_series', query, result, (value) => ({
        snapshot: value.snapshot,
        points: value.series.data.length,
      }));
    },
  },
  {
    name: 'list_budget_approved_records',
    description: `Faithful flat approved-law records of one edition form or one pinned interpretationId, in source order, native THOUSAND_LEI only, one value per loaded slot (null = no stored number). No hierarchy or depth is inferred from codes. Cursor pages are bound to the snapshot (or the pinned interpretation). ${COMMON} Example: {"input":{"source":{"edition":{"editionId":"2025:law_2025_as_sent_to_monitorul_oficial","form":"STATE_BUDGET_AUTHORITY_DETAIL"}},"authorityCode":"01"},"first":50}`,
    strictInput: true,
    inputShape: { input: recordsInput, first, after, expectedSnapshot },
    async handler(args): Promise<McpToolOutput> {
      const query = pick(args, ['input', 'first', 'after', 'expectedSnapshot']);
      const result = await budgetApprovedRecords(deps, query);
      return respond('budget_approved_records', query, result, (value) => ({
        snapshot: value.snapshot,
        hasNextPage: value.pageInfo.hasNextPage,
        endCursor: value.pageInfo.endCursor,
      }));
    },
  },
  {
    name: 'get_budget_execution_releases',
    description: `MF execution bulletin calendar months: the current selected release (or NO_SELECTED_RELEASE, which is not proof that no bulletin existed), bounded revision chains following predecessor links, and family presence exactly as sealed. ${COMMON} Example: {"input":{"months":{"type":"MONTH","selection":{"interval":{"start":"2025-04","end":"2025-06"}}},"revisionsPerMonth":3}}`,
    strictInput: true,
    inputShape: { input: releasesInput, expectedSnapshot },
    async handler(args): Promise<McpToolOutput> {
      const query = pick(args, ['input', 'expectedSnapshot']);
      const result = await budgetExecutionReleases(deps, query);
      return respond('budget_execution_releases', query, result, (value) => ({
        snapshot: value.snapshot,
      }));
    },
  },
  {
    name: 'list_budget_execution_observations',
    description: `Printed MF bulletin observations per selection occurrence (physical node + selection edge), ordered by period, selection, input and key. FACT by default; BLANK/UNRESOLVED/NONFINANCIAL need exactly one resolved selection and only classified cells. BGC and Sinteza stay separate; only BGC maps to catalog items. ${COMMON} Example: {"input":{"source":{"selectionIds":["6110a784-1f51-4bee-8add-cf8bacf8455a"]},"inputs":["BGC"],"dispositions":["FACT","BLANK"]},"first":100}`,
    strictInput: true,
    inputShape: { input: observationsInput, first, after, expectedSnapshot },
    async handler(args): Promise<McpToolOutput> {
      const query = pick(args, ['input', 'first', 'after', 'expectedSnapshot']);
      const result = await budgetExecutionObservations(deps, query);
      return respond('budget_execution_observations', query, result, (value) => ({
        snapshot: value.snapshot,
        hasNextPage: value.pageInfo.hasNextPage,
        endCursor: value.pageInfo.endCursor,
      }));
    },
  },
  {
    name: 'get_budget_national_execution_series',
    description: `Reviewed national consolidated-budget series (BGC, RON) as the common DataSeries, from the audited view: MONTH×YTD, MONTH×PERIOD_DIFFERENCE, QUARTER×YTD, QUARTER×PERIOD_DIFFERENCE or YEAR×FULL_YEAR. periodStart/periodEnd are the interval the value covers; unavailable periods keep the raw view reason and have no DataPoint. Results keep the requested item order. ${COMMON} Example: {"input":{"itemIds":["mfin.bgc.revenue.total"],"basis":"PERIOD_DIFFERENCE","period":{"type":"QUARTER","selection":{"dates":["2025-Q2","2025-Q4"]}}}}`,
    strictInput: true,
    inputShape: { input: executionSeriesInput, expectedSnapshot },
    async handler(args): Promise<McpToolOutput> {
      const query = pick(args, ['input', 'expectedSnapshot']);
      const result = await budgetNationalExecutionSeries(deps, query);
      return respond('budget_national_execution_series', query, result, (value) => ({
        snapshot: value.snapshot,
        results: value.results.length,
      }));
    },
  },
];
