import { ok } from 'neverthrow';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';

import { createDatabaseError } from '@/modules/user-data/core/errors.js';
import {
  makeUserDataMaintenanceRuntime,
  processUserDataReceiptCleanup,
  processUserDataReconciliation,
} from '@/modules/user-data/shell/jobs/maintenance-runtime.js';

import { makeFakeUserDataStore } from '../../fixtures/user-data/index.js';
import { makeSequentialIds, makeTestClock } from '../../support/index.js';

import type { CreateWorkerOptions, QueueClient } from '@/infra/queue/client.js';
import type { LoggerPort } from '@/modules/user-data/core/usecases/shared.js';
import type { Queue, Worker } from 'bullmq';

const makeHarness = () => {
  const clock = makeTestClock(new Date('2026-01-10T00:00:00.000Z'));
  const store = makeFakeUserDataStore({ clock, ids: makeSequentialIds('jobs') });
  const logs: { level: string; message: string; context?: Record<string, unknown> }[] = [];
  const writeLog = (level: string, message: string, context?: Record<string, unknown>): void => {
    logs.push(context === undefined ? { level, message } : { level, message, context });
  };
  const logger: LoggerPort = {
    debug: (message, context) => {
      writeLog('debug', message, context);
    },
    info: (message, context) => {
      writeLog('info', message, context);
    },
    warn: (message, context) => {
      writeLog('warn', message, context);
    },
    error: (message, context) => {
      writeLog('error', message, context);
    },
  };
  return { clock, store, logs, logger };
};

describe('User Data Store maintenance job handlers', () => {
  it('receipt cleanup logs a fault and does not throw', async () => {
    const h = makeHarness();
    h.store.faults.fail('deleteExpiredReceipts', {
      error: createDatabaseError('unavailable', true),
    });

    await expect(
      processUserDataReceiptCleanup({ mutationPort: h.store, clock: h.clock, logger: h.logger })
    ).resolves.toBeNull();
    expect(h.logs).toContainEqual({
      level: 'error',
      message: 'User Data Store receipt cleanup failed',
      context: { errorType: 'DatabaseError' },
    });
  });

  it('reconciliation logs faults without throwing and violations with ids but no content', async () => {
    const h = makeHarness();
    h.store.faults.fail('findViolations', { error: createDatabaseError('unavailable', true) });
    await expect(
      processUserDataReconciliation({ reconciliationPort: h.store, logger: h.logger })
    ).resolves.toBeNull();

    h.store.findViolations = async () =>
      ok({
        checkedRecords: 1,
        violations: [
          { recordId: 'record-1', kind: 'revisionMismatch' as const, detail: 'ids-only' },
        ],
      });
    await expect(
      processUserDataReconciliation({ reconciliationPort: h.store, logger: h.logger })
    ).resolves.toMatchObject({ checkedRecords: 1 });
    expect(h.logs.at(-1)).toEqual({
      level: 'error',
      message: 'User Data Store reconciliation found violations',
      context: { checkedRecords: 1, violationCount: 1, recordIds: ['record-1'] },
    });
    expect(JSON.stringify(h.logs)).not.toContain('payload');
  });
});

describe('makeUserDataMaintenanceRuntime', () => {
  it('registers both repeatable schedules and closes its queue client once', async () => {
    const h = makeHarness();
    const schedules: { id: string; repeat: unknown }[] = [];
    const workers: string[] = [];
    let closes = 0;
    const queue = {
      upsertJobScheduler: async (id: string, repeat: unknown) => {
        schedules.push({ id, repeat });
        return undefined as never;
      },
    } as unknown as Queue;
    const queueClient: QueueClient = {
      getQueue: <T>() => queue as Queue<T>,
      createWorker: <T>(options: CreateWorkerOptions<T>) => {
        workers.push(options.name);
        return {} as Worker<T>;
      },
      close: async () => {
        closes += 1;
      },
    };
    const runtime = await makeUserDataMaintenanceRuntime({
      redisUrl: 'redis://unused',
      bullmqPrefix: 'test',
      mutationPort: h.store,
      reconciliationPort: h.store,
      clock: h.clock,
      logger: pino({ level: 'silent' }),
      config: { receiptCleanupCron: '0 4 * * *', reconcileMinutes: 60 },
      queueClient,
    });

    expect(schedules).toEqual([
      { id: 'ud-receipt-cleanup', repeat: { pattern: '0 4 * * *' } },
      { id: 'ud-reconcile', repeat: { every: 3_600_000 } },
    ]);
    expect(workers).toEqual(['ud-receipt-cleanup', 'ud-reconcile']);
    await runtime.stop();
    await runtime.stop();
    expect(closes).toBe(1);
  });
});
