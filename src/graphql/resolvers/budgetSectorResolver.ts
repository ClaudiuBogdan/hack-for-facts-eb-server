import { budgetSectorRepository, executionLineItemRepository } from "../../db/repositories";
import { BudgetSectorFilter } from "../../db/repositories/budgetSectorRepository";

export const budgetSectorResolver = {
    Query: {
        budgetSector: async (_: any, { id }: { id: number }) => {
            return budgetSectorRepository.getById(id);
        },
        budgetSectors: async (
            _: any,
            {
                filter = {},
                limit = 20,
                offset = 0,
            }: {
                filter?: BudgetSectorFilter;
                limit?: number;
                offset?: number;
            }
        ) => {
            console.log('filter', filter)
            const [nodes, totalCount] = await Promise.all([
                budgetSectorRepository.getAll(filter, limit, offset),
                budgetSectorRepository.count(filter),
            ]);

            return {
                nodes,
                pageInfo: {
                    totalCount,
                    hasNextPage: offset + limit < totalCount,
                    hasPreviousPage: offset > 0,
                },
            };
        },
    },

    BudgetSector: {
        executionLineItems: async (
            parent: any,
            {
                limit = 100,
                offset = 0,
                reportId,
                accountCategory,
            }: {
                limit: number;
                offset: number;
                reportId?: number;
                accountCategory?: "vn" | "ch";
            }
        ) => {
            const filter: any = { budget_sector_id: parent.sector_id };

            if (reportId) filter.report_id = reportId;
            if (accountCategory) filter.account_category = accountCategory;

            const [lineItems, totalCount] = await Promise.all([
                executionLineItemRepository.getAll(filter, undefined, limit, offset),
                executionLineItemRepository.count(filter),
            ]);

            return {
                nodes: lineItems,
                pageInfo: {
                    totalCount,
                    hasNextPage: offset + limit < totalCount,
                    hasPreviousPage: offset > 0,
                },
            };
        },
    },
};
