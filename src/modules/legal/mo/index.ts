/**
 * Monitorul-Oficial surface (`mo/` area, plan 06 §11) — `makeMonitorulSurface`.
 * Composed INSIDE `makeLegalModule` (the single `legal` module factory); it does
 * NOT register a second module. It returns the `Mo*` typeDefs (incl. the
 * `extend type LegalAct`/`Entity`/`Query` blocks), the resolvers, the MCP tools,
 * and the ONE issuer-keyed contributor — which `legal/index.ts` stitches into the
 * single legal slice + contributor set.
 *
 * Importing this barrel pulls in `./db-schema.js`, whose `declare module` augments
 * `ProdDatabase` with the `legal.mo_*` tables.
 */

import './db-schema.js';

import { ok } from 'neverthrow';

import { makeMonitorulContributor } from './contributor.js';
import { makeMonitorulResolvers, monitorulTypeDefs } from './graphql.js';
import { makeMonitorulMcpTools } from './mcp.js';
import { makeMonitorulRepo } from './repo.js';

import type { MoCoverageDeps } from './usecases.js';
import type { LegalRepoBase } from '../core/repo-base.js';
import type {
  ContributorRegistry,
  IdentityRepo,
  KernelCache,
  KernelMcpTool,
  ProdDatabase,
  SourceContributor,
} from '@/modules/shared/index.js';
import type { Kysely } from 'kysely';

/** The year-range cache TTL (loader-cadence-driven; one bounded scan per window). */
const YEAR_RANGE_TTL_MS = 10 * 60_000;

export interface MonitorulSurfaceDeps {
  readonly db: Kysely<ProdDatabase>;
  /** The 05-owned act identity base (MO reuses `findActsByIds` for act hydration). */
  readonly base: LegalRepoBase;
  /** Kernel identity hub (issuer-slug→org name matching for the contributor). */
  readonly identity: IdentityRepo;
  /** The kernel contributor registry (the `Entity.monitorul` resolver reads it). */
  readonly registry: ContributorRegistry;
  readonly cache: KernelCache;
  readonly clientBaseUrl: string;
}

export interface MonitorulSurface {
  readonly typeDefs: string;
  readonly resolvers: Record<string, unknown>;
  readonly mcpTools: readonly KernelMcpTool[];
  readonly contributor: SourceContributor;
}

export const makeMonitorulSurface = (deps: MonitorulSurfaceDeps): MonitorulSurface => {
  const repo = makeMonitorulRepo(deps.db);

  // Coverage year-range: a process-level memo refreshed on the TTL (foundation
  // §10) — one bounded scan per window, never a per-request unbounded max().
  let cached: { value: { min: number | null; max: number | null }; at: number } | null = null;
  const coverage: MoCoverageDeps = {
    async yearRange() {
      const now = Date.now();
      if (cached !== null && now - cached.at < YEAR_RANGE_TTL_MS) {
        return ok(cached.value);
      }
      const res = await repo.getIssueYearRange();
      if (res.isOk()) cached = { value: res.value, at: now };
      return res;
    },
  };

  const contributor = makeMonitorulContributor({ repo, identity: deps.identity });

  const resolvers = makeMonitorulResolvers({
    repo,
    base: deps.base,
    coverage,
    registry: deps.registry,
  });
  const mcpTools = makeMonitorulMcpTools({ repo, coverage, clientBaseUrl: deps.clientBaseUrl });

  return { typeDefs: monitorulTypeDefs, resolvers, mcpTools, contributor };
};

export { makeMonitorulRepo } from './repo.js';
export { monitorulTypeDefs } from './graphql.js';
export * from './types.js';
export { MO_FILTER_SPECS, moEdgesSpec, moIssuesSpec, moPublicationsSpec } from './filters.js';
