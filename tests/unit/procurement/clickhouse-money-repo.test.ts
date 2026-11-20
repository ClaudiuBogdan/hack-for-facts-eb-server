/**
 * Totals v2 reader: the WHERE carries every non-status filter, escaped, with
 * undated rows admitted under a date range; the aggregate rows map to exact
 * BigInt sums; tables are the build's own; labels are cached per build.
 */
import { ok } from 'neverthrow';
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

  it('caches labels per build and reads only public supplier refs', async () => {
    const { r, sqls } = reader([]);
    const repo = makeClickhouseMoneyRepo({ db, reader: r });
    await repo.labels('17');
    await repo.labels('17');
    await repo.supplierRef('17', '123');
    expect(sqls.filter((s) => s.includes('money_labels_b17'))).toHaveLength(1);
    expect(sqls.at(-1)).toContain(
      "FROM money_suppliers_b17 WHERE supplier_cui = '123' AND supplier_ref != '0'"
    );
  });
});
