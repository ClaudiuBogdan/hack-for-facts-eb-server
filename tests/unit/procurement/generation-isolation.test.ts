import { ok } from 'neverthrow';
import { describe, expect, it } from 'vitest';

import { analysisStats } from '@/modules/procurement/core/analysis-usecases.js';
import { getContractDetail } from '@/modules/procurement/core/usecases.js';

import { fakeAnalysisRepo } from './analysis-fakes.js';

import type { ProcurementRepo } from '@/modules/procurement/core/ports.js';

describe('analysis generation isolation', () => {
  it('blocks analysis when no generation is published without blocking retained record reads', async () => {
    const { repo: analysisRepo } = fakeAnalysisRepo({ generation: null });
    let recordReads = 0;
    const recordRepo = {
      getContractDetail: () => {
        recordReads += 1;
        return Promise.resolve(ok(null));
      },
    } as unknown as ProcurementRepo;

    const analysis = await analysisStats({ analysisRepo }, { scope: {} });
    const record = await getContractDetail(recordRepo, 'contract-1');

    expect(analysis._unsafeUnwrapErr().type).toBe('ServiceUnavailable');
    expect(record.isOk()).toBe(true);
    expect(recordReads).toBe(1);
  });
});
