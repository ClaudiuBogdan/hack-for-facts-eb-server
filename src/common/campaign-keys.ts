export const FUNKY_CAMPAIGN_KEY = 'funky' as const;
export const PUBLIC_DEBATE_CAMPAIGN_KEY = FUNKY_CAMPAIGN_KEY;

export const FUNKY_NOTIFICATION_GLOBAL_TYPE = 'funky:notification:global' as const;
export const FUNKY_NOTIFICATION_ENTITY_UPDATES_TYPE = 'funky:notification:entity_updates' as const;

export const FUNKY_OUTBOX_WELCOME_TYPE = 'funky:outbox:welcome' as const;
export const FUNKY_OUTBOX_ENTITY_SUBSCRIPTION_TYPE = 'funky:outbox:entity_subscription' as const;
export const FUNKY_OUTBOX_ENTITY_UPDATE_TYPE = 'funky:outbox:entity_update' as const;
export const FUNKY_OUTBOX_ADMIN_FAILURE_TYPE = 'funky:outbox:admin_failure' as const;

export const FUNKY_PROGRESS_STATE_KEY = 'funky:progress:state' as const;
export const FUNKY_PROGRESS_ONBOARDING_KEY = 'funky:progress:onboarding' as const;
export const FUNKY_PROGRESS_TERMS_ACCEPTED_PREFIX =
  'funky:progress:terms_accepted::entity:' as const;
