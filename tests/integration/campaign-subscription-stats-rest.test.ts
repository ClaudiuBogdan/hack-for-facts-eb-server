import rateLimit, { type RateLimitOptions } from '@fastify/rate-limit';
import fastifyLib, { type FastifyInstance } from 'fastify';
import { err, ok } from 'neverthrow';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createCampaignNotFoundError,
  makeCampaignSubscriptionStatsRoutes,
  type CampaignSubscriptionStatsReader,
} from '@/modules/campaign-subscription-stats/index.js';

function makeReader(): CampaignSubscriptionStatsReader & {
  getByCampaignId: ReturnType<typeof vi.fn>;
} {
  return {
    getByCampaignId: vi.fn(async (campaignId: string) => {
      if (campaignId !== 'funky') {
        return err(createCampaignNotFoundError(campaignId));
      }

      return ok({
        total: 12,
        perUat: [
          { sirutaCode: '179132', uatName: 'Cluj-Napoca', count: 8 },
          { sirutaCode: '55274', uatName: 'Floresti', count: 4 },
        ],
      });
    }),
  };
}

async function createTestApp(options?: {
  reader?: CampaignSubscriptionStatsReader;
  routeRateLimit?: RateLimitOptions;
}): Promise<FastifyInstance> {
  const app = fastifyLib({ logger: false });

  await app.register(rateLimit, {
    max: 1000,
    timeWindow: '1 minute',
  });

  await app.register(
    makeCampaignSubscriptionStatsRoutes({
      reader: options?.reader ?? makeReader(),
      ...(options?.routeRateLimit !== undefined ? { rateLimit: options.routeRateLimit } : {}),
    })
  );

  await app.ready();
  return app;
}

describe('Campaign subscription stats REST API', () => {
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

  it('returns public aggregated stats without authentication', async () => {
    app = await createTestApp();

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/campaigns/funky/subscription-stats',
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe(
      'public, max-age=60, stale-while-revalidate=300'
    );
    expect(response.json()).toEqual({
      total: 12,
      per_uat: [
        { siruta_code: '179132', uat_name: 'Cluj-Napoca', count: 8 },
        { siruta_code: '55274', uat_name: 'Floresti', count: 4 },
      ],
    });
  });

  it('rejects invalid campaign identifiers', async () => {
    app = await createTestApp();

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/campaigns/FUNKY!/subscription-stats',
    });

    expect(response.statusCode).toBe(400);
  });

  it('returns a consistent error envelope for unsupported campaigns', async () => {
    app = await createTestApp();

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/campaigns/unknown/subscription-stats',
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      ok: false,
      error: 'CampaignNotFoundError',
      message: "Campaign 'unknown' is not supported.",
    });
  });

  it('applies route-level rate limiting', async () => {
    const reader = makeReader();
    app = await createTestApp({
      reader,
      routeRateLimit: {
        max: 2,
        timeWindow: '1 minute',
        errorResponseBuilder: (_request, context) => ({
          statusCode: context.statusCode,
          ok: false,
          error: 'RateLimitExceededError',
          message: 'Too many requests',
        }),
      },
    });

    const first = await app.inject({
      method: 'GET',
      url: '/api/v1/campaigns/funky/subscription-stats',
    });
    const second = await app.inject({
      method: 'GET',
      url: '/api/v1/campaigns/funky/subscription-stats',
    });
    const third = await app.inject({
      method: 'GET',
      url: '/api/v1/campaigns/funky/subscription-stats',
    });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(third.statusCode).toBe(429);
    expect(third.json()).toEqual({
      ok: false,
      error: 'RateLimitExceededError',
      message: 'Too many requests',
    });
    expect(reader.getByCampaignId).toHaveBeenCalledTimes(2);
  });
});
