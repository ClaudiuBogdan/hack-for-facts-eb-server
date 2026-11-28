/**
 * MO-1 aggregate (`issuerYearBreakdown`): the resolution filter reaches the repo,
 * and the repo's resolution counts become `coverage.resolutionRates`.
 */
import { ok } from 'neverthrow';
import { describe, expect, it } from 'vitest';

import { makeMonitorulResolvers } from '@/modules/legal/mo/graphql.js';
import { issuerYearBreakdown } from '@/modules/legal/mo/usecases.js';

import type { MonitorulRepo, MoPublicationAggInput } from '@/modules/legal/mo/ports.js';
import type { MoResolution } from '@/modules/legal/mo/types.js';

const rates = { unique: 808, ambiguous: 0, unmatched: 53 };

const repoSeeing = (seen: MoPublicationAggInput[]): MonitorulRepo =>
  ({
    countPublicationsByIssuerYear: async (input: MoPublicationAggInput) => {
      seen.push(input);
      return ok({
        rows: [{ issuerSlug: 'guvernul-romaniei', actType: null, year: 2025, count: 53 }],
        total: 53,
        rates,
      });
    },
  }) as unknown as MonitorulRepo;

const coverage = { yearRange: async () => ok({ min: 1990, max: 2026 }) };

describe('MO-1 aggregate: resolution filter and rates', () => {
  it('passes the resolution filter to the repo and fills resolutionRates from its counts', async () => {
    const seen: MoPublicationAggInput[] = [];
    const res = await issuerYearBreakdown(repoSeeing(seen), coverage, {
      year: 2025,
      issuerSlug: 'guvernul-romaniei',
      resolution: ['unmatched'],
      groupBy: 'issuer',
    });
    expect(seen).toEqual([
      { year: 2025, issuerSlug: 'guvernul-romaniei', resolution: ['unmatched'], groupBy: 'issuer' },
    ]);
    const value = res._unsafeUnwrap();
    expect(value.denominator).toBe(53);
    expect(value.coverage.resolutionRates).toEqual(rates);
    expect(value.coverage.yearMin).toBe(1990);
  });

  it('the GraphQL resolver drops an explicit null resolution and passes an empty list on', async () => {
    const seen: MoPublicationAggInput[] = [];
    const resolvers = makeMonitorulResolvers({
      repo: repoSeeing(seen),
      base: {} as never,
      coverage,
      registry: {} as never,
    }) as {
      Query: {
        moPublicationsByIssuerYear: (
          r: unknown,
          a: { filter: { year: number; resolution?: MoResolution[] | null } }
        ) => Promise<unknown>;
      };
    };
    await resolvers.Query.moPublicationsByIssuerYear(null, {
      filter: { year: 2025, resolution: null },
    });
    await resolvers.Query.moPublicationsByIssuerYear(null, {
      filter: { year: 2025, resolution: [] },
    });
    expect(seen).toEqual([
      { year: 2025, groupBy: 'issuer' },
      { year: 2025, resolution: [], groupBy: 'issuer' },
    ]);
  });

  it('the GraphQL resolver drops an explicit null issuerSlug and actType', async () => {
    const seen: MoPublicationAggInput[] = [];
    const resolvers = makeMonitorulResolvers({
      repo: repoSeeing(seen),
      base: {} as never,
      coverage,
      registry: {} as never,
    }) as {
      Query: {
        moPublicationsByIssuerYear: (
          r: unknown,
          a: { filter: { year: number; issuerSlug?: string | null; actType?: string[] | null } }
        ) => Promise<unknown>;
      };
    };
    await resolvers.Query.moPublicationsByIssuerYear(null, {
      filter: { year: 2025, issuerSlug: null, actType: null },
    });
    await resolvers.Query.moPublicationsByIssuerYear(null, {
      filter: { year: 2025, issuerSlug: 'guvernul-romaniei', actType: ['ordin'] },
    });
    expect(seen).toEqual([
      { year: 2025, groupBy: 'issuer' },
      { year: 2025, issuerSlug: 'guvernul-romaniei', actType: ['ordin'], groupBy: 'issuer' },
    ]);
  });
});
