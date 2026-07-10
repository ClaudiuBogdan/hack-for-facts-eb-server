import { expect, it } from 'vitest';

import { expectOk, type PortContractCases } from '../../support/index.js';

import type { SourceWatermarkRepo } from '@/modules/notification-platform/core/events/ports.js';

export const sourceWatermarkRepoContractCases: PortContractCases<SourceWatermarkRepo> = ({
  getPort,
}) => {
  it('compares and sets absent and existing watermarks atomically', async () => {
    const repo = getPort();
    expect(expectOk(await repo.get('source-a'))).toBeNull();
    expect(
      expectOk(await repo.compareAndSet({ sourceId: 'source-a', expected: 'wrong', next: 'v1' }))
    ).toBe(false);
    expect(
      expectOk(await repo.compareAndSet({ sourceId: 'source-a', expected: null, next: 'v1' }))
    ).toBe(true);
    expect(
      expectOk(await repo.compareAndSet({ sourceId: 'source-a', expected: null, next: 'v2' }))
    ).toBe(false);
    expect(
      expectOk(await repo.compareAndSet({ sourceId: 'source-a', expected: 'v1', next: 'v2' }))
    ).toBe(true);
    expect(expectOk(await repo.get('source-a'))).toBe('v2');
  });

  it('allows only one concurrent compare-and-set winner', async () => {
    const repo = getPort();
    expectOk(await repo.compareAndSet({ sourceId: 'source-race', expected: null, next: 'base' }));
    const results = await Promise.all([
      repo.compareAndSet({ sourceId: 'source-race', expected: 'base', next: 'left' }),
      repo.compareAndSet({ sourceId: 'source-race', expected: 'base', next: 'right' }),
    ]);
    expect(results.map((result) => expectOk(result)).filter((value) => value)).toHaveLength(1);
  });
};
