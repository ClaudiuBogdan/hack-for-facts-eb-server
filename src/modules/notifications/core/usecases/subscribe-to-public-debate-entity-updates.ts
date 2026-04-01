import { subscribe, type SubscribeDeps } from './subscribe.js';

import type { NotificationError } from '../errors.js';
import type { Notification } from '../types.js';
import type { Result } from 'neverthrow';

export interface SubscribeToPublicDebateEntityUpdatesInput {
  userId: string;
  entityCui: string;
}

export async function subscribeToPublicDebateEntityUpdates(
  deps: SubscribeDeps,
  input: SubscribeToPublicDebateEntityUpdatesInput
): Promise<Result<Notification, NotificationError>> {
  return subscribe(deps, {
    userId: input.userId,
    notificationType: 'campaign_public_debate_entity_updates',
    entityCui: input.entityCui,
    config: null,
  });
}
