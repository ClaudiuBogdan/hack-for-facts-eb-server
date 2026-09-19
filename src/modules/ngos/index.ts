import './shell/db/schema.js';

import { makeNgoRegistryResolvers, ngoRegistryTypeDefs } from './shell/graphql/schema.js';
import { makeNgoRegistryMcpTools } from './shell/mcp/tools.js';
import { makeNgoRegistryRepo } from './shell/repo/registry-repo.js';

import type { GraphqlSlice, ProdDatabase } from '@/modules/shared/index.js';
import type { Kysely } from 'kysely';

export const makeNgosModule = (deps: {
  db: Kysely<ProdDatabase>;
  enabled?: boolean;
  clientBaseUrl?: string;
}) => {
  const repo = makeNgoRegistryRepo(deps.db, deps.enabled ?? false);
  return {
    repo,
    graphqlSlice: { source: 'ngos', typeDefs: ngoRegistryTypeDefs } satisfies GraphqlSlice,
    graphqlResolvers: makeNgoRegistryResolvers(repo),
    mcpTools:
      deps.enabled === true
        ? makeNgoRegistryMcpTools(repo, deps.clientBaseUrl ?? 'https://transparenta.eu')
        : [],
  };
};
export type { NgoRegistryRepository } from './core/ports.js';
export type { NgoRegistryRecord, NgoRegistrySnapshot, NgoRegistryPage } from './core/types.js';
