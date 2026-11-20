/**
 * Totals v2 reader: the WHERE carries every non-status filter, escaped, with
 * undated rows admitted under a date range; the aggregate rows map to exact
 * BigInt sums; tables are the build's own; labels are cached per build.
 */
import { err, ok } from 'neverthrow';
import { describe, expect, it } from 'vitest';

import {
  makeClickhouseMoneyRepo,
  moneyWhere,
} from '@/modules/procurement/shell/repo/clickhouse-money-repo.js';

import type { AggregateFilters } from '@/modules/procurement/core/money-totals.js';
import type { ClickhouseReader } from '@/modules/procurement/shell/repo/clickhouse-reader.js';
import type { ProdDatabase } from '@/modules/shared/index.js';
import type { Kysely } from 'kysely';

const filters = (over: Partial<AggregateFilters> = {}): AggregateFilters => ({
  procurementKinds: ['contract_award'],
  contractKinds: null,
  from: null,
  to: null,
  buyerCode: null,
  supplierCode: null,
  cpvPrefix: null,
  countyCode: null,
  siruta: null,
  vatBases: null,
  q: null,
  ...over,
});

describe('moneyWhere', () => {
  it('admits undated rows under a date range, and escapes every literal', () => {
    const where = moneyWhere(
      filters({ from: '2025-01-01', to: '2025-12-31', q: "drum 'DJ' \\x", buyerCode: '4305857' }),
      'ref-1',
      ['awarded']
    );
    expect(where).toContain("procurement_kind IN ('contract_award')");
    expect(where).toContain("value_kind IN ('awarded')");
    expect(where).toContain(
      "(award_day IS NULL OR (award_day >= toDate('2025-01-01') AND award_day <= toDate('2025-12-31')))"
    );
    expect(where).toContain("has(supplier_refs, 'ref-1')");
    expect(where).toContain("buyer_code = '4305857'");
    expect(where).toContain(
      "positionCaseInsensitiveUTF8(ifNull(title_shown, ''), 'drum \\'DJ\\' \\\\x') > 0"
    );
  });

  it('leaves out every filter that was not asked', () => {
    expect(moneyWhere(filters(), null, ['awarded'])).toBe(
      "procurement_kind IN ('contract_award') AND value_kind IN ('awarded')"
    );
  });
});

describe('makeClickhouseMoneyRepo', () => {
  const reader = (rows: Record<string, unknown>[]) => {
    const sqls: string[] = [];
    const r: ClickhouseReader = {
      query: (sql) => {
        sqls.push(sql);
        return Promise.resolve(ok(rows as never));
      },
    };
    return { r, sqls };
  };
  const db = {} as Kysely<ProdDatabase>;

  it('reads the build’s own tables and maps exact sums', async () => {
    const { r, sqls } = reader([
      {
        value_kind: 'awarded',
        status: 'awarded',
        additive: '1',
        dated: '0',
        has_amount: '1',
        joint_win: '0',
        vat_basis: 'unknown',
        currency: 'RON',
        unverified_head: '1',
        list_value: '0',
        withheld_supplier: '0',
        n: '3',
        sum_bani: '922337203685477580700',
        native_minor: '15',
      },
    ]);
    const repo = makeClickhouseMoneyRepo({ db, reader: r });
    const rows = (await repo.aggregate('17', filters(), null, ['awarded']))._unsafeUnwrap();
    expect(sqls[0]).toContain('FROM money_facts_b17');
    expect(rows[0]).toMatchObject({
      dated: false,
      inRange: false,
      unverifiedHead: true,
      count: 3n,
      sumBani: 922337203685477580700n,
    });
  });

  it('reads labels with every batch and only public supplier refs', async () => {
    const { r, sqls } = reader([]);
    const repo = makeClickhouseMoneyRepo({ db, reader: r });
    await repo.labels('17');
    await repo.labels('17');
    await repo.supplierRef('17', '123');
    // No cache: a label table that is gone answers ServiceUnavailable next time.
    expect(sqls.filter((s) => s.includes('money_labels_b17'))).toHaveLength(2);
    expect(sqls.at(-1)).toContain(
      "FROM money_suppliers_b17 WHERE supplier_cui = '123' AND toString(supplier_ref) != '0'"
    );
  });

  it('a missing build table answers ServiceUnavailable, never a guessed total', async () => {
    const r: ClickhouseReader = {
      query: () =>
        Promise.resolve(
          err({ type: 'Database', message: 'clickhouse HTTP 404 (code 60)' } as never)
        ),
    };
    const repo = makeClickhouseMoneyRepo({ db, reader: r });
    expect(
      (await repo.aggregate('17', filters(), null, ['awarded']))._unsafeUnwrapErr()
    ).toMatchObject({
      type: 'ServiceUnavailable',
    });
    expect((await repo.labels('17'))._unsafeUnwrapErr()).toMatchObject({
      type: 'ServiceUnavailable',
    });
  });

  it('an absent pointer table is "not published"; other database failures are failures', async () => {
    const failing = (error: unknown) =>
      ({
        getExecutor: () => {
          throw error;
        },
      }) as unknown as Kysely<ProdDatabase>;
    const absent = Object.assign(
      new Error('relation "procurement_v3.money_generations" does not exist'),
      {
        code: '42P01',
      }
    );
    const denied = Object.assign(new Error('permission denied for table money_generations'), {
      code: '42501',
    });
    const { r } = reader([]);
    expect(
      (
        await makeClickhouseMoneyRepo({ db: failing(absent), reader: r }).activeBuild()
      )._unsafeUnwrap()
    ).toBeNull();
    expect(
      (
        await makeClickhouseMoneyRepo({ db: failing(denied), reader: r }).activeBuild()
      )._unsafeUnwrapErr()
    ).toMatchObject({ type: 'Database' });
  });
});
