import { request as httpRequest } from 'node:http';

import fastifyFactory from 'fastify';
import mercuriusPlugin from 'mercurius';
import { ok } from 'neverthrow';
import { describe, expect, it, vi } from 'vitest';

import { makeInsGraphqlLifecycle } from '@/app/ins-graphql-session.js';

import { makeFakeRepo } from './fake-repo.js';

import type { GraphQLContextBuilder } from '@/infra/graphql/index.js';
import type { InsReadSession } from '@/modules/ins-native/index.js';

const build = async (auth?: GraphQLContextBuilder) => {
  const app = fastifyFactory({ logger: false });
  const sessions: InsReadSession[] = [];
  let signalClose!: () => void;
  const closed = new Promise<void>((resolve) => {
    signalClose = resolve;
  });
  const lifecycle = makeInsGraphqlLifecycle(
    app,
    () => {
      const session = {
        getRepo: vi.fn(async () => ok(makeFakeRepo())),
        close: vi.fn(async () => {
          signalClose();
          return ok(undefined);
        }),
      };
      sessions.push(session);
      return session;
    },
    auth
  );
  await app.register(mercuriusPlugin, {
    schema: 'type Query { probe: String! who: String! fail: String! }',
    context: lifecycle.context,
    resolvers: {
      Query: {
        probe: async (_parent: unknown, _args: unknown, context: unknown) => {
          const repo = (
            await (context as { insReadSession: InsReadSession }).insReadSession.getRepo()
          )._unsafeUnwrap();
          return (await repo.getDataset('POPTEST'))._unsafeUnwrap()?.code ?? 'missing';
        },
        who: (_parent: unknown, _args: unknown, context: unknown) =>
          (context as { subject?: string }).subject ?? 'anonymous',
        fail: () => {
          throw new Error('field failure');
        },
      },
    },
  });
  lifecycle.registerHooks();
  await app.ready();
  return { app, sessions, closed };
};

describe('INS HTTP operation lifetime', () => {
  it('shares one session across aliases, retains auth and isolates the next request', async () => {
    const { app, sessions } = await build(async () => ({ subject: 'viewer' }));
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/graphql',
        payload: { query: '{ a: probe b: probe who }' },
      });
      expect(response.json()).toEqual({ data: { a: 'POPTEST', b: 'POPTEST', who: 'viewer' } });
      expect(sessions).toHaveLength(1);
      expect(sessions[0]?.getRepo).toHaveBeenCalledTimes(2);
      expect(sessions[0]?.close).toHaveBeenCalledTimes(1);
      await app.inject({ method: 'POST', url: '/graphql', payload: { query: '{ probe }' } });
      expect(sessions).toHaveLength(2);
      expect(sessions[1]).not.toBe(sessions[0]);
      expect(sessions[1]?.close).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });

  it('closes a request with no INS reads without acquiring its repository', async () => {
    const { app, sessions } = await build();
    try {
      await app.inject({ method: 'POST', url: '/graphql', payload: { query: '{ who }' } });
      expect(sessions[0]?.getRepo).not.toHaveBeenCalled();
      expect(sessions[0]?.close).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });

  it('coalesces cleanup after GraphQL non-null error propagation', async () => {
    const { app, sessions } = await build();
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/graphql',
        payload: { query: '{ probe fail }' },
      });
      expect(response.json<{ errors: unknown[] }>().errors).toHaveLength(1);
      expect(sessions[0]?.close).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });

  it('cleans up when authentication fails', async () => {
    const { app, sessions } = await build(async () => {
      throw new Error('auth unavailable');
    });
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/graphql',
        payload: { query: '{ probe }' },
      });
      expect(response.statusCode).toBe(500);
      expect(sessions[0]?.getRepo).not.toHaveBeenCalled();
      expect(sessions[0]?.close).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });

  it('closes on disconnect after the full body while authentication is pending', async () => {
    let enterAuth!: () => void;
    const authStarted = new Promise<void>((resolve) => {
      enterAuth = resolve;
    });
    let finishAuth!: (value: object) => void;
    const authPending = new Promise<object>((resolve) => {
      finishAuth = resolve;
    });
    const { app, sessions, closed } = await build(async () => {
      enterAuth();
      return authPending;
    });
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const client = httpRequest(`${address}/graphql`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    });
    client.on('error', () => undefined); // Expected local socket destruction.
    try {
      client.end(JSON.stringify({ query: '{ probe }' }));
      await authStarted;
      client.destroy();
      await closed;
      expect(sessions[0]?.close).toHaveBeenCalledTimes(1);
      expect(sessions[0]?.getRepo).not.toHaveBeenCalled();
    } finally {
      finishAuth({});
      client.destroy();
      await app.close();
    }
  });
});
