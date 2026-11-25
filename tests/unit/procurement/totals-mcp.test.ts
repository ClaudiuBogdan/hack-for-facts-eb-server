/**
 * aggregate_procurement_totals: the same structured answers as GraphQL — null
 * means "not set", and a bad value is an InvalidInput naming its field.
 */
import { ok } from 'neverthrow';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { makeTotalsMcpTools } from '@/modules/procurement/shell/mcp/totals-tools.js';

import type { MoneyTotalsPort } from '@/modules/procurement/core/money-totals.js';

const port: MoneyTotalsPort = {
  activeBuild: () => Promise.resolve(ok('17')),
  caFloor: () => Promise.resolve(ok(null)),
  labels: () => Promise.resolve(ok([])),
  supplierRef: () => Promise.resolve(ok(null)),
  aggregate: () => Promise.resolve(ok([])),
};
const [tool] = makeTotalsMcpTools(port);
const parse = (args: unknown) =>
  z
    .object(tool?.inputShape ?? {})
    .strict()
    .safeParse(args);

describe('aggregate_procurement_totals', () => {
  it('accepts null as "not set", as GraphQL does', async () => {
    const args = {
      requests: [{ id: 'a', filters: { procurementKinds: ['direct_acquisition'], from: null } }],
    };
    expect(parse(args).success).toBe(true);
    const out = await tool?.handler(args);
    expect(out).toMatchObject({ ok: true, meta: { factBuild: '17', disclosureKey: 'off' } });
  });

  it('answers a bad value as a structured InvalidInput naming the field', async () => {
    const args = {
      requests: [
        { id: 'a', filters: { procurementKinds: ['direct_acquisition'], statuses: ['bogus'] } },
      ],
    };
    expect(parse(args).success).toBe(true);
    expect(await tool?.handler(args)).toMatchObject({
      ok: false,
      errorType: 'InvalidInput',
      error: "unknown statuses 'bogus'",
    });
  });
});
