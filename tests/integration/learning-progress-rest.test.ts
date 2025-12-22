/**
 * Integration tests for Learning Progress REST API
 *
 * Tests cover:
 * - Authentication handling
 * - Route behavior (request/response mapping)
 * - Error responses
 * - HTTP status codes
 *
 * Uses in-memory fakes for repositories and the test auth provider.
 */

import fastifyLib, { type FastifyInstance } from 'fastify';
import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'vitest';

import { createTestAuthProvider, makeAuthMiddleware } from '@/modules/auth/index.js';
import { makeLearningProgressRoutes } from '@/modules/learning-progress/shell/rest/routes.js';

import {
  makeFakeLearningProgressRepo,
  createTestContentProgressedEvent,
} from '../fixtures/fakes.js';

import type { LearningProgressRepository } from '@/modules/learning-progress/core/ports.js';
import type { LearningProgressEvent } from '@/modules/learning-progress/core/types.js';

/**
 * Creates a test Fastify app with learning progress routes.
 */
const createTestApp = async (options: { learningProgressRepo?: LearningProgressRepository }) => {
  const { provider } = createTestAuthProvider();

  const app = fastifyLib({ logger: false });

  // Add custom error handler to format all errors consistently
  app.setErrorHandler((err, _request, reply) => {
    const error = err as { statusCode?: number; code?: string; name?: string; message?: string };
    const statusCode = error.statusCode ?? 500;
    void reply.status(statusCode).send({
      ok: false,
      error: error.code ?? error.name ?? 'Error',
      message: error.message ?? 'An error occurred',
    });
  });

  // Add auth middleware
  app.addHook('preHandler', makeAuthMiddleware({ authProvider: provider }));

  // Register learning progress routes
  const learningProgressRepo = options.learningProgressRepo ?? makeFakeLearningProgressRepo();

  await app.register(
    makeLearningProgressRoutes({
      learningProgressRepo,
    })
  );

  await app.ready();
  return app;
};

