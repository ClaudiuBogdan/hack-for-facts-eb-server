import { createRequire } from 'node:module';

import { describe, expect, it } from 'vitest';

const requireFromHere = createRequire(import.meta.url);

describe('GraphQL runtime compatibility', () => {
  it('provides the execution helper required by Mercurius', () => {
    const executionModule = requireFromHere('graphql/execution/execute') as {
      readonly buildExecutionContext?: unknown;
    };

    expect(executionModule.buildExecutionContext).toBeTypeOf('function');
  });
});
