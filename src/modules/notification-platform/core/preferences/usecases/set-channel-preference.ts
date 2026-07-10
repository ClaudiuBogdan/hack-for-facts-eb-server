import { err, type Result } from 'neverthrow';

import { cancelPendingExternalForUser } from '../../delivery/usecases/cancel-pending-external-for-user.js';

import type { AuditLedgerPort } from '../../audit/ports.js';
import type { PlatformDeliveryError } from '../../delivery/errors.js';
import type { DeliveryRepo } from '../../delivery/ports.js';
import type { DigestBatchRepo } from '../../digest/ports.js';
import type { KindRegistry } from '../../registry/registry.js';
import type { Clock, IdGenerator, LoggerPort } from '../../shared/ports.js';
import type { Cadence, Channel } from '../../shared/types.js';
import type { PreferenceError } from '../errors.js';
import type { PreferenceRepo } from '../ports.js';
import type { UserNotificationPreferences } from '../types.js';

export interface SetChannelPreferenceDeps {
  preferences: PreferenceRepo;
  deliveries: DeliveryRepo;
  digests: DigestBatchRepo;
  audit: AuditLedgerPort;
  registry: KindRegistry;
  clock: Clock;
  ids: IdGenerator;
  logger: LoggerPort;
}

export interface SetChannelPreferenceInput {
  userId: string;
  channel: Channel;
  enabled: boolean;
  cadence: Cadence;
}

export type SetChannelPreferenceResult = UserNotificationPreferences;
export type SetChannelPreferenceError = PreferenceError | PlatformDeliveryError;

export const setChannelPreference = async (
  deps: SetChannelPreferenceDeps,
  input: SetChannelPreferenceInput
): Promise<Result<SetChannelPreferenceResult, SetChannelPreferenceError>> => {
  // DESIGN NOTE: preferences are global per channel and the input has no kindId;
  // kind-specific cadence compatibility is therefore enforced by evaluateEligibility,
  // which falls back to each kind's registered default.
  const updated = await deps.preferences.upsertChannel({
    userId: input.userId,
    channel: input.channel,
    enabled: input.enabled,
    cadence: input.cadence,
    now: deps.clock.now(),
  });
  if (updated.isErr()) {
    return err(updated.error);
  }
  if (input.channel === 'email' && (!input.enabled || input.cadence === 'off')) {
    const cancelled = await cancelPendingExternalForUser(deps, {
      userId: input.userId,
      channels: ['email'],
      reason: 'channel_preference_disabled',
    });
    if (cancelled.isErr()) {
      return err(cancelled.error);
    }
  }
  return deps.preferences.getForUser(input.userId);
};
