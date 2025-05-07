import { uatRepository } from "../../db/repositories";

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
        filter: any;
        limit: number;
        offset: number;
      }
    ) => {
      const [uats, totalCount] = await Promise.all([
        uatRepository.getAll(filter, limit, offset),
        uatRepository.count(filter),
      ]);

      return {
        nodes: uats,
        pageInfo: {
          totalCount,
          hasNextPage: offset + limit < totalCount,
          hasPreviousPage: offset > 0,
        },
      };
    },
  },
};
