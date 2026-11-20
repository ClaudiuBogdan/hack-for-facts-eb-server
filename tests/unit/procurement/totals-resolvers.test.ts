/**
 * `procurementTotals`: off unless enabled (ServiceUnavailable, no read), and
 * a refused request names its field in the GraphQL extensions.
 */
import { GraphQLError } from 'graphql';
import { ok } from 'neverthrow';
import { describe, expect, it } from 'vitest';

import { makeTotalsResolvers } from '@/modules/procurement/shell/graphql/totals-schema.js';

import type { MoneyTotalsPort } from '@/modules/procurement/core/money-totals.js';

const call = (port: MoneyTotalsPort | undefined, requests: unknown) =>
  makeTotalsResolvers(port)
    .Query.procurementTotals(undefined, { requests: requests as never })
    .catch((error: unknown) => error);

describe('procurementTotals resolver', () => {
  it('answers ServiceUnavailable when totals v2 is off', async () => {
    const failure = await call(undefined, [
      { id: 'a', filters: { procurementKinds: ['contract_award'] } },
    ]);
    expect(failure).toBeInstanceOf(GraphQLError);
    expect((failure as GraphQLError).extensions).toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
  });

  it('names the refused field', async () => {
    const port: MoneyTotalsPort = {
      activeBuild: () => Promise.resolve(ok('17')),
      labels: () => Promise.resolve(ok([])),
      supplierRef: () => Promise.resolve(ok(null)),
      aggregate: () => Promise.resolve(ok([])),
    };
    const failure = await call(port, [{ id: 'a', filters: { procurementKinds: [] } }]);
    expect((failure as GraphQLError).extensions).toMatchObject({
      code: 'INVALID_INPUT',
      field: 'procurementKinds',
    });
  });
});
