/**
 * Generates tests/golden-master/corpus/client-documents.json from the CLIENT
 * repo's actual source tree, so every document is byte-identical to what the
 * client sends over the legacy `/graphql` transport and every variables
 * object comes from the client's own builders where one exists.
 *
 *   pnpm gm:corpus                 # (re)write the corpus from ../hack-for-facts-eb-client
 *   pnpm gm:corpus:check           # fail when the committed corpus drifts from the client tree
 *   pnpm gm:corpus -- --client /path/to/client   (or GM_CLIENT_REPO=…)
 *
 * How documents are found: inline documents are located by ANCHOR — the one
 * backtick template literal in the cited client file that contains
 * `query <OperationName>` — so the recorded `source` (`file:start-end`) is
 * computed, never hand-maintained, and cannot rot when the file shifts. The
 * INS documents are imported from `ins-queries.ts` (string constants with
 * fragments interpolated) and `InsObservationsBatch` from the client's own
 * `buildInsObservationsBatchQuery`.
 *
 * How variables are derived: the client modules are imported through
 * `client-module-hooks.mts` (path alias, Lingui macro shim, Vite meta
 * substitution) and the real builders are called — `prepareFilterForServer`,
 * `buildEntityIncomeExpenseChartState` (series ids, default year range),
 * `defaultMapFilters`, `defaultEntityAnalyticsFilter`, `buildCommitmentsFilter`
 * (omits `show_period_growth` exactly where the base commitments filter
 * omits it), the challenge-page period builders, the INS filter builders.
 * Where the client hard-codes a literal at the call site, the literal is
 * repeated here with its `file:line` in `variablesSource`. Every variables
 * object is JSON round-tripped, as the client's transport does, so
 * `undefined` members are dropped.
 *
 * `meta.clientCommit` pins the client commit the file was derived from
 * (`+dirty` when the client tree had uncommitted changes); `--check` fails on
 * ANY difference, the pin included — a stale pin is misleading evidence.
 * `meta.clientBranch` is informational and not part of the check.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { register } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { format as prettierFormat, resolveConfig as resolvePrettierConfig } from 'prettier';

import { canonicalJsonStringify } from '../../src/common/canonical-json/index.js';
import {
  validateCorpus,
  type CorpusEntry,
  type CorpusFile,
} from '../../tests/golden-master/corpus.js';

import type { ClientModuleHookData } from './client-module-hooks.mts';

// =============================================================================
// CLI / paths
// =============================================================================

const SERVER_ROOT = path.resolve(import.meta.dirname, '..', '..');
const GENERATOR_ID = 'scripts/gm/gen-client-corpus.mts';
const OUT = path.join(SERVER_ROOT, 'tests', 'golden-master', 'corpus', 'client-documents.json');

interface CliOptions {
  clientRepo: string;
  check: boolean;
}

/**
 * Default client location: a sibling of the server's MAIN checkout (resolved
 * through the git common dir, so a worktree under `.claude/worktrees/` finds
 * the same client repo as the main checkout).
 */
function defaultClientRepo(): string {
  let mainCheckout = SERVER_ROOT;
  try {
    const commonDir = execFileSync(
      'git',
      ['-C', SERVER_ROOT, 'rev-parse', '--path-format=absolute', '--git-common-dir'],
      { encoding: 'utf8' }
    ).trim();
    mainCheckout = path.dirname(commonDir);
  } catch {
    // not a git checkout: fall back to the server root's parent
  }
  return path.resolve(mainCheckout, '..', 'hack-for-facts-eb-client');
}

function parseArgs(argv: readonly string[]): CliOptions {
  let clientRepo = process.env['GM_CLIENT_REPO'] ?? defaultClientRepo();
  let check = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--check') {
      check = true;
    } else if (arg === '--client') {
      const value = argv[i + 1];
      if (value === undefined) throw new Error('--client requires a path');
      clientRepo = value;
      i += 1;
    } else if (arg?.startsWith('--client=') === true) {
      clientRepo = arg.slice('--client='.length);
    } else {
      throw new Error(`Unknown argument: ${String(arg)}`);
    }
  }
  return { clientRepo: path.resolve(clientRepo), check };
}

const options = parseArgs(process.argv.slice(2));
const CLIENT = options.clientRepo;
const CLIENT_SRC = path.join(CLIENT, 'src');
if (!existsSync(path.join(CLIENT_SRC, 'lib', 'api', 'graphql.ts'))) {
  throw new Error(
    `Client repo not found at ${CLIENT} (expected src/lib/api/graphql.ts) — pass --client <path> or set GM_CLIENT_REPO`
  );
}

// =============================================================================
// Client git pin
// =============================================================================

function git(...args: string[]): string {
  return execFileSync('git', ['-C', CLIENT, ...args], { encoding: 'utf8' }).trim();
}

const clientHead = git('rev-parse', 'HEAD');
const clientDirty = git('status', '--porcelain').length > 0;
const clientBranch = git('rev-parse', '--abbrev-ref', 'HEAD');
const clientCommit = clientDirty ? `${clientHead}+dirty` : clientHead;

// =============================================================================
// Client module loading (hooks + Vite meta)
// =============================================================================

declare global {
  /** Runtime stand-ins for Vite's `import.meta.env` / `import.meta.glob` (client-module-hooks.mts). */
  var gmViteEnv: Record<string, unknown>;
  var gmViteGlob: (...args: unknown[]) => Record<string, unknown>;
}

// `src/config/env.ts` validates these at import time; the values are never
// used by a builder (no request is made), they only satisfy the schema.
globalThis.gmViteEnv = {
  DEV: false,
  PROD: true,
  SSR: true,
  MODE: 'gm-corpus',
  BASE_URL: '/',
  VITE_APP_VERSION: 'gm-corpus',
  VITE_APP_NAME: 'gm-corpus',
  VITE_APP_ENVIRONMENT: 'gm-corpus',
  VITE_API_URL: 'http://gm-corpus.invalid',
};
globalThis.gmViteGlob = () => ({});

const hookData: ClientModuleHookData = {
  clientSrc: CLIENT_SRC,
  linguiShimUrl: pathToFileURL(path.join(import.meta.dirname, 'lingui-macro-shim.mts')).href,
};
// `module.registerHooks` (sync, in-thread) is still experimental in Node 24
// and its ordering against tsx's own async hook chain is undocumented;
// `register` is what tsx itself uses, so the two chains compose.
// eslint-disable-next-line @typescript-eslint/no-deprecated -- see above
register('./client-module-hooks.mts', import.meta.url, { data: hookData });

async function importClient<T>(relativeToSrc: string): Promise<T> {
  const mod: unknown = await import(pathToFileURL(path.join(CLIENT_SRC, relativeToSrc)).href);
  return mod as T;
}

// --- the client module surfaces this generator relies on -------------------
// (interfaces mirror the client's exported names verbatim, UPPER_CASE constants included)
/* eslint-disable @typescript-eslint/naming-convention -- mirrors the client's export names */

type Json = Record<string, unknown>;
interface ReportPeriod {
  type: string;
  selection: Json;
}

