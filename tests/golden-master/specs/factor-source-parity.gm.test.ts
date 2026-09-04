/** Phase A paired dev-kernel proof, including factors absent from the original corpus. */
import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { describe, expect, it } from 'vitest';

const baseline = process.env['PHASE_A_BASELINE_URL'];
const target = process.env['PHASE_A_TARGET_URL'];
const suite = baseline !== undefined && target !== undefined ? describe : describe.skip;
const envelopeSchema = Type.Object(
  {
    data: Type.Object({
      executionAnalytics: Type.Array(
        Type.Object({
          seriesId: Type.String(),
          xAxis: Type.Object({ name: Type.String(), type: Type.String(), unit: Type.String() }),
          yAxis: Type.Object({ name: Type.String(), type: Type.String(), unit: Type.String() }),
          data: Type.Array(Type.Object({ x: Type.String(), y: Type.Number() })),
        })
      ),
    }),
  },
  { additionalProperties: false }
);

const document = `query PhaseAFactorParity($inputs: [AnalyticsInput!]!) {
  executionAnalytics(inputs: $inputs) { seriesId xAxis { name type unit } yAxis { name type unit } data { x y } }
}`;

// Two dev endpoints, each using the existing read-only budget path. No snapshots
// are rewritten and no difference allowlist is used for this unchanged slice.
suite('factor source dev-kernel parity', () => {
  it.each([
    { label: 'nominal RON', normalization: 'total', currency: 'RON' },
    { label: 'EUR', normalization: 'total', currency: 'EUR' },
    { label: 'USD', normalization: 'total', currency: 'USD' },
    { label: 'CPI', normalization: 'total', inflation_adjusted: true },
    { label: 'GDP', normalization: 'percent_gdp' },
    { label: 'population', normalization: 'per_capita' },
    {
      label: 'real EUR growth',
      normalization: 'total',
      currency: 'EUR',
      inflation_adjusted: true,
      show_period_growth: true,
    },
  ])(
    '$label full envelope remains identical',
    async ({ label, ...normalization }) => {
      if (baseline === undefined || target === undefined || baseline === target) {
        throw new Error(
          'Two distinct dev endpoints are required: PHASE_A_BASELINE_URL and PHASE_A_TARGET_URL'
        );
      }
      const variables = {
        inputs: [
          {
            seriesId: label,
            filter: {
              account_category: 'ch',
              report_type: 'PRINCIPAL_AGGREGATED',
              entity_cuis: ['4305857'],
              report_period: {
                type: 'YEAR',
                selection: { interval: { start: '2020', end: '2024' } },
              },
              ...normalization,
            },
          },
        ],
      };
      const read = async (url: string) => {
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: document, variables }),
          signal: AbortSignal.timeout(20_000),
        });
        expect(response.status).toBe(200);
        const result: unknown = await response.json();
        expect(
          Value.Check(envelopeSchema, result),
          'No GraphQL errors and a valid full envelope'
        ).toBe(true);
        if (!Value.Check(envelopeSchema, result)) throw new Error('Invalid GraphQL envelope');
        expect(result.data.executionAnalytics[0]?.data.length).toBeGreaterThan(0);
        return result;
      };
      const before = await read(baseline);
      const after = await read(target);
      expect(after).toEqual(before);
    },
    45_000
  );
});
