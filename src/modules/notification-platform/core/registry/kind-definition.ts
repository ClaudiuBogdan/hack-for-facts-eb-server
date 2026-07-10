import type { ValidationError } from '../shared/errors.js';
import type { Cadence, Channel, Locale, PreferenceClass, SenderMode } from '../shared/types.js';
import type { Static, TSchema } from '@sinclair/typebox';
import type { Result } from 'neverthrow';

export interface ContentProjection {
  inbox: { title: string; body: string; actionUrl: string | null };
  email: { templatePayload: Record<string, unknown> };
  digestItem: { title: string; summary: string; actionUrl: string | null };
}

export interface PolicyRecipientResolution {
  strategy: 'policy';
  policyResolverId: string;
}

export interface OrderingPolicy<TEventFacts extends TSchema> {
  streamKey(facts: Static<TEventFacts>): string;
  streamSequence(facts: Static<TEventFacts>): number;
}

export interface RedactionPolicy {
  redactedFactPaths: readonly string[];
  redactedRecipientFactPaths: readonly string[];
}

export interface KindDefinition<
  TEventFacts extends TSchema = TSchema,
  TSubscriptionConfig extends TSchema = TSchema,
> {
  kindId: string;
  kindVersion: number;
  eventType: string;
  eventSchemaVersion: number;
  eventFactsSchema: TEventFacts;
  recipientResolution:
    | {
        strategy: 'subscription';
        subscription: {
          configSchema: TSubscriptionConfig;
          allowedSubjectTypes: readonly string[];
          subjectFromFacts(facts: Static<TEventFacts>): {
            subjectType: string;
            subjectId: string;
          };
        };
      }
    | PolicyRecipientResolution;
  preferenceClass: PreferenceClass;
  supportedChannels: readonly Channel[];
  cadence: {
    allowed: readonly Cadence[];
    defaultByChannel: Partial<Record<Channel, Cadence>>;
  };
  deliveryExpiryHours: number | null;
  ordering: OrderingPolicy<TEventFacts> | null;
  projectContent(input: {
    facts: Static<TEventFacts>;
    locale: Locale;
    recipient: { userId: string; recipientFacts?: Record<string, unknown> };
    links: { platformBaseUrl: string };
  }): Result<ContentProjection, ValidationError>;
  redaction: RedactionPolicy;
  templates: {
    inbox: { templateId: string; version: string };
    email: { templateId: string; version: string };
  };
  activeSender: SenderMode;
}
