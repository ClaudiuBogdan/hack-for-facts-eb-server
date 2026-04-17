import { Value } from '@sinclair/typebox/value';
import { describe, expect, it } from 'vitest';

import {
  PublicDebateEntityUpdateThreadStartedSubscriberPayloadSchema,
  WelcomePayloadSchema,
} from '@/modules/email-templates/core/schemas.js';
import {
  indexRegistrations,
  makeTemplateRegistry,
} from '@/modules/email-templates/shell/registry/index.js';

const makeDiscoveredModule = (label: string, id: string) => ({
  label,
  registration: {
    id,
    name: id,
    version: '1.0.0',
    description: `${id} description`,
    payloadSchema: WelcomePayloadSchema,
    createElement() {
      return {} as never;
    },
    getSubject() {
      return id;
    },
    exampleProps: {
      templateType: 'welcome' as const,
      lang: 'ro' as const,
      unsubscribeUrl: 'https://transparenta.eu/unsub/token',
      platformBaseUrl: 'https://transparenta.eu',
      copyrightYear: 2026,
      registeredAt: '2026-03-28T15:00:00.000Z',
    },
  },
});

describe('Template Registry', () => {
  const registry = makeTemplateRegistry();

  it('discovers all registration files', () => {
    const all = registry.getAll();
    expect(all).toHaveLength(13);
    const ids = all.map((r) => r.id);
    expect(ids).toEqual([
      'admin_reviewed_user_interaction',
      'alert_series',
      'anaf_forexebug_digest',
      'newsletter_entity',
      'public_debate_admin_failure',
      'public_debate_admin_response_requester',
      'public_debate_admin_response_subscriber',
      'public_debate_campaign_welcome',
      'public_debate_entity_subscription',
      'public_debate_entity_update',
      'public_debate_entity_update_thread_started_subscriber',
      'weekly_progress_digest',
      'welcome',
    ]);
  });

  it('returns welcome registration by id', () => {
    const reg = registry.get('welcome');
    expect(reg).toBeDefined();
    expect(reg?.id).toBe('welcome');
    expect(reg?.name).toBe('welcome');
    expect(reg?.version).toBe('1.0.0');
  });

  it('returns undefined for unknown id', () => {
    expect(registry.get('nonexistent')).toBeUndefined();
  });

  it('has() returns true for registered and false for unknown', () => {
    expect(registry.has('welcome')).toBe(true);
    expect(registry.has('alert_series')).toBe(true);
    expect(registry.has('newsletter_entity')).toBe(true);
    expect(registry.has('anaf_forexebug_digest')).toBe(true);
    expect(registry.has('admin_reviewed_user_interaction')).toBe(true);
    expect(registry.has('public_debate_admin_failure')).toBe(true);
    expect(registry.has('public_debate_admin_response_requester')).toBe(true);
    expect(registry.has('public_debate_admin_response_subscriber')).toBe(true);
    expect(registry.has('public_debate_campaign_welcome')).toBe(true);
    expect(registry.has('public_debate_entity_subscription')).toBe(true);
    expect(registry.has('public_debate_entity_update')).toBe(true);
    expect(registry.has('public_debate_entity_update_thread_started_subscriber')).toBe(true);
    expect(registry.has('weekly_progress_digest')).toBe(true);
    expect(registry.has('nonexistent')).toBe(false);
  });

  it('getShell returns registration with rendering capabilities', () => {
    const reg = registry.getShell('welcome');
    expect(reg).toBeDefined();
    expect(typeof reg?.createElement).toBe('function');
    expect(typeof reg?.getSubject).toBe('function');
    expect(reg?.exampleProps).toBeDefined();
  });

  it('rejects duplicate template ids during indexing', () => {
    expect(() =>
      indexRegistrations([
        makeDiscoveredModule('/tmp/first.ts', 'welcome'),
        makeDiscoveredModule('/tmp/second.ts', 'welcome'),
      ])
    ).toThrow(
      "Duplicate email template id 'welcome' found in '/tmp/first.ts' and '/tmp/second.ts'"
    );
  });

  it('rejects malformed registration exports during indexing', () => {
    expect(() =>
      indexRegistrations([{ label: '/tmp/bad.ts', registration: { id: 'welcome' } }])
    ).toThrow("Email template registration '/tmp/bad.ts' must export a valid registration object");
  });
});

describe('WelcomePayloadSchema validation', () => {
  it('accepts valid welcome payload', () => {
    const payload = {
      registeredAt: '2026-03-28T15:00:00.000Z',
      ctaUrl: 'https://transparenta.eu',
    };
    expect(Value.Check(WelcomePayloadSchema, payload)).toBe(true);
  });

  it('accepts minimal welcome payload (only registeredAt)', () => {
    const payload = { registeredAt: '2026-03-28T15:00:00.000Z' };
    expect(Value.Check(WelcomePayloadSchema, payload)).toBe(true);
  });

  it('rejects payload missing registeredAt', () => {
    const payload = {};
    expect(Value.Check(WelcomePayloadSchema, payload)).toBe(false);
  });

  it('rejects empty registeredAt', () => {
    const payload = { registeredAt: '' };
    expect(Value.Check(WelcomePayloadSchema, payload)).toBe(false);
  });

  it('accepts valid subscriber public debate thread-started payload', () => {
    const payload = {
      entityCui: '12345678',
      entityName: 'Municipiul Exemplu',
      occurredAt: '2026-04-03T10:00:00.000Z',
      ctaUrl: 'https://transparenta.eu/primarie/12345678',
    };
    expect(Value.Check(PublicDebateEntityUpdateThreadStartedSubscriberPayloadSchema, payload)).toBe(
      true
    );
  });

  it('rejects subscriber public debate thread-started payload without CTA URL', () => {
    const payload = {
      entityCui: '12345678',
      occurredAt: '2026-04-03T10:00:00.000Z',
    };
    expect(Value.Check(PublicDebateEntityUpdateThreadStartedSubscriberPayloadSchema, payload)).toBe(
      false
    );
  });
});
