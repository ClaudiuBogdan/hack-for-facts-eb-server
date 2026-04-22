export const buildPublicDebateAnnouncementScopeKey = (input: {
  entityCui: string;
  announcementFingerprint: string;
}): string => {
  return `funky:delivery:public_debate_announcement:${input.entityCui}:${input.announcementFingerprint}`;
};

export const buildPublicDebateAnnouncementDeliveryKey = (input: {
  userId: string;
  entityCui: string;
  announcementFingerprint: string;
}): string => {
  return `${input.userId}:${input.entityCui}:${input.announcementFingerprint}`;
};
