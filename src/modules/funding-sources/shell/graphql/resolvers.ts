/**
 * GraphQL resolvers for Funding Source module.
 */

import {
  DEFAULT_LIMIT,
  DEFAULT_LINE_ITEMS_LIMIT,
  MAX_LINE_ITEMS_LIMIT,
  type FundingSourceFilter,
  type FundingSource,
} from '../../core/types.js';
import { getFundingSource } from '../../core/usecases/get-funding-source.js';
import { listFundingSources } from '../../core/usecases/list-funding-sources.js';

import type { FundingSourceRepository, ExecutionLineItemRepository } from '../../core/ports.js';
import type { IResolvers, MercuriusContext } from 'mercurius';

/**
 * Dependencies for funding source resolvers.
 */
export interface MakeFundingSourceResolversDeps {
  fundingSourceRepo: FundingSourceRepository;
  executionLineItemRepo: ExecutionLineItemRepository;
}

interface FundingSourceQueryArgs {
  id: string;
}

interface FundingSourcesQueryArgs {
  filter?: {
    search?: string;
    source_ids?: string[];
  };
  limit?: number;
  offset?: number;
}

interface ExecutionLineItemsArgs {
  limit?: number;
  offset?: number;
  reportId?: string;
  accountCategory?: 'vn' | 'ch';
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
 * Creates GraphQL resolvers for funding source queries.
 *
 * @param deps - Repository dependencies
 * @returns Mercurius-compatible resolvers
 */
export const makeFundingSourceResolvers = (deps: MakeFundingSourceResolversDeps): IResolvers => {
  return {
    Query: {
      fundingSource: async (
        _parent: unknown,
        args: FundingSourceQueryArgs,
        context: MercuriusContext
      ) => {
        // Validate ID is a valid integer
        const id = parseIdToInt(args.id);
        if (id === null) {
          return null; // Invalid ID returns null per spec
        }

        const result = await getFundingSource({ fundingSourceRepo: deps.fundingSourceRepo }, id);

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

      fundingSources: async (
        _parent: unknown,
        args: FundingSourcesQueryArgs,
        context: MercuriusContext
      ) => {
        // Transform GraphQL filter input to domain filter
        const filter: FundingSourceFilter | undefined =
          args.filter !== undefined
            ? {
                search: args.filter.search,
                source_ids: args.filter.source_ids
                  ?.map((id) => parseIdToInt(id))
                  .filter((id): id is number => id !== null),
              }
            : undefined;

        const result = await listFundingSources(
          { fundingSourceRepo: deps.fundingSourceRepo },
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

    FundingSource: {
      executionLineItems: async (
        parent: FundingSource,
        args: ExecutionLineItemsArgs,
        context: MercuriusContext
      ) => {
        // Clamp limit and offset
        const limit = Math.min(
          Math.max(1, args.limit ?? DEFAULT_LINE_ITEMS_LIMIT),
          MAX_LINE_ITEMS_LIMIT
        );
        const offset = Math.max(0, args.offset ?? 0);

        const result = await deps.executionLineItemRepo.listByFundingSource(
          {
            funding_source_id: parent.source_id,
            report_id: args.reportId,
            account_category: args.accountCategory,
          },
          limit,
          offset
        );

        if (result.isErr()) {
          const error = result.error;
          context.reply.log.error(
            {
              err: error,
              errorType: error.type,
              fundingSourceId: parent.source_id,
              args,
            },
            `[${error.type}] ${error.message}`
          );
          throw new Error(`[${error.type}] ${error.message}`);
        }

        return result.value;
      },
    },
  };
};
