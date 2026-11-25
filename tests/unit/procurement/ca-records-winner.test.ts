/**
 * Winner-code lists (PROC-KB0Z item 3): the read order and the refusals, over an in-memory reader.
 * A code outside the gate is refused before the winner scan (W1) runs; a code past the key ceiling
 * and a key set spanning sources are refused rather than paged.
 */

import { ok } from 'neverthrow';
import { describe, expect, it } from 'vitest';

import {
  caWinnerSummary,
  listCaWinnerRecords,
} from '@/modules/procurement/core/ca-records-usecases.js';
import { CA_WINNER_MAX_KEYS, type CaKey } from '@/modules/procurement/core/ca-records.js';

import type {
  CaRecordsReader,
  CaRecordsRepo,
  CaWinnerGate,
  CaWinnerKeys,
} from '@/modules/procurement/core/ca-records-ports.js';

const CODE = '14399840';
const AS_OF = '2026-11-24T12:00:00.000000Z';
const VIEW_COMPANY = { kind: 'company', name: 'ALFA SRL', source: 'view' } as const;

interface Calls {
  winnerKeys: number;
  keySetCounts: number;
  keySetPage: number;
}

const unused = (): never => {
  throw new Error('not expected in this test');
};

const fakeRepo = (gate: CaWinnerGate, keys: CaWinnerKeys, calls: Calls): CaRecordsRepo => {
  const reader: CaRecordsReader = {
    dataAsOf: () => Promise.resolve(ok(AS_OF)),
    namesReadable: () => true,
    releaseReadable: () => true,
    publishedFloor: () => null,
    winnerGate: () => Promise.resolve(ok(gate)),
    winnerKeys: (_code, limit) => {
      calls.winnerKeys += 1;
      return Promise.resolve(ok({ ...keys, keys: keys.keys.slice(0, limit) }));
    },
    keySetCounts: () => {
      calls.keySetCounts += 1;
      return Promise.resolve(
        ok({ recordCount: 0, valuedCount: 0, identityReviewCount: 0, undatedCount: 0 })
      );
    },
    keySetPage: () => {
      calls.keySetPage += 1;
      return Promise.resolve(ok([]));
    },
    buyerCounts: unused,
    buyerKeys: unused,
    awardDayOf: unused,
    recordsByKeys: unused,
    winnersByKeys: unused,
    lotsOf: unused,
    currentKeyOf: unused,
    buyerProbe: unused,
    buyerRegistryNames: unused,
  };
  return { enabled: true, snapshot: (read) => read(reader) };
};

const keysOf = (count: number, sourceOf: (i: number) => string = () => 'seap'): CaKey[] =>
  Array.from({ length: count }, (_v, i) => ({
    sourceName: sourceOf(i),
    matchId: `ca:${String(i)}:1`,
  }));

const run = async (gate: CaWinnerGate, keys: CaWinnerKeys) => {
  const calls: Calls = { winnerKeys: 0, keySetCounts: 0, keySetPage: 0 };
  const deps = { repo: fakeRepo(gate, keys, calls) };
  const summary = await caWinnerSummary(deps, { winnerFiscalCode: CODE });
  const list = await listCaWinnerRecords(deps, { winnerFiscalCode: CODE, page: 1, pageSize: 5 });
  return { summary, list, calls };
};

const SOME_KEYS: CaWinnerKeys = { keys: keysOf(3), allDisclosed: true, anyDisclosed: true };

describe('winner-code lists: read order and refusals', () => {
  it('refuses every code outside the gate before the winner scan', async () => {
    const outside: CaWinnerGate[] = [
      // Outside D6 and not named (masked or code only), hidden, no row, unreadable views.
      {
        disclosed: false,
        naming: { kind: 'person_masked', name: 'Io** Po****', source: 'view' },
        viewNamed: false,
      },
      {
        disclosed: false,
        naming: { kind: 'code_only', name: null, source: 'view' },
        viewNamed: false,
      },
      { disclosed: true, naming: { kind: 'hidden', name: null, source: 'view' }, viewNamed: false },
      {
        disclosed: true,
        naming: { kind: 'code_only', name: null, source: 'none' },
        viewNamed: false,
      },
      { disclosed: false, naming: null, viewNamed: false },
    ];
    for (const gate of outside) {
      const { summary, list, calls } = await run(gate, SOME_KEYS);
      for (const answer of [summary._unsafeUnwrapErr(), list._unsafeUnwrapErr()])
        expect(answer).toEqual({
          type: 'NotFound',
          message: 'No published contract awards for this supplier code.',
          resource: 'contractAwardWinner',
        });
      expect(calls).toEqual({ winnerKeys: 0, keySetCounts: 0, keySetPage: 0 });
    }
  });

  it('reads a gate code’s keys once per request', async () => {
    const { summary, list, calls } = await run(
      { disclosed: true, naming: VIEW_COMPANY, viewNamed: true },
      SOME_KEYS
    );
    expect(summary.isOk() && list.isOk()).toBe(true);
    // One scan for the summary, one for the list: never per page item.
    expect(calls).toEqual({ winnerKeys: 2, keySetCounts: 2, keySetPage: 1 });
  });

  it('refuses winner rows that disagree with the gate’s D6 read', async () => {
    const disclosedGate = { disclosed: true, naming: VIEW_COMPANY, viewNamed: true };
    const namedGate = { disclosed: false, naming: VIEW_COMPANY, viewNamed: true };
    for (const [gate, keys] of [
      [disclosedGate, { keys: keysOf(2), allDisclosed: false, anyDisclosed: true }],
      [namedGate, { keys: keysOf(2), allDisclosed: false, anyDisclosed: true }],
    ] as const) {
      const { summary, calls } = await run(gate, keys);
      expect(summary._unsafeUnwrapErr().type).toBe('Database');
      expect(calls.keySetCounts).toBe(0);
    }
  });

  it('refuses a code past the key ceiling, and a key set spanning sources', async () => {
    const gate = { disclosed: true, naming: VIEW_COMPANY, viewNamed: true };
    const many = await run(gate, {
      keys: keysOf(CA_WINNER_MAX_KEYS + 1),
      allDisclosed: true,
      anyDisclosed: true,
    });
    expect(many.summary._unsafeUnwrapErr().type).toBe('ServiceUnavailable');
    expect(many.calls.keySetCounts).toBe(0);
    const atCeiling = await run(gate, {
      keys: keysOf(CA_WINNER_MAX_KEYS),
      allDisclosed: true,
      anyDisclosed: true,
    });
    expect(atCeiling.summary.isOk()).toBe(true);
    const mixed = await run(gate, {
      keys: keysOf(4, (i) => (i === 3 ? 'other' : 'seap')),
      allDisclosed: true,
      anyDisclosed: true,
    });
    expect(mixed.summary._unsafeUnwrapErr().type).toBe('Database');
    expect(mixed.calls.keySetCounts).toBe(0);
  });

  it('answers a gate code with no records with zero counts and no key-set reads', async () => {
    const { summary, list, calls } = await run(
      { disclosed: true, naming: VIEW_COMPANY, viewNamed: false },
      { keys: [], allDisclosed: true, anyDisclosed: false }
    );
    expect(summary._unsafeUnwrap()).toMatchObject({ recordCount: 0, undatedCount: 0 });
    expect(list._unsafeUnwrap()).toMatchObject({ items: [], total: 0, hasMore: false });
    expect(calls).toEqual({ winnerKeys: 2, keySetCounts: 0, keySetPage: 0 });
  });
});
