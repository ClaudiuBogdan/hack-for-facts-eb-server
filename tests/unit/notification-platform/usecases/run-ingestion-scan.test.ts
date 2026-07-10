import { describe, expect, it } from 'vitest';

import { runIngestionScan } from '@/modules/notification-platform/core/events/usecases/run-ingestion-scan.js';

import { makeUsecaseHarness } from './harness.js';
import { makeFakeEventSourcePort } from '../../../fixtures/notification-platform/index.js';
import { expectOk } from '../../../support/index.js';

describe('runIngestionScan', () => {
  it('records a page and tolerates losing the watermark CAS', async () => {
    const h = makeUsecaseHarness();
    h.watermarks.store.put({ sourceId: 'test-source', watermark: 'w0' });
    const source = makeFakeEventSourcePort({
      occurrences: [
        {
          eventType: h.kind.eventType,
          occurrenceKey: 'occurrence-1',
          occurredAt: h.clock.now(),
          facts: { subjectId: 'subject-1', title: 'Created' },
        },
      ],
      nextWatermark: 'w1',
      onRead: () => h.watermarks.store.put({ sourceId: 'test-source', watermark: 'concurrent' }),
    });

    const result = expectOk(await runIngestionScan({ ...h, source }, { batchLimit: 10 }));
    expect(result).toEqual({ recorded: 1, duplicates: 0, watermarkAdvanced: false });
    expect(h.events.store.size()).toBe(1);
    expect(h.watermarks.store.get('test-source')?.watermark).toBe('concurrent');
  });
});
