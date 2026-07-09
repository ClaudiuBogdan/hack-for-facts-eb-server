/**
 * The supplier-records union: merge order, cursor round-trip, and the cross-table
 * id tie-break. `contract_id` and `da_id` are only unique WITHIN their table, so a
 * cursor without the grain tag would collide and silently drop or repeat a row.
 */

import { describe, expect, it } from 'vitest';

import {
  compareBigintDesc,
  compareRecords,
  cursorOf,
  decodeRecordCursor,
  encodeRecordCursor,
  grainRank,
  mergeSupplierRecords,
} from '@/modules/procurement/core/supplier-records.js';

import type {
  ProcurementContract,
  ProcurementDirectAcquisition,
  SupplierRecord,
} from '@/modules/procurement/core/types.js';

const contract = (id: string, date: string | null): SupplierRecord => ({
  grain: 'procurement_contract',
  contract: { contractId: id, contractDate: date } as unknown as ProcurementContract,
});

const da = (id: string, date: string | null): SupplierRecord => ({
  grain: 'direct_acquisition',
  directAcquisition: { daId: id, finalizationDate: date } as unknown as ProcurementDirectAcquisition,
});

const ids = (records: readonly SupplierRecord[]): string[] =>
  records.map((r) => `${r.grain === 'procurement_contract' ? 'c' : 'd'}${cursorOf(r).id}`);

describe('bigint id comparison (never a lossy JS number)', () => {
  it('orders by magnitude, not lexicographically', () => {
    expect(compareBigintDesc('100', '99')).toBeLessThan(0); // 100 sorts first (desc)
    expect(compareBigintDesc('99', '100')).toBeGreaterThan(0);
    expect(compareBigintDesc('5', '5')).toBe(0);
  });

  it('handles ids beyond Number.MAX_SAFE_INTEGER', () => {
    expect(compareBigintDesc('9007199254740993', '9007199254740992')).toBeLessThan(0);
  });
});

describe('merge order: (date DESC NULLS LAST, grainRank ASC, id DESC)', () => {
  it('dated rows precede null-dated rows', () => {
    expect(compareRecords(cursorOf(contract('1', '2020-01-01')), cursorOf(contract('2', null)))).toBeLessThan(0);
  });

  it('a later date precedes an earlier one', () => {
    expect(compareRecords(cursorOf(da('1', '2026-01-01')), cursorOf(da('2', '2025-01-01')))).toBeLessThan(0);
  });

  it('on a date tie, contracts precede direct acquisitions', () => {
    expect(grainRank('procurement_contract')).toBeLessThan(grainRank('direct_acquisition'));
    expect(compareRecords(cursorOf(contract('1', '2024-01-01')), cursorOf(da('999', '2024-01-01')))).toBeLessThan(0);
  });

  it('on a date+grain tie, the higher id precedes', () => {
    expect(compareRecords(cursorOf(da('20', '2024-01-01')), cursorOf(da('3', '2024-01-01')))).toBeLessThan(0);
  });

  it('a cross-table id collision is broken by the grain tag, not dropped', () => {
    // Same date, same numeric id, different tables — both rows must survive.
    const merged = mergeSupplierRecords([contract('7', '2024-01-01')], [da('7', '2024-01-01')], 10);
    expect(ids(merged.page)).toEqual(['c7', 'd7']);
  });
});

describe('mergeSupplierRecords', () => {
  it('interleaves the two tables into one date-desc stream', () => {
    const contracts = [contract('1', '2026-01-01'), contract('2', '2024-01-01')];
    const das = [da('9', '2025-01-01'), da('8', '2023-01-01')];
    expect(ids(mergeSupplierRecords(contracts, das, 10).page)).toEqual(['c1', 'd9', 'c2', 'd8']);
  });

  it('slices to `first` and reports that more remain', () => {
    const merged = mergeSupplierRecords([contract('1', '2026-01-01')], [da('9', '2025-01-01')], 1);
    expect(ids(merged.page)).toEqual(['c1']);
    expect(merged.hasNextPage).toBe(true);
  });

  it('reports no next page when the merge fits', () => {
    const merged = mergeSupplierRecords([contract('1', '2026-01-01')], [], 5);
    expect(merged.hasNextPage).toBe(false);
  });

  it('null-dated rows sort to the very end', () => {
    const merged = mergeSupplierRecords([contract('1', null)], [da('9', '2020-01-01')], 10);
    expect(ids(merged.page)).toEqual(['d9', 'c1']);
  });
});

describe('cursor round-trip', () => {
  it('encodes and decodes (date, grain, id)', () => {
    const cursor = { date: '2024-05-01', grain: 'direct_acquisition' as const, id: '197920952' };
    expect(decodeRecordCursor(encodeRecordCursor(cursor))._unsafeUnwrap()).toEqual(cursor);
  });

  it('round-trips a null date', () => {
    const cursor = { date: null, grain: 'procurement_contract' as const, id: '42' };
    expect(decodeRecordCursor(encodeRecordCursor(cursor))._unsafeUnwrap()).toEqual(cursor);
  });

  it('the SAME id on the two grains yields DIFFERENT cursors', () => {
    const a = encodeRecordCursor({ date: '2024-01-01', grain: 'procurement_contract', id: '7' });
    const b = encodeRecordCursor({ date: '2024-01-01', grain: 'direct_acquisition', id: '7' });
    expect(a).not.toBe(b);
  });

  it('rejects a malformed cursor rather than paging from a guess', () => {
    expect(decodeRecordCursor('not-base64!!').isErr()).toBe(true);
    expect(decodeRecordCursor(Buffer.from('2024-01-01|c', 'utf8').toString('base64url')).isErr()).toBe(true);
    expect(decodeRecordCursor(Buffer.from('2024-01-01|x|7', 'utf8').toString('base64url')).isErr()).toBe(true);
    expect(decodeRecordCursor(Buffer.from('2024-01-01|c|abc', 'utf8').toString('base64url')).isErr()).toBe(true);
    expect(decodeRecordCursor(Buffer.from('01-01-2024|c|7', 'utf8').toString('base64url')).isErr()).toBe(true);
  });

  it('cursorOf reads the grain’s own date + pk column', () => {
    expect(cursorOf(contract('5', '2024-01-01'))).toEqual({
      date: '2024-01-01',
      grain: 'procurement_contract',
      id: '5',
    });
    expect(cursorOf(da('6', '2023-02-02'))).toEqual({
      date: '2023-02-02',
      grain: 'direct_acquisition',
      id: '6',
    });
  });
});
