import { makeKindRegistry } from '@/modules/notification-platform/core/registry/registry.js';

import {
  makeFakeAuditLedgerPort,
  makeFakeAnonymizationCheckPort,
  makeFakeChannelAdapterPort,
  makeFakeChannelDestinationRepo,
  makeFakeDeliveryAttemptRepo,
  makeFakeDeliveryRepo,
  makeFakeDigestBatchRepo,
  makeFakeEventFanOutScheduler,
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

export const makeUsecaseHarness = () => {
  const clock = makeTestClock(new Date('2026-01-15T10:00:00.000Z'));
  const ids = makeSequentialIds('test');
  const logger = makeFakeLoggerPort();
  const runtime = makeInMemoryJobRuntime({ clock, ids: makeSequentialIds('job') });
  const kind = makeTestKind();
  const registryResult = makeKindRegistry([kind]);
  if (registryResult.isErr()) throw new Error(registryResult.error.message);
  const events = makeFakeNotificationEventRepo({ clock });
  const subscriptions = makeFakeSubscriptionRepo();
  const preferences = makeFakePreferenceRepo();
  const logicalNotifications = makeFakeLogicalNotificationRepo();
  const deliveries = makeFakeDeliveryRepo({ clock });
  const attempts = makeFakeDeliveryAttemptRepo();
  const destinations = makeFakeChannelDestinationRepo({ ids });
  const digests = makeFakeDigestBatchRepo({
    clock,
    logicalNotifications: logicalNotifications.store,
    deliveries: deliveries.store,
  });
  const audit = makeFakeAuditLedgerPort({ ids });
  const anonymization = makeFakeAnonymizationCheckPort();
  const adapter = makeFakeChannelAdapterPort();
  const channelAdapters = new Map([['email' as const, adapter]]);
  const fanOutScheduler = makeFakeEventFanOutScheduler(runtime);
  const renderScheduler = makeFakeRenderJobScheduler(runtime);
  const sendScheduler = makeFakeSendJobScheduler(runtime);
  const watermarks = makeFakeSourceWatermarkRepo();

  return {
    clock,
    ids,
    logger,
    runtime,
    kind,
    registry: registryResult.value,
    events,
    subscriptions,
    preferences,
    logicalNotifications,
    deliveries,
    attempts,
    destinations,
    digests,
    audit,
    anonymization,
    adapter,
    channelAdapters,
    fanOutScheduler,
    renderScheduler,
    sendScheduler,
    watermarks,
  };
};
