export type CampaignSubscriptionStatsError =
  | {
      type: 'CampaignNotFoundError';
      message: string;
    }
  | {
      type: 'DatabaseError';
      message: string;
      cause?: unknown;
    };

export const createCampaignNotFoundError = (
  campaignId: string
): CampaignSubscriptionStatsError => ({
  type: 'CampaignNotFoundError',
  message: `Campaign '${campaignId}' is not supported.`,
});

export const createDatabaseError = (
  message: string,
  cause?: unknown
): CampaignSubscriptionStatsError => ({
  type: 'DatabaseError',
  message,
  ...(cause !== undefined ? { cause } : {}),
});

export const CAMPAIGN_SUBSCRIPTION_STATS_ERROR_HTTP_STATUS: Record<
  CampaignSubscriptionStatsError['type'],
  404 | 500
> = {
  CampaignNotFoundError: 404,
  DatabaseError: 500,
};

export const getHttpStatusForError = (error: CampaignSubscriptionStatsError): 404 | 500 =>
  CAMPAIGN_SUBSCRIPTION_STATS_ERROR_HTTP_STATUS[error.type];
