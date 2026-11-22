/**
 * Procurement module — public API (plan §11). Assembles the record + analysis
 * repos, the GraphQL slice, and MCP tools from a kernel Kysely instance.
 *
 * Importing this barrel pulls in `shell/db/schema.ts`, whose `declare module`
 * augments `ProdDatabase` with the retained `procurement.*` tables and analysis rollups.
 */

import './shell/db/schema.js';

import { analysisBreakdown, analysisStats } from './core/analysis-usecases.js';
import { DA_LIST_MAX_WINDOW_DAYS_DEFAULT } from './core/constants.js';
import { makeDaTotalsCache, type DaReleaseDeps } from './core/da-release-usecases.js';
import { makeProcurementContributor } from './shell/contributor.js';
import { daReleaseTypeDefs, makeDaReleaseResolvers } from './shell/graphql/da-release-schema.js';
import { makeProcurementResolvers } from './shell/graphql/resolvers.js';
import { makeTotalsResolvers, totalsTypeDefs } from './shell/graphql/totals-schema.js';
import { procurementTypeDefs } from './shell/graphql/typedefs.js';
import { makeDaReleaseMcpTools } from './shell/mcp/da-release-tools.js';
import { makeProcurementMcpTools } from './shell/mcp/tools.js';
import { makeTotalsMcpTools } from './shell/mcp/totals-tools.js';
import {
  makeClickhouseAnalysisRepo,
  makeUnconfiguredAnalysisRepo,
  type ClickhouseAnalysisConfig,
} from './shell/repo/clickhouse-analysis-repo.js';
import { makeClickhouseMoneyRepo } from './shell/repo/clickhouse-money-repo.js';
import { makeClickhouseReader } from './shell/repo/clickhouse-reader.js';
import { withDaAnalysisDisclosure } from './shell/repo/da-analysis-disclosure.js';
import { withDaDisclosure } from './shell/repo/da-disclosure-repo.js';
import { makeDaReleaseRepo } from './shell/repo/da-release-repo.js';
import { makeDaRoutingAnalysisRepo } from './shell/repo/da-routing-analysis-repo.js';
import { makeDaV3AnalysisSource } from './shell/repo/da-v3-analysis-source.js';
import { makeProcurementGenerationRepo } from './shell/repo/generation-repo.js';
import {
  makeRetiredAnalysisRepo,
  retiredPresenceRepo,
  retireLegacyRecords,
} from './shell/repo/legacy-retired.js';
import {
  makeOpenSearchListEngine,
  type OpenSearchListConfig,
} from './shell/repo/opensearch-list-repo.js';
import { makeProcurementPresenceRepo } from './shell/repo/presence-repo.js';
import { makeProcurementRepo } from './shell/repo/procurement-repo.js';
import { makeSupplierGeographyPolicy } from './shell/repo/supplier-geography-policy.js';
import { makeDaReleaseRestPlugin } from './shell/rest/da-release-routes.js';

import type { AnalysisRepo, ProcurementRepo } from './core/ports.js';
import type {
  GraphqlSlice,
  KernelMcpTool,
  Logger,
  ProdDatabase,
  SourceContributor,
  SupplierDisclosurePort,
} from '@/modules/shared/index.js';
import type { FastifyPluginAsync } from 'fastify';
import type { Kysely } from 'kysely';

export interface ProcurementModuleDeps {
  readonly db: Kysely<ProdDatabase>;
  readonly clientBaseUrl?: string;
  /** Cap on a bare-date DA list window (days). Default 366. Env: PROCUREMENT_DA_LIST_MAX_WINDOW_DAYS. */
  readonly daListMaxWindowDays?: number;
  /** Warm the empty-scope aggregate cache at init (default true). Tests pass false. */
  readonly warmCache?: boolean;
  /** Structured diagnostics for analysis query failures. */
  readonly logger?: Logger;
  /**
   * The analytics backend: ClickHouse wide fact tables answer the analysis
   * shapes (stats/series/breakdown/share/facets/concentration). Generation +
   * quality metadata still come from Postgres `analysis_generations`. When
   * unset the module still boots (lists/search/detail are unaffected) but every
   * analysis read fails with a clear "backend not configured" error.
   * See shell/repo/clickhouse-analysis-repo.ts.
   */
  readonly clickhouse?: ClickhouseAnalysisConfig;
  /**
   * The record-list search engine. When set, the three indexed grains are
   * served by OpenSearch (filters, total order, page window, count, facets)
   * with Postgres hydrating the page by primary key; geography and CPV
   * mid-level filters exist ONLY on this path. Unset, the module still boots
   * and lists fall back to SQL — minus those dimensions, which then fail
   * explicitly. See shell/repo/opensearch-list-repo.ts.
   */
  readonly opensearch?: OpenSearchListConfig;
  /**
   * Direct acquisitions release 1 (`procurement_v3`), beside the legacy DA
   * surface. Off (the default): the SDL and REST routes are served, every data
   * read answers ServiceUnavailable without a query, and no MCP tool is
   * registered. Env: PROCUREMENT_DA_V3_ENABLED.
   */
  readonly daV3Enabled?: boolean;
  /** The kernel's site-wide D6 port (`Kernel.supplierDisclosure`); absent means not enforced. */
  readonly supplierDisclosure?: SupplierDisclosurePort;
  /**
   * Totals v2 (`procurementTotals`), over the money-fact builds. Off (the
   * default): the SDL is served and every read answers ServiceUnavailable.
   * Needs ClickHouse. Env: PROCUREMENT_TOTALS_V2.
   */
  readonly totalsV2Enabled?: boolean;
  /**
   * The legacy procurement reads: records (lists, details, supplier records,
   * search), the legacy ClickHouse analysis (every grain the DA v3 reader does
   * not answer) and entity-360 presence. On (the default) they are served as
   * before. Off, records and presence answer ServiceUnavailable without a
   * query; legacy analysis grains read nothing legacy (ServiceUnavailable with
   * DA v3 off; with it on, the DA generation is read and each legacy block
   * abstains as unavailable). The legacy-only MCP tools are not registered and
   * the cache is not warmed; the CPV reference, DA release 1, the v3 DA grain
   * and totals v2 are unaffected.
   * Env: PROCUREMENT_LEGACY_ENABLED.
   */
  readonly legacyEnabled?: boolean;
}

