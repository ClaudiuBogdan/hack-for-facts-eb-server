import { describe, expect, it } from 'vitest';

import { loadChronosDevEmailConfig } from '@/app/chronos-dev-notification-delivery.js';

const clientUrl = 'https://dev-chronos.transparenta.eu';
const signingSecret = 'whsec_Zml4dHVyZS1vbmx5';
const redis = {
  url: 'rediss://queue.example.test:6379/0',
  password: 'fixture',
  caFile: '/fixture/ca.crt',
};

describe('Chronos dev mail configuration', () => {
  it('keeps workers and sends off when credentials are present', () => {
    const env = {
      RESEND_WEBHOOK_SECRET: signingSecret,
      RESEND_API_KEY: 're_fixture',
      EMAIL_FROM_ADDRESS: 'example@example.test',
      CLERK_SECRET_KEY: 'sk_test_fixture',
      UNSUBSCRIBE_HMAC_SECRET: 'x'.repeat(32),
    };
    expect(loadChronosDevEmailConfig(env, clientUrl, redis)).toEqual({ signingSecret });
    expect(
      loadChronosDevEmailConfig(
        {
          ...env,
          CHRONOS_DEV_CAMPAIGN_REPLAY_EVENT_ID: 'fixture-event',
          NOTIFICATION_DELIVERY_ENABLED: 'false',
        },
        clientUrl,
        redis
      )
    ).toEqual({ signingSecret });
    expect(
      loadChronosDevEmailConfig(
        { ...env, NOTIFICATION_DELIVERY_ENABLED: 'false' },
        clientUrl,
        redis
      )
    ).toEqual({ signingSecret });
    expect(
      loadChronosDevEmailConfig({ ...env, NOTIFICATION_DELIVERY_ENABLED: 'true' }, clientUrl, redis)
    ).toHaveProperty('send');
    expect(() =>
      loadChronosDevEmailConfig(
        {
          ...env,
          CHRONOS_DEV_CAMPAIGN_WELCOME_OWNER: 'user_wrong',
          NOTIFICATION_DELIVERY_ENABLED: 'true',
        },
        clientUrl,
        redis
      )
    ).toThrow(/approved Clerk test owner/);
  });

  it('fails closed without valid origins and the independent receiver', () => {
    expect(() =>
      loadChronosDevEmailConfig(
        { RESEND_WEBHOOK_SECRET: signingSecret },
        'https://transparenta.eu',
        redis
      )
    ).toThrow(/HTTPS client and API origins/);
    expect(() =>
      loadChronosDevEmailConfig({ NOTIFICATION_DELIVERY_ENABLED: 'true' }, clientUrl, redis)
    ).toThrow(/signing secret/);
    expect(() =>
      loadChronosDevEmailConfig(
        { NOTIFICATION_DELIVERY_ENABLED: 'true', RESEND_WEBHOOK_SECRET: signingSecret },
        clientUrl,
        redis
      )
    ).toThrow(/sender credentials/);
  });

  it('can enable the same welcome runtime with production origins and credentials', () => {
    const env = {
      NOTIFICATION_DELIVERY_ENABLED: 'true',
      API_BASE_URL: 'https://api.transparenta.eu',
      RESEND_WEBHOOK_SECRET: signingSecret,
      RESEND_API_KEY: 're_fixture',
      EMAIL_FROM_ADDRESS: 'hello@example.test',
      FUNKY_EMAIL_FROM_ADDRESS: 'campaign@example.test',
      CLERK_SECRET_KEY: 'sk_live_fixture',
      UNSUBSCRIBE_HMAC_SECRET: 'x'.repeat(32),
    };
    expect(loadChronosDevEmailConfig(env, 'https://transparenta.eu', redis)).toMatchObject({
      environment: 'api-transparenta-eu',
      send: { apiBaseUrl: env.API_BASE_URL, from: env.FUNKY_EMAIL_FROM_ADDRESS },
    });
    expect(() =>
      loadChronosDevEmailConfig(
        { ...env, CLERK_SECRET_KEY: undefined },
        'https://transparenta.eu',
        redis
      )
    ).toThrow(/Clerk backend key/);
  });
});
