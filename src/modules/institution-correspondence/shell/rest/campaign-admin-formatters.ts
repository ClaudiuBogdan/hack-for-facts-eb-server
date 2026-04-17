import { projectCampaignAdminThread } from '../../core/admin-workflow.js';

import type { AdminResponseEvent, CorrespondenceEntry, ThreadRecord } from '../../core/types.js';
import type { PublicDebateEntityAudienceSummary } from '@/modules/notification-delivery/index.js';

const resolveCampaignKey = (thread: ThreadRecord): string =>
  thread.campaignKey ?? thread.record.campaignKey ?? thread.record.campaign;

const formatCampaignAdminResponseEvent = (responseEvent: AdminResponseEvent) => ({
  id: responseEvent.id,
  responseDate: responseEvent.responseDate,
  messageContent: responseEvent.messageContent,
  responseStatus: responseEvent.responseStatus,
  actorUserId: responseEvent.actorUserId,
  createdAt: responseEvent.createdAt,
  source: responseEvent.source,
});

export const formatCampaignAdminCorrespondenceEntry = (entry: CorrespondenceEntry) => ({
  id: entry.id,
  direction: entry.direction,
  source: entry.source,
  fromAddress: entry.fromAddress,
  subject: entry.subject,
  textBody: entry.textBody,
  attachments: entry.attachments,
  occurredAt: entry.occurredAt,
});

export const formatCampaignAdminThreadListItem = (input: {
  thread: ThreadRecord;
  entityName: string | null;
  notificationAudience: PublicDebateEntityAudienceSummary;
}) => {
  const projectedThread = projectCampaignAdminThread(input.thread);

  return {
    id: input.thread.id,
    entityCui: input.thread.entityCui,
    entityName: input.entityName,
    campaignKey: resolveCampaignKey(input.thread),
    submissionPath: input.thread.record.submissionPath,
    ownerUserId: input.thread.record.ownerUserId,
    institutionEmail: input.thread.record.institutionEmail,
    subject: input.thread.record.subject,
    threadState: projectedThread.threadState,
    currentResponseStatus: projectedThread.currentResponseStatus,
    createdAt: input.thread.createdAt.toISOString(),
    updatedAt: input.thread.updatedAt.toISOString(),
    latestResponseAt: projectedThread.latestResponseAt,
    responseEventCount: projectedThread.responseEventCount,
    notificationAudience: input.notificationAudience,
  };
};

export const formatCampaignAdminThreadDetail = (input: {
  thread: ThreadRecord;
  entityName: string | null;
  notificationAudience: PublicDebateEntityAudienceSummary;
}) => {
  const projectedThread = projectCampaignAdminThread(input.thread);

  return {
    ...formatCampaignAdminThreadListItem(input),
    requesterOrganizationName: input.thread.record.requesterOrganizationName,
    budgetPublicationDate: input.thread.record.budgetPublicationDate,
    consentCapturedAt: input.thread.record.consentCapturedAt,
    contestationDeadlineAt: input.thread.record.contestationDeadlineAt,
    responseEvents: projectedThread.responseEvents.map(formatCampaignAdminResponseEvent),
    correspondence: input.thread.record.correspondence.map(formatCampaignAdminCorrespondenceEntry),
  };
};
