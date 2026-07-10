/**
 * Integration tests for the INS dataset-request REST endpoint.
 *
 * Covers anonymous and authenticated submissions, body validation, and the
 * repository error path. Uses an in-memory fake repository, so no database is
 * required.
 */

import fastifyLib, { type FastifyError, type FastifyInstance } from 'fastify';
import { err, ok } from 'neverthrow';
import { describe, expect, it, afterEach } from 'vitest';

import { toUserId } from '@/modules/auth/core/types.js';
import { createDatabaseError } from '@/modules/ins/core/errors.js';
import { makeInsRoutes } from '@/modules/ins/shell/rest/routes.js';

import type {
  InsDatasetRequest,
  InsDatasetRequestInput,
} from '@/modules/ins/core/dataset-requests.js';
import type {
  InsDatasetCatalogReader,
  InsDatasetRequestRepository,
} from '@/modules/ins/core/ports.js';

const makeFakeRepo = (): InsDatasetRequestRepository & { created: InsDatasetRequestInput[] } => {
  const created: InsDatasetRequestInput[] = [];
  return {
    created,
    create: async (input) => {
      created.push(input);
      const request: InsDatasetRequest = {
        id: 'req-1',
        dataset_code: input.dataset_code,
        siruta: input.siruta ?? null,
        created_at: new Date('2026-07-09T00:00:00.000Z'),
      };
      return ok(request);
    },
  };
};

/** Knows POP107D only. */
const fakeCatalog: InsDatasetCatalogReader = {
  datasetExists: async (code) => ok(code === 'POP107D'),
};

const createTestApp = async (options: {
  datasetRequestRepo: InsDatasetRequestRepository;
  datasetCatalog?: InsDatasetCatalogReader;
  /** Simulates the global auth preHandler having produced a session. */
  authUserId?: string;
  /** Defaults to true; set false to model a deploy without the Clerk webhook. */
  userDeletionHandlerConfigured?: boolean;
}): Promise<FastifyInstance> => {
  const app = fastifyLib({ logger: false });

  // Mirrors the shape build-app's global error handler produces for schema
  // validation failures, so the route's 400 response schema can serialize them.
  app.setErrorHandler((error: FastifyError, _request, reply) => {
    if (error.validation != null) {
      return reply.status(400).send({
        ok: false,
        error: 'ValidationError',
        message: 'Request validation failed',
      });
    }
    return reply.status(error.statusCode ?? 500).send({
      ok: false,
      error: error.code ?? error.name,
      message: error.message,
    });
  });

  if (options.authUserId !== undefined) {
    const userId = toUserId(options.authUserId);
    app.addHook('preHandler', (request, _reply, done) => {
      request.auth = { userId, expiresAt: new Date(Date.now() + 60_000) };
      done();
    });
  }

  await app.register(
    makeInsRoutes({
      datasetRequestRepo: options.datasetRequestRepo,
      datasetCatalog: options.datasetCatalog ?? fakeCatalog,
      userDeletionHandlerConfigured: options.userDeletionHandlerConfigured ?? true,
    })
  );
  await app.ready();
  return app;
};

