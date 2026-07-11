import { fastify as makeFastify, type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { sendUserDataRouteError } from '@/modules/user-data/shell/rest/route-errors.js';

import type { UserDataError } from '@/modules/user-data/index.js';

const current = {
  recordId: 'record',
  category: 'category',
  logicalKey: 'key',
  target: null,
  schemaVersion: 1,
  revision: 2,
  status: 'active' as const,
  payload: { safe: true },
  annotations: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  deletedAt: null,
};

const cases: readonly [UserDataError, number, string?][] = [
  [{ type: 'UnknownCategory', category: 'x' }, 400],
  [{ type: 'UnknownSchemaVersion', category: 'x', schemaVersion: 9 }, 400],
  [{ type: 'InvalidPayload', violations: ['/field:rule'] }, 400],
  [{ type: 'InvalidLogicalKey', rule: 'pattern' }, 400],
  [{ type: 'InvalidTarget', rule: 'type' }, 400],
  [{ type: 'InvalidCursor' }, 400],
  [
    { type: 'SchemaVersionWriteDisabled', category: 'x', schemaVersion: 1 },
    409,
    'UPGRADE_REQUIRED',
  ],
  [{ type: 'RevisionConflict', current }, 409],
  [{ type: 'IdempotencyConflict' }, 409, 'IDEMPOTENCY_KEY_REUSED'],
  [{ type: 'RecordDeleted', current }, 409],
  [{ type: 'RecordNotDeleted' }, 409],
  [{ type: 'NotFound', category: 'x' }, 404],
  [{ type: 'AdminAccessNotConfigured', category: 'x' }, 404],
  [{ type: 'Forbidden', reason: 'secret' }, 403],
  [{ type: 'ActorNotAllowed', namespace: 'x', actorType: 'owner' }, 403],
  [{ type: 'UnknownAnnotationNamespace', category: 'x', namespace: 'n' }, 403],
  [{ type: 'PayloadTooLarge', limitBytes: 12 }, 413],
  [{ type: 'QuotaExceeded', category: 'x', limit: 2 }, 429, 'QUOTA_EXCEEDED'],
  [{ type: 'RateLimited', retryAfterSeconds: 17 }, 429],
  [{ type: 'DatabaseError', message: 'driver secret', retryable: true }, 500],
];

describe('user-data route error mapping', () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => app?.close());

  for (const [error, expectedStatus, expectedCode] of cases) {
    it(`maps ${error.type}`, async () => {
      app = makeFastify({ logger: false });
      app.get('/', (_request, reply) => sendUserDataRouteError(reply, error));
      const response = await app.inject('/');
      const body = response.json<Record<string, unknown>>();
      expect(response.statusCode).toBe(expectedStatus);
      if (expectedCode !== undefined) expect(body['code']).toBe(expectedCode);
      if (error.type === 'RevisionConflict') expect(body['current']).toEqual(current);
      if (error.type === 'InvalidPayload') expect(body['violations']).toEqual(error.violations);
      if (error.type === 'RateLimited') expect(response.headers['retry-after']).toBe('17');
      expect(response.body).not.toContain('driver secret');
      expect(response.body).not.toContain('secret-owner-payload');
    });
  }

  it('renders NotFound and AdminAccessNotConfigured identically', async () => {
    const bodies: string[] = [];
    for (const error of [
      { type: 'NotFound', category: 'unknown' } as const,
      { type: 'AdminAccessNotConfigured', category: 'known' } as const,
    ]) {
      app = makeFastify({ logger: false });
      app.get('/', (_request, reply) => sendUserDataRouteError(reply, error));
      bodies.push((await app.inject('/')).body);
      await app.close();
      app = undefined;
    }
    expect(bodies[0]).toBe(bodies[1]);
  });
});
