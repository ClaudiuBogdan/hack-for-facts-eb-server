import { generateDeliveryKey } from '@/modules/notifications/core/types.js';

export interface PublicDebateAdminResponseKeyInput {
  threadId: string;
  responseEventId: string;
}

export const buildPublicDebateAdminResponseScopeKey = (
  input: PublicDebateAdminResponseKeyInput
): string => {
  return `funky:delivery:admin_response_${input.threadId}_${input.responseEventId}`;
};

export const buildPublicDebateAdminResponseDeliveryKey = (input: {
  userId: string;
  notificationId: string;
  scopeKey: string;
}): string => {
  return generateDeliveryKey(input.userId, input.notificationId, input.scopeKey);
};
