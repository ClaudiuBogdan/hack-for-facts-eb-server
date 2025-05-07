import { types } from "../types";
import { makeExecutableSchema } from "@graphql-tools/schema";
import { resolvers } from "../resolvers";

export const schema = makeExecutableSchema({
  typeDefs: types,
  resolvers,
});
