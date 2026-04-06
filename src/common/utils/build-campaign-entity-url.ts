const trimTrailingSlashes = (baseUrl: string): string => {
  return baseUrl.replace(/\/+$/u, '');
};

export const buildCampaignEntityUrl = (platformBaseUrl: string, entityCui: string): string => {
  return `${trimTrailingSlashes(platformBaseUrl)}/primarie/${entityCui}`;
};

export const buildCampaignLocalitiesUrl = (platformBaseUrl: string): string => {
  return `${trimTrailingSlashes(platformBaseUrl)}/primarie`;
};
