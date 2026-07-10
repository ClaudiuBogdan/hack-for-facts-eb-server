import { err, type Result } from 'neverthrow';

import { cancelPendingExternalForUser } from '../../delivery/usecases/cancel-pending-external-for-user.js';

import type { AuditLedgerPort } from '../../audit/ports.js';
import type { PlatformDeliveryError } from '../../delivery/errors.js';
import type { DeliveryRepo } from '../../delivery/ports.js';
import type { DigestBatchRepo } from '../../digest/ports.js';
import type { KindRegistry } from '../../registry/registry.js';
import type { Clock, IdGenerator, LoggerPort } from '../../shared/ports.js';
import type { PreferenceError } from '../errors.js';
import type { PreferenceRepo } from '../ports.js';
import type { UserNotificationPreferences } from '../types.js';

export interface SetGlobalPreferenceDeps {
  preferences: PreferenceRepo;
  deliveries: DeliveryRepo;
  digests: DigestBatchRepo;
  audit: AuditLedgerPort;
  registry: KindRegistry;
  clock: Clock;
  ids: IdGenerator;
  logger: LoggerPort;
}

export interface SetGlobalPreferenceInput {
  userId: string;
  enabled: boolean;
}

export type SetGlobalPreferenceResult = UserNotificationPreferences;
export type SetGlobalPreferenceError = PreferenceError | PlatformDeliveryError;

export const setGlobalPreference = async (
  deps: SetGlobalPreferenceDeps,
  input: SetGlobalPreferenceInput
): Promise<Result<SetGlobalPreferenceResult, SetGlobalPreferenceError>> => {
  const updated = await deps.preferences.upsertGlobal({
    userId: input.userId,
    enabled: input.enabled,
    now: deps.clock.now(),
  });
  if (updated.isErr()) {
    return err(updated.error);
  }
  if (!input.enabled) {
    const cancelled = await cancelPendingExternalForUser(deps, {
      userId: input.userId,
      reason: 'global_preference_disabled',
    });
    if (cancelled.isErr()) {
      return err(cancelled.error);
    }
  }
  return deps.preferences.getForUser(input.userId);
};
