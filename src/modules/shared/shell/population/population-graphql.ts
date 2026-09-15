import { GraphQLError } from 'graphql';
import { sql } from 'kysely';
import { ok } from 'neverthrow';

import { readMapAnnualPopulation } from './map-annual-population.js';
import { isWithheldOrganizationIdentifier } from '../../core/types.js';

import type { AnnualPopulationPort } from './annual-population-port.js';
import type { GraphqlSlice } from '../graphql/merge.js';

/** Annual audit and map lookups; financial amount/period contracts stay intact. */
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
    enum AnnualPopulationMapLevel { UAT County }
    type MapAnnualPopulationValue {
      territoryCode: String!
      territoryId: Int!
      year: Int!
      population: String
      metadata: AnnualPopulationProvenance
    }
    extend type Entity {
      "Population for the selected budget year, only for territorial executives."
      annualPopulation(year: Int!): AnnualPopulationValue
    }
    extend type Query {
      mapAnnualPopulation(year: Int!, granularity: AnnualPopulationMapLevel!): [MapAnnualPopulationValue!]!
      annualPopulation(territoryId: Int!, year: Int!): AnnualPopulationValue
    }
  `,
};

export const annualPopulationResolvers = (population: AnnualPopulationPort) => ({
  Entity: {
    annualPopulation: async (parent: { cui: string }, args: { year: number }) => {
      if (isWithheldOrganizationIdentifier(parent.cui)) return null;
      const result = await population.withSnapshot(async (snapshot) => {
        const { rows } = await sql<{ territory_id: number }>`
          select e.territory_id from core.public_entities e
          join core.territories t on t.id=e.territory_id and t.privacy_class='public'
          where e.cui=${parent.cui} and e.is_territorial_executive
            and not exists (select 1 from core.organizations o where o.cui=e.cui and o.privacy_class<>'public')
        `.execute(snapshot.trx);
        const anchor = rows[0];
        if (anchor === undefined) return ok(null);
        const cells = await snapshot.cells([anchor.territory_id], [args.year]);
        return cells.map((values) => values[0] ?? null);
      });
      if (result.isErr())
        throw new GraphQLError('Annual population is unavailable', {
          extensions: { code: result.error.type },
        });
      return result.value;
    },
  },
  Query: {
    mapAnnualPopulation: async (
      _: unknown,
      args: { year: number; granularity: 'UAT' | 'County' }
    ) => {
      const result = await readMapAnnualPopulation(population, args.year, args.granularity);
      if (result.isErr())
        throw new GraphQLError('Map annual population is unavailable', {
          extensions: { code: result.error.type },
        });
      return result.value;
    },
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
