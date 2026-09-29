import './shell/db/schema.js';

import {
  makeNgoOrganizationResolvers,
  ngoOrganizationTypeDefs,
} from './shell/graphql/organization-schema.js';
import { makeNgoProfileResolvers, ngoProfileTypeDefs } from './shell/graphql/profile-schema.js';
import { makeNgoRegistryResolvers, ngoRegistryTypeDefs } from './shell/graphql/schema.js';
import { makeNgoOrganizationMcpTools } from './shell/mcp/organization-tools.js';
import { makeNgoProfileMcpTools } from './shell/mcp/profile-tools.js';
import { makeNgoRegistryMcpTools } from './shell/mcp/tools.js';
import { makeNgoOrganizationRepo } from './shell/repo/organization-repo.js';
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
  const organizationRepo = makeNgoOrganizationRepo(deps.db, deps.enabled ?? false);
  const organizationResolvers = makeNgoOrganizationResolvers(organizationRepo);
  return {
    repo,
    profileRepo,
    organizationRepo,
    graphqlSlice: {
      source: 'ngos',
      typeDefs: ngoRegistryTypeDefs + ngoProfileTypeDefs + ngoOrganizationTypeDefs,
    } satisfies GraphqlSlice,
    graphqlResolvers: {
      Query: {
        ...makeNgoRegistryResolvers(repo).Query,
        ...makeNgoProfileResolvers(profileRepo).Query,
        ...organizationResolvers.Query,
      },
      NgoOrganizationProfile: organizationResolvers.NgoOrganizationProfile,
      NgoFinancialsSection: organizationResolvers.NgoFinancialsSection,
    },
    mcpTools:
      deps.enabled === true
        ? [
            ...makeNgoRegistryMcpTools(repo, deps.clientBaseUrl ?? 'https://transparenta.eu'),
            ...makeNgoProfileMcpTools(profileRepo, deps.clientBaseUrl ?? 'https://transparenta.eu'),
            ...makeNgoOrganizationMcpTools(
              organizationRepo,
              deps.clientBaseUrl ?? 'https://transparenta.eu'
            ),
          ]
        : [],
  };
};
export type { NgoRegistryRepository } from './core/ports.js';
export type { NgoOrganizationRepository } from './core/organization.js';
export type { NgoRegistryRecord, NgoRegistrySnapshot, NgoRegistryPage } from './core/types.js';
