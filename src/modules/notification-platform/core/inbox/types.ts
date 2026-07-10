import type { Locale } from '../shared/types.js';

export interface LogicalNotification {
  id: string;
  eventId: string;
  kindId: string;
  kindVersion: number;
  userId: string;
  eligibilityReason: string;
  locale: Locale;
  recipientFacts: Record<string, unknown> | null;
  inboxTemplateId: string;
  inboxTemplateVersion: string;
  inboxTitle: string;
  inboxBody: string;
  inboxActionUrl: string | null;
  inboxVisible: boolean;
  readAt: Date | null;
  archivedAt: Date | null;
  streamKey: string | null;
  streamSequence: number | null;
  createdAt: Date;
  retentionExpiresAt: Date;
}

export interface CreateLogicalNotificationInput {
  id: string;
  eventId: string;
  kindId: string;
  kindVersion: number;
  userId: string;
  eligibilityReason: string;
  locale: Locale;
  recipientFacts: Record<string, unknown> | null;
  inboxTemplateId: string;
  inboxTemplateVersion: string;
  inboxTitle: string;
  inboxBody: string;
  inboxActionUrl: string | null;
  inboxVisible: boolean;
  streamKey: string | null;
  streamSequence: number | null;
  createdAt: Date;
  retentionExpiresAt: Date;
}

export type InboxView = 'all' | 'unread' | 'archived';
