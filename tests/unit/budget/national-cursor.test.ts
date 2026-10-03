import { describe, expect, it } from 'vitest';

import { decodeOpaqueJson, encodeOpaqueJson } from '@/common/canonical-json/index.js';
import { validateApprovedRecordsInput } from '@/modules/budget/core/national/approved-inputs.js';
import {
  decodeNationalCursor,
  encodeNationalCursor,
  nationalFilterHash,
  type CursorBinding,
} from '@/modules/budget/core/national/cursor.js';
import { isSnapshotChanged } from '@/modules/budget/core/national/errors.js';
import { validateExecutionObservationsInput } from '@/modules/budget/core/national/execution-inputs.js';
import {
  compareObservationAfter,
  observationsBinding,
  OBSERVATIONS_CURSOR,
  parseObservationAfter,
  parseRecordAfter,
  recordsBinding,
  RECORDS_CURSOR,
  type ObservationAfter,
} from '@/modules/budget/core/national/paging.js';
import {
  approvedLaneToken,
  checkExpectedSnapshot,
  executionLaneToken,
  pinToken,
} from '@/modules/budget/core/national/snapshot.js';
import { buildNextCursor, decodeCursor, encodeCursor } from '@/modules/shared/index.js';

const LIVE: CursorBinding = { mode: 'LIVE', lane: 'APPROVED', snapshot: 'a1.snapshot-one' };
const FHASH = 'fhash-1';
// Real UUID shapes (selection_id is a PostgreSQL uuid); ordered S1 < S2 < S3.
const S1 = '0cda5d3a-09d1-4c3a-b794-455670ae0ec2';
const S2 = '4fe38180-00c8-599f-a53c-b5ddccb05ffc';
const S3 = '6110a784-1f51-4bee-8add-cf8bacf8455a';

const encodeOuter = (value: unknown): string => encodeOpaqueJson(value);

