import { CHANNELS, type Cadence, type Channel } from '../shared/types.js';

import type {
  ChannelPlanEntry,
  EligibilityDecision,
  UserNotificationPreferences,
} from './types.js';
import type { KindDefinition } from '../registry/kind-definition.js';

const getKindDefaultCadence = (kind: KindDefinition, channel: Channel): Cadence => {
  return kind.cadence.defaultByChannel[channel] ?? 'immediate';
};

/**
 * A user's channel cadence applies only where the kind permits it
 * (architecture §6.3); otherwise the kind's default (registry-validated
 * to be allowed) is used.
 */
const getEffectiveCadence = (
  kind: KindDefinition,
  channel: Channel,
  userCadence: Cadence
): Cadence => {
  return kind.cadence.allowed.includes(userCadence)
    ? userCadence
    : getKindDefaultCadence(kind, channel);
};

const requiredChannelPlan = (kind: KindDefinition): ChannelPlanEntry[] => {
  return kind.supportedChannels.map((channel) => ({
    channel,
    cadence: getKindDefaultCadence(kind, channel),
  }));
};

export const evaluateEligibility = (input: {
  kind: KindDefinition;
  preferences: UserNotificationPreferences;
  hasActiveSubscription: boolean;
}): EligibilityDecision => {
  const { kind, preferences } = input;

  if (kind.preferenceClass === 'required') {
    const channelPlan = requiredChannelPlan(kind);
    return channelPlan.length === 0
      ? { eligible: false, reason: 'all_channels_disabled' }
      : { eligible: true, channelPlan };
  }

  if (!preferences.globalOptionalEnabled) {
    return { eligible: false, reason: 'global_paused' };
  }

  if (kind.preferenceClass === 'subscription-required' && !input.hasActiveSubscription) {
    return { eligible: false, reason: 'no_active_subscription' };
  }

  const everyPlatformChannelDisabled = CHANNELS.every(
    (channel) => !preferences.channels[channel].enabled
  );
  if (everyPlatformChannelDisabled) {
    return { eligible: false, reason: 'all_channels_disabled' };
  }

  const enabledSupportedChannels = kind.supportedChannels.filter(
    (channel) => preferences.channels[channel].enabled
  );
  if (enabledSupportedChannels.length === 0) {
    return { eligible: false, reason: 'channel_disabled' };
  }

  const channelPlan = enabledSupportedChannels
    .filter((channel) => preferences.channels[channel].cadence !== 'off')
    .map((channel) => ({
      channel,
      cadence: getEffectiveCadence(kind, channel, preferences.channels[channel].cadence),
    }));

  if (channelPlan.length === 0) {
    return { eligible: false, reason: 'cadence_off' };
  }

  return { eligible: true, channelPlan };
};
