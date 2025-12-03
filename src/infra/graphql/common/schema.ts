/**
 * Common GraphQL schema
 * Combines all common GraphQL definitions (directives, scalars, enums, types)
 */

import { IResolvers } from 'mercurius';

import { CommonDirectives } from './directives.js';
import { CommonEnums } from './enums.js';
import { EnumResolvers } from './resolvers.js';
import { CommonScalars } from './scalars.js';
import { CommonTypes } from './types.js';

/**
 * Combined common schema for use in GraphQL schema composition
 * Import this in app.ts and include it in the schema array
 */
export const CommonGraphQLSchema = [CommonDirectives, CommonScalars, CommonEnums, CommonTypes].join(
  '\n\n'
);

/**
 * Combined common resolvers for use in GraphQL schema composition
 * Import this in app.ts and include it in the resolvers array
 */
export const commonGraphQLResolvers: IResolvers = {
  ...EnumResolvers,
};
