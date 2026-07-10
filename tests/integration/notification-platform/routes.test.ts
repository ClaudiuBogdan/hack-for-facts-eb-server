import { afterEach, describe, expect, it } from 'vitest';

import { FUNKY_CAMPAIGN_ADMIN_PERMISSION } from '@/modules/campaign-admin/index.js';
import { NOTIFICATION_PLATFORM_ADMIN_PERMISSION } from '@/modules/notification-platform/index.js';

import {
  authHeaders,
  makeNotificationPlatformIntegrationHarness,
  type NotificationPlatformIntegrationHarness,
} from './harness.js';
import {
  makeChannelDestination,
  makeDelivery,
  makeDeliveryAttempt,
  makeDigestBatch,
  makeLogicalNotification,
  makeNotificationEvent,
} from '../../fixtures/notification-platform/index.js';

describe('notification platform REST routes', () => {
  let harness: NotificationPlatformIntegrationHarness | undefined;

  afterEach(async () => {
    await harness?.app.close();
    harness = undefined;
  });

  it('paginates and filters the inbox, then drives every inbox state transition', async () => {
    harness = await makeNotificationPlatformIntegrationHarness();
    const userId = harness.auth.userIds.user1;
    const otherUserId = harness.auth.userIds.user2;
    const baseTime = harness.clock.now().getTime();
    harness.logicalNotifications.store.put(
      makeLogicalNotification(harness, {
        id: 'inbox-old-unread',
        eventId: 'event-old',
        userId,
        inboxTitle: 'Old unread',
        createdAt: new Date(baseTime - 3_000),
      })
    );
    harness.logicalNotifications.store.put(
      makeLogicalNotification(harness, {
        id: 'inbox-read',
        eventId: 'event-read',
        userId,
        inboxTitle: 'Already read',
        readAt: new Date(baseTime - 500),
        createdAt: new Date(baseTime - 2_000),
      })
    );
    harness.logicalNotifications.store.put(
      makeLogicalNotification(harness, {
        id: 'inbox-new-unread',
        eventId: 'event-new',
        userId,
        inboxTitle: 'New unread',
        createdAt: new Date(baseTime - 1_000),
      })
    );
    harness.logicalNotifications.store.put(
      makeLogicalNotification(harness, {
        id: 'inbox-archived',
        eventId: 'event-archived',
        userId,
        inboxTitle: 'Archived',
        archivedAt: new Date(baseTime - 500),
        createdAt: new Date(baseTime - 500),
      })
    );
    harness.logicalNotifications.store.put(
      makeLogicalNotification(harness, {
        id: 'other-user-item',
        eventId: 'event-other-user',
        userId: otherUserId,
        inboxTitle: 'Private item',
      })
    );

    const firstPage = await harness.app.inject({
      method: 'GET',
      url: '/api/notifications/inbox?view=all&limit=2',
      headers: authHeaders(harness),
    });
    expect(firstPage.statusCode).toBe(200);
    const firstPageBody = firstPage.json<{
      data: { items: { id: string; createdAt: string }[]; nextCursor: string | null };
    }>();
    expect(firstPageBody.data.items.map((item) => item.id)).toEqual([
      'inbox-new-unread',
      'inbox-read',
    ]);
    expect(firstPageBody.data.items[0]?.createdAt).toBe(new Date(baseTime - 1_000).toISOString());
    expect(firstPageBody.data.nextCursor).toBe('inbox-read');

    harness.logicalNotifications.store.put(
      makeLogicalNotification(harness, {
        id: 'inbox-interleaved-newer',
        eventId: 'event-interleaved',
        userId,
        createdAt: new Date(baseTime + 1_000),
      })
    );
    const secondPage = await harness.app.inject({
      method: 'GET',
      url: `/api/notifications/inbox?view=all&limit=2&cursor=${String(
        firstPageBody.data.nextCursor
      )}`,
      headers: authHeaders(harness),
    });
    expect(secondPage.statusCode).toBe(200);
    expect(
      secondPage.json<{ data: { items: { id: string }[]; nextCursor: string | null } }>().data.items
    ).toEqual([expect.objectContaining({ id: 'inbox-old-unread' })]);

    const unread = await harness.app.inject({
      method: 'GET',
      url: '/api/notifications/inbox?view=unread',
      headers: authHeaders(harness),
    });
    expect(
      unread.json<{ data: { items: { id: string }[] } }>().data.items.map((item) => item.id)
    ).toEqual(['inbox-interleaved-newer', 'inbox-new-unread', 'inbox-old-unread']);

    const archived = await harness.app.inject({
      method: 'GET',
      url: '/api/notifications/inbox?view=archived',
      headers: authHeaders(harness),
    });
    expect(archived.json<{ data: { items: { id: string }[] } }>().data.items).toEqual([
      expect.objectContaining({ id: 'inbox-archived' }),
    ]);

    const countBefore = await harness.app.inject({
      method: 'GET',
      url: '/api/notifications/inbox/unread-count',
      headers: authHeaders(harness),
    });
    expect(countBefore.json<{ data: { count: number } }>().data.count).toBe(3);

    for (const suffix of ['read', 'unread', 'archive', 'unarchive'] as const) {
      const response = await harness.app.inject({
        method: 'POST',
        url: `/api/notifications/inbox/inbox-new-unread/${suffix}`,
        headers: authHeaders(harness),
      });
      expect(response.statusCode).toBe(200);
    }

    const ownershipResponse = await harness.app.inject({
      method: 'POST',
      url: '/api/notifications/inbox/other-user-item/read',
      headers: authHeaders(harness),
    });
    expect(ownershipResponse.statusCode).toBe(404);
    expect(harness.logicalNotifications.store.get('other-user-item')?.readAt).toBeNull();

    const markAll = await harness.app.inject({
      method: 'POST',
      url: '/api/notifications/inbox/read-all',
      headers: authHeaders(harness),
    });
    expect(markAll.statusCode).toBe(200);
    expect(markAll.json<{ data: { updated: number } }>().data.updated).toBe(3);

    const countAfter = await harness.app.inject({
      method: 'GET',
      url: '/api/notifications/inbox/unread-count',
      headers: authHeaders(harness),
    });
    expect(countAfter.json<{ data: { count: number } }>().data.count).toBe(0);
  });

  it('creates, lists, pauses, resumes, and removes only the session user subscriptions', async () => {
    harness = await makeNotificationPlatformIntegrationHarness();
    const createResponse = await harness.app.inject({
      method: 'POST',
      url: '/api/notifications/subscriptions',
      headers: authHeaders(harness),
      payload: {
        kindId: harness.kind.kindId,
        subjectType: 'test-subject',
        subjectId: 'subject-1',
        config: {},
      },
    });
    expect(createResponse.statusCode).toBe(201);
    const subscription = createResponse.json<{
      data: { id: string; userId: string; state: string };
    }>().data;
    expect(subscription.userId).toBe(harness.auth.userIds.user1);
    expect(harness.subjectAuthorizer.calls).toEqual([
      expect.objectContaining({ userId: harness.auth.userIds.user1 }),
    ]);

    for (const [action, state] of [
      ['pause', 'paused'],
      ['resume', 'active'],
    ] as const) {
      const response = await harness.app.inject({
        method: 'POST',
        url: `/api/notifications/subscriptions/${subscription.id}/${action}`,
        headers: authHeaders(harness),
      });
      expect(response.statusCode).toBe(200);
      expect(response.json<{ data: { state: string } }>().data.state).toBe(state);
    }

    const removeResponse = await harness.app.inject({
      method: 'DELETE',
      url: `/api/notifications/subscriptions/${subscription.id}`,
      headers: authHeaders(harness),
    });
    expect(removeResponse.statusCode).toBe(200);
    expect(harness.subscriptions.store.get(subscription.id)?.state).toBe('removed');

    const listResponse = await harness.app.inject({
      method: 'GET',
      url: `/api/notifications/subscriptions?kindId=${harness.kind.kindId}&limit=10`,
      headers: authHeaders(harness),
    });
    expect(listResponse.statusCode).toBe(200);
    expect(listResponse.json<{ data: { items: { id: string }[] } }>().data.items).toEqual([
      expect.objectContaining({ id: subscription.id }),
    ]);
  });

  it('rejects denied subjects and kind-invalid subscription config', async () => {
    harness = await makeNotificationPlatformIntegrationHarness({ subjectAllowed: false });
    const denied = await harness.app.inject({
      method: 'POST',
      url: '/api/notifications/subscriptions',
      headers: authHeaders(harness),
      payload: {
        kindId: harness.kind.kindId,
        subjectType: 'test-subject',
        subjectId: 'subject-1',
        config: {},
      },
    });
    expect(denied.statusCode).toBe(403);

    await harness.app.close();
    harness = await makeNotificationPlatformIntegrationHarness();
    const invalidConfig = await harness.app.inject({
      method: 'POST',
      url: '/api/notifications/subscriptions',
      headers: authHeaders(harness),
      payload: {
        kindId: harness.kind.kindId,
        subjectType: 'test-subject',
        subjectId: 'subject-1',
        config: { unsupported: true },
      },
    });
    expect(invalidConfig.statusCode).toBe(400);
    expect(invalidConfig.json<{ error: string }>().error).toBe('ValidationError');
  });

  it('materializes preference defaults, cancels pending optional delivery, and validates cadence', async () => {
    harness = await makeNotificationPlatformIntegrationHarness();
    const userId = harness.auth.userIds.user1;
    const defaults = await harness.app.inject({
      method: 'GET',
      url: '/api/notifications/preferences',
      headers: authHeaders(harness),
    });
    expect(defaults.statusCode).toBe(200);
    expect(defaults.json<{ data: { globalOptionalEnabled: boolean } }>().data).toMatchObject({
      globalOptionalEnabled: true,
    });

    harness.deliveries.store.put(
      makeDelivery(harness, {
        id: 'pending-optional-delivery',
        deliveryKey: 'logical:preference-test:email:1',
        userId,
        kindId: harness.kind.kindId,
        status: 'ready',
      })
    );
    const disableGlobal = await harness.app.inject({
      method: 'PUT',
      url: '/api/notifications/preferences/global',
      headers: authHeaders(harness),
      payload: { enabled: false },
    });
    expect(disableGlobal.statusCode).toBe(200);
    expect(harness.deliveries.store.get('pending-optional-delivery')?.status).toBe('cancelled');

    const setCadence = await harness.app.inject({
      method: 'PUT',
      url: '/api/notifications/preferences/channels/email',
      headers: authHeaders(harness),
      payload: { enabled: true, cadence: 'daily' },
    });
    expect(setCadence.statusCode).toBe(200);
    expect(
      setCadence.json<{ data: { channels: { email: { cadence: string } } } }>().data.channels.email
        .cadence
    ).toBe('daily');

    const invalidCadence = await harness.app.inject({
      method: 'PUT',
      url: '/api/notifications/preferences/channels/email',
      headers: authHeaders(harness),
      payload: { enabled: true, cadence: 'monthly' },
    });
    expect(invalidCadence.statusCode).toBe(400);
  });

  it('drives audited admin requeue, reveal, search, trace, suppression, shadow, and digest cancel flows', async () => {
    harness = await makeNotificationPlatformIntegrationHarness();
    const userId = harness.auth.userIds.user1;
    const event = makeNotificationEvent(harness, { id: 'event-trace' });
    const logical = makeLogicalNotification(harness, {
      id: 'logical-trace',
      eventId: event.id,
      userId,
    });
    const unknownDelivery = makeDelivery(harness, {
      id: 'delivery-unknown',
      deliveryKey: 'logical:logical-trace:email:1',
      logicalNotificationId: logical.id,
      userId,
      status: 'unknown',
      renderedSubject: 'Sensitive subject',
      renderedHtml: '<p>Sensitive body</p>',
      renderedText: 'Sensitive body',
      contentHash: 'sensitive-hash',
      lastErrorMessage: 'Sensitive provider error',
    });
    harness.events.store.put(event);
    harness.logicalNotifications.store.put(logical);
    harness.deliveries.store.put(unknownDelivery);
    harness.attempts.store.put(
      makeDeliveryAttempt(harness, {
        id: 'attempt-trace',
        deliveryId: unknownDelivery.id,
        destinationFingerprint: 'sensitive-fingerprint',
        errorMessage: 'Sensitive attempt error',
      })
    );
    harness.audit.store.put({
      id: 'audit-trace',
      action: 'event.accepted',
      occurredAt: harness.clock.now(),
      actor: 'system',
      eventId: event.id,
      details: { sensitive: 'audit detail' },
    });

    const missingReason = await harness.app.inject({
      method: 'POST',
      url: `/api/admin/notifications/deliveries/${unknownDelivery.id}/requeue`,
      headers: authHeaders(harness),
      payload: { acknowledgeDuplicateRisk: true },
    });
    expect(missingReason.statusCode).toBe(400);

    const missingAcknowledgement = await harness.app.inject({
      method: 'POST',
      url: `/api/admin/notifications/deliveries/${unknownDelivery.id}/requeue`,
      headers: authHeaders(harness),
      payload: { reason: 'Operator reviewed ambiguity', acknowledgeDuplicateRisk: false },
    });
    expect(missingAcknowledgement.statusCode).toBe(403);

    const requeue = await harness.app.inject({
      method: 'POST',
      url: `/api/admin/notifications/deliveries/${unknownDelivery.id}/requeue`,
      headers: authHeaders(harness),
      payload: { reason: 'Operator reviewed ambiguity', acknowledgeDuplicateRisk: true },
    });
    expect(requeue.statusCode).toBe(200);
    expect(harness.deliveries.store.get(unknownDelivery.id)?.status).toBe('ready');
    expect(harness.audit.store.list().map((entry) => entry.action)).toEqual(
      expect.arrayContaining(['admin.ambiguous_acknowledged', 'admin.requeued'])
    );

    const revealWithoutReason = await harness.app.inject({
      method: 'POST',
      url: `/api/admin/notifications/deliveries/${unknownDelivery.id}/reveal`,
      headers: authHeaders(harness),
      payload: {},
    });
    expect(revealWithoutReason.statusCode).toBe(400);
    const reveal = await harness.app.inject({
      method: 'POST',
      url: `/api/admin/notifications/deliveries/${unknownDelivery.id}/reveal`,
      headers: authHeaders(harness),
      payload: { reason: 'Investigating provider ambiguity' },
    });
    expect(reveal.statusCode).toBe(200);
    expect(reveal.json<{ data: { subject: string } }>().data.subject).toBe('Sensitive subject');
    expect(harness.audit.store.list().map((entry) => entry.action)).toContain(
      'admin.content_revealed'
    );

    harness.deliveries.store.put(
      makeDelivery(harness, {
        id: 'dead-filter-match',
        deliveryKey: 'logical:dead-filter-match:email:1',
        userId,
        kindId: harness.kind.kindId,
        status: 'dead_letter',
        destinationFingerprint: 'dead-letter-fingerprint',
        renderedSubject: 'Dead-letter subject',
        renderedHtml: '<p>Dead-letter body</p>',
        renderedText: 'Dead-letter body',
        contentHash: 'dead-letter-content-hash',
        lastErrorMessage: 'Dead-letter driver detail',
      })
    );
    harness.deliveries.store.put(
      makeDelivery(harness, {
        id: 'dead-filter-other',
        deliveryKey: 'logical:dead-filter-other:email:1',
        userId: harness.auth.userIds.user2,
        kindId: 'other.kind',
        status: 'permanent_failed',
      })
    );
    const deadLetters = await harness.app.inject({
      method: 'GET',
      url: `/api/admin/notifications/dead-letters?kindId=${harness.kind.kindId}&status=dead_letter&userId=${userId}`,
      headers: authHeaders(harness),
    });
    expect(deadLetters.statusCode).toBe(200);
    const deadLetterItems = deadLetters.json<{
      data: { items: Record<string, unknown>[] };
    }>().data.items;
    expect(deadLetterItems).toHaveLength(1);
    expect(deadLetterItems[0]?.['id']).toBe('dead-filter-match');
    expect(Object.keys(deadLetterItems[0] ?? {}).sort()).toEqual(
      [
        'id',
        'deliveryKey',
        'logicalNotificationId',
        'digestBatchId',
        'kindId',
        'userId',
        'channel',
        'status',
        'attemptCount',
        'notBefore',
        'expiresAt',
        'nextAttemptAt',
        'lastErrorCode',
        'providerRef',
        'senderMode',
        'createdAt',
        'updatedAt',
        'acceptedAt',
        'terminalAt',
        'retentionExpiresAt',
      ].sort()
    );

    const trace = await harness.app.inject({
      method: 'GET',
      url: `/api/admin/notifications/events/${event.id}/trace`,
      headers: authHeaders(harness),
    });
    expect(trace.statusCode).toBe(200);
    const traceData = trace.json<{
      data: {
        event: Record<string, unknown>;
        logicalNotifications: {
          logicalNotification: Record<string, unknown>;
          deliveries: {
            delivery: Record<string, unknown>;
            attempts: Record<string, unknown>[];
          }[];
        }[];
        auditEntries: Record<string, unknown>[];
      };
    }>().data;
    const tracedLogical = traceData.logicalNotifications[0];
    const tracedDelivery = tracedLogical?.deliveries[0];
    expect(Object.keys(traceData.event).sort()).toEqual(
      [
        'id',
        'source',
        'eventType',
        'schemaVersion',
        'occurrenceKey',
        'payloadHash',
        'status',
        'occurredAt',
        'createdAt',
        'resolvedAt',
        'retentionExpiresAt',
      ].sort()
    );
    expect(Object.keys(tracedLogical?.logicalNotification ?? {}).sort()).toEqual(
      [
        'id',
        'eventId',
        'kindId',
        'kindVersion',
        'userId',
        'eligibilityReason',
        'locale',
        'inboxVisible',
        'readAt',
        'archivedAt',
        'createdAt',
        'retentionExpiresAt',
      ].sort()
    );
    expect(Object.keys(tracedDelivery?.delivery ?? {}).sort()).toEqual(
      Object.keys(deadLetterItems[0] ?? {}).sort()
    );
    expect(Object.keys(tracedDelivery?.attempts[0] ?? {}).sort()).toEqual(
      ['attemptNumber', 'result', 'errorCode', 'latencyMs', 'startedAt', 'completedAt'].sort()
    );
    for (const auditEntry of traceData.auditEntries) {
      expect(auditEntry).not.toHaveProperty('id');
      expect(auditEntry).not.toHaveProperty('occurredAt');
      expect(auditEntry).not.toHaveProperty('details');
    }

    harness.destinations.store.put(
      makeChannelDestination(harness, {
        id: 'suppressed-destination',
        userId,
        suppressedAt: harness.clock.now(),
        suppressionReason: 'hard_bounce',
      })
    );
    const suppressions = await harness.app.inject({
      method: 'GET',
      url: `/api/admin/notifications/suppressions?userId=${userId}`,
      headers: authHeaders(harness),
    });
    expect(suppressions.statusCode).toBe(200);
    expect(suppressions.json<{ data: { items: { fingerprint: string }[] } }>().data.items).toEqual([
      expect.objectContaining({ fingerprint: 'fingerprint-1' }),
    ]);

    const shadowComparison = await harness.app.inject({
      method: 'GET',
      url: `/api/admin/notifications/shadow-comparison/${harness.kind.kindId}`,
      headers: authHeaders(harness),
    });
    expect(shadowComparison.statusCode).toBe(200);
    expect(
      shadowComparison.json<{
        data: { legacyRecipientCount: number; shadowRecipientCount: number };
      }>().data
    ).toMatchObject({ legacyRecipientCount: 0, shadowRecipientCount: 0 });

    harness.digests.store.put(makeDigestBatch(harness, { id: 'digest-cancel' }));
    const cancelDigest = await harness.app.inject({
      method: 'POST',
      url: '/api/admin/notifications/digest-batches/digest-cancel/cancel',
      headers: authHeaders(harness),
      payload: { reason: 'Legal removal request' },
    });
    expect(cancelDigest.statusCode).toBe(200);
    expect(harness.digests.store.get('digest-cancel')?.status).toBe('cancelled');
    expect(harness.audit.store.list().map((entry) => entry.action)).toContain(
      'digest.batch_cancelled'
    );
  });

  it('rejects a non-admin session on every platform admin route', async () => {
    harness = await makeNotificationPlatformIntegrationHarness();
    const requests = [
      { method: 'GET', url: '/api/admin/notifications/events/event-1/trace' },
      { method: 'GET', url: '/api/admin/notifications/dead-letters' },
      {
        method: 'POST',
        url: '/api/admin/notifications/deliveries/delivery-1/requeue',
        payload: { reason: 'test', acknowledgeDuplicateRisk: true },
      },
      {
        method: 'POST',
        url: '/api/admin/notifications/deliveries/delivery-1/reveal',
        payload: { reason: 'test' },
      },
      { method: 'GET', url: '/api/admin/notifications/suppressions' },
      { method: 'GET', url: '/api/admin/notifications/shadow-comparison/test.kind' },
      {
        method: 'POST',
        url: '/api/admin/notifications/digest-batches/batch-1/cancel',
        payload: { reason: 'test' },
      },
    ] as const;

    for (const request of requests) {
      const response = await harness.app.inject({
        ...request,
        headers: authHeaders(harness, 'user2'),
      });
      expect(response.statusCode, `${request.method} ${request.url}`).toBe(403);
    }
    expect(harness.adminPermissionCalls).toHaveLength(requests.length);
    expect(
      harness.adminPermissionCalls.every(
        (call) => call.permissionName === NOTIFICATION_PLATFORM_ADMIN_PERMISSION
      )
    ).toBe(true);
  });

  it('denies a user who holds only the funky campaign permission', async () => {
    harness = await makeNotificationPlatformIntegrationHarness({
      adminPermissions: { user1: [FUNKY_CAMPAIGN_ADMIN_PERMISSION] },
    });
    const response = await harness.app.inject({
      method: 'GET',
      url: '/api/admin/notifications/dead-letters',
      headers: authHeaders(harness),
    });

    expect(response.statusCode).toBe(403);
    expect(harness.adminPermissionCalls).toEqual([
      {
        userId: harness.auth.userIds.user1,
        permissionName: NOTIFICATION_PLATFORM_ADMIN_PERMISSION,
      },
    ]);
  });

  it('returns a generic 500 without leaking database driver text', async () => {
    harness = await makeNotificationPlatformIntegrationHarness();
    harness.deliveries.faults.fail('searchDeadLetters', {
      error: {
        type: 'DatabaseError',
        message: 'postgres driver failed: password authentication rejected',
        retryable: true,
      },
    });

    const response = await harness.app.inject({
      method: 'GET',
      url: '/api/admin/notifications/dead-letters',
      headers: authHeaders(harness),
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      error: 'Internal Server Error',
      message: 'An unexpected error occurred',
      retryable: true,
    });
    expect(response.body).not.toContain('postgres');
    expect(response.body).not.toContain('password authentication');
  });
});
