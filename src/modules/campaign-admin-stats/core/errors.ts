export type CampaignAdminStatsError =
  | {
      type: 'CampaignAdminStatsNotFoundError';
      message: string;
    }
  | {
      type: 'CampaignAdminStatsDatabaseError';
      message: string;
      cause?: unknown;
    };

export const createCampaignNotFoundError = (campaignKey: string): CampaignAdminStatsError => ({
  type: 'CampaignAdminStatsNotFoundError',
  message: `Campaign '${campaignKey}' is not supported.`,
});

export const createDatabaseError = (message: string, cause?: unknown): CampaignAdminStatsError => ({
  type: 'CampaignAdminStatsDatabaseError',
  message,
  ...(cause !== undefined ? { cause } : {}),
});

export const CAMPAIGN_ADMIN_STATS_ERROR_HTTP_STATUS: Record<
  CampaignAdminStatsError['type'],
  404 | 500
> = {
  CampaignAdminStatsNotFoundError: 404,
  CampaignAdminStatsDatabaseError: 500,
};

export const getHttpStatusForError = (error: CampaignAdminStatsError): 404 | 500 =>
  CAMPAIGN_ADMIN_STATS_ERROR_HTTP_STATUS[error.type];
