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
import { makeProcurementResolvers } from './shell/graphql/resolvers.js';
import { procurementTypeDefs } from './shell/graphql/typedefs.js';
import { makeProcurementMcpTools } from './shell/mcp/tools.js';
import {
  makeClickhouseAnalysisRepo,
  makeUnconfiguredAnalysisRepo,
  type ClickhouseAnalysisConfig,
} from './shell/repo/clickhouse-analysis-repo.js';
import { makeProcurementGenerationRepo } from './shell/repo/generation-repo.js';
import { makeOpenSearchQResolver, type OpenSearchQConfig } from './shell/repo/opensearch-q-repo.js';
import { makeProcurementRepo } from './shell/repo/procurement-repo.js';

import type { AnalysisRepo, ProcurementRepo } from './core/ports.js';
import type { GraphqlSlice, KernelMcpTool, Logger, ProdDatabase } from '@/modules/shared/index.js';
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
   * DEV: when set, the list `q` facet resolves through OpenSearch (Romanian
   * analyzer BM25 → bounded pk id-set) instead of SQL ILIKE, degrading back
   * to ILIKE on any engine failure. See shell/repo/opensearch-q-repo.ts.
   */
  readonly opensearch?: OpenSearchQConfig;
}

export interface ProcurementModule {
  readonly repo: ProcurementRepo;
  readonly analysis: AnalysisRepo;
  readonly graphqlSlice: GraphqlSlice;
  readonly graphqlResolvers: Record<string, unknown>;
  readonly mcpTools: readonly KernelMcpTool[];
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
  const repo = makeProcurementRepo(
    deps.db,
    deps.daListMaxWindowDays ?? DA_LIST_MAX_WINDOW_DAYS_DEFAULT,
    deps.opensearch !== undefined ? makeOpenSearchQResolver(deps.opensearch) : undefined,
    deps.logger
  );
  // ClickHouse is the analytics backend; the generation ledger (buildId,
  // quality, matrix_hash) stays authoritative in Postgres and is delegated to.
  // With no ClickHouse configured, analysis reads fail closed with a clear error.
  const generationRepo = makeProcurementGenerationRepo(deps.db, Date.now, deps.logger);
  const analysis =
    deps.clickhouse !== undefined
      ? makeClickhouseAnalysisRepo(
          deps.clickhouse,
          () => generationRepo.activeGeneration(),
          deps.logger
        )
      : makeUnconfiguredAnalysisRepo();
  const clientBaseUrl = deps.clientBaseUrl ?? 'https://transparenta.eu';

  if (deps.warmCache !== false) warmEmptyScope(analysis);

  return {
    repo,
    analysis,
    graphqlSlice: { source: 'procurement', typeDefs: procurementTypeDefs },
    graphqlResolvers: makeProcurementResolvers({ repo, analysis }),
    mcpTools: makeProcurementMcpTools({ repo, analysis, clientBaseUrl }),
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