describe('POST /api/ins/dataset-requests', () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('records an anonymous request', async () => {
    const repo = makeFakeRepo();
    app = await createTestApp({ datasetRequestRepo: repo });

    const response = await app.inject({
      method: 'POST',
      url: '/api/ins/dataset-requests',
      payload: { datasetCode: 'pop107d', siruta: '54975' },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({
      ok: true,
      data: { id: 'req-1', datasetCode: 'POP107D' },
    });
    expect(repo.created).toEqual([{ dataset_code: 'POP107D', siruta: '54975' }]);
  });

  it('attaches the authenticated Clerk user id', async () => {
    const repo = makeFakeRepo();
    app = await createTestApp({ datasetRequestRepo: repo, authUserId: 'user_abc' });

    const response = await app.inject({
      method: 'POST',
      url: '/api/ins/dataset-requests',
      payload: { datasetCode: 'POP107D', contactEmail: 'a@b.ro' },
    });

    expect(response.statusCode).toBe(201);
    expect(repo.created[0]?.clerk_user_id).toBe('user_abc');
    expect(repo.created[0]?.contact_email).toBe('a@b.ro');
  });

  it('accepts an anonymous request but never persists its PII', async () => {
    const repo = makeFakeRepo();
    app = await createTestApp({ datasetRequestRepo: repo });

    const response = await app.inject({
      method: 'POST',
      url: '/api/ins/dataset-requests',
      payload: { datasetCode: 'POP107D', contactEmail: 'a@b.ro', note: 'I am Ana' },
    });

    expect(response.statusCode).toBe(201);
    expect(repo.created[0]).toEqual({ dataset_code: 'POP107D' });
    expect(repo.created[0]?.contact_email).toBeUndefined();
    expect(repo.created[0]?.note).toBeUndefined();
  });

  it('records no personal data when the deletion webhook is not configured', async () => {
    const repo = makeFakeRepo();
    app = await createTestApp({
      datasetRequestRepo: repo,
      authUserId: 'user_abc',
      userDeletionHandlerConfigured: false,
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/ins/dataset-requests',
      payload: { datasetCode: 'POP107D', contactEmail: 'a@b.ro', note: 'I am Ana' },
    });

    // Even for an authenticated caller: without user.deleted wired, a row
    // carrying a clerk_user_id could never be erased, so none is attached and
    // no PII is stored.
    expect(response.statusCode).toBe(201);
    expect(repo.created[0]).toEqual({ dataset_code: 'POP107D' });
  });

  it('rejects a body without a dataset code', async () => {
    const repo = makeFakeRepo();
    app = await createTestApp({ datasetRequestRepo: repo });

    const response = await app.inject({
      method: 'POST',
      url: '/api/ins/dataset-requests',
      payload: { siruta: '54975' },
    });

    expect(response.statusCode).toBe(400);
    expect(repo.created).toHaveLength(0);
  });

  it('rejects a note over 1000 characters at the schema boundary', async () => {
    const repo = makeFakeRepo();
    app = await createTestApp({ datasetRequestRepo: repo });

    const response = await app.inject({
      method: 'POST',
      url: '/api/ins/dataset-requests',
      payload: { datasetCode: 'POP107D', note: 'x'.repeat(1001) },
    });

    expect(response.statusCode).toBe(400);
    expect(repo.created).toHaveLength(0);
  });

  it('ignores a client-supplied clerkUserId rather than trusting it', async () => {
    const repo = makeFakeRepo();
    app = await createTestApp({ datasetRequestRepo: repo });

    const response = await app.inject({
      method: 'POST',
      url: '/api/ins/dataset-requests',
      payload: { datasetCode: 'POP107D', clerkUserId: 'user_spoofed' },
    });

    // Fastify's ajv strips properties the schema does not declare, so the
    // spoofed id never reaches the usecase.
    expect(response.statusCode).toBe(201);
    expect(repo.created[0]?.clerk_user_id).toBeUndefined();
  });

  it('rejects a dataset code that is not in the catalog', async () => {
    const repo = makeFakeRepo();
    app = await createTestApp({ datasetRequestRepo: repo });

    const response = await app.inject({
      method: 'POST',
      url: '/api/ins/dataset-requests',
      payload: { datasetCode: 'NOT_A_DATASET' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ ok: false, error: 'ValidationError' });
    expect(repo.created).toHaveLength(0);
  });

  it('maps a repository failure to 500', async () => {
    const repo: InsDatasetRequestRepository = {
      create: async () => err(createDatabaseError('boom')),
    };
    app = await createTestApp({ datasetRequestRepo: repo });

    const response = await app.inject({
      method: 'POST',
      url: '/api/ins/dataset-requests',
      payload: { datasetCode: 'POP107D' },
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({ ok: false, error: 'DatabaseError' });
  });
});
