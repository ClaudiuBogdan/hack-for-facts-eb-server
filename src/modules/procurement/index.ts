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
import { assertProcurementMatrixArtifact } from './shell/matrix-artifact.js';
import { makeProcurementMcpTools } from './shell/mcp/tools.js';
import { makeProcurementAnalysisRepo } from './shell/repo/analysis-repo.js';
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
  assertProcurementMatrixArtifact();
  const repo = makeProcurementRepo(
    deps.db,
    deps.daListMaxWindowDays ?? DA_LIST_MAX_WINDOW_DAYS_DEFAULT,
    deps.opensearch !== undefined ? makeOpenSearchQResolver(deps.opensearch) : undefined,
    deps.logger
  );
  const analysis = makeProcurementAnalysisRepo(deps.db, undefined, Date.now, deps.logger);
  const clientBaseUrl = deps.clientBaseUrl ?? 'https://transparenta.eu';

  if (deps.warmCache !== false) warmEmptyScope(analysis);

  return {
    repo,
    analysis,
    graphqlSlice: { source: 'procurement', typeDefs: procurementTypeDefs },
    graphqlResolvers: makeProcurementResolvers({
      repo,
      analysis,
    }),
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
export { WAVE1_CAPABILITIES, ANALYSIS_MATRIX_SHA256, routeAnalysis } from './core/combinations.js';
export { makeProcurementRepo } from './shell/repo/procurement-repo.js';
export { makeProcurementAnalysisRepo } from './shell/repo/analysis-repo.js';