describe('snapshot-bound national cursor', () => {
  it('round-trips the kernel sort keys under the same binding and filters', () => {
    const cursor = encodeNationalCursor(LIVE, RECORDS_CURSOR, FHASH, ['interp-1', 42]);
    const keys = decodeNationalCursor(cursor, LIVE, RECORDS_CURSOR, FHASH)._unsafeUnwrap();
    expect(keys).toEqual(['interp-1', '42']);
    expect(parseRecordAfter(keys)._unsafeUnwrap()).toEqual({
      interpretationId: 'interp-1',
      recordIndex: 42,
    });
  });

  it('keeps the binding outside the untouched kernel cursor', () => {
    const cursor = encodeNationalCursor(LIVE, RECORDS_CURSOR, FHASH, ['interp-1', 42]);
    const outer = decodeOpaqueJson(cursor)._unsafeUnwrap() as Record<string, unknown>;
    expect(Object.keys(outer).sort()).toEqual(['bind', 'kernel', 'lane', 'mode', 'v']);
    expect(outer['bind']).toBe('a1.snapshot-one');
    const kernel = decodeCursor(String(outer['kernel']), {
      sort: RECORDS_CURSOR.sort,
      dir: 'asc',
      fhash: FHASH,
    })._unsafeUnwrap();
    expect(kernel.keys).toEqual(['interp-1', '42']);
    expect(kernel.fhash).toBe(FHASH);
    expect(String(outer['kernel'])).toBe(
      buildNextCursor({
        sort: RECORDS_CURSOR.sort,
        dir: 'asc',
        fhash: FHASH,
        lastKeys: ['interp-1', 42],
      })
    );
  });

  it('reports a changed live lane as SNAPSHOT_CHANGED with the current snapshot', () => {
    const cursor = encodeNationalCursor(LIVE, RECORDS_CURSOR, FHASH, ['interp-1', 42]);
    const moved: CursorBinding = { ...LIVE, snapshot: 'a1.snapshot-two' };
    const error = decodeNationalCursor(cursor, moved, RECORDS_CURSOR, FHASH)._unsafeUnwrapErr();
    expect(isSnapshotChanged(error)).toBe(true);
    expect(error).toMatchObject({
      type: 'InvalidInput',
      field: 'after',
      reason: 'SNAPSHOT_CHANGED',
      currentSnapshot: 'a1.snapshot-two',
    });
  });

  it('distinguishes malformed cursors and filter/lane/mode mismatches from a snapshot change', () => {
    const cursor = encodeNationalCursor(LIVE, RECORDS_CURSOR, FHASH, ['interp-1', 42]);
    const malformed = ['%%%', 'bm90IGpzb24', encodeOuter({ v: 1 }), encodeOuter([1, 2])];
    for (const raw of malformed) {
      const error = decodeNationalCursor(raw, LIVE, RECORDS_CURSOR, FHASH)._unsafeUnwrapErr();
      expect(error).toMatchObject({ type: 'InvalidInput', field: 'after' });
      expect(error.message).toMatch(/malformed/u);
      expect(isSnapshotChanged(error)).toBe(false);
    }
    const withExtra = encodeOuter({
      v: 1,
      lane: 'APPROVED',
      mode: 'LIVE',
      bind: 'a1.snapshot-one',
      kernel: 'x',
      keys: ['smuggled'],
    });
    expect(
      decodeNationalCursor(withExtra, LIVE, RECORDS_CURSOR, FHASH)._unsafeUnwrapErr().message
    ).toMatch(/malformed/u);
    const filterMismatch = decodeNationalCursor(cursor, LIVE, RECORDS_CURSOR, 'fhash-2');
    expect(filterMismatch._unsafeUnwrapErr().message).toMatch(/mismatch/u);
    const laneMismatch = decodeNationalCursor(
      cursor,
      { mode: 'LIVE', lane: 'EXECUTION', snapshot: 'a1.snapshot-one' },
      RECORDS_CURSOR,
      FHASH
    );
    expect(laneMismatch._unsafeUnwrapErr().message).toMatch(/mismatch/u);
    const modeMismatch = decodeNationalCursor(
      cursor,
      { mode: 'PINNED', lane: 'APPROVED', pin: 'a1.snapshot-one' },
      RECORDS_CURSOR,
      FHASH
    );
    expect(modeMismatch._unsafeUnwrapErr().message).toMatch(/mismatch/u);
    const wrongArity = encodeNationalCursor(LIVE, RECORDS_CURSOR, FHASH, ['interp-1']);
    expect(
      decodeNationalCursor(wrongArity, LIVE, RECORDS_CURSOR, FHASH)._unsafeUnwrapErr().message
    ).toMatch(/malformed/u);
    // A bare kernel cursor (no outer binding) is malformed, never silently accepted.
    const bare = encodeCursor({
      v: 1,
      sort: RECORDS_CURSOR.sort,
      dir: 'asc',
      keys: ['a', '1'],
      fhash: FHASH,
    });
    expect(
      decodeNationalCursor(bare, LIVE, RECORDS_CURSOR, FHASH)._unsafeUnwrapErr().message
    ).toMatch(/malformed/u);
  });

  it('pins immutable sources: reproducible cursors that survive lane changes', () => {
    const query = validateApprovedRecordsInput({
      source: { interpretationId: 'interp-1' },
    })._unsafeUnwrap();
    const first = recordsBinding(query, 'a1.snapshot-one')._unsafeUnwrap();
    const later = recordsBinding(query, 'a1.snapshot-two')._unsafeUnwrap();
    expect(first).toEqual(later);
    expect(first.mode).toBe('PINNED');
    const fhash = nationalFilterHash('budgetApprovedRecords', query)._unsafeUnwrap();
    const cursorA = encodeNationalCursor(first, RECORDS_CURSOR, fhash, ['interp-1', 7]);
    const cursorB = encodeNationalCursor(later, RECORDS_CURSOR, fhash, ['interp-1', 7]);
    expect(cursorA).toBe(cursorB);
    expect(decodeNationalCursor(cursorA, later, RECORDS_CURSOR, fhash).isOk()).toBe(true);
    const other = validateApprovedRecordsInput({
      source: { interpretationId: 'interp-2' },
    })._unsafeUnwrap();
    const otherBinding = recordsBinding(other, 'a1.snapshot-two')._unsafeUnwrap();
    expect(
      decodeNationalCursor(cursorA, otherBinding, RECORDS_CURSOR, fhash)._unsafeUnwrapErr().message
    ).toMatch(/mismatch/u);
  });

  it('binds edition/form records and month observations to their live lane', () => {
    const records = validateApprovedRecordsInput({
      source: { edition: { editionId: '2025:law', form: 'STATE_BUDGET_SYNTHESIS' } },
    })._unsafeUnwrap();
    expect(recordsBinding(records, 'a1.x')._unsafeUnwrap()).toEqual({
      mode: 'LIVE',
      lane: 'APPROVED',
      snapshot: 'a1.x',
    });
    const months = validateExecutionObservationsInput({
      source: { months: { type: 'MONTH', selection: { dates: ['2025-06'] } } },
    })._unsafeUnwrap();
    expect(observationsBinding(months, 'e1.y')._unsafeUnwrap()).toEqual({
      mode: 'LIVE',
      lane: 'EXECUTION',
      snapshot: 'e1.y',
    });
    const pinned = validateExecutionObservationsInput({
      source: { selectionIds: [S2, S1] },
    })._unsafeUnwrap();
    const reordered = validateExecutionObservationsInput({
      source: { selectionIds: [S1.toUpperCase(), S2] },
    })._unsafeUnwrap();
    expect(reordered.source).toEqual({ kind: 'SELECTIONS', selectionIds: [S1, S2] });
    expect(observationsBinding(pinned, 'e1.y')._unsafeUnwrap()).toEqual(
      observationsBinding(reordered, 'e2.z')._unsafeUnwrap()
    );
  });

  it('hashes the canonical validated input, so equal requests share a filter hash', () => {
    const a = validateExecutionObservationsInput({
      source: { selectionIds: [S2, S1] },
      sections: ['EXPENDITURE', 'REVENUE'],
    })._unsafeUnwrap();
    const b = validateExecutionObservationsInput({
      source: { selectionIds: [S1.toUpperCase(), S2.toUpperCase()] },
      sections: ['REVENUE', 'EXPENDITURE'],
    })._unsafeUnwrap();
    const c = validateExecutionObservationsInput({
      source: { selectionIds: [S1, S2] },
      sections: ['REVENUE'],
    })._unsafeUnwrap();
    const hash = (q: unknown) =>
      nationalFilterHash('budgetExecutionObservations', q)._unsafeUnwrap();
    expect(hash(a)).toBe(hash(b));
    expect(hash(a)).not.toBe(hash(c));
    expect(nationalFilterHash('budgetApprovedRecords', a)._unsafeUnwrap()).not.toBe(hash(a));
  });
});

