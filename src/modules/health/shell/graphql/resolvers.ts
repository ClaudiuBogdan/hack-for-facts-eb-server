import { IResolvers } from 'mercurius';

import { mapCheckResults, evaluateReadiness } from '../../core/logic.js';
import { HealthDeps } from '../../core/types.js';

/**
 * Factory function to create health resolvers with dependencies
 */
export const makeHealthResolvers = (deps: HealthDeps = {}): IResolvers => {
  const { version, checkers = [] } = deps;

  return {
    Query: {
      health: () => 'ok',
      ready: async () => {
        // Run all health checkers in parallel (IO)
        const results = await Promise.allSettled(checkers.map((checker) => checker()));

        // Map results (Core Logic)
        const checks = mapCheckResults(results);

        // Get Environment/State
        const uptime = process.uptime();
        const timestamp = new Date().toISOString();

        // Evaluate Logic (Core Logic)
        return evaluateReadiness(checks, uptime, timestamp, version);
      },
    },
  };
};
