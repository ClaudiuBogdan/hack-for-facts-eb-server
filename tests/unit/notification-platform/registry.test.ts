import { Type } from '@sinclair/typebox';
import { ok } from 'neverthrow';
import { describe, expect, it } from 'vitest';

import { makeKindRegistry } from '@/modules/notification-platform/core/registry/registry.js';

import type { KindDefinition } from '@/modules/notification-platform/core/registry/kind-definition.js';

const makeKind = (overrides: Partial<KindDefinition> = {}): KindDefinition => ({
  kindId: 'test.kind',
  kindVersion: 1,
  eventType: 'test.event',
  eventSchemaVersion: 1,
  eventFactsSchema: Type.Object({ sequence: Type.Integer() }),
  recipientResolution: { strategy: 'policy', policyResolverId: 'test-policy' },
  preferenceClass: 'opt-out',
  supportedChannels: ['inbox', 'email'],
  cadence: {
    allowed: ['immediate', 'daily'],
    defaultByChannel: { inbox: 'immediate', email: 'daily' },
  },
  deliveryExpiryHours: 24,
  ordering: {
    streamKey: () => 'stream',
    streamSequence: () => 1,
  },
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
  activeSender: 'shadow',
  ...overrides,
});

describe('makeKindRegistry', () => {
  it('accepts a coherent definition and exposes both lookups', () => {
    const kind = makeKind();
    const result = makeKindRegistry([kind]);

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.getByKindId(kind.kindId)).toBe(kind);
      expect(result.value.getByEventType(kind.eventType)).toBe(kind);
      expect(result.value.getByKindId('missing')).toBeUndefined();
      expect(result.value.list()).toEqual([kind]);
    }
  });

  it('rejects duplicate kind ids', () => {
    const result = makeKindRegistry([makeKind(), makeKind({ eventType: 'another.event' })]);

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.field).toBe('kindId');
    }
  });

  it('rejects duplicate event types to preserve strict one-to-one mapping', () => {
    const result = makeKindRegistry([makeKind(), makeKind({ kindId: 'another.kind' })]);

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.field).toBe('eventType');
    }
  });

  it.each([
    [
      'missing default',
      { allowed: ['immediate'] as const, defaultByChannel: { inbox: 'immediate' as const } },
    ],
    [
      'default outside allowed set',
      {
        allowed: ['immediate'] as const,
        defaultByChannel: { inbox: 'immediate' as const, email: 'daily' as const },
      },
    ],
  ])('rejects incoherent cadence coverage: %s', (_name, cadence) => {
    const result = makeKindRegistry([makeKind({ cadence })]);
    expect(result.isErr()).toBe(true);
  });

  it('rejects ordering without a sequence function', () => {
    const invalidOrdering = {
      streamKey: () => 'stream',
    } as unknown as KindDefinition['ordering'];
    const result = makeKindRegistry([makeKind({ ordering: invalidOrdering })]);

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.field).toBe('ordering');
    }
  });

  it('rejects a missing template for a supported channel', () => {
    const invalidTemplates = {
      inbox: { templateId: 'inbox-template', version: '1' },
    } as KindDefinition['templates'];
    const result = makeKindRegistry([makeKind({ templates: invalidTemplates })]);

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.field).toBe('templates.email');
    }
  });

  it('returns an error instead of throwing for a malformed template object', () => {
    const malformedTemplates = {
      inbox: { version: '1' },
      email: { templateId: 'email-template', version: '1' },
    } as unknown as KindDefinition['templates'];

    const result = makeKindRegistry([makeKind({ templates: malformedTemplates })]);

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.field).toBe('templates.inbox');
    }
  });

  it.each([
    ['empty kindId', { kindId: '' }, 'kindId'],
    ['empty eventType', { eventType: '' }, 'eventType'],
    ['non-positive kindVersion', { kindVersion: 0 }, 'kindVersion'],
    ['non-positive eventSchemaVersion', { eventSchemaVersion: 0 }, 'eventSchemaVersion'],
    ['non-positive deliveryExpiryHours', { deliveryExpiryHours: 0 }, 'deliveryExpiryHours'],
    ['empty supportedChannels', { supportedChannels: [] }, 'supportedChannels'],
    ['duplicate supportedChannels', { supportedChannels: ['email', 'email'] }, 'supportedChannels'],
    [
      'empty allowed cadences',
      { cadence: { allowed: [], defaultByChannel: {} } },
      'cadence.allowed',
    ],
  ] as const)('rejects a kind with %s', (_name, overrides, field) => {
    const result = makeKindRegistry([makeKind(overrides)]);

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.field).toBe(field);
    }
  });
});
