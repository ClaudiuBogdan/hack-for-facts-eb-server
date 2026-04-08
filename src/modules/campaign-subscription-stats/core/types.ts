export interface CampaignSubscriptionStatsPerUat {
  sirutaCode: string;
  uatName: string;
  count: number;
}

export interface CampaignSubscriptionStats {
  total: number;
  perUat: CampaignSubscriptionStatsPerUat[];
}
