import { GraphQLError } from 'graphql';

import { GRAPHQL_ERROR_CODE } from '@/modules/shared/index.js';

import { getNgoProfileOverview } from '../../core/usecases.js';

import type { NgoProfileRepository } from '../../core/ports.js';

export const ngoProfileTypeDefs = `
  type NgoFiscalObservation {
    vatPayer: Boolean
    declaredFiscallyInactive: Boolean
    splitVat: Boolean
    mainCaenCode: String
    mainCaenRev: String
    queryDate: Date
    capturedAt: DateTime
    sourceUrl: String!
    sourceSnapshotId: String!
  }
  type NgoFiscalSection { availability: String! data: NgoFiscalObservation }
  type NgoUnreleasedSection { key: String! availability: String! }
  type NgoProfileOverview {
    cui: CUI!
    identityBasis: String!
    registryRecords: [NgoRegistryRecord!]!
    fiscal: NgoFiscalSection!
    sections: [NgoUnreleasedSection!]!
  }
  extend type Query { ngoProfileOverview(cui: CUI!): NgoProfileOverview }
`;
export const makeNgoProfileResolvers = (repo: NgoProfileRepository) => ({
  Query: {
    ngoProfileOverview: async (_root: unknown, args: { cui: string }) => {
      const result = await getNgoProfileOverview(repo, args.cui);
      if (result.isErr())
        throw new GraphQLError(result.error.message, {
          extensions: { code: GRAPHQL_ERROR_CODE[result.error.type] },
        });
      return result.value;
    },
  },
});
