/**
 * GraphQL resolvers for Budget Sector module.
 */

import { DEFAULT_LIMIT, type BudgetSectorFilter } from '../../core/types.js';
import { getBudgetSector } from '../../core/usecases/get-budget-sector.js';
import { listBudgetSectors } from '../../core/usecases/list-budget-sectors.js';

import type { BudgetSectorRepository } from '../../core/ports.js';
import type { IResolvers, MercuriusContext } from 'mercurius';

/**
 * Dependencies for budget sector resolvers.
 */
export interface MakeBudgetSectorResolversDeps {
  budgetSectorRepo: BudgetSectorRepository;
}

interface BudgetSectorQueryArgs {
  id: string;
}

interface BudgetSectorsQueryArgs {
  filter?: {
    search?: string;
    sector_ids?: string[];
  };
  limit?: number;
  offset?: number;
}

/**
 * Parse GraphQL ID to integer.
 * Returns null for invalid IDs (non-numeric, negative).
 */
const parseIdToInt = (id: string): number | null => {
  const parsed = Number.parseInt(id, 10);
  if (Number.isNaN(parsed) || parsed < 0) {
    return null;
  }
  return parsed;
};

/**
 * Creates GraphQL resolvers for budget sector queries.
 *
 * @param deps - Repository dependency
 * @returns Mercurius-compatible resolvers
 */
export const makeBudgetSectorResolvers = (deps: MakeBudgetSectorResolversDeps): IResolvers => {
  return {
    Query: {
      budgetSector: async (
        _parent: unknown,
        args: BudgetSectorQueryArgs,
        context: MercuriusContext
      ) => {
        // Validate ID is a valid integer
        const id = parseIdToInt(args.id);
        if (id === null) {
          return null; // Invalid ID returns null per spec
        }

        const result = await getBudgetSector({ budgetSectorRepo: deps.budgetSectorRepo }, id);

        if (result.isErr()) {
          const error = result.error;
          context.reply.log.error(
            { err: error, errorType: error.type, id: args.id },
            `[${error.type}] ${error.message}`
          );
          throw new Error(`[${error.type}] ${error.message}`);
        }

        return result.value;
      },

      budgetSectors: async (
        _parent: unknown,
        args: BudgetSectorsQueryArgs,
        context: MercuriusContext
      ) => {
        // Transform GraphQL filter input to domain filter
        const filter: BudgetSectorFilter | undefined =
          args.filter !== undefined
            ? {
                search: args.filter.search,
                sector_ids: args.filter.sector_ids
                  ?.map((id) => parseIdToInt(id))
                  .filter((id): id is number => id !== null),
              }
            : undefined;

        const result = await listBudgetSectors(
          { budgetSectorRepo: deps.budgetSectorRepo },
          {
            filter,
            limit: args.limit ?? DEFAULT_LIMIT,
            offset: args.offset ?? 0,
          }
        );

        if (result.isErr()) {
          const error = result.error;
          context.reply.log.error(
            { err: error, errorType: error.type, filter: args.filter },
            `[${error.type}] ${error.message}`
          );
          throw new Error(`[${error.type}] ${error.message}`);
        }

        return result.value;
      },
    },
  };
};
