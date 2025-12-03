import { IResolvers } from 'mercurius';

import { getReadiness, type GetReadinessDeps } from '../../core/usecases/get-readiness.js';

/**
 * Factory function to create health resolvers with dependencies
 */
export const makeHealthResolvers = (deps: Partial<GetReadinessDeps> = {}): IResolvers => {
  const { version, checkers = [] } = deps;

  return {
    Query: {
      health: () => 'ok',
      ready: async () => {
        // Get Environment/State
        const uptime = process.uptime();
        const timestamp = new Date().toISOString();

        // Execute use case
        return getReadiness({ version, checkers }, { uptime, timestamp });
      },
    },
  };
};
