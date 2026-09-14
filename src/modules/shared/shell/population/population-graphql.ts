import { GraphQLError } from 'graphql';

import type { AnnualPopulationPort } from './annual-population-port.js';
import type { GraphqlSlice } from '../graphql/merge.js';

/** One-cell audit lookup; ordinary financial amount/period contracts stay intact. */
export const annualPopulationGraphql: GraphqlSlice = {
  source: 'annual-population',
  typeDefs: `
    type AnnualPopulationProvenance {
      calculation: String!
      sourceYearMin: Int!
      sourceYearMax: Int!
      maxCarryAge: Int!
      carriedCount: Int!
      provisionalCount: Int!
      constituentCount: Int!
      sourceCode: String
      sourceUrl: String
      sourceSha256: String
      publicationStatus: String
      sourceLocator: JSON
      loadRunId: String!
      inputSha256: String!
    }
    type AnnualPopulationValue {
      territoryId: Int!
      year: Int!
      population: String
      metadata: AnnualPopulationProvenance
    }
    extend type Query {
      annualPopulation(territoryId: Int!, year: Int!): AnnualPopulationValue
    }
  `,
};

export const annualPopulationResolvers = (population: AnnualPopulationPort) => ({
  Query: {
    annualPopulation: async (_: unknown, args: { territoryId: number; year: number }) => {
      const result = await population.withSnapshot((snapshot) =>
        snapshot.cells([args.territoryId], [args.year])
      );
      if (result.isErr())
        throw new GraphQLError('Annual population is unavailable', {
          extensions: { code: result.error.type },
        });
      return result.value[0] ?? null;
    },
  },
});