describe('Learning Progress REST API', () => {
  let app: FastifyInstance;
  let testAuth: ReturnType<typeof createTestAuthProvider>;

  beforeAll(() => {
    testAuth = createTestAuthProvider();
  });

  afterAll(async () => {
    if (app != null) {
      await app.close();
    }
  });

  describe('authentication', () => {
    beforeEach(async () => {
      if (app != null) await app.close();
      app = await createTestApp({});
    });

    it('returns 401 when no auth token provided for GET', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/learning/progress',
      });

      expect(response.statusCode).toBe(401);
    });

    it('returns 401 when invalid auth token provided', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/learning/progress',
        headers: {
          authorization: 'Bearer invalid-token',
        },
      });

      expect(response.statusCode).toBe(401);
    });

    it('returns 401 when no auth token provided for PUT', async () => {
      const response = await app.inject({
        method: 'PUT',
        url: '/api/v1/learning/progress',
        headers: {
          'content-type': 'application/json',
        },
        payload: {
          clientUpdatedAt: new Date().toISOString(),
          events: [],
        },
      });

      expect(response.statusCode).toBe(401);
    });

    it('allows access with valid token for GET', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/learning/progress',
        headers: {
          authorization: `Bearer ${testAuth.tokens.user1}`,
        },
      });

      expect(response.statusCode).toBe(200);
    });

    it('allows access with valid token for PUT', async () => {
      const response = await app.inject({
        method: 'PUT',
        url: '/api/v1/learning/progress',
        headers: {
          authorization: `Bearer ${testAuth.tokens.user1}`,
          'content-type': 'application/json',
        },
        payload: {
          clientUpdatedAt: new Date().toISOString(),
          events: [],
        },
      });

      expect(response.statusCode).toBe(200);
    });
  });

  describe('GET /api/v1/learning/progress', () => {
    beforeEach(async () => {
      if (app != null) await app.close();
    });

    it('returns empty events for user with no progress', async () => {
      app = await createTestApp({});

      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/learning/progress',
        headers: {
          authorization: `Bearer ${testAuth.tokens.user1}`,
        },
      });

      expect(response.statusCode).toBe(200);

      const body = response.json<{
        ok: boolean;
        data: { events: unknown[]; cursor: string };
      }>();
      expect(body.ok).toBe(true);
      expect(body.data.events).toEqual([]);
      expect(body.data.cursor).toBe('');
    });

    it('returns all events when no cursor provided', async () => {
      const events: LearningProgressEvent[] = [
        createTestContentProgressedEvent({
          eventId: 'e1',
          occurredAt: '2024-01-15T10:00:00Z',
          payload: { contentId: 'lesson-1', status: 'completed' },
        }),
      ];

      const initialEvents = new Map<string, LearningProgressEvent[]>();
      // testAuth.userIds.user1 is the user ID for the test token
      initialEvents.set(testAuth.userIds.user1, events);

      app = await createTestApp({
        learningProgressRepo: makeFakeLearningProgressRepo({ initialEvents }),
      });

      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/learning/progress',
        headers: {
          authorization: `Bearer ${testAuth.tokens.user1}`,
        },
      });

      expect(response.statusCode).toBe(200);

      const body = response.json<{
        ok: boolean;
        data: {
          events: { eventId: string; payload: { contentId: string; status: string } }[];
          cursor: string;
        };
      }>();
      expect(body.ok).toBe(true);
      expect(body.data.events).toHaveLength(1);
      expect(body.data.events[0]!.eventId).toBe('e1');
      expect(body.data.events[0]!.payload.contentId).toBe('lesson-1');
      expect(body.data.cursor).toBe('2024-01-15T10:00:00Z');
    });

    it('returns events since cursor when provided', async () => {
      const events: LearningProgressEvent[] = [
        createTestContentProgressedEvent({
          eventId: 'e1',
          occurredAt: '2024-01-15T10:00:00Z',
          payload: { contentId: 'lesson-1', status: 'in_progress' },
        }),
        createTestContentProgressedEvent({
          eventId: 'e2',
          occurredAt: '2024-01-15T12:00:00Z',
          payload: { contentId: 'lesson-1', status: 'completed' },
        }),
      ];

      const initialEvents = new Map<string, LearningProgressEvent[]>();
      initialEvents.set(testAuth.userIds.user1, events);

      app = await createTestApp({
        learningProgressRepo: makeFakeLearningProgressRepo({ initialEvents }),
      });

      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/learning/progress?since=2024-01-15T11:00:00Z',
        headers: {
          authorization: `Bearer ${testAuth.tokens.user1}`,
        },
      });

      expect(response.statusCode).toBe(200);

      const body = response.json<{
        ok: boolean;
        data: { events: { eventId: string }[] };
      }>();
      expect(body.data.events).toHaveLength(1);
      expect(body.data.events[0]!.eventId).toBe('e2');
    });
  });

  describe('PUT /api/v1/learning/progress', () => {
    beforeEach(async () => {
      if (app != null) await app.close();
      app = await createTestApp({});
    });

    it('accepts empty events array', async () => {
      const response = await app.inject({
        method: 'PUT',
        url: '/api/v1/learning/progress',
        headers: {
          authorization: `Bearer ${testAuth.tokens.user1}`,
          'content-type': 'application/json',
        },
        payload: {
          clientUpdatedAt: new Date().toISOString(),
          events: [],
        },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json<{ ok: boolean }>();
      expect(body.ok).toBe(true);
    });

    it('stores content.progressed events', async () => {
      const response = await app.inject({
        method: 'PUT',
        url: '/api/v1/learning/progress',
        headers: {
          authorization: `Bearer ${testAuth.tokens.user1}`,
          'content-type': 'application/json',
        },
        payload: {
          clientUpdatedAt: new Date().toISOString(),
          events: [
            {
              eventId: 'test-event-1',
              occurredAt: new Date().toISOString(),
              clientId: 'test-client',
              type: 'content.progressed',
              payload: {
                contentId: 'lesson-1',
                status: 'completed',
                score: 85,
              },
            },
          ],
        },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json<{ ok: boolean }>();
      expect(body.ok).toBe(true);
    });

    it('stores onboarding.completed events', async () => {
      const response = await app.inject({
        method: 'PUT',
        url: '/api/v1/learning/progress',
        headers: {
          authorization: `Bearer ${testAuth.tokens.user1}`,
          'content-type': 'application/json',
        },
        payload: {
          clientUpdatedAt: new Date().toISOString(),
          events: [
            {
              eventId: 'onboarding-1',
              occurredAt: new Date().toISOString(),
              clientId: 'test-client',
              type: 'onboarding.completed',
              payload: {
                pathId: 'path-basics',
              },
            },
          ],
        },
      });

      expect(response.statusCode).toBe(200);
    });

    it('stores activePath.set events', async () => {
      const response = await app.inject({
        method: 'PUT',
        url: '/api/v1/learning/progress',
        headers: {
          authorization: `Bearer ${testAuth.tokens.user1}`,
          'content-type': 'application/json',
        },
        payload: {
          clientUpdatedAt: new Date().toISOString(),
          events: [
            {
              eventId: 'path-1',
              occurredAt: new Date().toISOString(),
              clientId: 'test-client',
              type: 'activePath.set',
              payload: {
                pathId: 'advanced-path',
              },
            },
          ],
        },
      });

      expect(response.statusCode).toBe(200);
    });

    it('stores progress.reset events', async () => {
      const response = await app.inject({
        method: 'PUT',
        url: '/api/v1/learning/progress',
        headers: {
          authorization: `Bearer ${testAuth.tokens.user1}`,
          'content-type': 'application/json',
        },
        payload: {
          clientUpdatedAt: new Date().toISOString(),
          events: [
            {
              eventId: 'reset-1',
              occurredAt: new Date().toISOString(),
              clientId: 'test-client',
              type: 'progress.reset',
            },
          ],
        },
      });

      expect(response.statusCode).toBe(200);
    });

    it('rejects invalid event type', async () => {
      const response = await app.inject({
        method: 'PUT',
        url: '/api/v1/learning/progress',
        headers: {
          authorization: `Bearer ${testAuth.tokens.user1}`,
          'content-type': 'application/json',
        },
        payload: {
          clientUpdatedAt: new Date().toISOString(),
          events: [
            {
              eventId: 'bad-event',
              occurredAt: new Date().toISOString(),
              clientId: 'test-client',
              type: 'invalid.type',
              payload: {},
            },
          ],
        },
      });

      expect(response.statusCode).toBe(400);
    });

    it('rejects missing required fields', async () => {
      const response = await app.inject({
        method: 'PUT',
        url: '/api/v1/learning/progress',
        headers: {
          authorization: `Bearer ${testAuth.tokens.user1}`,
          'content-type': 'application/json',
        },
        payload: {
          clientUpdatedAt: new Date().toISOString(),
          events: [
            {
              // Missing eventId, occurredAt, clientId
              type: 'content.progressed',
              payload: {
                contentId: 'lesson-1',
                status: 'completed',
              },
            },
          ],
        },
      });

      expect(response.statusCode).toBe(400);
    });

    it('rejects invalid content status', async () => {
      const response = await app.inject({
        method: 'PUT',
        url: '/api/v1/learning/progress',
        headers: {
          authorization: `Bearer ${testAuth.tokens.user1}`,
          'content-type': 'application/json',
        },
        payload: {
          clientUpdatedAt: new Date().toISOString(),
          events: [
            {
              eventId: 'event-1',
              occurredAt: new Date().toISOString(),
              clientId: 'test-client',
              type: 'content.progressed',
              payload: {
                contentId: 'lesson-1',
                status: 'invalid_status',
              },
            },
          ],
        },
      });

      expect(response.statusCode).toBe(400);
    });

    it('rejects score out of range', async () => {
      const response = await app.inject({
        method: 'PUT',
        url: '/api/v1/learning/progress',
        headers: {
          authorization: `Bearer ${testAuth.tokens.user1}`,
          'content-type': 'application/json',
        },
        payload: {
          clientUpdatedAt: new Date().toISOString(),
          events: [
            {
              eventId: 'event-1',
              occurredAt: new Date().toISOString(),
              clientId: 'test-client',
              type: 'content.progressed',
              payload: {
                contentId: 'lesson-1',
                status: 'passed',
                score: 150, // > 100
              },
            },
          ],
        },
      });

      expect(response.statusCode).toBe(400);
    });
  });

  describe('user isolation', () => {
    beforeEach(async () => {
      if (app != null) await app.close();
    });

    it('user cannot see other user progress', async () => {
      const user1Events: LearningProgressEvent[] = [
        createTestContentProgressedEvent({
          eventId: 'u1-e1',
          payload: { contentId: 'secret-lesson', status: 'completed' },
        }),
      ];

      const initialEvents = new Map<string, LearningProgressEvent[]>();
      initialEvents.set(testAuth.userIds.user1, user1Events);

      app = await createTestApp({
        learningProgressRepo: makeFakeLearningProgressRepo({ initialEvents }),
      });

      // User 2 should not see user 1's progress
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/learning/progress',
        headers: {
          authorization: `Bearer ${testAuth.tokens.user2}`,
        },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json<{
        ok: boolean;
        data: { events: unknown[] };
      }>();
      // User 2 should have no events (user 1's events are not visible)
      expect(body.data.events).toEqual([]);
    });
  });
});
