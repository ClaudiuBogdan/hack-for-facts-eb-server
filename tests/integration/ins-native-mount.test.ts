/**
 * The native INS module mounts on the kernel endpoint (opt-in `'ins-native'`)
 * next to the budget module (which owns `PeriodDate`, `ReportPeriodInput` and
 * the `PageInfo` extension the INS connections rely on): the merged schema
 * validates, the eight client-sent roots exist, the two dropped roots do not,
 * and the frozen leaf fields are present. No database is reached: the pool
 * points at a closed port and only introspection is executed.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildRedesignApp } from '@/app/build-redesign-app.js';
import { INS_LEGACY_ROOTS, INS_LEGACY_ROOTS_DROPPED } from '@/modules/ins-native/index.js';

import type { FastifyInstance } from 'fastify';

describe('ins-native module on the kernel endpoint', () => {
  let app: FastifyInstance | undefined;

  beforeAll(async () => {
    const built = await buildRedesignApp({
      logLevel: 'silent',
      modules: ['budget', 'ins-native'],
      kernelConfig: {
        prodDatabaseUrl: 'postgres://unused:unused@127.0.0.1:1/unused',
        meiliHost: '',
        meiliApiKey: '',
        opensearchUrl: '',
      },
    });
    app = built.app;
    await app.ready();
  }, 60_000);

  afterAll(async () => {
    await app?.close();
  });

  const introspect = async (query: string): Promise<Record<string, unknown>> => {
    if (app === undefined) throw new Error('app not built');
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/graphql',
      payload: { query },
    });
    expect(res.statusCode).toBe(200);
    return res.json<{ data: Record<string, unknown> }>().data;
  };

  it('exposes exactly the eight client-sent INS roots and not the two dropped ones', async () => {
    const data = await introspect('{ __type(name: "Query") { fields { name } } }');
    const fields = (data['__type'] as { fields: { name: string }[] }).fields.map((f) => f.name);
    for (const root of INS_LEGACY_ROOTS) expect(fields).toContain(root);
    for (const root of INS_LEGACY_ROOTS_DROPPED) expect(fields).not.toContain(root);
  });

  it('keeps the legacy leaf shapes on the connection and observation types', async () => {
    const pageInfo = await introspect('{ __type(name: "PageInfo") { fields { name } } }');
    const pageInfoFields = (pageInfo['__type'] as { fields: { name: string }[] }).fields.map(
      (f) => f.name
    );
    expect(pageInfoFields).toEqual(
      expect.arrayContaining(['hasNextPage', 'totalCount', 'hasPreviousPage'])
    );
    const observation = await introspect(
      '{ __type(name: "InsObservation") { fields { name type { kind name ofType { name } } } } }'
    );
    const obsFields = (observation['__type'] as { fields: { name: string }[] }).fields.map(
      (f) => f.name
    );
    expect(obsFields).toEqual([
      'id',
      'dataset_code',
      'territory',
      'time_period',
      'unit',
      'value',
      'value_status',
      'classifications',
      'dimensions',
    ]);
    const periodicity = await introspect(
      '{ __type(name: "InsPeriodicity") { enumValues { name } } }'
    );
    expect(
      (periodicity['__type'] as { enumValues: { name: string }[] }).enumValues.map((v) => v.name)
    ).toEqual(['ANNUAL', 'QUARTERLY', 'MONTHLY', 'SEMESTRIAL', 'RANGE', 'OTHER']);
  });
});