/** The MCP tools that read only the CPV reference (kept when legacy is off). */
const CPV_REFERENCE_TOOLS: ReadonlySet<string> = new Set(['resolve_procurement_filter']);
/** The analysis tool: kept when legacy is off only while the DA v3 grain answers. */
const ANALYSIS_TOOL = 'aggregate_procurement';

export interface ProcurementModule {
  readonly repo: ProcurementRepo;
  readonly analysis: AnalysisRepo;
  readonly graphqlSlice: GraphqlSlice;
  readonly graphqlResolvers: Record<string, unknown>;
  readonly mcpTools: readonly KernelMcpTool[];
  /** The kernel-registry contributor (entity-360 presence + profile slice). */
  readonly contributor: SourceContributor;
  /** Direct acquisitions release 1 REST, mounted at `/api/v1/procurement/da`. */
  readonly daRestPlugin: FastifyPluginAsync;
}

/**
 * Pre-load the platform-wide (empty-scope) analysis answers into the in-process
 * cache — but ONLY when a generation is active (an unpublished package skips
 * silently; the queries would just error). Fire-and-forget: a warm failure must
 * never crash the process.
 */
const warmEmptyScope = (analysis: AnalysisRepo): void => {
  void (async (): Promise<void> => {
    try {
      const gen = await analysis.activeGeneration();
      if (gen.isErr() || gen.value === null) return;
      const deps = { analysisRepo: analysis };
      await Promise.all([
        analysisStats(deps, { scope: {} }),
        analysisBreakdown(deps, { scope: {}, dimension: 'cpvDivision' }),
      ]);
    } catch {
      // Intentionally swallowed — see above.
    }
  })();
};

