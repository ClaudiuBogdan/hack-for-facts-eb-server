import {
  extractTagValue,
  type ResendEmailWebhookEvent,
  type ResendWebhookSideEffect,
  type ResendWebhookSideEffectInput,
} from '@/modules/resend-webhooks/index.js';

import {
  applyProviderOutcome,
  type ApplyProviderOutcomeDeps,
  type ApplyProviderOutcomeInput,
} from '../../core/delivery/usecases/apply-provider-outcome.js';
import { computeDestinationFingerprint } from '../channel/destination-fingerprint.js';

export interface ResendPlatformWebhookSideEffectDeps extends ApplyProviderOutcomeDeps {
  fingerprintSecret: string;
}

const isHardBounce = (event: ResendEmailWebhookEvent): boolean => {
  const bounceType = event.data.bounce?.type.trim().toLowerCase();
  return bounceType === 'permanent' || bounceType === 'hard';
};

const normalizeOutcome = (
  event: ResendEmailWebhookEvent
): ApplyProviderOutcomeInput['outcome'] | null => {
  switch (event.type) {
    case 'email.delivered':
      return 'delivered';
    case 'email.bounced':
      return isHardBounce(event) ? 'bounced' : null;
    case 'email.complained':
      return 'complained';
    case 'email.delivery_delayed':
      return 'delayed';
    default:
      return null;
  }
};

const destinationFingerprintFor = (
  secret: string,
  input: ResendWebhookSideEffectInput
): string | undefined => {
  if (input.event.type !== 'email.bounced' && input.event.type !== 'email.complained') {
    return undefined;
  }

  const address = input.event.data.to[0] ?? input.storedEvent.toAddresses[0];
  if (address === undefined || address.trim().length === 0) {
    return undefined;
  }

  return computeDestinationFingerprint(secret, address);
};

export const makeResendPlatformWebhookSideEffect = (
  deps: ResendPlatformWebhookSideEffectDeps
): ResendWebhookSideEffect => ({
  async handle(input) {
    const outcome = normalizeOutcome(input.event);
    if (outcome === null) {
      return;
    }

    const destinationFingerprint = destinationFingerprintFor(deps.fingerprintSecret, input);
    const deliveryId = extractTagValue(input.event.data.tags, 'delivery_id');
    const result = await applyProviderOutcome(deps, {
      providerRef: input.event.data.email_id,
      ...(deliveryId === undefined ? {} : { deliveryId }),
      outcome,
      occurredAt: input.storedEvent.eventCreatedAt,
      ...(destinationFingerprint === undefined ? {} : { destinationFingerprint }),
    });
    if (result.isErr()) {
      deps.logger.error('Notification platform Resend webhook side effect failed', {
        eventType: input.event.type,
        providerRef: input.event.data.email_id,
        errorType: result.error.type,
      });
      throw new Error('Notification platform Resend webhook side effect failed');
    }

    deps.logger.debug('Notification platform Resend webhook outcome processed', {
      eventType: input.event.type,
      providerRef: input.event.data.email_id,
      applied: result.value.applied,
    });
  },
});
