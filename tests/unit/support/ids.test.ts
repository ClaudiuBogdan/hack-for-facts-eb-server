import { describe, expect, it } from 'vitest';

import { makeSequentialIds } from '../../support/index.js';

describe('makeSequentialIds', () => {
  it('uses the default prefix and lets callers peek without consuming an id', () => {
    const ids = makeSequentialIds();

    expect(ids.peek()).toBe('id-1');
    expect(ids.peek()).toBe('id-1');
    expect(ids.newId()).toBe('id-1');
    expect(ids.peek()).toBe('id-2');
    expect(ids.issued()).toEqual(['id-1']);
  });

  it('keeps counters independent per instance', () => {
    const left = makeSequentialIds('record');
    const right = makeSequentialIds('record');

    expect(left.newId()).toBe('record-1');
    expect(left.newId()).toBe('record-2');
    expect(right.newId()).toBe('record-1');
  });

  it('returns an isolated issued list and resets all instance state', () => {
    const ids = makeSequentialIds('job');
    ids.newId();
    const issued = ids.issued() as string[];
    issued.push('forged');

    expect(ids.issued()).toEqual(['job-1']);
    ids.reset();
    expect(ids.issued()).toEqual([]);
    expect(ids.newId()).toBe('job-1');
  });
});