describe('lane snapshot tokens', () => {
  it('are order-insensitive, lane-scoped and change with the lane content', () => {
    const rows = [
      { editionId: '2025:law', form: 'state_budget', interpretationId: 'i1', lineCount: 10 },
      { editionId: '2024:law', form: 'state_budget', interpretationId: 'i0', lineCount: 9 },
    ];
    const token = approvedLaneToken(rows)._unsafeUnwrap();
    expect(token).toMatch(/^a1\.[0-9a-f]{32}$/u);
    expect(approvedLaneToken([...rows].reverse())._unsafeUnwrap()).toBe(token);
    expect(approvedLaneToken([{ ...rows[0]!, lineCount: 11 }, rows[1]!])._unsafeUnwrap()).not.toBe(
      token
    );
    const execution = executionLaneToken([{ periodEnd: '2025-06-30', selectionId: 's1' }]);
    expect(execution._unsafeUnwrap()).toMatch(/^e1\.[0-9a-f]{32}$/u);
    expect(pinToken('EXECUTION', ['b', 'a'])._unsafeUnwrap()).toBe(
      pinToken('EXECUTION', ['a', 'b'])._unsafeUnwrap()
    );
    expect(pinToken('APPROVED', ['a'])._unsafeUnwrap()).not.toBe(
      pinToken('EXECUTION', ['a'])._unsafeUnwrap()
    );
  });

  it('applies expectedSnapshot as the same SNAPSHOT_CHANGED precondition', () => {
    expect(checkExpectedSnapshot(null, 'a1.now').isOk()).toBe(true);
    expect(checkExpectedSnapshot('a1.now', 'a1.now').isOk()).toBe(true);
    const error = checkExpectedSnapshot('a1.before', 'a1.now')._unsafeUnwrapErr();
    expect(error).toMatchObject({
      type: 'InvalidInput',
      field: 'expectedSnapshot',
      reason: 'SNAPSHOT_CHANGED',
      currentSnapshot: 'a1.now',
    });
  });
});

