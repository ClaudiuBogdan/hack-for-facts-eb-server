/**
 * Public enterprises (docs/server-redesign/15-public-enterprises.md): the AMEPIP /
 * S1001 / JSON-APT core over the five scraper R5 public views only. Kernel
 * identity names the organizations; financials stay in the companies module.
 * Disabled (the default), every read refuses without a query and no MCP tool is
 * registered.
 */
import './shell/db/schema.js';

import { makePublicEnterpriseResolvers, publicEnterpriseTypeDefs } from './shell/graphql/schema.js';
import { makePublicEnterpriseMcpTools } from './shell/mcp/tools.js';
import { makePublicEnterpriseRepo } from './shell/repo/public-enterprise-repo.js';

import type { PublicEnterpriseDeps } from './core/usecases.js';
import type { GraphqlSlice, IdentityRepo, ProdDatabase } from '@/modules/shared/index.js';
import type { Kysely } from 'kysely';

export const makePublicEnterprisesModule = (deps: {
  db: Kysely<ProdDatabase>;
  identityRepo: Pick<IdentityRepo, 'findManyByCui' | 'searchByName'>;
  enabled?: boolean;
}) => {
  const enabled = deps.enabled ?? false;
  const repo = makePublicEnterpriseRepo(deps.db, enabled);
  const usecaseDeps: PublicEnterpriseDeps = { repo, identityRepo: deps.identityRepo };
  const resolvers = makePublicEnterpriseResolvers(usecaseDeps);
  return {
    repo,
    graphqlSlice: {
      source: 'public-enterprises',
      typeDefs: publicEnterpriseTypeDefs,
    } satisfies GraphqlSlice,
    graphqlResolvers: {
      Query: resolvers.Query,
      PublicEnterpriseProfile: resolvers.PublicEnterpriseProfile,
    },
    mcpTools: enabled ? makePublicEnterpriseMcpTools(usecaseDeps) : [],
  };
};

export type { PublicEnterpriseRepository } from './core/ports.js';
export type {
  PublicEnterprisePage,
  PublicEnterpriseProfile,
  PublicEnterpriseSource,
} from './core/types.js';
