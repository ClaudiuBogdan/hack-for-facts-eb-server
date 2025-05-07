import {
  entityRepository,
  reportRepository,
  uatRepository,
  executionLineItemRepository,
} from "../../db/repositories";

export const entityResolver = {
  Query: {
    entity: async (_: any, { cui }: { cui: string }) => {
      return entityRepository.getById(cui);
    },
    entities: async (
      _: any,
      {
        filter = {},
        limit = 20,
        offset = 0,
      }: {
        filter: any;
        limit: number;
        offset: number;
      }
    ) => {
      const [entities, totalCount] = await Promise.all([
        entityRepository.getAll(filter, limit, offset),
        entityRepository.count(filter),
      ]);

      return {
        nodes: entities,
        pageInfo: {
          totalCount,
          hasNextPage: offset + limit < totalCount,
          hasPreviousPage: offset > 0,
        },
      };
    },
  },
  Entity: {
    uat: async (parent: any) => {
      if (!parent.uat_id) return null;
      return uatRepository.getById(parent.uat_id);
    },
    reports: async (
      parent: any,
      {
        limit = 10,
        offset = 0,
        year,
        period,
      }: {
        limit: number;
        offset: number;
        year?: number;
        period?: string;
      }
    ) => {
      const filter: any = { entity_cui: parent.cui };

      if (year) filter.reporting_year = year;
      if (period) filter.reporting_period = period;

      const [reports, totalCount] = await Promise.all([
        reportRepository.getAll(filter, limit, offset),
        reportRepository.count(filter),
      ]);

      return {
        nodes: reports,
        pageInfo: {
          totalCount,
          hasNextPage: offset + limit < totalCount,
          hasPreviousPage: offset > 0,
        },
      };
    },
    executionLineItems: async (
      parent: any,
      {
        filter = {},
        limit = 100,
        offset = 0,
      }: {
        filter: any;
        limit: number;
        offset: number;
      }
    ) => {
      const combinedFilter = { ...filter, entity_cui: parent.cui };

      const [lineItems, totalCount] = await Promise.all([
        executionLineItemRepository.getAll(combinedFilter, limit, offset),
        executionLineItemRepository.count(combinedFilter),
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
