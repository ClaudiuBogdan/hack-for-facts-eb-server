/**
 * Elections catalog and contest metadata over the `elections` dimension tables
 * (source editions, contests, public event links). Results and mandates are
 * not served: no qualified projection exists. Source opening is held: stored
 * artifact custody (restricted by default) is not a client access contract.
 * Disabled (the default), every read refuses without a query and no
 * MCP tool is registered. GraphQL, MCP and the GET REST plugin
 * (`/api/v1/elections`) call the same usecases.
 */
import './shell/db/schema.js';

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
export type { ElectionContest, ElectionEdition, ElectionPage } from './core/types.js';