interface ChartLinksModule {
  buildEntityIncomeExpenseChartState(
    cui: string,
    entityName: string,
    normalizationOptions: Json
  ): { chart: { series: { id: string; type: string; filter?: Json }[] } };
}
interface FilterUtilsModule {
  prepareFilterForServer(filter: Json): Json;
  normalizeAnalyticsFilter(filter: Json): Json;
}
interface MapFiltersModule {
  defaultMapFilters: Json;
}
interface EntityAnalyticsFilterModule {
  defaultEntityAnalyticsFilter: Json;
}
interface UserPreferencesModule {
  DEFAULT_CURRENCY: string;
  DEFAULT_INFLATION_ADJUSTED: boolean;
}
interface CommitmentsApiModule {
  buildCommitmentsFilter(params: {
    reportPeriod: ReportPeriod;
    reportType?: string;
    cui?: string;
    normalization?: string;
    currency?: string;
    inflationAdjusted?: boolean;
    showPeriodGrowth?: boolean;
    excludeTransfers?: boolean;
  }): Json;
}
interface CommitmentsUtilsModule {
  toCommitmentsReportPeriod(reportPeriod: ReportPeriod): ReportPeriod;
}
interface ChallengeQueriesModule {
  buildChallengeEntityAnalysisReportPeriod(params: {
    periodType: string;
    selectedYear: number;
    month: string;
    quarter: string;
  }): ReportPeriod;
  buildChallengeEntityAnalysisTrendPeriod(params: {
    periodType: string;
    selectedYear: number;
  }): ReportPeriod;
}
interface ChartsSchemaModule {
  DEFAULT_SELECTED_YEAR: number;
}
interface NormalizationModule {
  normalizeNormalizationOptions(options: Json): {
    normalization: string;
    currency: string;
    inflation_adjusted: boolean;
    show_period_growth: boolean;
  };
}
interface LessonDataModule {
  CHALLENGE_LESSON_REPORT_PERIOD: ReportPeriod;
  CHALLENGE_LESSON_DEFAULT_CURRENCY: string;
  CHALLENGE_LESSON_DEFAULT_REPORT_TYPE: string;
  CHALLENGE_LESSON_DEFAULT_NATIONAL_EXPENSE_EXCLUSIONS: readonly string[];
}
interface ReportingSchemaModule {
  toReportTypeValue(reportType: string): string;
}
interface ExplorerFilterModule {
  EXPLORER_PAGE_SIZE: number;
  buildDatasetFilterInput(search: Json): Json;
  explorerOffset(search: Json): number;
}
interface DatasetSelectionModule {
  NATIONAL_ENTITY: Json;
  SERIES_MAX_ROWS: number;
  buildSeriesFilter(scope: Json): Json;
}
interface ComparisonsApiModule {
  buildComparisonObservationFilter(params: Json): Json;
}
interface InsStatsFiltersModule {
  buildHistoryFilter(params: { isCounty: boolean; countyCode: string; sirutaCode: string }): Json;
  buildIndicatorPeriodFilter(params: {
    reportPeriod: ReportPeriod;
    isCounty: boolean;
    countyCode: string;
    sirutaCode: string;
  }): Json;
}
interface InsMetricRegistryModule {
  INS_TOP_METRICS_BY_LEVEL: { uat: { code: string }[] };
}
interface LandingConstantsModule {
  LANDING_NATIONAL_DATASET_CODES: readonly string[];
  DECADE_DATASET_CODE: string;
  DECADE_START_YEAR: number;
  DECADE_END_YEAR: number;
  EXAMPLE_DATASET_CODE: string;
  EXAMPLE_TERRITORY_CODES: readonly string[];
}
interface InsQueriesModule extends Record<string, unknown> {
  buildInsObservationsBatchQuery(codes: readonly string[]): { query: string };
}
/* eslint-enable @typescript-eslint/naming-convention -- end of the client-mirroring interfaces */

const chartLinks = await importClient<ChartLinksModule>('lib/chart-links.ts');
const filterUtils = await importClient<FilterUtilsModule>('lib/filterUtils.ts');
const mapFilters = await importClient<MapFiltersModule>('schemas/map-filters.ts');
const entityAnalyticsFilter = await importClient<EntityAnalyticsFilterModule>(
  'hooks/useEntityAnalyticsFilter.ts'
);
const userPreferences = await importClient<UserPreferencesModule>('lib/user-preferences.ts');
const commitmentsApi = await importClient<CommitmentsApiModule>('lib/api/commitments.ts');
const commitmentsUtils = await importClient<CommitmentsUtilsModule>(
  'components/entities/views/commitments-utils.ts'
);
const challengeQueries = await importClient<ChallengeQueriesModule>(
  'features/challenges/components/analysis/challenge-entity-analysis-queries.ts'
);
const chartsSchema = await importClient<ChartsSchemaModule>('schemas/charts.ts');
const normalization = await importClient<NormalizationModule>('lib/normalization.ts');
const lessonData = await importClient<LessonDataModule>(
  'features/challenges/hooks/use-challenge-lesson-entity-data.ts'
);
const reportingSchema = await importClient<ReportingSchemaModule>('schemas/reporting.ts');
const explorerFilter = await importClient<ExplorerFilterModule>(
  'features/statistics/lib/explorer-filter.ts'
);
const datasetSelection = await importClient<DatasetSelectionModule>(
  'features/statistics/lib/dataset-selection.ts'
);
const comparisonsApi = await importClient<ComparisonsApiModule>(
  'features/statistics/api/comparisons-api.ts'
);
const insStatsFilters = await importClient<InsStatsFiltersModule>(
  'components/entities/views/ins-stats-view.filters.ts'
);
const insMetricRegistry = await importClient<InsMetricRegistryModule>(
  'lib/ins/ins-metric-registry.ts'
);
const landingConstants = await importClient<LandingConstantsModule>(
  'features/statistics/lib/landing-constants.ts'
);
const insQueries = await importClient<InsQueriesModule>(
  'features/statistics/api/graphql/ins-queries.ts'
);

// =============================================================================
// Document location (anchored, never by hand-maintained line numbers)
// =============================================================================

interface LocatedText {
  text: string;
  source: string;
}

function lineOf(fileText: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i += 1) {
    if (fileText.charCodeAt(i) === 10) line += 1;
  }
  return line;
}

/**
 * The one backtick template literal in `file` whose content contains
 * `query|mutation <operationName>`; throws when there is none or more than one,
 * or when the literal interpolates (`${`) — such a document would not be
 * byte-identical to what the client sends.
 */
