/**
 * UAT Module GraphQL Resolvers
 *
 * Implements Query resolvers for UAT data access.
 * The UAT.county_entity field is resolved via Mercurius loaders.
 */

import { getUAT } from '../../core/usecases/get-uat.js';
import { listUATs } from '../../core/usecases/list-uats.js';

import type { UATRepository } from '../../core/ports.js';
import type { UAT, UATFilter } from '../../core/types.js';
import type { IResolvers, MercuriusContext } from 'mercurius';

// ─────────────────────────────────────────────────────────────────────────────
// GraphQL Input Types
// ─────────────────────────────────────────────────────────────────────────────

interface GqlUATFilterInput {
  id?: string;
  ids?: string[];
  uat_key?: string;
  uat_code?: string;
  name?: string;
  county_code?: string;
  county_name?: string;
  region?: string;
  search?: string;
  is_county?: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Converts GraphQL UATFilterInput to internal UATFilter.
 */
const mapGqlFilterToUATFilter = (gqlFilter?: GqlUATFilterInput): UATFilter => {
  if (gqlFilter === undefined) {
    return {};
  }
  const filter: UATFilter = {};
  if (gqlFilter.id !== undefined) filter.id = Number.parseInt(gqlFilter.id, 10);
  if (gqlFilter.ids !== undefined) filter.ids = gqlFilter.ids.map((id) => Number.parseInt(id, 10));
  if (gqlFilter.uat_key !== undefined) filter.uat_key = gqlFilter.uat_key;
  if (gqlFilter.uat_code !== undefined) filter.uat_code = gqlFilter.uat_code;
  if (gqlFilter.name !== undefined) filter.name = gqlFilter.name;
  if (gqlFilter.county_code !== undefined) filter.county_code = gqlFilter.county_code;
  if (gqlFilter.county_name !== undefined) filter.county_name = gqlFilter.county_name;
  if (gqlFilter.region !== undefined) filter.region = gqlFilter.region;
  if (gqlFilter.search !== undefined) filter.search = gqlFilter.search;
  if (gqlFilter.is_county !== undefined) filter.is_county = gqlFilter.is_county;
  return filter;
};

// ─────────────────────────────────────────────────────────────────────────────
// Resolver Dependencies
// ─────────────────────────────────────────────────────────────────────────────

export interface MakeUATResolversDeps {
  uatRepo: UATRepository;
}

// ─────────────────────────────────────────────────────────────────────────────
// Resolver Factory
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Creates GraphQL resolvers for the UAT module.
 */
export const makeUATResolvers = (deps: MakeUATResolversDeps): IResolvers => {
  const { uatRepo } = deps;

  return {
    // ─────────────────────────────────────────────────────────────────────────
    // Query Resolvers
    // ─────────────────────────────────────────────────────────────────────────

    Query: {
      uat: async (
        _parent: unknown,
        args: { id: string },
        context: MercuriusContext
      ): Promise<UAT | null> => {
        const id = Number.parseInt(args.id, 10);
        if (Number.isNaN(id)) {
          throw new Error('[VALIDATION_ERROR] Invalid UAT ID');
        }

        const result = await getUAT({ uatRepo }, { id });

        if (result.isErr()) {
          context.reply.log.error(
            { err: result.error, id: args.id },
            `[${result.error.type}] ${result.error.message}`
          );
          throw new Error(`[${result.error.type}] ${result.error.message}`);
        }

        return result.value;
      },

      uats: async (
        _parent: unknown,
        args: { filter?: GqlUATFilterInput; limit?: number; offset?: number },
        context: MercuriusContext
      ) => {
        const filter = mapGqlFilterToUATFilter(args.filter);
        const result = await listUATs(
          { uatRepo },
          {
            filter,
            limit: args.limit ?? 20,
            offset: args.offset ?? 0,
          }
        );

        if (result.isErr()) {
          context.reply.log.error(
            { err: result.error, filter },
            `[${result.error.type}] ${result.error.message}`
          );
          throw new Error(`[${result.error.type}] ${result.error.message}`);
        }

        return result.value;
      },
    },

    // ─────────────────────────────────────────────────────────────────────────
    // UAT Type Resolvers
    // ─────────────────────────────────────────────────────────────────────────
    // Note: UAT.county_entity is handled by Mercurius loaders for N+1 prevention
  };
};