export const makeProcurementModule = (deps: ProcurementModuleDeps): ProcurementModule => {
  const legacyEnabled = deps.legacyEnabled ?? true;
  // Site-wide D6 and the free-text gate on the legacy DA reads (a no-op until enforced).
  const servedRepo = withDaDisclosure(
    makeProcurementRepo(
      deps.db,
      deps.daListMaxWindowDays ?? DA_LIST_MAX_WINDOW_DAYS_DEFAULT,
      legacyEnabled && deps.opensearch !== undefined
        ? makeOpenSearchListEngine(deps.opensearch)
        : undefined,
      deps.logger
    ),
    deps.supplierDisclosure
  );
  // Legacy off: outermost, so no record read (nor its D6 wrapper) runs a query; CPV stays.
  const repo = legacyEnabled ? servedRepo : retireLegacyRecords(servedRepo);
  // ClickHouse is the analytics backend; the generation ledger (buildId,
  // quality, matrix_hash) stays authoritative in Postgres and is delegated to.
  // With no ClickHouse configured, analysis reads fail closed with a clear error.
  // One ClickHouse reader per process: every ClickHouse read shares the per-pod cap.
  const clickhouseReader =
    deps.clickhouse !== undefined ? makeClickhouseReader(deps.clickhouse, deps.logger) : undefined;
  const legacyAnalysis = (): AnalysisRepo => {
    const generationRepo = makeProcurementGenerationRepo(deps.db, Date.now, deps.logger);
    const supplierGeography = makeSupplierGeographyPolicy(deps.db, Date.now, deps.logger);
    // Site-wide D6 on the ClickHouse DA grain (its own switch; a v3 rollback never
    // re-exposes a name). A no-op when not enforced.
    return withDaAnalysisDisclosure(
      deps.clickhouse !== undefined
        ? makeClickhouseAnalysisRepo(
            deps.clickhouse,
            () => generationRepo.activeGeneration(),
            deps.logger,
            () => supplierGeography.supplierGeographyPublic(),
            clickhouseReader
          )
        : makeUnconfiguredAnalysisRepo(),
      deps.supplierDisclosure
    );
  };
  // Legacy off: no legacy generation, geography or fact read is built at all.
  const baseAnalysis = legacyEnabled ? legacyAnalysis() : makeRetiredAnalysisRepo();
  // ── DA release 1 (W2): with PROCUREMENT_DA_V3_ENABLED the analysis API's
  // direct_acquisition grain is answered from procurement_v3; every other
  // grain stays on ClickHouse. Off, the analysis repo is unchanged.
  const daV3Source =
    deps.daV3Enabled === true ? makeDaV3AnalysisSource(deps.db, deps.logger) : undefined;
  const analysis =
    daV3Source !== undefined
      ? makeDaRoutingAnalysisRepo(baseAnalysis, daV3Source, deps.logger)
      : baseAnalysis;
  const clientBaseUrl = deps.clientBaseUrl ?? 'https://transparenta.eu';

  if (deps.warmCache !== false && legacyEnabled) warmEmptyScope(analysis);

  const daV3Enabled = deps.daV3Enabled ?? false;
  const daRelease: DaReleaseDeps = {
    repo: makeDaReleaseRepo(deps.db, daV3Enabled),
    totalsCache: makeDaTotalsCache(),
    ...(deps.supplierDisclosure !== undefined && { supplierDisclosure: deps.supplierDisclosure }),
  };
  // PROC-B51G: DA supplier buckets are named only through the v3 source's D6 name gate, per
  // answer. Without the v3 grain no DA supplier bucket is named.
  const daSupplierNames = daV3Source !== undefined ? { namesOf: daV3Source.namesOf } : undefined;
  const legacyResolvers = makeProcurementResolvers({
    repo,
    analysis,
    ...(daSupplierNames !== undefined && { daSupplierNames }),
    ...(deps.supplierDisclosure !== undefined && { supplierDisclosure: deps.supplierDisclosure }),
  });
  const daResolvers = makeDaReleaseResolvers(daRelease);
  const moneyPort =
    deps.totalsV2Enabled === true && clickhouseReader !== undefined
      ? makeClickhouseMoneyRepo({ db: deps.db, reader: clickhouseReader })
      : undefined;
  const totalsResolvers = makeTotalsResolvers(moneyPort, deps.supplierDisclosure);
  const procurementTools = makeProcurementMcpTools({
    repo,
    analysis,
    clientBaseUrl,
    ...(daSupplierNames !== undefined && { daSupplierNames }),
    ...(deps.supplierDisclosure !== undefined && {
      supplierDisclosure: deps.supplierDisclosure,
    }),
  }).filter(
    (tool) =>
      legacyEnabled ||
      CPV_REFERENCE_TOOLS.has(tool.name) ||
      (tool.name === ANALYSIS_TOOL && daV3Enabled)
  );

  return {
    repo,
    analysis,
    graphqlSlice: {
      source: 'procurement',
      typeDefs: `${procurementTypeDefs}\n${daReleaseTypeDefs}\n${totalsTypeDefs}`,
    },
    graphqlResolvers: {
      ...legacyResolvers,
      Query: {
        ...(legacyResolvers['Query'] as Record<string, unknown>),
        ...daResolvers.Query,
        ...totalsResolvers.Query,
      },
    },
    mcpTools: [
      ...procurementTools,
      ...(daV3Enabled ? makeDaReleaseMcpTools(daRelease) : []),
      ...(moneyPort !== undefined ? makeTotalsMcpTools(moneyPort, deps.supplierDisclosure) : []),
    ],
    contributor: makeProcurementContributor(
      legacyEnabled
        ? makeProcurementPresenceRepo(deps.db, deps.supplierDisclosure)
        : retiredPresenceRepo
    ),
    daRestPlugin: makeDaReleaseRestPlugin(daRelease),
  };
};

export type { ProcurementRepo, AnalysisRepo } from './core/ports.js';
export * from './core/types.js';
export {
  PROCUREMENT_FLOW_TYPES,
  PROCUREMENT_DOC_TYPES,
  PROCUREMENT_GRAINS,
  PROCUREMENT_GRAIN_NOTE,
  ANALYSIS_GRAINS,
} from './core/constants.js';
export { PROCUREMENT_FILTER_SPECS } from './core/filters.js';
export { POLICY_TABLE, policyFor } from './core/policy.js';
export { routeAnalysis } from './core/combinations.js';
export { makeProcurementRepo } from './shell/repo/procurement-repo.js';
export { makeProcurementGenerationRepo } from './shell/repo/generation-repo.js';
