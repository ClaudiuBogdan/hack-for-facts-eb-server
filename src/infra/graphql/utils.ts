import { IResolvers } from 'mercurius';

/**
 * Deep merges an array of resolver objects.
 * Specifically handles merging of Query, Mutation, and Subscription types.
 */
export const mergeResolvers = (resolversArray: IResolvers[]): IResolvers => {
  const merged: IResolvers = {};

  for (const resolvers of resolversArray) {
    for (const [key, value] of Object.entries(resolvers)) {
      if (
        (key === 'Query' || key === 'Mutation' || key === 'Subscription') &&
        value != null &&
        typeof value === 'object'
      ) {
        merged[key] = {
          ...(merged[key] as object),
          ...(value as object),
        };
      } else {
        // For other types (e.g. custom types), we assume no collision or we overwrite
        // Ideally we should merge these too if they are partials, but usually they are full definitions
        // For now, simple overwrite is standard behavior for type resolvers
        merged[key] = value;
      }
    }
  }

  return merged;
};
