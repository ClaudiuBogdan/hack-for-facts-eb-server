/**
 * Base GraphQL schema
 * Defines the root types that other modules extend
 */
export const BaseSchema = `
  type Query {
    _empty: String
  }

  type Mutation {
    _empty: String
  }
`;
