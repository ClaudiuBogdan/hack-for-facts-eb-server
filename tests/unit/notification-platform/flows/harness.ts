import { QUEUE_NAMES } from '@/infra/queue/client.js';
import { makeKindRegistry } from '@/modules/notification-platform/core/registry/registry.js';
import { processDigestJob } from '@/modules/notification-platform/shell/queue/workers/digest-worker.js';
import { processFanOutJob } from '@/modules/notification-platform/shell/queue/workers/fanout-worker.js';
import { processRecoveryJob } from '@/modules/notification-platform/shell/queue/workers/recovery-worker.js';
import { processRenderJob } from '@/modules/notification-platform/shell/queue/workers/render-worker.js';
import { processSendJob } from '@/modules/notification-platform/shell/queue/workers/send-worker.js';

import {
  makeChannelDestination,
  makeFakeChannelAdapterPort,
  makeSubscription,
  makeTestKind,
  makeUserNotificationPreferences,
  type FakeChannelAdapterPort,
} from '../../../fixtures/notification-platform/index.js';
import { makeUsecaseHarness } from '../usecases/harness.js';

import type { KindDefinition } from '@/modules/notification-platform/core/registry/kind-definition.js';

export const makeFlowHarness = (
  options: {
    kind?: KindDefinition;
    adapter?: FakeChannelAdapterPort;
  } = {}
) => {
  const base = makeUsecaseHarness();
  const kind = options.kind ?? makeTestKind();
  const registry = makeKindRegistry([kind]);
  if (registry.isErr()) {
    throw new Error(registry.error.message);
  }
  const adapter = options.adapter ?? makeFakeChannelAdapterPort();
  const channelAdapters = new Map([['email' as const, adapter]]);
  const h = { ...base, kind, registry: registry.value, adapter, channelAdapters };

  h.runtime.register<{ eventId: string }>(QUEUE_NAMES.NP_FANOUT, async (job) => {
    await processFanOutJob(h, job.payload);
  });
  h.runtime.register<{ deliveryId: string }>(QUEUE_NAMES.NP_RENDER, async (job) => {
    await processRenderJob(h, job.payload);
  });
  h.runtime.register<{ deliveryId: string }>(QUEUE_NAMES.NP_SEND, async (job) => {
    await processSendJob(h, job.payload);
  });
  h.runtime.register<{ limit: number }>(QUEUE_NAMES.NP_DIGEST, async (job) => {
    await processDigestJob(h, job.payload);
  });
  h.runtime.register<{ thresholdMinutes: number }>(QUEUE_NAMES.NP_RECOVERY, async (job) => {
    await processRecoveryJob(h, job.payload);
  });

  return h;
};

export const seedFlowRecipient = (
  h: ReturnType<typeof makeFlowHarness>,
  options: { userId?: string; cadence?: 'immediate' | 'daily' | 'weekly' } = {}
): void => {
  const userId = options.userId ?? 'user-1';
  h.subscriptions.store.put(
    makeSubscription(h, {
      id: `subscription-${userId}`,
      userId,
      kindId: h.kind.kindId,
      subjectId: 'subject-1',
    })
  );
  h.preferences.store.put(
    makeUserNotificationPreferences(h, {
      userId,
      channels: {
        inbox: { enabled: true, cadence: 'immediate' },
        email: { enabled: true, cadence: options.cadence ?? 'immediate' },
      },
    })
  );
  h.destinations.store.put(
    makeChannelDestination(h, {
      id: `destination-${userId}`,
      userId,
      fingerprint: 'fingerprint-1',
    })
  );
};
