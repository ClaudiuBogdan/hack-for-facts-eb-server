export type EventStatus = 'pending' | 'resolving' | 'resolved' | 'conflicted' | 'failed';

export interface NotificationEvent {
  id: string;
  source: string;
  eventType: string;
  eventSchemaVersion: number;
  occurrenceKey: string;
  occurredAt: Date;
  facts: Record<string, unknown>;
  payloadHash: string;
  correlationId: string | null;
  causationId: string | null;
  streamKey: string | null;
  streamSequence: number | null;
  status: EventStatus;
  resolutionCursor: string | null;
  claimToken: string | null;
  claimExpiresAt: Date | null;
  createdAt: Date;
  resolvedAt: Date | null;
  retentionExpiresAt: Date;
}

export interface CreateNotificationEventInput {
  source: string;
  eventType: string;
  eventSchemaVersion: number;
  occurrenceKey: string;
  occurredAt: Date;
  facts: Record<string, unknown>;
  correlationId?: string;
  causationId?: string;
}

export type RecordEventOutcome =
  | { outcome: 'created'; event: NotificationEvent }
  | { outcome: 'duplicate'; event: NotificationEvent };

export interface SourceOccurrence {
  eventType: string;
  occurrenceKey: string;
  occurredAt: Date;
  facts: Record<string, unknown>;
  correlationId?: string;
}
