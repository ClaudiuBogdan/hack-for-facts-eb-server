/**
 * Procurement module — public API (plan §11). Assembles the repos (entity +
 * aggregate + analysis), the GraphQL slice, MCP tools, and the cross-source
 * contributor from a kernel Kysely instance. The app registers the slice + tools
 * and the contributor; the procurement flow types (`procurement_contract`,
 * `direct_acquisition`) are already live in the kernel `flows.money_flows` — the
 * module just registers the contributor over them.
 *
 * Importing this barrel pulls in `shell/db/schema.ts`, whose `declare module`
 * augments `ProdDatabase` with the `procurement.*` tables + MVs + analysis rollups.
 */

import './shell/db/schema.js';

import { analysisBreakdown, analysisStats } from './core/analysis-usecases.js';
import { ANALYSIS_MATRIX_SHA256 } from './core/combinations.js';
import { DA_LIST_MAX_WINDOW_DAYS_DEFAULT } from './core/constants.js';
import { makeProcurementContributor } from './shell/contributor.js';
import { makeProcurementResolvers } from './shell/graphql/resolvers.js';
import { procurementTypeDefs } from './shell/graphql/typedefs.js';
import { makeProcurementMcpTools } from './shell/mcp/tools.js';
import { makeProcurementAggregateRepo } from './shell/repo/aggregate-repo.js';
import { makeProcurementAnalysisRepo } from './shell/repo/analysis-repo.js';
import { makeProcurementRepo } from './shell/repo/procurement-repo.js';

import type { AnalysisRepo, ProcurementAggregateRepo, ProcurementRepo } from './core/ports.js';
import type {
  ContributorRegistry,
  GraphqlSlice,
  KernelMcpTool,
  Logger,
  ProdDatabase,
  SourceContributor,
} from '@/modules/shared/index.js';
import type { Kysely } from 'kysely';

export interface ProcurementModuleDeps {
  readonly db: Kysely<ProdDatabase>;
  readonly registry: ContributorRegistry;
  readonly clientBaseUrl?: string;
  /** Cap on a bare-date DA list window (days). Default 366. Env: PROCUREMENT_DA_LIST_MAX_WINDOW_DAYS. */
  readonly daListMaxWindowDays?: number;
  /** Warm the empty-scope aggregate cache at init (default true). Tests pass false. */
  readonly warmCache?: boolean;
  /** For the boot-time matrix drift check; silent when absent. */
  readonly logger?: Logger;
}

export interface ProcurementModule {
  readonly repo: ProcurementRepo;
  readonly aggregate: ProcurementAggregateRepo;
  readonly analysis: AnalysisRepo;
  readonly graphqlSlice: GraphqlSlice;
  readonly graphqlResolvers: Record<string, unknown>;
  readonly mcpTools: readonly KernelMcpTool[];
  readonly contributor: SourceContributor;
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

/**
 * Boot-time matrix drift check (design §6.2): the vendored combinations artifact
 * must match the active generation's `matrix_hash`. Log-only — a drift NEVER
 * fails requests; the matrix rejections themselves stay authoritative. Falls back
 * to the console so the check still fires when no structured logger is wired.
 */
const checkMatrixDrift = (analysis: AnalysisRepo, logger: Logger | undefined): void => {
  void (async (): Promise<void> => {
    try {
      const gen = await analysis.activeGeneration();
      if (gen.isErr() || gen.value === null) return;
      const { matrixHash, buildId } = gen.value;
      if (matrixHash !== null && matrixHash !== ANALYSIS_MATRIX_SHA256) {
        const message = `procurement analysis matrix drift: generation ${buildId} was built against matrix ${matrixHash}, server vendored ${ANALYSIS_MATRIX_SHA256}`;
        if (logger !== undefined) logger.error(message);
        else console.error(message);
      }
    } catch {
      // Log-only path; never propagate.
    }
  })();
};

export const makeProcurementModule = (deps: ProcurementModuleDeps): ProcurementModule => {
  const repo = makeProcurementRepo(
    deps.db,
    deps.daListMaxWindowDays ?? DA_LIST_MAX_WINDOW_DAYS_DEFAULT
  );
  const aggregate = makeProcurementAggregateRepo(deps.db);
  const analysis = makeProcurementAnalysisRepo(deps.db);
  const contributor = makeProcurementContributor(aggregate);
  const clientBaseUrl = deps.clientBaseUrl ?? 'https://transparenta.eu';

  if (deps.warmCache !== false) warmEmptyScope(analysis);
  checkMatrixDrift(analysis, deps.logger);

  return {
    repo,
    aggregate,
    analysis,
    graphqlSlice: { source: 'procurement', typeDefs: procurementTypeDefs },
    graphqlResolvers: makeProcurementResolvers({
      repo,
      aggregate,
      analysis,
      registry: deps.registry,
    }),
    mcpTools: makeProcurementMcpTools({ repo, aggregate, analysis, clientBaseUrl }),
    contributor,
  };
};

export type { ProcurementRepo, ProcurementAggregateRepo, AnalysisRepo } from './core/ports.js';
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
export { makeProcurementContributor, toProfileSlice } from './shell/contributor.js';
export { makeProcurementRepo } from './shell/repo/procurement-repo.js';
export { makeProcurementAggregateRepo } from './shell/repo/aggregate-repo.js';
export { makeProcurementAnalysisRepo } from './shell/repo/analysis-repo.js';
