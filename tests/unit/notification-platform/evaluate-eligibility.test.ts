import { Type } from '@sinclair/typebox';
import { ok } from 'neverthrow';
import { describe, expect, it } from 'vitest';

import { evaluateEligibility } from '@/modules/notification-platform/core/preferences/evaluate-eligibility.js';

import type { UserNotificationPreferences } from '@/modules/notification-platform/core/preferences/types.js';
import type { KindDefinition } from '@/modules/notification-platform/core/registry/kind-definition.js';

const makeKind = (overrides: Partial<KindDefinition> = {}): KindDefinition => ({
  kindId: 'test.kind',
  kindVersion: 1,
  eventType: 'test.event',
  eventSchemaVersion: 1,
  eventFactsSchema: Type.Object({ id: Type.String() }),
  recipientResolution: { strategy: 'policy', policyResolverId: 'test-policy' },
  preferenceClass: 'opt-out',
  supportedChannels: ['inbox', 'email'],
  cadence: {
    allowed: ['immediate', 'daily', 'weekly'],
    defaultByChannel: { inbox: 'immediate', email: 'immediate' },
  },
  deliveryExpiryHours: null,
  ordering: null,
  projectContent: () =>
    ok({
      inbox: { title: 'Title', body: 'Body', actionUrl: null },
      email: { templatePayload: {} },
      digestItem: { title: 'Title', summary: 'Summary', actionUrl: null },
    }),
  redaction: { redactedFactPaths: [], redactedRecipientFactPaths: [] },
  templates: {
    inbox: { templateId: 'inbox-template', version: '1' },
    email: { templateId: 'email-template', version: '1' },
  },
  activeSender: 'active',
  ...overrides,
});

const makePreferences = (
  overrides: Partial<UserNotificationPreferences> = {}
): UserNotificationPreferences => ({
  userId: 'user-1',
  globalOptionalEnabled: true,
  channels: {
    inbox: { enabled: true, cadence: 'immediate' },
    email: { enabled: true, cadence: 'immediate' },
  },
  ...overrides,
});

describe('evaluateEligibility', () => {
  it('gives global pause first precedence for optional kinds', () => {
    const decision = evaluateEligibility({
      kind: makeKind({ preferenceClass: 'subscription-required' }),
      preferences: makePreferences({
        globalOptionalEnabled: false,
        channels: {
          inbox: { enabled: false, cadence: 'off' },
          email: { enabled: false, cadence: 'off' },
        },
      }),
      hasActiveSubscription: false,
    });

    expect(decision).toEqual({ eligible: false, reason: 'global_paused' });
  });

  it('requires an active subscription before channel evaluation', () => {
    const decision = evaluateEligibility({
      kind: makeKind({ preferenceClass: 'subscription-required' }),
      preferences: makePreferences({
        channels: {
          inbox: { enabled: false, cadence: 'off' },
          email: { enabled: false, cadence: 'off' },
        },
      }),
      hasActiveSubscription: false,
    });

    expect(decision).toEqual({ eligible: false, reason: 'no_active_subscription' });
  });

  it('skips when every platform channel is disabled', () => {
    const decision = evaluateEligibility({
      kind: makeKind(),
      preferences: makePreferences({
        channels: {
          inbox: { enabled: false, cadence: 'immediate' },
          email: { enabled: false, cadence: 'immediate' },
        },
      }),
      hasActiveSubscription: true,
    });

    expect(decision).toEqual({ eligible: false, reason: 'all_channels_disabled' });
  });

  it('skips when the only kind-supported channel is disabled', () => {
    const decision = evaluateEligibility({
      kind: makeKind({ supportedChannels: ['email'] }),
      preferences: makePreferences({
        channels: {
          inbox: { enabled: true, cadence: 'immediate' },
          email: { enabled: false, cadence: 'immediate' },
        },
      }),
      hasActiveSubscription: true,
    });

    expect(decision).toEqual({ eligible: false, reason: 'channel_disabled' });
  });

  it('skips when every enabled supported channel has cadence off', () => {
    const decision = evaluateEligibility({
      kind: makeKind({ supportedChannels: ['email'] }),
      preferences: makePreferences({
        channels: {
          inbox: { enabled: true, cadence: 'immediate' },
          email: { enabled: true, cadence: 'off' },
        },
      }),
      hasActiveSubscription: true,
    });

    expect(decision).toEqual({ eligible: false, reason: 'cadence_off' });
  });

  it('plans only enabled channels and preserves their cadence', () => {
    const decision = evaluateEligibility({
      kind: makeKind(),
      preferences: makePreferences({
        channels: {
          inbox: { enabled: true, cadence: 'daily' },
          email: { enabled: false, cadence: 'weekly' },
        },
      }),
      hasActiveSubscription: true,
    });

    expect(decision).toEqual({
      eligible: true,
      channelPlan: [{ channel: 'inbox', cadence: 'daily' }],
    });
  });

  it('allows opt-out kinds without a subscription', () => {
    const decision = evaluateEligibility({
      kind: makeKind({ preferenceClass: 'opt-out' }),
      preferences: makePreferences(),
      hasActiveSubscription: false,
    });

    expect(decision.eligible).toBe(true);
  });

  it('makes required kinds bypass global, enabled, and cadence-off preferences', () => {
    const decision = evaluateEligibility({
      kind: makeKind({ preferenceClass: 'required' }),
      preferences: makePreferences({
        globalOptionalEnabled: false,
        channels: {
          inbox: { enabled: false, cadence: 'off' },
          email: { enabled: false, cadence: 'off' },
        },
      }),
      hasActiveSubscription: false,
    });

    expect(decision).toEqual({
      eligible: true,
      channelPlan: [
        { channel: 'inbox', cadence: 'immediate' },
        { channel: 'email', cadence: 'immediate' },
      ],
    });
  });

  it('falls back to the kind default when the user cadence is not permitted by the kind', () => {
    const decision = evaluateEligibility({
      kind: makeKind({
        supportedChannels: ['email'],
        cadence: { allowed: ['immediate'], defaultByChannel: { email: 'immediate' } },
      }),
      preferences: makePreferences({
        channels: {
          inbox: { enabled: false, cadence: 'off' },
          email: { enabled: true, cadence: 'weekly' },
        },
      }),
      hasActiveSubscription: true,
    });

    expect(decision).toEqual({
      eligible: true,
      channelPlan: [{ channel: 'email', cadence: 'immediate' }],
    });
  });

  it('keeps a permitted user cadence unchanged', () => {
    const decision = evaluateEligibility({
      kind: makeKind({ supportedChannels: ['email'] }),
      preferences: makePreferences({
        channels: {
          inbox: { enabled: false, cadence: 'off' },
          email: { enabled: true, cadence: 'weekly' },
        },
      }),
      hasActiveSubscription: true,
    });

    expect(decision).toEqual({
      eligible: true,
      channelPlan: [{ channel: 'email', cadence: 'weekly' }],
    });
  });

  it('uses the reviewed kind default cadence for required notifications', () => {
    const decision = evaluateEligibility({
      kind: makeKind({ preferenceClass: 'required', supportedChannels: ['email'] }),
      preferences: makePreferences({
        channels: {
          inbox: { enabled: false, cadence: 'off' },
          email: { enabled: false, cadence: 'weekly' },
        },
      }),
      hasActiveSubscription: false,
    });

    expect(decision).toEqual({
      eligible: true,
      channelPlan: [{ channel: 'email', cadence: 'immediate' }],
    });
  });
});
