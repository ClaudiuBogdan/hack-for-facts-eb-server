import type { CampaignAdminNotificationError } from '../errors.js';
import type { CampaignNotificationAuditRepository } from '../ports.js';
import type {
  ListCampaignNotificationAuditInput,
  ListCampaignNotificationAuditOutput,
} from '../types.js';
import type { Result } from 'neverthrow';

export const listCampaignNotificationAudit = (
  deps: {
    auditRepository: CampaignNotificationAuditRepository;
  },
  input: ListCampaignNotificationAuditInput
): Promise<Result<ListCampaignNotificationAuditOutput, CampaignAdminNotificationError>> => {
  return deps.auditRepository.listCampaignNotificationAudit(input);
};
