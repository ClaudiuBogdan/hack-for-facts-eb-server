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

  it('fails closed outside the dev client or without the independent receiver', () => {
    expect(() =>
      loadChronosDevEmailConfig(
        { RESEND_WEBHOOK_SECRET: signingSecret },
        'https://transparenta.eu',
        redis
      )
    ).toThrow(/development client/);
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
});