describe('observation occurrence paging', () => {
  // One month whose selection chain rolled back: R1 → R2 → R1.
  const occurrences: ObservationAfter[] = [S1, S2, S3].flatMap((selectionId) =>
    ['k1', 'k2'].map((observationKey) => ({
      periodEnd: '2025-06-30',
      selectionId,
      inputSourceId: 'bgc' as const,
      observationKey,
    }))
  );
  const nodeOf: Record<string, string> = { [S1]: 'R1', [S2]: 'R2', [S3]: 'R1' };
  const short = (id: string): string => id.slice(0, 4);
  const binding: CursorBinding = { mode: 'PINNED', lane: 'EXECUTION', pin: 'p1.selections' };

  /** In-memory page over the reference order (stands in for the SQL keyset). */
  const page = (after: ObservationAfter | null, size: number): ObservationAfter[] =>
    [...occurrences]
      .sort(compareObservationAfter)
      .filter((o) => after === null || compareObservationAfter(o, after) > 0)
      .slice(0, size);

  it('visits every occurrence exactly once across pages, including repeated nodes', () => {
    const seen: string[] = [];
    let after: ObservationAfter | null = null;
    for (let guard = 0; guard < 10; guard++) {
      const rows = page(after, 4);
      if (rows.length === 0) break;
      for (const o of rows)
        seen.push(`${short(o.selectionId)}/${nodeOf[o.selectionId] ?? '?'}/${o.observationKey}`);
      const last = rows[rows.length - 1]!;
      const cursor = encodeNationalCursor(binding, OBSERVATIONS_CURSOR, FHASH, [
        last.periodEnd,
        last.selectionId,
        last.inputSourceId,
        last.observationKey,
      ]);
      const keys = decodeNationalCursor(
        cursor,
        binding,
        OBSERVATIONS_CURSOR,
        FHASH
      )._unsafeUnwrap();
      after = parseObservationAfter(keys)._unsafeUnwrap();
    }
    expect(seen).toEqual([
      '0cda/R1/k1',
      '0cda/R1/k2',
      '4fe3/R2/k1',
      '4fe3/R2/k2',
      '6110/R1/k1',
      '6110/R1/k2',
    ]);
  });

  it('orders observation keys bytewise like COLLATE "C" and validates decoded keys', () => {
    const base = { periodEnd: '2025-06-30', selectionId: S1, inputSourceId: 'bgc' as const };
    const keys = ['b', 'B', 'a', 'Z', '_', 'é'].map((observationKey) => ({
      ...base,
      observationKey,
    }));
    expect([...keys].sort(compareObservationAfter).map((k) => k.observationKey)).toEqual([
      'B',
      'Z',
      '_',
      'a',
      'b',
      'é',
    ]);
    expect(parseRecordAfter(['interp', '-1']).isErr()).toBe(true);
    expect(parseRecordAfter(['interp', '01']).isErr()).toBe(true);
  });

  it('accepts only real column domains in decoded observation keys', () => {
    expect(parseObservationAfter(['2025-06-30', S1, 'bgc', 'k'])._unsafeUnwrap()).toEqual({
      periodEnd: '2025-06-30',
      selectionId: S1,
      inputSourceId: 'bgc',
      observationKey: 'k',
    });
    expect(parseObservationAfter(['2024-02-29', S1, 'sinteza', 'k']).isOk()).toBe(true);
    const forged: (readonly string[])[] = [
      ['2025-13-01', S1, 'bgc', 'k'],
      ['2025-02-31', S1, 'bgc', 'k'],
      ['2025-02-29', S1, 'bgc', 'k'],
      ['2025-06-15', S1, 'bgc', 'k'],
      ['0000-01-31', S1, 'bgc', 'k'],
      ['2025-06-30', 'not-uuid', 'bgc', 'k'],
      ['2025-06-30', S1.toUpperCase(), 'bgc', 'k'],
      ['2025-06-30', `{${S1}}`, 'bgc', 'k'],
      ['2025-06-30', S1, 'nota', 'k'],
      ['2025-06-30', S1, 'BGC', 'k'],
      ['2025-06-30', S1, 'bgc', ''],
    ];
    for (const keys of forged) {
      expect(parseObservationAfter(keys)._unsafeUnwrapErr()).toMatchObject({
        type: 'InvalidInput',
        field: 'after',
      });
    }
  });

  it('bounds the record index to the PostgreSQL integer range', () => {
    expect(parseRecordAfter(['interp', '2147483647'])._unsafeUnwrap().recordIndex).toBe(2147483647);
    expect(parseRecordAfter(['interp', '0'])._unsafeUnwrap().recordIndex).toBe(0);
    expect(parseRecordAfter(['interp', '2147483648']).isErr()).toBe(true);
    expect(parseRecordAfter(['interp', '9999999999']).isErr()).toBe(true);
    expect(parseRecordAfter(['interp', '99999999999']).isErr()).toBe(true);
    // A forged but well-encoded cursor fails at decode time, before any SQL cast.
    const forged = encodeNationalCursor(LIVE, RECORDS_CURSOR, FHASH, ['interp-1', '9999999999']);
    const keys = decodeNationalCursor(forged, LIVE, RECORDS_CURSOR, FHASH)._unsafeUnwrap();
    expect(parseRecordAfter(keys)._unsafeUnwrapErr()).toMatchObject({ field: 'after' });
  });
});
