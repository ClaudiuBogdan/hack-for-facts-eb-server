import type { AuditEntry } from '../audit/types.js';
import type { Delivery, DeliveryAttempt, DeliveryState } from '../delivery/types.js';
import type { NotificationEvent } from '../events/types.js';
import type { LogicalNotification } from '../inbox/types.js';
import type { ExternalChannel } from '../shared/types.js';

export interface EventTraceDelivery {
  delivery: Delivery;
  attempts: DeliveryAttempt[];
}

export interface EventTraceLogicalNotification {
  logicalNotification: LogicalNotification;
  deliveries: EventTraceDelivery[];
}

export interface EventTrace {
  event: NotificationEvent;
  logicalNotifications: EventTraceLogicalNotification[];
  auditEntries: AuditEntry[];
}

export interface DeadLetterSearchFilter {
  kindId?: string;
  channel?: ExternalChannel;
  status?: DeliveryState;
  eventId?: string;
  userId?: string;
}

export interface ShadowComparisonSummary {
  kindId: string;
  periodKey: string | null;
  legacyRecipientCount: number;
  shadowRecipientCount: number;
  matchingRecipientCount: number;
  legacyOnlyRecipientCount: number;
  shadowOnlyRecipientCount: number;
  matchingContentCount: number;
  contentMismatchCount: number;
}

export interface SuppressionView {
  userId: string;
  channel: ExternalChannel;
  fingerprint: string;
  generation: number;
  suppressedAt: Date | null;
  suppressionReason: string | null;
}

export interface RevealedDeliveryContent {
  deliveryId: string;
  templateId: string | null;
  templateVersion: string | null;
  subject: string | null;
  html: string | null;
  text: string | null;
  contentHash: string | null;
}
