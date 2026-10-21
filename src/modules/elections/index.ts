/**
 * Elections results over the scrapper's serving model: per event, one active,
 * audited generation of aggregate figures (votes and mandates per competitor,
 * turnout, coverage) at UAT, county, diaspora and national scope, read only
 * through `elections.serving_active` and the generation tables it activates.
 * Results are party-level: candidate tallies and names are not served
 * (independents appear as competitors under their ballot label). Race figures
 * (leader, runner-up, margin) and shares are computed here from one scope's
 * figures and never sum across scopes, measures or mandate phases.
 * Issues are served as public codes (a missing place keeps its key; any other
 * detail, which can name an internal decision, is dropped); the generation's
 * source inputs are not served until a public provenance contract exists.
 *
 * Pagination: offset pages on all three surfaces (page ≥ 1, pageSize 1-100,
 * exact total), the module's one stated deviation from the foundation's Relay
 * connections; see docs/server-redesign/16-elections.md §6.
 * Disabled (the default), every read refuses without a query and no MCP tool
 * is registered. GraphQL, MCP and the GET REST plugin (`/api/v1/elections`)
 * call the same usecases.
 */
import { electionsTypeDefs, makeElectionsResolvers } from './shell/graphql/schema.js';
import { makeElectionsMcpTools } from './shell/mcp/tools.js';
import { makeElectionsRepo } from './shell/repo/elections-repo.js';
import { makeElectionsRestPlugin } from './shell/rest/routes.js';

import type { ElectionsDeps } from './core/usecases.js';
import type { GraphqlSlice, ProdDatabase } from '@/modules/shared/index.js';
import type { Kysely } from 'kysely';

export const makeElectionsModule = (deps: { db: Kysely<ProdDatabase>; enabled?: boolean }) => {
  const enabled = deps.enabled ?? false;
  const repo = makeElectionsRepo(deps.db, enabled);
  const usecaseDeps: ElectionsDeps = { repo };
  return {
    repo,
    graphqlSlice: { source: 'elections', typeDefs: electionsTypeDefs } satisfies GraphqlSlice,
    graphqlResolvers: makeElectionsResolvers(usecaseDeps),
    mcpTools: enabled ? makeElectionsMcpTools(usecaseDeps) : [],
    restPlugin: makeElectionsRestPlugin(usecaseDeps),
  };
};

export type { ElectionsRepository } from './core/ports.js';
export type { ElectionContest, ElectionEvent, ElectionPage, ElectionResult } from './core/types.js';
