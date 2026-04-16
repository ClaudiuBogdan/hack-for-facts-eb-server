/**
 * Unit tests for delivery repository (fake implementation)
 *
 * Tests cover:
 * - Creating deliveries with unique constraint enforcement
 * - Atomic claim pattern for sending
 * - Status updates and conditional updates
 * - Finding stuck deliveries
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

import { makeFakeDeliveryRepo, createTestDeliveryRecord } from '../../fixtures/fakes.js';

describe('DeliveryRepository (fake)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-15T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('create', () => {
    it('creates a new delivery record with pending status', async () => {
      const repo = makeFakeDeliveryRepo();

      const result = await repo.create({
        userId: 'user-1',
        notificationType: 'newsletter_entity_monthly',
        referenceId: 'notif-1',
        scopeKey: '2025-01',
        deliveryKey: 'user-1:notif-1:2025-01',
      });

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value.status).toBe('pending');
        expect(result.value.userId).toBe('user-1');
        expect(result.value.notificationType).toBe('newsletter_entity_monthly');
        expect(result.value.referenceId).toBe('notif-1');
        expect(result.value.scopeKey).toBe('2025-01');
        expect(result.value.deliveryKey).toBe('user-1:notif-1:2025-01');
        expect(result.value.attemptCount).toBe(0);
      }
    });

    it('returns error for duplicate delivery key', async () => {
      const existing = createTestDeliveryRecord({
        deliveryKey: 'user-1:notif-1:2025-01',
      });
      const repo = makeFakeDeliveryRepo({ deliveries: [existing] });

      const result = await repo.create({
        userId: 'user-1',
        notificationType: 'newsletter_entity_monthly',
        referenceId: 'notif-1',
        scopeKey: '2025-01',
        deliveryKey: 'user-1:notif-1:2025-01',
      });

      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error.type).toBe('DuplicateDelivery');
      }
    });

    it('stores rendered content when provided', async () => {
      const repo = makeFakeDeliveryRepo();

      const result = await repo.create({
        userId: 'user-1',
        notificationType: 'newsletter_entity_monthly',
        referenceId: 'notif-1',
        scopeKey: '2025-01',
        deliveryKey: 'user-1:notif-1:2025-01',
        renderedSubject: 'Test Subject',
        renderedHtml: '<p>HTML content</p>',
        renderedText: 'Text content',
        templateName: 'newsletter_entity',
        templateVersion: '1.0.0',
      });

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value.renderedSubject).toBe('Test Subject');
        expect(result.value.renderedHtml).toBe('<p>HTML content</p>');
        expect(result.value.renderedText).toBe('Text content');
        expect(result.value.templateName).toBe('newsletter_entity');
        expect(result.value.templateVersion).toBe('1.0.0');
      }
    });
  });

  describe('findById', () => {
    it('returns delivery when found', async () => {
      const existing = createTestDeliveryRecord({ id: 'delivery-123' });
      const repo = makeFakeDeliveryRepo({ deliveries: [existing] });

      const result = await repo.findById('delivery-123');

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value).not.toBeNull();
        expect(result.value?.id).toBe('delivery-123');
      }
    });

    it('returns null when not found', async () => {
      const repo = makeFakeDeliveryRepo();

      const result = await repo.findById('nonexistent');

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value).toBeNull();
      }
    });
  });

  describe('findByDeliveryKey', () => {
    it('returns delivery when found by key', async () => {
      const existing = createTestDeliveryRecord({
        id: 'delivery-456',
        deliveryKey: 'user-1:notif-1:2025-01',
      });
      const repo = makeFakeDeliveryRepo({ deliveries: [existing] });

      const result = await repo.findByDeliveryKey('user-1:notif-1:2025-01');

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value).not.toBeNull();
        expect(result.value?.id).toBe('delivery-456');
      }
    });

    it('returns null when key not found', async () => {
      const repo = makeFakeDeliveryRepo();

      const result = await repo.findByDeliveryKey('nonexistent:key:here');

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value).toBeNull();
      }
    });
  });

  describe('refreshMetadataForRecomposeIfReplayable', () => {
    it('refreshes metadata and clears rendered content for pending rows', async () => {
      const existing = createTestDeliveryRecord({
        id: 'delivery-recompose-pending',
        status: 'pending',
        renderedSubject: 'Old subject',
        renderedHtml: '<p>Old</p>',
        renderedText: 'Old',
        contentHash: 'hash-1',
        templateName: 'public_debate_entity_update',
        templateVersion: '1.0.0',
        metadata: { recipientRole: 'requester' },
      });
      const repo = makeFakeDeliveryRepo({ deliveries: [existing] });

      const result = await repo.refreshMetadataForRecomposeIfReplayable(existing.id, {
        recipientRole: 'subscriber',
      });

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value).not.toBeNull();
        expect(result.value?.status).toBe('pending');
        expect(result.value?.metadata).toEqual({ recipientRole: 'subscriber' });
        expect(result.value?.renderedSubject).toBeNull();
        expect(result.value?.renderedHtml).toBeNull();
        expect(result.value?.renderedText).toBeNull();
        expect(result.value?.contentHash).toBeNull();
        expect(result.value?.templateName).toBeNull();
        expect(result.value?.templateVersion).toBeNull();
      }
    });

    it('refreshes failed_transient rows and resets them back to pending', async () => {
      const existing = createTestDeliveryRecord({
        id: 'delivery-recompose-failed',
        status: 'failed_transient',
        toEmail: 'stale@example.com',
        renderedSubject: 'Old subject',
        renderedHtml: '<p>Old</p>',
        renderedText: 'Old',
        resendEmailId: 'resend-old',
        attemptCount: 3,
        lastAttemptAt: new Date('2025-01-15T11:30:00.000Z'),
        sentAt: new Date('2025-01-15T11:31:00.000Z'),
      });
      const repo = makeFakeDeliveryRepo({ deliveries: [existing] });

      const result = await repo.refreshMetadataForRecomposeIfReplayable(existing.id, {
        recipientRole: 'subscriber',
      });

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value?.status).toBe('pending');
        expect(result.value?.toEmail).toBeNull();
        expect(result.value?.renderedSubject).toBeNull();
        expect(result.value?.resendEmailId).toBeNull();
        expect(result.value?.attemptCount).toBe(0);
        expect(result.value?.lastAttemptAt).toBeNull();
        expect(result.value?.sentAt).toBeNull();
      }
    });

    it('refreshes composing rows and clears stale render state', async () => {
      const existing = createTestDeliveryRecord({
        id: 'delivery-recompose-composing',
        status: 'composing',
        toEmail: 'stale@example.com',
        renderedSubject: 'Old subject',
        renderedHtml: '<p>Old</p>',
        renderedText: 'Old',
        lastError: 'temporary failure',
      });
      const repo = makeFakeDeliveryRepo({ deliveries: [existing] });

      const result = await repo.refreshMetadataForRecomposeIfReplayable(existing.id, {
        recipientRole: 'subscriber',
      });

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value?.status).toBe('pending');
        expect(result.value?.toEmail).toBeNull();
        expect(result.value?.renderedSubject).toBeNull();
        expect(result.value?.renderedHtml).toBeNull();
        expect(result.value?.renderedText).toBeNull();
        expect(result.value?.lastError).toBeNull();
      }
    });

    it('returns null for terminal rows', async () => {
      const existing = createTestDeliveryRecord({
        id: 'delivery-recompose-delivered',
        status: 'delivered',
        renderedSubject: 'Sent subject',
        renderedHtml: '<p>Sent</p>',
        renderedText: 'Sent',
      });
      const repo = makeFakeDeliveryRepo({ deliveries: [existing] });

      const result = await repo.refreshMetadataForRecomposeIfReplayable(existing.id, {
        recipientRole: 'subscriber',
      });

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value).toBeNull();
      }
    });

    it('drops stale rendered updates when the compose claim changes', async () => {
      const existing = createTestDeliveryRecord({
        id: 'delivery-compose-claim',
        status: 'composing',
        metadata: {
          __composeClaimId: 'claim-1',
        },
      });
      const repo = makeFakeDeliveryRepo({ deliveries: [existing] });

      const result = await repo.updateRenderedContent(existing.id, {
        renderedSubject: 'New subject',
        renderedHtml: '<p>New</p>',
        renderedText: 'New',
        contentHash: 'hash-1',
        templateName: 'welcome',
        templateVersion: '1.0.0',
        expectedComposeClaimId: 'claim-2',
      });

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value).toBe(false);
      }
    });

    it('requires the expected compose claim when updating status conditionally', async () => {
      const existing = createTestDeliveryRecord({
        id: 'delivery-compose-status-claim',
        status: 'composing',
        metadata: {
          __composeClaimId: 'claim-1',
        },
      });
      const repo = makeFakeDeliveryRepo({ deliveries: [existing] });

      const mismatchResult = await repo.updateStatusIfCurrentIn(
        existing.id,
        ['composing'],
        'pending',
        {
          expectedComposeClaimId: 'claim-2',
        }
      );

      expect(mismatchResult.isOk()).toBe(true);
      if (mismatchResult.isOk()) {
        expect(mismatchResult.value).toBe(false);
      }

      const matchResult = await repo.updateStatusIfCurrentIn(
        existing.id,
        ['composing'],
        'pending',
        {
          expectedComposeClaimId: 'claim-1',
        }
      );

      expect(matchResult.isOk()).toBe(true);
      if (matchResult.isOk()) {
        expect(matchResult.value).toBe(true);
      }
    });
  });

  describe('claimForSending (atomic claim)', () => {
    it('claims pending delivery and transitions to sending', async () => {
      const pending = createTestDeliveryRecord({
        id: 'delivery-pending',
        status: 'pending',
        attemptCount: 0,
        renderedSubject: 'Subject',
        renderedHtml: '<p>Hello</p>',
        renderedText: 'Hello',
      });
      const repo = makeFakeDeliveryRepo({ deliveries: [pending] });

      const result = await repo.claimForSending('delivery-pending');

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value).not.toBeNull();
        expect(result.value?.status).toBe('sending');
        expect(result.value?.attemptCount).toBe(1);
        expect(result.value?.lastAttemptAt).not.toBeNull();
      }
    });

    it('claims failed_transient delivery and increments attempt count', async () => {
      const failedTransient = createTestDeliveryRecord({
        id: 'delivery-failed',
        status: 'failed_transient',
        attemptCount: 2,
        renderedSubject: 'Subject',
        renderedHtml: '<p>Hello</p>',
        renderedText: 'Hello',
      });
      const repo = makeFakeDeliveryRepo({ deliveries: [failedTransient] });

      const result = await repo.claimForSending('delivery-failed');

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value).not.toBeNull();
        expect(result.value?.status).toBe('sending');
        expect(result.value?.attemptCount).toBe(3);
      }
    });

    it('returns null for delivery already in sending status', async () => {
      const sending = createTestDeliveryRecord({
        id: 'delivery-sending',
        status: 'sending',
      });
      const repo = makeFakeDeliveryRepo({ deliveries: [sending] });

      const result = await repo.claimForSending('delivery-sending');

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value).toBeNull();
      }
    });

    it('returns null for delivery in terminal status', async () => {
      const delivered = createTestDeliveryRecord({
        id: 'delivery-delivered',
        status: 'delivered',
      });
      const repo = makeFakeDeliveryRepo({ deliveries: [delivered] });

      const result = await repo.claimForSending('delivery-delivered');

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value).toBeNull();
      }
    });

    it('returns null for nonexistent delivery', async () => {
      const repo = makeFakeDeliveryRepo();

      const result = await repo.claimForSending('nonexistent');

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value).toBeNull();
      }
    });
  });

  describe('updateStatus', () => {
    it('updates status to sent with email ID', async () => {
      const sending = createTestDeliveryRecord({
        id: 'delivery-sending',
        status: 'sending',
      });
      const repo = makeFakeDeliveryRepo({ deliveries: [sending] });

      const result = await repo.updateStatus('delivery-sending', {
        status: 'sent',
        resendEmailId: 'resend-abc123',
        toEmail: 'user@example.com',
        sentAt: new Date(),
      });

      expect(result.isOk()).toBe(true);

      // Verify the update
      const findResult = await repo.findById('delivery-sending');
      if (findResult.isOk() && findResult.value !== null) {
        expect(findResult.value.status).toBe('sent');
        expect(findResult.value.resendEmailId).toBe('resend-abc123');
        expect(findResult.value.toEmail).toBe('user@example.com');
      }
    });

    it('updates status to failed_transient with error', async () => {
      const sending = createTestDeliveryRecord({
        id: 'delivery-sending',
        status: 'sending',
      });
      const repo = makeFakeDeliveryRepo({ deliveries: [sending] });

      const result = await repo.updateStatus('delivery-sending', {
        status: 'failed_transient',
        lastError: 'Rate limit exceeded',
      });

      expect(result.isOk()).toBe(true);

      const findResult = await repo.findById('delivery-sending');
      if (findResult.isOk() && findResult.value !== null) {
        expect(findResult.value.status).toBe('failed_transient');
        expect(findResult.value.lastError).toBe('Rate limit exceeded');
      }
    });

    it('silently succeeds for nonexistent delivery', async () => {
      const repo = makeFakeDeliveryRepo();

      const result = await repo.updateStatus('nonexistent', {
        status: 'sent',
      });

      expect(result.isOk()).toBe(true);
    });
  });

  describe('updateStatusIfStillSending', () => {
    it('updates status when delivery is still sending', async () => {
      const sending = createTestDeliveryRecord({
        id: 'delivery-sending',
        status: 'sending',
      });
      const repo = makeFakeDeliveryRepo({ deliveries: [sending] });

      const result = await repo.updateStatusIfStillSending('delivery-sending', 'sent', {
        resendEmailId: 'resend-123',
      });

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value).toBe(true);
      }

      const findResult = await repo.findById('delivery-sending');
      if (findResult.isOk() && findResult.value !== null) {
        expect(findResult.value.status).toBe('sent');
      }
    });

    it('returns false when delivery is no longer sending', async () => {
      const sent = createTestDeliveryRecord({
        id: 'delivery-sent',
        status: 'sent',
      });
      const repo = makeFakeDeliveryRepo({ deliveries: [sent] });

      const result = await repo.updateStatusIfStillSending('delivery-sent', 'delivered');

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value).toBe(false);
      }

      // Status should remain unchanged
      const findResult = await repo.findById('delivery-sent');
      if (findResult.isOk() && findResult.value !== null) {
        expect(findResult.value.status).toBe('sent');
      }
    });

    it('returns false for nonexistent delivery', async () => {
      const repo = makeFakeDeliveryRepo();

      const result = await repo.updateStatusIfStillSending('nonexistent', 'sent');

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value).toBe(false);
      }
    });
  });

  describe('claimForCompose', () => {
    it('claims pending outbox rows that still need rendered content', async () => {
      const pending = createTestDeliveryRecord({
        id: 'delivery-compose',
        status: 'pending',
        renderedSubject: null,
        renderedHtml: null,
        renderedText: null,
      });
      const repo = makeFakeDeliveryRepo({ deliveries: [pending] });

      const result = await repo.claimForCompose('delivery-compose');

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value?.status).toBe('composing');
        expect(result.value?.lastAttemptAt).not.toBeNull();
        expect(result.value?.attemptCount).toBe(0);
      }
    });

    it('does not claim already composed pending rows', async () => {
      const pending = createTestDeliveryRecord({
        id: 'delivery-compose-ready',
        status: 'pending',
        renderedSubject: 'Subject',
        renderedHtml: '<p>Hello</p>',
        renderedText: 'Hello',
      });
      const repo = makeFakeDeliveryRepo({ deliveries: [pending] });

      const result = await repo.claimForCompose('delivery-compose-ready');

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value).toBeNull();
      }
    });
  });

  describe('findStuckSending', () => {
    it('finds deliveries stuck in sending status', async () => {
      const stuckDelivery = createTestDeliveryRecord({
        id: 'delivery-stuck',
        status: 'sending',
        lastAttemptAt: new Date('2025-01-15T11:30:00Z'), // 30 minutes ago
      });
      const repo = makeFakeDeliveryRepo({ deliveries: [stuckDelivery] });

      const result = await repo.findStuckSending(15);

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value.length).toBe(1);
        expect(result.value[0]?.id).toBe('delivery-stuck');
      }
    });

    it('excludes recent sending deliveries', async () => {
      const recentSending = createTestDeliveryRecord({
        id: 'delivery-recent',
        status: 'sending',
        lastAttemptAt: new Date('2025-01-15T11:50:00Z'), // 10 minutes ago
      });
      const repo = makeFakeDeliveryRepo({ deliveries: [recentSending] });

      const result = await repo.findStuckSending(15);

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value.length).toBe(0);
      }
    });

    it('excludes deliveries in non-sending status', async () => {
      const pending = createTestDeliveryRecord({
        id: 'delivery-pending',
        status: 'pending',
        lastAttemptAt: new Date('2025-01-15T10:00:00Z'),
      });
      const repo = makeFakeDeliveryRepo({ deliveries: [pending] });

      const result = await repo.findStuckSending(15);

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value.length).toBe(0);
      }
    });

    it('includes sending deliveries whose lastAttemptAt is null', async () => {
      const pending = createTestDeliveryRecord({
        id: 'delivery-null-attempt',
        status: 'sending',
        lastAttemptAt: null,
      });
      const repo = makeFakeDeliveryRepo({ deliveries: [pending] });

      const result = await repo.findStuckSending(15);

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value.length).toBe(1);
        expect(result.value[0]?.id).toBe('delivery-null-attempt');
      }
    });
  });

  describe('existsByDeliveryKey', () => {
    it('returns true when delivery exists', async () => {
      const existing = createTestDeliveryRecord({
        deliveryKey: 'user-1:notif-1:2025-01',
      });
      const repo = makeFakeDeliveryRepo({ deliveries: [existing] });

      const result = await repo.existsByDeliveryKey('user-1:notif-1:2025-01');

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value).toBe(true);
      }
    });

    it('returns false when delivery does not exist', async () => {
      const repo = makeFakeDeliveryRepo();

      const result = await repo.existsByDeliveryKey('nonexistent:key:here');

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value).toBe(false);
      }
    });
  });

  describe('database error simulation', () => {
    it('returns database error when simulateDbError is true', async () => {
      const repo = makeFakeDeliveryRepo({ simulateDbError: true });

      const createResult = await repo.create({
        userId: 'user-1',
        notificationType: 'newsletter_entity_monthly',
        referenceId: 'notif-1',
        scopeKey: '2025-01',
        deliveryKey: 'user-1:notif-1:2025-01',
      });

      expect(createResult.isErr()).toBe(true);
      if (createResult.isErr()) {
        expect(createResult.error.type).toBe('DatabaseError');
      }
    });
  });
});
