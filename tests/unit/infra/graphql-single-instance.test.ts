/**
 * Our ESM sources and mercurius (CJS) must share one `graphql` module
 * instance under vitest, as they do in the running server. With two instances
 * every cross-instance `instanceof` check fails inside validation, and the
 * production error formatter then redacts that crash to "Internal server
 * error" — which made the redaction tests pass for the wrong reason. The
 * vitest config pins the bare `graphql` specifier to the CJS entry; this test
 * pins that pin.
 */

import { createRequire } from 'node:module';

import { GraphQLNonNull, GraphQLString } from 'graphql';
import { describe, expect, it } from 'vitest';

describe('graphql module identity under vitest', () => {
  it('resolves the ESM import and the CJS require to the same instance', () => {
    const cjs = createRequire(import.meta.url)('graphql') as {
      GraphQLNonNull: typeof GraphQLNonNull;
      isNonNullType: (type: unknown) => boolean;
    };
    expect(cjs.GraphQLNonNull).toBe(GraphQLNonNull);
    // The check that failed across instances: a type built here must be
    // recognised by the copy mercurius executes with.
    expect(cjs.isNonNullType(new GraphQLNonNull(GraphQLString))).toBe(true);
  });
});