function inlineDocument(file: string, operationName: string): LocatedText {
  const fileText = readFileSync(path.join(CLIENT_SRC, file), 'utf8');
  const anchor = new RegExp(`\\b(query|mutation)\\s+${operationName}\\b`);
  const matches: { text: string; start: number; end: number }[] = [];
  const literal = /`([^`]*)`/g;
  for (const match of fileText.matchAll(literal)) {
    const inner = match[1] ?? '';
    if (!anchor.test(inner)) continue;
    matches.push({ text: inner, start: match.index, end: match.index + match[0].length - 1 });
  }
  const found = matches[0];
  if (matches.length !== 1 || found === undefined) {
    throw new Error(
      `${file}: expected exactly one template literal containing "${operationName}", found ${String(matches.length)}`
    );
  }
  if (found.text.includes('${')) {
    throw new Error(
      `${file}: the "${operationName}" document interpolates (\${) — not a literal document`
    );
  }
  return {
    text: found.text,
    source: `src/${file}:${String(lineOf(fileText, found.start))}-${String(lineOf(fileText, found.end))}`,
  };
}

/** Line range of `export const <name> = \`…\`` / `export function <name>(…) {…}` in `file` (source only). */
function declarationRange(file: string, name: string): string {
  const fileText = readFileSync(path.join(CLIENT_SRC, file), 'utf8');
  const lines = fileText.split('\n');
  const startIndex = lines.findIndex(
    (line) =>
      line.startsWith(`export const ${name} =`) || line.startsWith(`export function ${name}(`)
  );
  const startLine = lines[startIndex];
  if (startIndex < 0 || startLine === undefined)
    throw new Error(`${file}: declaration "${name}" not found`);
  const isFunction = startLine.startsWith('export function');
  let endIndex = -1;
  for (let i = startIndex; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (isFunction ? line === '}' : i > startIndex && line.trimEnd().endsWith('`')) {
      endIndex = i;
      break;
    }
    if (
      !isFunction &&
      i === startIndex &&
      line.trimEnd().endsWith('`') &&
      line.split('`').length === 3
    ) {
      endIndex = i;
      break;
    }
  }
  if (endIndex < 0) throw new Error(`${file}: end of declaration "${name}" not found`);
  return `src/${file}:${String(startIndex + 1)}-${String(endIndex + 1)}`;
}

const INS_QUERIES_FILE = 'features/statistics/api/graphql/ins-queries.ts';

function insDocument(constantName: string): LocatedText {
  const text = insQueries[constantName];
  if (typeof text !== 'string')
    throw new Error(`${INS_QUERIES_FILE}: "${constantName}" is not a string export`);
  return { text, source: declarationRange(INS_QUERIES_FILE, constantName) };
}

// =============================================================================
// Variables (builders first, literals with their call site otherwise)
// =============================================================================

/** What the client's transport does to every variables object (`JSON.stringify`): drops `undefined`. */
function wire<T>(value: T): T {
  // eslint-disable-next-line no-restricted-syntax -- round-trip of a value this script just built
  return JSON.parse(JSON.stringify(value)) as T;
}

const CUI = '4305857'; // Municipiul Cluj-Napoca
const SIRUTA = '54975'; // Cluj-Napoca (LAU)
const COUNTY = 'CJ';

// challenge-entity-analysis-page.tsx: queryNormalizationOptions defaults —
// normalization 'total' (route search default), currency DEFAULT_CURRENCY,
// inflation DEFAULT_INFLATION_ADJUSTED, show_period_growth CHALLENGE_SHOW_PERIOD_GROWTH (false).
const PAGE_NORMALIZATION_OPTIONS = {
  normalization: 'total',
  currency: userPreferences.DEFAULT_CURRENCY,
  inflation_adjusted: userPreferences.DEFAULT_INFLATION_ADJUSTED,
  show_period_growth: false,
};
const pageNormalization = normalization.normalizeNormalizationOptions(PAGE_NORMALIZATION_OPTIONS);

// --- charts: the entity income/expense chart (series ids + year range from the builder)
const incomeExpenseChart = chartLinks.buildEntityIncomeExpenseChartState(
  CUI,
  'Municipiul Cluj-Napoca',
  PAGE_NORMALIZATION_OPTIONS
);
const executionAnalyticsInputs = incomeExpenseChart.chart.series
  .filter((series) => series.type === 'line-items-aggregated-yearly')
  .map((series) => {
    const filter = series.filter ?? {};
    // components/charts/hooks/useChartData.ts: normalizeAnalyticsFilter({...filter, account_category})
    // lib/api/charts.ts getChartAnalytics: prepareFilterForServer(filter)
    const normalized = filterUtils.normalizeAnalyticsFilter({
      ...filter,
      account_category: filter['account_category'] ?? 'ch',
    });
    return { seriesId: series.id, filter: filterUtils.prepareFilterForServer(normalized) };
  });
if (executionAnalyticsInputs.length !== 2) {
  throw new Error(
    `expected 2 line-items-aggregated-yearly series, got ${String(executionAnalyticsInputs.length)}`
  );
}

// --- map: routes/map.tsx normalizedFilters over defaultMapFilters, then prepareFilterForServer
const mapFilter = filterUtils.prepareFilterForServer({
  ...mapFilters.defaultMapFilters,
  account_category: mapFilters.defaultMapFilters['account_category'] ?? 'ch',
  normalization: 'total',
  currency: userPreferences.DEFAULT_CURRENCY,
  inflation_adjusted: userPreferences.DEFAULT_INFLATION_ADJUSTED,
});

// --- entity analytics: routes/entity-analytics.tsx effectiveFilter over defaultEntityAnalyticsFilter
const entityAnalyticsEffectiveFilter = {
  ...entityAnalyticsFilter.defaultEntityAnalyticsFilter,
  normalization: 'total',
  currency: userPreferences.DEFAULT_CURRENCY,
  inflation_adjusted: userPreferences.DEFAULT_INFLATION_ADJUSTED,
};
const entityAnalyticsServerFilter = filterUtils.prepareFilterForServer(
  entityAnalyticsEffectiveFilter
);
const entityAnalyticsSort = { by: 'total_amount', order: 'desc' };

// --- aggregated line items: the lesson's national read (use-challenge-lesson-entity-data.ts:207-216)
const lessonNationalFilter = filterUtils.prepareFilterForServer({
  account_category: 'ch',
  report_period: lessonData.CHALLENGE_LESSON_REPORT_PERIOD,
  report_type: reportingSchema.toReportTypeValue(lessonData.CHALLENGE_LESSON_DEFAULT_REPORT_TYPE),
  normalization: 'total',
  currency: lessonData.CHALLENGE_LESSON_DEFAULT_CURRENCY,
  inflation_adjusted: false,
  is_uat: true,
  exclude: {
    economic_prefixes: [...lessonData.CHALLENGE_LESSON_DEFAULT_NATIONAL_EXPENSE_EXCLUSIONS],
  },
});

// --- commitments: challenge-entity-analysis-page.tsx periods → Commitments.tsx → buildCommitmentsFilter
const analysisReportPeriod = challengeQueries.buildChallengeEntityAnalysisReportPeriod({
  periodType: 'YEAR',
  selectedYear: chartsSchema.DEFAULT_SELECTED_YEAR,
  month: '01',
  quarter: 'Q1',
});
const analysisTrendPeriod = challengeQueries.buildChallengeEntityAnalysisTrendPeriod({
  periodType: 'YEAR',
  selectedYear: chartsSchema.DEFAULT_SELECTED_YEAR,
});
// Commitments.tsx:120-133 — the base filter does NOT pass showPeriodGrowth.
const commitmentsFilter = commitmentsApi.buildCommitmentsFilter({
  reportPeriod: commitmentsUtils.toCommitmentsReportPeriod(analysisReportPeriod),
  reportType: 'PRINCIPAL_AGGREGATED',
  cui: CUI,
  normalization: pageNormalization.normalization,
  currency: pageNormalization.currency,
  inflationAdjusted: pageNormalization.inflation_adjusted,
  excludeTransfers: true,
});
// Commitments.tsx:135-146 — the trend filter passes showPeriodGrowth explicitly.
const commitmentsTrendFilter = commitmentsApi.buildCommitmentsFilter({
  reportPeriod: commitmentsUtils.toCommitmentsReportPeriod(analysisTrendPeriod),
  reportType: 'PRINCIPAL_AGGREGATED',
  cui: CUI,
  normalization: pageNormalization.normalization,
  currency: pageNormalization.currency,
  inflationAdjusted: pageNormalization.inflation_adjusted,
  showPeriodGrowth: pageNormalization.show_period_growth,
  excludeTransfers: true,
});
const COMMITMENTS_AGGREGATED_PAGE_SIZE = 500; // lib/api/commitments.ts fetchCommitmentsAggregatedAll pageSize default

// --- INS
const landingCodes = [...landingConstants.LANDING_NATIONAL_DATASET_CODES];
const insTopUatCodes = insMetricRegistry.INS_TOP_METRICS_BY_LEVEL.uat.map((metric) => metric.code);
const seriesScopeNationalTotal = {
  territory: null,
  territoryDefaulted: true,
  classifications: new Map([
    ['SEX', 'TOTAL'],
    ['AGE_GROUP', 'TOTAL'],
  ]),
  defaultedTypes: new Set(['SEX', 'AGE_GROUP']),
  unitCode: null,
  unitDefaulted: true,
  periodicity: null,
};
const seriesFilter = datasetSelection.buildSeriesFilter(seriesScopeNationalTotal);
const comparisonFilter = comparisonsApi.buildComparisonObservationFilter({
  datasetCode: 'FOM104D',
  territoryCodes: ['RO', COUNTY, SIRUTA],
  classificationPins: [],
  unitCode: null,
});
const historyFilter = insStatsFilters.buildHistoryFilter({
  isCounty: false,
  countyCode: COUNTY,
  sirutaCode: SIRUTA,
});
const indicatorPeriodFilter = insStatsFilters.buildIndicatorPeriodFilter({
  reportPeriod: analysisReportPeriod,
  isCounty: false,
  countyCode: COUNTY,
  sirutaCode: SIRUTA,
});
const batch = insQueries.buildInsObservationsBatchQuery(insTopUatCodes);

// =============================================================================
// Entries
// =============================================================================

const entries: CorpusEntry[] = [];

function add(entry: Omit<CorpusEntry, 'document' | 'source'> & { located: LocatedText }): void {
  const { located, ...rest } = entry;
  entries.push({
    ...rest,
    document: located.text,
    source: located.source,
    variables: wire(rest.variables),
  });
}

const PICK = { search: '', limit: 100, offset: 0 }; // hooks/useMultiSelectInfinite pageSize 100, offset paging

// ── 1.1 charts / datasets / heatmaps / entity analytics / national budget ──
add({
  id: 'execution-analytics-entity-income-expense',
  located: inlineDocument('lib/api/charts.ts', 'GetExecutionLineItemsAnalytics'),
  status: 'live',
  timeoutMs: 180000,
  variablesSource:
    'lib/chart-links.ts buildEntityIncomeExpenseChartState (series ids + defaultYearRange) → components/charts/hooks/useChartData.ts normalizeAnalyticsFilter → lib/api/charts.ts getChartAnalytics prepareFilterForServer',
  variables: { inputs: executionAnalyticsInputs },
});
const staticChart = inlineDocument('lib/api/charts.ts', 'GetStaticChartAnalytics');
add({
  id: 'static-chart-analytics-ro',
  located: staticChart,
  status: 'live',
  variablesSource:
    'lib/api/charts.ts getStaticChartAnalytics (lang omitted when locale is not en); ids from server datasets/yaml',
  variables: { seriesIds: ['ro.economics.gdp.yearly', 'ro.demographics.population.yearly'] },
});
add({
  id: 'static-chart-analytics-en',
  located: staticChart,
  status: 'live',
  variablesSource: 'lib/api/charts.ts getStaticChartAnalytics (lang: "en")',
  variables: {
    seriesIds: ['ro.economics.gdp.yearly', 'ro.demographics.population.yearly'],
    lang: 'en',
  },
});
add({
  id: 'get-datasets-invalid',
  located: inlineDocument('lib/api/datasets.ts', 'GetDatasets'),
  status: 'invalid-today',
  variablesSource: 'lib/api/datasets.ts getDatasets (lang: locale.toUpperCase())',
  note: 'Selects data { x y } on Dataset, which has no data field — validation error today; the client swallows it (hooks/filters/useDatasetStore.tsx).',
  variables: { ids: ['ro.economics.gdp.yearly'], lang: 'RO' },
});
const datasetsList = inlineDocument(
  'components/charts/components/series-config/DatasetList.tsx',
  'Datasets'
);
add({
  id: 'datasets-list-ro',
  located: datasetsList,
  status: 'live',
  variablesSource:
    'DatasetList.tsx (useMultiSelectInfinite pageSize 100, lang omitted when not en)',
  variables: { search: '', limit: 100, offset: 0 },
});
add({
  id: 'datasets-list-en',
  located: datasetsList,
  status: 'live',
  variablesSource: 'DatasetList.tsx (lang: "en")',
  variables: { search: '', limit: 100, offset: 0, lang: 'en' },
});
add({
  id: 'heatmap-county-default-map',
  located: inlineDocument('lib/api/dataDiscovery.ts', 'GetHeatmapCountyData'),
  status: 'live',
  timeoutMs: 180000,
  variablesSource:
    'schemas/map-filters.ts defaultMapFilters → routes/map.tsx normalizedFilters (DEFAULT_CURRENCY, DEFAULT_INFLATION_ADJUSTED) → lib/api/dataDiscovery.ts prepareFilterForServer',
  variables: { filter: mapFilter },
});
add({
  id: 'heatmap-uat-default-map',
  located: inlineDocument('lib/api/dataDiscovery.ts', 'GetHeatmapUATData'),
  status: 'live',
  timeoutMs: 180000,
  variablesSource:
    'same as heatmap-county-default-map (routes/map.tsx prefetches both by mapViewType)',
  variables: { filter: mapFilter },
});
const entityAnalyticsDoc = inlineDocument('lib/api/entity-analytics.ts', 'EntityAnalytics');
add({
  id: 'entity-analytics-table-default',
  located: entityAnalyticsDoc,
  status: 'live',
  timeoutMs: 180000,
  variablesSource:
    'hooks/useEntityAnalyticsFilter.ts defaultEntityAnalyticsFilter → routes/entity-analytics.tsx effectiveFilter (pageSize 25, no sort) → lib/api/entity-analytics.ts fetchEntityAnalytics prepareFilterForServer',
  variables: { filter: entityAnalyticsServerFilter, limit: 25, offset: 0 },
});
add({
  id: 'entity-analytics-sorted-total-amount-desc',
  located: entityAnalyticsDoc,
  status: 'live',
  timeoutMs: 180000,
  variablesSource:
    'routes/entity-analytics.lazy.tsx (sort {by: mapColumnIdToSortBy("total_amount"), order: "desc"})',
  variables: {
    filter: entityAnalyticsServerFilter,
    sort: entityAnalyticsSort,
    limit: 25,
    offset: 0,
  },
});
add({
  id: 'entity-analytics-csv-export-page',
  located: entityAnalyticsDoc,
  status: 'live',
  timeoutMs: 180000,
  variablesSource: 'routes/entity-analytics.lazy.tsx CSV export loop (pageSizeBatch 500)',
  variables: {
    filter: entityAnalyticsServerFilter,
    sort: entityAnalyticsSort,
    limit: 500,
    offset: 0,
  },
});
const aggregatedDoc = inlineDocument('lib/api/entity-analytics.ts', 'AggregatedLineItems');
add({
  id: 'aggregated-line-items-lesson-national',
  located: aggregatedDoc,
  status: 'live',
  timeoutMs: 300000,
  variablesSource:
    'features/challenges/hooks/use-challenge-lesson-entity-data.ts useChallengeLessonNationalAggregatedLineItems (limit 150000; BudgetCodeAnchors.tsx passes CHALLENGE_LESSON_DEFAULT_NATIONAL_EXPENSE_EXCLUSIONS) → fetchAggregatedLineItems prepareFilterForServer',
  variables: { filter: lessonNationalFilter, limit: 150000 },
});
add({
  id: 'aggregated-line-items-entity-analytics-page',
  located: aggregatedDoc,
  status: 'live',
  timeoutMs: 300000,
  variablesSource:
    'routes/entity-analytics.lazy.tsx fetchAggregatedLineItems({ filter: effectiveFilter, limit: 150000 }) with an entity_cuis filter',
  variables: {
    filter: filterUtils.prepareFilterForServer({
      ...entityAnalyticsEffectiveFilter,
      entity_cuis: [CUI],
    }),
    limit: 150000,
  },
});
add({
  id: 'national-budget-sectors',
  located: inlineDocument('features/national-budget/national-budget-api.ts', 'BudgetSectors'),
  status: 'live',
  variablesSource: 'national-budget-api.ts fetchBudgetSectors (limit 100, offset 0)',
  variables: { limit: 100, offset: 0 },
});
add({
  id: 'national-budget-funding-sources',
  located: inlineDocument(
    'features/national-budget/national-budget-api.ts',
    'NationalBudgetFundingSources'
  ),
  status: 'live',
  variablesSource: 'national-budget-api.ts fetchFundingSources (limit 200, offset 0)',
  variables: { limit: 200, offset: 0 },
});
const entitySearch = inlineDocument('lib/api/entities.ts', 'EntitySearch');
add({
  id: 'entity-search-cluj-napoca',
  located: entitySearch,
  status: 'live',
  variablesSource:
    'lib/api/entities.ts searchEntities ← components/entities/EntitySearch/useEntitySearch.ts (limit 8)',
  variables: { filter: { search: 'Cluj-Napoca' }, limit: 8 },
});
add({
  id: 'entity-search-uat-only',
  located: entitySearch,
  status: 'live',
  variablesSource:
    'lib/api/entities.ts searchEntities with options.isUat (campaign entity selector)',
  variables: { filter: { search: 'Cluj', is_uat: true }, limit: 8 },
});
add({
  id: 'entity-search-uat-finder',
  located: entitySearch,
  status: 'live',
  variablesSource: 'features/learning/components/interactive/useUATFinder.ts (SEARCH_LIMIT 15)',
  variables: { filter: { search: 'Sibiu' }, limit: 15 },
});

// ── 1.2 commitments ──
add({
  id: 'commitments-summary-entity-2025',
  located: inlineDocument('lib/api/commitments.ts', 'CommitmentsSummary'),
  status: 'live',
  timeoutMs: 120000,
  variablesSource:
    'lib/api/commitments.ts buildCommitmentsFilter ← components/entities/views/Commitments.tsx base filter (no showPeriodGrowth) ← challenge-entity-analysis-page.tsx reportPeriod (YEAR DEFAULT_SELECTED_YEAR); fetchCommitmentsSummary defaults limit 50 offset 0',
  variables: { filter: commitmentsFilter, limit: 50, offset: 0 },
});
add({
  id: 'commitments-line-items-entity-2025',
  located: inlineDocument('lib/api/commitments.ts', 'CommitmentsLineItems'),
  status: 'dead',
  timeoutMs: 120000,
  variablesSource:
    'lib/api/commitments.ts fetchCommitmentsLineItems (defaults limit 50 offset 0) — no non-test consumer',
  variables: { filter: commitmentsFilter, limit: 50, offset: 0 },
});
const commitmentsAggregated = inlineDocument('lib/api/commitments.ts', 'CommitmentsAggregated');
add({
  id: 'commitments-aggregated-credite-bugetare-definitive',
  located: commitmentsAggregated,
  status: 'live',
  timeoutMs: 120000,
  variablesSource:
    'Commitments.tsx budgetAggInput → useCommitmentsAggregatedAll → lib/api/commitments.ts fetchCommitmentsAggregatedAll (limit overridden to pageSize 500, offset 0)',
  variables: {
    input: {
      filter: commitmentsFilter,
      metric: 'CREDITE_BUGETARE_DEFINITIVE',
      limit: COMMITMENTS_AGGREGATED_PAGE_SIZE,
      offset: 0,
    },
  },
});
add({
  id: 'commitments-aggregated-plati-trezor',
  located: commitmentsAggregated,
  status: 'live',
  timeoutMs: 120000,
  variablesSource:
    'lib/api/commitments.ts buildPaidAggregatedInputs → fetchCommitmentsAggregatedAll (pageSize 500)',
  variables: {
    input: {
      filter: commitmentsFilter,
      metric: 'PLATI_TREZOR',
      limit: COMMITMENTS_AGGREGATED_PAGE_SIZE,
      offset: 0,
    },
  },
});
add({
  id: 'commitments-analytics-entity-trend',
  located: inlineDocument('lib/api/commitments.ts', 'CommitmentsAnalytics'),
  status: 'live',
  timeoutMs: 120000,
  variablesSource:
    'Commitments.tsx analyticsInputs (three series over trendFilter, showPeriodGrowth passed) ← challenge-entity-analysis-page.tsx trendPeriod (buildChallengeEntityAnalysisTrendPeriod over defaultYearRange)',
  variables: {
    inputs: [
      { filter: commitmentsTrendFilter, metric: 'CREDITE_BUGETARE_DEFINITIVE', seriesId: 'budget' },
      { filter: commitmentsTrendFilter, metric: 'CREDITE_ANGAJAMENT', seriesId: 'commitments' },
      { filter: commitmentsTrendFilter, metric: 'PLATI_TREZOR', seriesId: 'payments_trezor' },
    ],
  },
});
add({
  id: 'commitment-vs-execution-entity',
  located: inlineDocument('lib/api/commitments.ts', 'CommitmentVsExecution'),
  status: 'dead',
  timeoutMs: 120000,
  variablesSource: 'lib/api/commitments.ts fetchCommitmentVsExecution — no non-test consumer',
  variables: { input: { filter: commitmentsFilter, commitments_metric: 'PLATI_TREZOR' } },
});

// ── 1.3 labels ──
add({
  id: 'entity-names',
  located: inlineDocument('lib/api/labels.ts', 'EntityNames'),
  status: 'live',
  variablesSource: 'lib/api/labels.ts getEntityLabels (ids stringified)',
  variables: { entityCuis: [CUI, '4270740'] },
});
add({
  id: 'uat-names-invalid',
  located: inlineDocument('lib/api/labels.ts', 'UatNames'),
  status: 'invalid-today',
  variablesSource: 'lib/api/labels.ts getUatLabels',
  note: '$uatIds declared [String!]! but UATFilterInput.ids is [ID!] — validation error today; fetcher returns [].',
  variables: { uatIds: ['1'] },
});
add({
  id: 'functional-classification-names',
  located: inlineDocument('lib/api/labels.ts', 'FunctionalClassificationNames'),
  status: 'live',
  variablesSource: 'lib/api/labels.ts getFunctionalClassificationLabels',
  variables: { codes: ['65.02', '51.02'] },
});
add({
  id: 'economic-classification-names',
  located: inlineDocument('lib/api/labels.ts', 'EconomicClassificationNames'),
  status: 'live',
  variablesSource: 'lib/api/labels.ts getEconomicClassificationLabels',
  variables: { codes: ['10.01', '20.01'] },
});
add({
  id: 'budget-sector-names-invalid',
  located: inlineDocument('lib/api/labels.ts', 'BudgetSectorNames'),
  status: 'invalid-today',
  variablesSource: 'lib/api/labels.ts getBudgetSectorLabels',
  note: '$ids declared [String!] but BudgetSectorFilterInput.sector_ids is [ID!] — validation error today.',
  variables: { ids: ['1', '2'] },
});
add({
  id: 'funding-source-names-invalid',
  located: inlineDocument('lib/api/labels.ts', 'FundingSourceNames'),
  status: 'invalid-today',
  variablesSource: 'lib/api/labels.ts getFundingSourceLabels',
  note: '$ids declared [String!] but FundingSourceFilterInput.source_ids is [ID!] — validation error today.',
  variables: { ids: ['1', '4'] },
});
add({
  id: 'all-functional-classifications',
  located: inlineDocument('lib/api/labels.ts', 'AllFunctionalClassifications'),
  status: 'live',
  timeoutMs: 120000,
  variablesSource: 'lib/api/labels.ts getAllFunctionalClassifications (no variables)',
  variables: {},
});
add({
  id: 'all-economic-classifications',
  located: inlineDocument('lib/api/labels.ts', 'AllEconomicClassifications'),
  status: 'live',
  timeoutMs: 120000,
  variablesSource: 'lib/api/labels.ts getAllEconomicClassifications (no variables)',
  variables: {},
});

// ── 1.4 filter pickers (useMultiSelectInfinite, pageSize 100, offset paging) ──
add({
  id: 'picker-budget-sectors',
  located: inlineDocument(
    'components/filters/budget-sector-filter/BudgetSectorFilter.tsx',
    'BudgetSectors'
  ),
  status: 'live',
  variablesSource: 'BudgetSectorFilter.tsx fetchPage',
  variables: PICK,
});
add({
  id: 'picker-counties',
  located: inlineDocument('components/filters/county-filter/CountyList.tsx', 'Counties'),
  status: 'live',
  variablesSource: 'CountyList.tsx fetchPage',
  variables: PICK,
});
const economicPicker = inlineDocument(
  'components/filters/economic-classification-filter/EconomicClassificationList.tsx',
  'EconomicClassifications'
);
add({
  id: 'picker-economic-classifications',
  located: economicPicker,
  status: 'live',
  variablesSource: 'EconomicClassificationList.tsx fetchPage',
  variables: PICK,
});
add({
  id: 'picker-economic-classifications-search-code',
  located: economicPicker,
  status: 'live',
  variablesSource: 'EconomicClassificationList.tsx fetchPage (code search)',
  variables: { search: '10.01', limit: 100, offset: 0 },
});
const entityPicker = inlineDocument('components/filters/entity-filter/EntityList.tsx', 'Entities');
add({
  id: 'picker-entities',
  located: entityPicker,
  status: 'live',
  variablesSource: 'EntityList.tsx fetchPage',
  variables: PICK,
});
add({
  id: 'picker-entities-search-cluj',
  located: entityPicker,
  status: 'live',
  variablesSource: 'EntityList.tsx fetchPage (search term)',
  variables: { search: 'Cluj', limit: 100, offset: 0 },
});
add({
  id: 'picker-functional-classifications',
  located: inlineDocument(
    'components/filters/functional-classification-filter/FunctionalClassificationList.tsx',
    'FunctionalClassifications'
  ),
  status: 'live',
  variablesSource: 'FunctionalClassificationList.tsx fetchPage',
  variables: PICK,
});
add({
  id: 'picker-funding-sources',
  located: inlineDocument(
    'components/filters/funding-source-filter/FundingSourceFilter.tsx',
    'FundingSources'
  ),
  status: 'live',
  variablesSource: 'FundingSourceFilter.tsx fetchPage',
  variables: PICK,
});
const uatPicker = inlineDocument('components/filters/uat-filter/UatList.tsx', 'Uats');
add({
  id: 'picker-uats',
  located: uatPicker,
  status: 'live',
  variablesSource: 'UatList.tsx fetchPage',
  variables: PICK,
});
add({
  id: 'picker-uats-search-cluj',
  located: uatPicker,
  status: 'live',
  variablesSource: 'UatList.tsx fetchPage (search term)',
  variables: { search: 'Cluj', limit: 100, offset: 0 },
});

// ── 1.5a INS validated fetchers (statistics-fetchers.ts) ──
const territories = insDocument('INS_TERRITORIES_QUERY');
add({
  id: 'ins-territories-search-cluj',
  located: territories,
  status: 'live',
  variablesSource:
    'features/statistics/api/territory-search-api.ts (limit 20) → graphql/statistics-fetchers.ts searchInsTerritories',
  variables: { filter: { search: 'Cluj' }, limit: 20, offset: 0 },
});
add({
  id: 'ins-territories-counties',
  located: territories,
  status: 'live',
  variablesSource:
    'features/statistics/hooks/use-comparisons.ts countyQuery ({levels: [NUTS3]}, limit 60)',
  variables: { filter: { levels: ['NUTS3'] }, limit: 60, offset: 0 },
});
add({
  id: 'ins-territories-by-siruta',
  located: territories,
  status: 'live',
  variablesSource:
    'features/statistics/hooks/use-comparisons.ts identityQuery (sirutaCodes, limit 1)',
  variables: { filter: { sirutaCodes: [SIRUTA] }, limit: 1, offset: 0 },
});
const explorer = insDocument('INS_DATASETS_EXPLORER_QUERY');
add({
  id: 'ins-datasets-explorer-default',
  located: explorer,
  status: 'live',
  variablesSource:
    'features/statistics/lib/explorer-filter.ts buildDatasetFilterInput({}), EXPLORER_PAGE_SIZE, explorerOffset({}) → statistics-fetchers.ts fetchInsDatasetPage',
  variables: {
    filter: explorerFilter.buildDatasetFilterInput({}),
    limit: explorerFilter.EXPLORER_PAGE_SIZE,
    offset: explorerFilter.explorerOffset({}),
  },
});
add({
  id: 'ins-datasets-explorer-available-search',
  located: explorer,
  status: 'live',
  variablesSource:
    'explorer-filter.ts buildDatasetFilterInput({ q, stare: "available" }) (use-comparisons.ts useComparisonDatasetSearch)',
  variables: {
    filter: explorerFilter.buildDatasetFilterInput({ q: 'populatia', stare: 'available' }),
    limit: explorerFilter.EXPLORER_PAGE_SIZE,
    offset: explorerFilter.explorerOffset({}),
  },
});
add({
  id: 'statistics-landing-data',
  located: insDocument('STATISTICS_LANDING_DATA_QUERY'),
  status: 'live',
  timeoutMs: 120000,
  variablesSource:
    'features/statistics/api/statistics-api.ts fetchLandingData + lib/landing-constants.ts (SSR loader routes/statistici/index.tsx)',
  variables: {
    nationalCodes: landingCodes,
    decadeCode: landingConstants.DECADE_DATASET_CODE,
    decadeYears: [
      String(landingConstants.DECADE_START_YEAR),
      String(landingConstants.DECADE_END_YEAR),
    ],
    exampleCode: landingConstants.EXAMPLE_DATASET_CODE,
    exampleTerritories: [...landingConstants.EXAMPLE_TERRITORY_CODES],
  },
});
add({
  id: 'statistics-landing-catalog',
  located: insDocument('STATISTICS_LANDING_CATALOG_QUERY'),
  status: 'live',
  variablesSource:
    'statistics-fetchers.ts fetchStatisticsLandingCatalog (no variables; SSR loader routes/statistici/index.tsx)',
  variables: {},
});
add({
  id: 'statistics-uat-snapshot-cluj-napoca',
  located: insDocument('STATISTICS_UAT_SNAPSHOT_QUERY'),
  status: 'live',
  variablesSource:
    'statistics-api.ts fetchUatSnapshot (LANDING_NATIONAL_DATASET_CODES) → statistics-fetchers.ts fetchStatisticsUatSnapshot',
  variables: { siruta: SIRUTA, codes: landingCodes },
});
add({
  id: 'statistics-dataset-tier0-pop107d-national',
  located: insDocument('STATISTICS_DATASET_TIER0_QUERY'),
  status: 'live',
  variablesSource:
    'routes/statistici/seturi/$cod.tsx (NATIONAL_ENTITY, lib/dataset-selection.ts) → statistics-fetchers.ts fetchStatisticsDatasetTier0',
  variables: { code: 'POP107D', codes: ['POP107D'], entity: datasetSelection.NATIONAL_ENTITY },
});
const series = insDocument('STATISTICS_DATASET_SERIES_QUERY');
add({
  id: 'statistics-dataset-series-pop107d-national',
  located: series,
  status: 'live',
  timeoutMs: 120000,
  variablesSource:
    'lib/dataset-selection.ts buildSeriesFilter (national scope, SEX+AGE_GROUP TOTAL), SERIES_MAX_ROWS → statistics-fetchers.ts fetchStatisticsDatasetSeries (withRelated = contextCode !== null)',
  variables: {
    code: 'POP107D',
    filter: seriesFilter,
    limit: datasetSelection.SERIES_MAX_ROWS,
    contextCode: null,
    withRelated: false,
  },
});
add({
  id: 'statistics-dataset-series-pop107d-with-related',
  located: series,
  status: 'live',
  timeoutMs: 120000,
  variablesSource:
    'same builder with a context code (@include(if: $withRelated) exercised); contextCode "1" is the level-0 social-statistics context',
  variables: {
    code: 'POP107D',
    filter: seriesFilter,
    limit: datasetSelection.SERIES_MAX_ROWS,
    contextCode: '1',
    withRelated: true,
  },
});
add({
  id: 'statistics-territory-hub-cluj-napoca',
  located: insDocument('STATISTICS_TERRITORY_HUB_QUERY'),
  status: 'live',
  timeoutMs: 180000,
  variablesSource:
    'statistics-api.live.ts → statistics-fetchers.ts fetchStatisticsTerritoryHubData',
  variables: { sirutaCode: SIRUTA },
});
const hubContext = insDocument('STATISTICS_TERRITORY_HUB_CONTEXT_QUERY');
add({
  id: 'statistics-territory-hub-context-cj',
  located: hubContext,
  status: 'live',
  variablesSource:
    'statistics-fetchers.ts fetchStatisticsTerritoryHubContext (withCounty = countyCode !== null; benchmarkCodes = LANDING_NATIONAL_DATASET_CODES)',
  variables: { countyCode: COUNTY, benchmarkCodes: landingCodes, withCounty: true },
});
add({
  id: 'statistics-territory-hub-context-no-county',
  located: hubContext,
  status: 'live',
  variablesSource:
    'statistics-fetchers.ts fetchStatisticsTerritoryHubContext with countyCode null (@include toggle exercised)',
  variables: { countyCode: null, benchmarkCodes: landingCodes, withCounty: false },
});

// ── 1.5b INS unvalidated fetchers (ins-fetchers.ts) ──
add({
  id: 'ins-uat-dashboard-cluj-napoca',
  located: insDocument('INS_UAT_DASHBOARD_QUERY'),
  status: 'dead',
  timeoutMs: 180000,
  variablesSource:
    'graphql/ins-fetchers.ts getInsUatDashboard — no non-test consumer; contextCode omitted',
  variables: { sirutaCode: SIRUTA, period: '2022' },
});
add({
  id: 'ins-datasets-by-codes',
  located: insDocument('INS_DATASETS_BY_CODES_QUERY'),
  status: 'dead',
  variablesSource:
    'graphql/ins-fetchers.ts getInsDatasetsByCodes (limit: min(codes.length, 200)) — only reached through dead getInsCountyDashboard',
  variables: { codes: ['POP107D', 'FOM104D'], limit: Math.min(2, 200) },
});
add({
  id: 'ins-contexts-all',
  located: insDocument('INS_CONTEXTS_QUERY'),
  status: 'live',
  variablesSource:
    'components/entities/views/ins-stats-view.tsx useInsContexts (limit 500) → ins-fetchers.ts getInsContexts',
  variables: { limit: 500, offset: 0 },
});
const datasets = insDocument('INS_DATASETS_QUERY');
add({
  id: 'ins-datasets-catalog-uat',
  located: datasets,
  status: 'live',
  timeoutMs: 120000,
  variablesSource:
    'ins-stats-view.tsx useInsDatasetCatalog ({hasUatData: true}, limit 500) → ins-fetchers.ts getInsDatasetsCatalog',
  variables: { filter: { hasUatData: true }, limit: 500, offset: 0 },
});
add({
  id: 'ins-datasets-search-populatia',
  located: datasets,
  status: 'live',
  variablesSource:
    'components/charts/components/series-config/ins-dataset-list.tsx → ins-fetchers.ts searchInsDatasets (limit 50)',
  variables: { filter: { search: 'populatia' }, limit: 50, offset: 0 },
});
add({
  id: 'ins-dataset-details-pop107d',
  located: insDocument('INS_DATASET_DETAILS_QUERY'),
  status: 'live',
  variablesSource:
    'ins-fetchers.ts getInsDatasetDetails (dataset-detail-api.ts, comparisons-api.ts)',
  variables: { code: 'POP107D' },
});
add({
  id: 'ins-dataset-dimension-values-pop107d-dim0',
  located: insDocument('INS_DATASET_DIMENSION_VALUES_QUERY'),
  status: 'live',
  variablesSource:
    'ins-fetchers.ts getInsDatasetDimensionValues (search defaults to "", limit 50, offset 0)',
  variables: { datasetCode: 'POP107D', dimensionIndex: 0, search: '', limit: 50, offset: 0 },
});
add({
  id: 'ins-observations-comparison-fom104d',
  located: insDocument('INS_OBSERVATIONS_QUERY'),
  status: 'live',
  timeoutMs: 120000,
  variablesSource:
    'features/statistics/api/comparisons-api.ts buildComparisonObservationFilter (RO + county + LAU), COMPARISON_OBSERVATION_LIMIT 500 → ins-fetchers.ts getInsObservationsPage',
  variables: { datasetCode: 'FOM104D', filter: comparisonFilter, limit: 500, offset: 0 },
});
add({
  id: 'ins-dataset-history-pop107d-cluj-napoca',
  located: insDocument('INS_DATASET_HISTORY_QUERY'),
  status: 'live',
  timeoutMs: 120000,
  variablesSource:
    'components/entities/views/ins-stats-view.filters.ts buildHistoryFilter (LAU) → ins-fetchers.ts getInsDatasetHistory (pageSize 1000, offset 0)',
  variables: { datasetCode: 'POP107D', filter: historyFilter, limit: 1000, offset: 0 },
});
add({
  id: 'ins-dataset-dimensions-pop107d',
  located: insDocument('INS_DATASET_DIMENSIONS_QUERY'),
  status: 'live',
  variablesSource:
    'ins-fetchers.ts getInsDatasetDimensions (lib/hooks/use-ins-dashboard.ts insDatasetDimensionsQueryOptions)',
  variables: { datasetCode: 'POP107D' },
});
add({
  id: 'ins-observations-batch-uat-top-metrics',
  located: {
    text: batch.query,
    source: declarationRange(INS_QUERIES_FILE, 'buildInsObservationsBatchQuery'),
  },
  status: 'live',
  timeoutMs: 120000,
  variablesSource:
    'buildInsObservationsBatchQuery(INS_TOP_METRICS_BY_LEVEL.uat codes, lib/ins/ins-metric-registry.ts) + ins-stats-view.filters.ts buildIndicatorPeriodFilter(page reportPeriod, LAU) → ins-fetchers.ts getInsObservationsBatch (limit 200)',
  variables: { filter: indicatorPeriodFilter, limit: 200 },
});

// ── 1.6 campaign ──
add({
  id: 'campaign-uat-directory',
  located: inlineDocument(
    'features/campaigns/buget/api/subscription-stats.ts',
    'CampaignUatDirectory'
  ),
  status: 'dead',
  timeoutMs: 120000,
  variablesSource:
    'subscription-stats.ts (CAMPAIGN_UAT_DIRECTORY_LIMIT 4000 — hook use-campaign-uat-directory.ts unreferenced)',
  variables: { limit: 4000 },
});

// =============================================================================
// Output / check
// =============================================================================

const generated: CorpusFile = {
  meta: { generator: GENERATOR_ID, clientCommit, clientBranch },
  entries,
};

// The loader's own validation: unique ids/keys, one operation, variables declared.
const cases = validateCorpus(generated);
const distinctDocuments = new Set(cases.map((c) => c.document)).size;
console.log(
  `corpus: ${String(cases.length)} entries, ${String(distinctDocuments)} distinct documents, ` +
    `${String(cases.filter((c) => c.status === 'dead').length)} dead, ` +
    `${String(cases.filter((c) => c.status === 'invalid-today').length)} invalid-today; ` +
    `client ${clientBranch}@${clientCommit}`
);

// Formatted with the repo's prettier config so the committed file is stable
// under `pnpm format:check` (JSON arrays are re-flowed by prettier).
const prettierConfig = (await resolvePrettierConfig(OUT)) ?? {};
const text = await prettierFormat(JSON.stringify(generated, null, 2), {
  ...prettierConfig,
  filepath: OUT,
});

function canonical(value: unknown): string {
  if (value === undefined) return '<absent>';
  const result = canonicalJsonStringify(value);
  if (result.isErr()) throw new Error(result.error.message);
  return result.value;
}

if (options.check) {
  if (!existsSync(OUT)) {
    console.error(`DRIFT: ${OUT} does not exist — run pnpm gm:corpus`);
    process.exit(1);
  }
  // eslint-disable-next-line no-restricted-syntax -- the committed corpus, shape-validated by validateCorpus below
  const committed = JSON.parse(readFileSync(OUT, 'utf8')) as CorpusFile;
  validateCorpus(committed);
  const problems: string[] = [];
  // The PIN is generator + commit. `clientBranch` is informational only: a
  // detached HEAD reports `HEAD`, and the same commit on another branch is
  // the same source.
  for (const field of ['generator', 'clientCommit'] as const) {
    if (committed.meta[field] !== generated.meta[field]) {
      problems.push(
        `meta.${field} differs: committed ${committed.meta[field]} vs client ${generated.meta[field]}`
      );
    }
  }
  const committedById = new Map(committed.entries.map((entry) => [entry.id, entry]));
  const generatedById = new Map(generated.entries.map((entry) => [entry.id, entry]));
  for (const id of committedById.keys()) {
    if (!generatedById.has(id)) problems.push(`entry "${id}" is committed but no longer generated`);
  }
  for (const [id, entry] of generatedById) {
    const before = committedById.get(id);
    if (before === undefined) {
      problems.push(`entry "${id}" is generated but not committed`);
      continue;
    }
    for (const field of [
      'document',
      'variables',
      'source',
      'status',
      'variablesSource',
      'timeoutMs',
      'note',
    ] as const) {
      if (canonical(before[field]) !== canonical(entry[field])) {
        problems.push(
          `entry "${id}": ${field} differs (committed ${canonical(before[field]).slice(0, 120)} … vs client ${canonical(entry[field]).slice(0, 120)} …)`
        );
      }
    }
  }
  if (
    committed.entries.map((e) => e.id).join(',') !== generated.entries.map((e) => e.id).join(',')
  ) {
    problems.push('entry order differs');
  }
  if (problems.length > 0) {
    console.error(
      `DRIFT: ${OUT} differs from the client tree in ${String(problems.length)} way(s):`
    );
    for (const problem of problems) console.error(`  - ${problem}`);
    console.error('Run pnpm gm:corpus to regenerate.');
    process.exit(1);
  }
  console.log(`OK: ${OUT} matches the client tree at ${clientCommit}`);
} else {
  writeFileSync(OUT, text, 'utf8');
  console.log(`wrote ${OUT}`);
}
