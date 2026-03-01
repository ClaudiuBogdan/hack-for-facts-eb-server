import fastifyLib, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createTestAuthProvider,
  isAuthenticated,
  makeAuthMiddleware,
} from '@/modules/auth/index.js';

function getLoggerBindings(log: unknown): Record<string, unknown> {
  if (typeof log !== 'object' || log === null) {
    return {};
  }

  const candidate = log as {
    bindings?: () => Record<string, unknown>;
  };

  if (typeof candidate.bindings !== 'function') {
    return {};
  }

  return candidate.bindings();
}

describe('makeAuthMiddleware logger context', () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    if (app !== undefined) {
      await app.close();
      app = undefined;
    }
  });

  it('adds userId to request logger bindings for authenticated requests', async () => {
    const testAuth = createTestAuthProvider();
    app = fastifyLib({ logger: true });

    app.addHook('preHandler', makeAuthMiddleware({ authProvider: testAuth.provider }));
    app.get('/probe', async (request) => {
      const bindings = getLoggerBindings(request.log);
      const authUserId = isAuthenticated(request.auth) ? request.auth.userId : null;

      return {
        authUserId,
        logUserId: (bindings['userId'] as string | undefined) ?? null,
      };
    });

    await app.ready();

    const response = await app.inject({
      method: 'GET',
      url: '/probe',
      headers: {
        authorization: `Bearer ${testAuth.tokens.user1}`,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      authUserId: testAuth.userIds.user1,
      logUserId: testAuth.userIds.user1,
    });
  });

  it('does not add userId binding for anonymous requests', async () => {
    const testAuth = createTestAuthProvider();
    app = fastifyLib({ logger: true });

    app.addHook('preHandler', makeAuthMiddleware({ authProvider: testAuth.provider }));
    app.get('/probe', async (request) => {
      const bindings = getLoggerBindings(request.log);
      const authUserId = isAuthenticated(request.auth) ? request.auth.userId : null;

      return {
        authUserId,
        logUserId: (bindings['userId'] as string | undefined) ?? null,
      };
    });

    await app.ready();

    const response = await app.inject({
      method: 'GET',
      url: '/probe',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      authUserId: null,
      logUserId: null,
    });
  });
});
