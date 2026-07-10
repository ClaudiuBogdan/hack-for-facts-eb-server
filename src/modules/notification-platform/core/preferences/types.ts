import type { Cadence, Channel } from '../shared/types.js';

export interface ChannelPreference {
  enabled: boolean;
  cadence: Cadence;
}

export interface UserNotificationPreferences {
  userId: string;
  globalOptionalEnabled: boolean;
  channels: Record<Channel, ChannelPreference>;
}

export type SkipReason =
  | 'global_paused'
  | 'all_channels_disabled'
  | 'no_active_subscription'
  | 'channel_disabled'
  | 'cadence_off'
  | 'destination_suppressed'
  | 'destination_changed'
  | 'user_anonymized'
  | 'expired';

export interface ChannelPlanEntry {
  channel: Channel;
  cadence: Cadence;
}

export type EligibilityDecision =
  | { eligible: true; channelPlan: ChannelPlanEntry[] }
  | { eligible: false; reason: SkipReason };
