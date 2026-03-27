import fastifyLib, { type FastifyInstance } from 'fastify';
import { ok } from 'neverthrow';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { createTestAuthProvider, makeAuthMiddleware } from '@/modules/auth/index.js';
import {
  extractThreadKeyFromSubject,
  makeInstitutionCorrespondenceRoutes,
  makePublicDebateTemplateRenderer,
} from '@/modules/institution-correspondence/index.js';

import { makeInMemoryCorrespondenceRepo } from '../unit/institution-correspondence/fake-repo.js';

describe('Institution Correspondence REST API', () => {
  let app: FastifyInstance;

  afterAll(async () => {
    if (app != null) {
      await app.close();
    }
  });

  beforeEach(async () => {
    if (app != null) {
      await app.close();
    }
  });

  it('requires authentication for self-send prepare', async () => {
    const testAuth = createTestAuthProvider();
    app = fastifyLib({ logger: false });
    app.addHook('preHandler', makeAuthMiddleware({ authProvider: testAuth.provider }));

    await app.register(
      makeInstitutionCorrespondenceRoutes({
        repo: makeInMemoryCorrespondenceRepo(),
        emailSender: {
          getFromAddress() {
            return 'noreply@transparenta.eu';
          },
          async send() {
            return ok({ emailId: 'email-1' });
          },
        },
        templateRenderer: makePublicDebateTemplateRenderer(),
        auditCcRecipients: ['audit@transparenta.test'],
        platformBaseUrl: 'https://transparenta.test',
        captureAddress: 'debate@transparenta.test',
      })
    );

    await app.ready();

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/institution-correspondence/public-debate/self-send/prepare',
      payload: {
        entityCui: '12345678',
        institutionEmail: 'contact@primarie.ro',
      },
    });

    expect(response.statusCode).toBe(401);
  });

  it('returns a prepared self-send payload with a thread key in the subject', async () => {
    const testAuth = createTestAuthProvider();
    app = fastifyLib({ logger: false });
    app.addHook('preHandler', makeAuthMiddleware({ authProvider: testAuth.provider }));

    await app.register(
      makeInstitutionCorrespondenceRoutes({
        repo: makeInMemoryCorrespondenceRepo(),
        emailSender: {
          getFromAddress() {
            return 'noreply@transparenta.eu';
          },
          async send() {
            return ok({ emailId: 'email-1' });
          },
        },
        templateRenderer: makePublicDebateTemplateRenderer(),
        auditCcRecipients: ['audit@transparenta.test'],
        platformBaseUrl: 'https://transparenta.test',
        captureAddress: 'debate@transparenta.test',
      })
    );

    await app.ready();

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/institution-correspondence/public-debate/self-send/prepare',
      headers: {
        authorization: `Bearer ${testAuth.tokens.user1}`,
        'content-type': 'application/json',
      },
      payload: {
        entityCui: '12345678',
        institutionEmail: 'contact@primarie.ro',
        requesterOrganizationName: 'Asociatia Test',
      },
    });

    expect(response.statusCode).toBe(200);
    const payload = response.json<{
      ok: boolean;
      data: {
        threadKey: string;
        subject: string | null;
        cc: string[];
      };
    }>();

    expect(payload.ok).toBe(true);
    expect(payload.data.threadKey).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );
    expect(payload.data.subject).toContain(payload.data.threadKey);
    expect(extractThreadKeyFromSubject(payload.data.subject ?? '')).toBe(payload.data.threadKey);
    expect(payload.data.cc).toEqual(['debate@transparenta.test', 'audit@transparenta.test']);
  });
});
