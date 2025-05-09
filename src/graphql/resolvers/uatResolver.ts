import { uatRepository } from "../../db/repositories";
import { UATFilter } from "../../db/repositories/uatRepository";

export const uatResolver = {
  Query: {
    uat: async (_: any, { id }: { id: number }) => {
      return uatRepository.getById(id);
    },
    uats: async (
      _: any,
      {
        filter = {},
        limit = 20,
        offset = 0,
      }: {
        filter?: UATFilter;
        limit?: number;
        offset?: number;
      }
    ) => {
      const [nodes, totalCount] = await Promise.all([
        uatRepository.getAll(filter, limit, offset),
        uatRepository.count(filter),
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
};
