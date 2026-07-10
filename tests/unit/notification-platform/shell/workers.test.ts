import { ok } from 'neverthrow';
import { describe, expect, it } from 'vitest';

import { processDigestJob } from '@/modules/notification-platform/shell/queue/workers/digest-worker.js';
import { processFanOutJob } from '@/modules/notification-platform/shell/queue/workers/fanout-worker.js';
import { processIngestionScanJob } from '@/modules/notification-platform/shell/queue/workers/ingestion-scan-worker.js';
import { processRecoveryJob } from '@/modules/notification-platform/shell/queue/workers/recovery-worker.js';
import { processRenderJob } from '@/modules/notification-platform/shell/queue/workers/render-worker.js';
import { processRetentionJob } from '@/modules/notification-platform/shell/queue/workers/retention-worker.js';
import {
  makeSendWorkerOptions,
  processSendJob,
} from '@/modules/notification-platform/shell/queue/workers/send-worker.js';

import {
  makeFakeAnonymizationCheckPort,
  makeFakeAuditLedgerPort,
  makeFakeChannelAdapterPort,
  makeFakeChannelDestinationRepo,
  makeFakeDeliveryAttemptRepo,
  makeFakeDeliveryRepo,
  makeFakeDigestBatchRepo,
  makeFakeEventFanOutScheduler,
  makeFakeEventSourcePort,
  makeFakeKindRegistry,
  makeFakeLoggerPort,
  makeFakeLogicalNotificationRepo,
  makeFakeNotificationEventRepo,
  makeFakePreferenceRepo,
  makeFakeRenderJobScheduler,
  makeFakeSendJobScheduler,
  makeFakeSourceWatermarkRepo,
  makeFakeSubscriptionRepo,
  makeTestKind,
} from '../../../fixtures/notification-platform/index.js';
import {
  makeInMemoryJobRuntime,
  makeSequentialIds,
  makeTestClock,
} from '../../../support/index.js';

import type { RetentionRunner } from '@/modules/notification-platform/shell/retention/apply-retention.js';

const makeHarness = () => {
  const clock = makeTestClock(new Date('2026-07-10T09:00:00.000Z'));
  const ids = makeSequentialIds('worker');
  const jobs = makeInMemoryJobRuntime({ clock, ids: makeSequentialIds('job') });
  const logger = makeFakeLoggerPort();
  const events = makeFakeNotificationEventRepo({ clock });
  const logicalNotifications = makeFakeLogicalNotificationRepo();
  const deliveries = makeFakeDeliveryRepo({ clock });
  const digests = makeFakeDigestBatchRepo({
    clock,
    logicalNotifications: logicalNotifications.store,
    deliveries: deliveries.store,
  });
  const adapter = makeFakeChannelAdapterPort();
  const retention: RetentionRunner = {
    applyRetention: async () =>
      ok({
        deliveryAttemptsDeleted: 0,
        providerWebhooksDeleted: 0,
        digestMembersDeleted: 0,
        deliveriesDeleted: 0,
        digestBatchesDeleted: 0,
        logicalNotificationsDeleted: 0,
        eventsRedacted: 0,
        eventsDeleted: 0,
      }),
  };

  return {
    clock,
    ids,
    jobs,
    logger,
    events,
    logicalNotifications,
    deliveries,
    digests,
    adapter,
    registry: makeFakeKindRegistry([makeTestKind()]),
    audit: makeFakeAuditLedgerPort({ ids }),
    destinations: makeFakeChannelDestinationRepo({ ids }),
    attempts: makeFakeDeliveryAttemptRepo(),
    preferences: makeFakePreferenceRepo(),
    anonymization: makeFakeAnonymizationCheckPort(),
    subscriptions: makeFakeSubscriptionRepo(),
    watermarks: makeFakeSourceWatermarkRepo(),
    eventSources: new Map(),
    fanOutScheduler: makeFakeEventFanOutScheduler(jobs),
    renderScheduler: makeFakeRenderJobScheduler(jobs),
    sendScheduler: makeFakeSendJobScheduler(jobs),
    digestScheduler: { enqueue: async () => ok(undefined) },
    retention,
    channelAdapters: new Map([['email' as const, adapter]]),
  };
};

