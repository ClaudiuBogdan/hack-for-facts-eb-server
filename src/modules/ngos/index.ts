import './shell/db/schema.js';

import { makeNgoProfileResolvers, ngoProfileTypeDefs } from './shell/graphql/profile-schema.js';
import { makeNgoRegistryResolvers, ngoRegistryTypeDefs } from './shell/graphql/schema.js';
import { makeNgoProfileMcpTools } from './shell/mcp/profile-tools.js';
import { makeNgoRegistryMcpTools } from './shell/mcp/tools.js';
import { makeNgoProfileRepo } from './shell/repo/profile-repo.js';
import { makeNgoRegistryRepo } from './shell/repo/registry-repo.js';

import type { GraphqlSlice, ProdDatabase } from '@/modules/shared/index.js';
import type { Kysely } from 'kysely';

export const makeNgosModule = (deps: {
  db: Kysely<ProdDatabase>;
  enabled?: boolean;
  clientBaseUrl?: string;
}) => {
  const repo = makeNgoRegistryRepo(deps.db, deps.enabled ?? false);
  const profileRepo = makeNgoProfileRepo(deps.db, deps.enabled ?? false);
  return {
    repo,
    profileRepo,
    graphqlSlice: {
      source: 'ngos',
      typeDefs: ngoRegistryTypeDefs + ngoProfileTypeDefs,
    } satisfies GraphqlSlice,
    graphqlResolvers: {
      Query: {
        ...makeNgoRegistryResolvers(repo).Query,
        ...makeNgoProfileResolvers(profileRepo).Query,
      },
    },
    mcpTools:
      deps.enabled === true
        ? [
            ...makeNgoRegistryMcpTools(repo, deps.clientBaseUrl ?? 'https://transparenta.eu'),
            ...makeNgoProfileMcpTools(profileRepo, deps.clientBaseUrl ?? 'https://transparenta.eu'),
          ]
        : [],
  };
};
export type { NgoRegistryRepository } from './core/ports.js';
export type { NgoRegistryRecord, NgoRegistrySnapshot, NgoRegistryPage } from './core/types.js';
