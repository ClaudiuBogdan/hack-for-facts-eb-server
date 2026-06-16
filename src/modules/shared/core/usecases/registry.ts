/**
 * Shared Kernel — Contributor registry (foundation §4.4).
 *
 * A simple in-process registry. Source modules register one contributor each at
 * wiring time; kernel usecases iterate it. Pure (no IO).
 */

import type { ContributorRegistry, SourceContributor } from '../ports.js';

export const createContributorRegistry = (): ContributorRegistry => {
  const bySource = new Map<string, SourceContributor>();
  return {
    register(contributor: SourceContributor): void {
      bySource.set(contributor.source, contributor);
    },
    list(): readonly SourceContributor[] {
      return [...bySource.values()];
    },
    get(source: string): SourceContributor | undefined {
      return bySource.get(source);
    },
  };
};
