export const AUDIT_ACTIONS = [
  'event.accepted',
  'event.duplicate',
  'event.conflict',
  'recipient.included',
  'recipient.skipped',
  'logical.created',
  'delivery.created',
  'delivery.terminal',
  'destination.suppressed',
  'destination.restored',
  'digest.batch_cancelled',
  'admin.content_revealed',
  'admin.destination_revealed',
  'admin.requeued',
  'admin.ambiguous_acknowledged',
  'user.anonymized',
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export interface AuditEntryInput {
  action: AuditAction;
  occurredAt: Date;
  actor: string;
  userId?: string;
  eventId?: string;
  logicalNotificationId?: string;
  deliveryId?: string;
  batchId?: string;
  subscriptionId?: string;
  reason?: string;
  details?: Record<string, unknown>;
}

export interface AuditEntry extends AuditEntryInput {
  id: string;
}