describe('notification platform worker processors', () => {
  const invalidPayloadCases = [
    ['ingestion scan', (h: ReturnType<typeof makeHarness>) => processIngestionScanJob(h, {})],
    ['fan-out', (h: ReturnType<typeof makeHarness>) => processFanOutJob(h, {})],
    ['render', (h: ReturnType<typeof makeHarness>) => processRenderJob(h, {})],
    ['send', (h: ReturnType<typeof makeHarness>) => processSendJob(h, {})],
    ['digest', (h: ReturnType<typeof makeHarness>) => processDigestJob(h, {})],
    ['recovery', (h: ReturnType<typeof makeHarness>) => processRecoveryJob(h, {})],
    ['retention', (h: ReturnType<typeof makeHarness>) => processRetentionJob(h, {})],
  ] as const;

  it.each(invalidPayloadCases)('%s rejects invalid payloads', async (_label, run) => {
    await expect(run(makeHarness())).rejects.toThrow(/Invalid/u);
  });

  it('configures the send worker limiter from maxSendRps', () => {
    expect(
      makeSendWorkerOptions({
        redis: {} as never,
        bullmqPrefix: 'test',
        concurrency: 3,
        maxSendRps: 7,
      }).limiter
    ).toEqual({ max: 7, duration: 1000 });
  });

  it('ingestion scan resolves the source and calls the scan usecase', async () => {
    const h = makeHarness();
    let sourceRead = false;
    const source = makeFakeEventSourcePort({
      sourceId: 'source-1',
      onRead: () => {
        sourceRead = true;
      },
    });

    const result = await processIngestionScanJob(
      {
        eventSources: new Map([[source.sourceId, source]]),
        watermarks: makeFakeSourceWatermarkRepo(),
        events: h.events,
        registry: h.registry,
        audit: h.audit,
        fanOutScheduler: h.fanOutScheduler,
        clock: h.clock,
        ids: h.ids,
        logger: h.logger,
      },
      { sourceId: source.sourceId }
    );

    expect(sourceRead).toBe(true);
    expect(result).toEqual({ recorded: 0, duplicates: 0, watermarkAdvanced: false });
  });

  it('ingestion scan logs and completes an unknown source job', async () => {
    const h = makeHarness();

    await expect(
      processIngestionScanJob(
        {
          eventSources: new Map(),
          watermarks: makeFakeSourceWatermarkRepo(),
          events: h.events,
          registry: h.registry,
          audit: h.audit,
          fanOutScheduler: h.fanOutScheduler,
          clock: h.clock,
          ids: h.ids,
          logger: h.logger,
        },
        { sourceId: 'missing' }
      )
    ).resolves.toEqual({ unknownSource: true });
    expect(h.logger.entries).toContainEqual({
      level: 'error',
      msg: 'Unknown notification event source',
      data: { sourceId: 'missing' },
    });
  });

  it('fan-out calls recipient resolution and cleanly no-ops an unclaimable event', async () => {
    const h = makeHarness();

    const result = await processFanOutJob(
      {
        events: h.events,
        registry: h.registry,
        subscriptions: h.subscriptions,
        preferences: h.preferences,
        anonymization: h.anonymization,
        logicalNotifications: h.logicalNotifications,
        deliveries: h.deliveries,
        digests: h.digests,
        destinations: h.destinations,
        channelAdapters: h.channelAdapters,
        renderScheduler: h.renderScheduler,
        audit: h.audit,
        clock: h.clock,
        ids: h.ids,
        logger: h.logger,
      },
      { eventId: 'missing-event' }
    );

    expect(result).toEqual({ created: 0, skipped: 0, resumed: false });
  });

  it('render calls renderDelivery and cleanly no-ops an unclaimable delivery', async () => {
    const h = makeHarness();

    const result = await processRenderJob(
      {
        deliveries: h.deliveries,
        logicalNotifications: h.logicalNotifications,
        digests: h.digests,
        registry: h.registry,
        events: h.events,
        channelAdapters: h.channelAdapters,
        sendScheduler: h.sendScheduler,
        clock: h.clock,
        ids: h.ids,
        logger: h.logger,
      },
      { deliveryId: 'missing-delivery' }
    );

    expect(result).toEqual({ rendered: false });
  });

  it('send calls dispatchDelivery and returns the claimed-noop outcome', async () => {
    const h = makeHarness();

    const result = await processSendJob(
      {
        deliveries: h.deliveries,
        attempts: h.attempts,
        destinations: h.destinations,
        preferences: h.preferences,
        anonymization: h.anonymization,
        registry: h.registry,
        channelAdapters: h.channelAdapters,
        sendScheduler: h.sendScheduler,
        audit: h.audit,
        clock: h.clock,
        ids: h.ids,
        logger: h.logger,
      },
      { deliveryId: 'missing-delivery' }
    );

    expect(result).toEqual({ outcome: 'noop' });
  });

  it('digest calls the materialization usecase once for the requested limit', async () => {
    const h = makeHarness();

    const result = await processDigestJob(
      {
        digests: h.digests,
        deliveries: h.deliveries,
        destinations: h.destinations,
        channelAdapters: h.channelAdapters,
        renderScheduler: h.renderScheduler,
        audit: h.audit,
        clock: h.clock,
        ids: h.ids,
        logger: h.logger,
      },
      { limit: 7 }
    );

    expect(result).toEqual({ materialized: 0 });
  });

  it('recovery runs work recovery and delivery expiry', async () => {
    const h = makeHarness();
    const digestSweepLimits: number[] = [];

    const result = await processRecoveryJob(
      {
        events: h.events,
        deliveries: h.deliveries,
        attempts: h.attempts,
        digests: h.digests,
        channelAdapters: h.channelAdapters,
        fanOutScheduler: h.fanOutScheduler,
        renderScheduler: h.renderScheduler,
        sendScheduler: h.sendScheduler,
        digestScheduler: {
          enqueue: async (payload) => {
            digestSweepLimits.push(payload.limit);
            return ok(undefined);
          },
        },
        audit: h.audit,
        clock: h.clock,
        ids: h.ids,
        logger: h.logger,
      },
      { thresholdMinutes: 10 }
    );

    expect(result).toEqual({
      eventsEnqueued: 0,
      rendersEnqueued: 0,
      sendsEnqueued: 0,
      ambiguousResolved: 0,
      digestSweepsEnqueued: 1,
      expired: 0,
    });
    expect(digestSweepLimits).toEqual([500]);
  });

  it('retention passes the clock instant and batch limit to the runner', async () => {
    const h = makeHarness();
    const calls: { batchLimit: number; now: Date }[] = [];
    const retention: RetentionRunner = {
      applyRetention: async (input) => {
        calls.push(input);
        return ok({
          deliveryAttemptsDeleted: 1,
          providerWebhooksDeleted: 2,
          digestMembersDeleted: 3,
          deliveriesDeleted: 4,
          digestBatchesDeleted: 5,
          logicalNotificationsDeleted: 6,
          eventsRedacted: 7,
          eventsDeleted: 8,
        });
      },
    };

    const result = await processRetentionJob(
      { retention, clock: h.clock, logger: h.logger },
      { batchLimit: 25 }
    );

    expect(result.eventsDeleted).toBe(8);
    expect(calls).toEqual([{ batchLimit: 25, now: h.clock.now() }]);
  });
});
