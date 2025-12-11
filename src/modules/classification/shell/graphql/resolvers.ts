/**
 * Classification Module GraphQL Resolvers
 */

import {
  DEFAULT_LIMIT,
  type EconomicClassification,
  type EconomicClassificationFilter,
  type FunctionalClassification,
  type FunctionalClassificationFilter,
} from '../../core/types.js';
import { getEconomicClassification } from '../../core/usecases/get-economic-classification.js';
import { getFunctionalClassification } from '../../core/usecases/get-functional-classification.js';
import { listEconomicClassifications } from '../../core/usecases/list-economic-classifications.js';
import { listFunctionalClassifications } from '../../core/usecases/list-functional-classifications.js';

import type {
  EconomicClassificationRepository,
  FunctionalClassificationRepository,
} from '../../core/ports.js';
import type { IResolvers, MercuriusContext } from 'mercurius';

// ============================================================================
// Types
// ============================================================================

export interface MakeClassificationResolversDeps {
  functionalClassificationRepo: FunctionalClassificationRepository;
  economicClassificationRepo: EconomicClassificationRepository;
}

interface FunctionalClassificationQueryArgs {
  code: string;
}

interface FunctionalClassificationsQueryArgs {
  filter?: {
    search?: string;
    functional_codes?: string[];
  };
  limit?: number;
  offset?: number;
}

interface EconomicClassificationQueryArgs {
  code: string;
}

interface EconomicClassificationsQueryArgs {
  filter?: {
    search?: string;
    economic_codes?: string[];
  };
  limit?: number;
  offset?: number;
}

// ============================================================================
// Resolver Factory
// ============================================================================

/**
 * Creates GraphQL resolvers for classification queries.
 */
export const makeClassificationResolvers = (deps: MakeClassificationResolversDeps): IResolvers => {
  const { functionalClassificationRepo, economicClassificationRepo } = deps;

  return {
    Query: {
      /**
       * Get a single functional classification by code.
       */
      functionalClassification: async (
        _parent: unknown,
        args: FunctionalClassificationQueryArgs,
        context: MercuriusContext
      ): Promise<FunctionalClassification | null> => {
        const result = await getFunctionalClassification(
          { functionalClassificationRepo },
          args.code
        );

        if (result.isErr()) {
          context.reply.log.error(
            { err: result.error, code: args.code },
            `[${result.error.type}] ${result.error.message}`
          );
          throw new Error(`[${result.error.type}] ${result.error.message}`);
        }

        return result.value;
      },

      /**
       * List functional classifications with filtering and pagination.
       */
      functionalClassifications: async (
        _parent: unknown,
        args: FunctionalClassificationsQueryArgs,
        context: MercuriusContext
      ) => {
        const filter: FunctionalClassificationFilter = {};
        if (args.filter?.search !== undefined) {
          filter.search = args.filter.search;
        }
        if (args.filter?.functional_codes !== undefined) {
          filter.functional_codes = args.filter.functional_codes;
        }

        const result = await listFunctionalClassifications(
          { functionalClassificationRepo },
          {
            filter,
            limit: args.limit ?? DEFAULT_LIMIT,
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

      /**
       * Get a single economic classification by code.
       */
      economicClassification: async (
        _parent: unknown,
        args: EconomicClassificationQueryArgs,
        context: MercuriusContext
      ): Promise<EconomicClassification | null> => {
        const result = await getEconomicClassification({ economicClassificationRepo }, args.code);

        if (result.isErr()) {
          context.reply.log.error(
            { err: result.error, code: args.code },
            `[${result.error.type}] ${result.error.message}`
          );
          throw new Error(`[${result.error.type}] ${result.error.message}`);
        }

        return result.value;
      },

      /**
       * List economic classifications with filtering and pagination.
       */
      economicClassifications: async (
        _parent: unknown,
        args: EconomicClassificationsQueryArgs,
        context: MercuriusContext
      ) => {
        const filter: EconomicClassificationFilter = {};
        if (args.filter?.search !== undefined) {
          filter.search = args.filter.search;
        }
        if (args.filter?.economic_codes !== undefined) {
          filter.economic_codes = args.filter.economic_codes;
        }

        const result = await listEconomicClassifications(
          { economicClassificationRepo },
          {
            filter,
            limit: args.limit ?? DEFAULT_LIMIT,
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
  };
};
