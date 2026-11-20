import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '@/app/build-app.js';

import { makeTestConfig } from '../fixtures/builders.js';
import { makeFakeBudgetDb, makeFakeDatasetRepo } from '../fixtures/fakes.js';
import { LEGAL_CLIENT_CASES } from '../fixtures/legal/client-documents.js';

import type { FastifyInstance } from 'fastify';

/**
 * Schema-validation contract for the CLIENT's legal GraphQL documents.
 *
 * The client repo (hack-for-facts-eb-client, src/features/legal/api/*.live.ts)
 * unit-tests its adapters against a MOCKED transport, so nothing there ever
 * validates the documents against this server's real schema — which is
 * exactly how a `tree(depth: 1)` selection on a field that never shipped
 * reached production (fixed 2026-08-10). These are verbatim copies of the
 * client's five live documents, injected against the mounted redesign schema:
 * a document that fails GraphQL VALIDATION (unknown field/argument/type) fails
 * here, while resolver-time failures (the kernel points at a fast-fail DB on
 * purpose) are fine — they mean the shape passed validation.
 *
 * If a client query changes, update the copy here in the same review.
 */

const VALIDATION_ERROR =
  /Cannot query field|Unknown argument|Unknown type|Expected type|cannot represent|got invalid value|of required type|Unknown fragment/i;

describe.each(['legacy', 'v2'] as const)(
  'legal client GraphQL documents validate against the mounted schema (LEGAL_SOURCE=%s)',
  (legalSource) => {
    let app: FastifyInstance;

    beforeAll(async () => {
      app = await createApp({
        fastifyOptions: { logger: false },
        deps: {
          budgetDb: makeFakeBudgetDb(),
          datasetRepo: makeFakeDatasetRepo(),
          config: makeTestConfig(),
          redesignComposition: { procurement: {}, legalSource },
          // Fast-fail endpoints: resolver-time DB errors are expected and fine;
          // only schema VALIDATION failures matter here.
          redesignKernelConfig: {
            prodDatabaseUrl: 'postgres://test:test@127.0.0.1:1/test',
            meiliHost: '',
            meiliApiKey: '',
            opensearchUrl: '',
          },
        },
      });
    });

    afterAll(async () => {
      await app.close();
    });

    it('mounts the redesign GraphQL route (precondition)', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/graphql',
        payload: { query: '{ __typename }' },
      });
      expect(response.statusCode).toBe(200);
    });

    for (const testCase of LEGAL_CLIENT_CASES) {
      it(`validates: ${testCase.name}`, async () => {
        const response = await app.inject({
          method: 'POST',
          url: '/api/v1/graphql',
          payload: { query: testCase.query, variables: testCase.variables },
        });

        const body: { errors?: readonly { message: string }[] } = response.json();
        const validationErrors = (body.errors ?? []).filter((error) =>
          VALIDATION_ERROR.test(error.message)
        );
        expect(validationErrors).toEqual([]);
      });
    }
  }
);
