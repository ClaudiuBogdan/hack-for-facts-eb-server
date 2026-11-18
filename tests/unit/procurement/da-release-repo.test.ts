/**
 * Direct acquisitions release 1 — the repository's compiled SQL over a
 * capturing driver: a disabled repo runs nothing; each request is ONE
 * read-only, repeatable-read transaction in which every statement runs; only
 * `procurement_v3` tables and served columns are named; parties join on
 * (source_name, party_kind, portal_party_id); D6 shapes the supplier filter
 * and the supplier buckets; pending columns are referenced only once present;
 * driver faults map to typed errors.
 */
import { describe, expect, it } from 'vitest';

import { makeDaReleaseRepo } from '@/modules/procurement/shell/repo/da-release-repo.js';

import { makeCapturingDb, type CapturedQuery } from '../../fixtures/capturing-db.js';

import type { DaReleaseReader } from '@/modules/procurement/core/da-release-ports.js';

const ID = 'a'.repeat(64);
const PAGE = { page: 1, pageSize: 20 };

const run = async (
  read: (reader: DaReleaseReader) => Promise<unknown>,
  probe: { supplier_privacy: boolean; listed_now: boolean; superseded_at?: boolean } = {
    supplier_privacy: true,
    listed_now: true,
    superseded_at: true,
  },
  respond?: (text: string) => readonly unknown[]
) => {
  const captured: CapturedQuery[] = [];
  const transactions: unknown[] = [];
  const db = makeCapturingDb(captured, {
    respond: (text) => {
      if (text.includes('is not null as present')) return [{ present: probe.supplier_privacy }];
      if (text.includes('from pg_attribute')) {
        const present: [string, string, boolean | undefined][] = [
          ['da_purchases', 'listed_now', probe.listed_now],
          ['da_items', 'superseded_at', probe.superseded_at],
        ];
        return present
          .filter(([, , on]) => on === true)
          .map(([table, column]) => ({ table_name: table, column_name: column }));
      }
      if (respond !== undefined) return respond(text);
      if (text.includes('as total')) return [{ total: '0' }];
      if (text.includes('as counted_count'))
        return [
          {
            counted_value: null,
            counted_count: '0',
            symbolic_price_count: '0',
            purchase_count: '0',
          },
        ];
      return [];
    },
    onBeginTransaction: (settings) => transactions.push(settings.isolationLevel),
  });
  const repo = makeDaReleaseRepo(db, true);
  const result = await repo.snapshot(async (reader) => {
    await read(reader);
    return (await reader.dataAsOf()).map(() => null);
  });
  return { captured, transactions, result, sql: captured.map((query) => query.sql).join('\n') };
};

const READS: [string, (reader: DaReleaseReader) => Promise<unknown>][] = [
  [
    'listPurchases',
    (r) =>
      r.listPurchases({
        sort: 'finalizationDesc',
        filter: {
          supplierFiscalCode: '14399840',
          buyerFiscalCode: '4305857',
          cpvDivision: '44',
          finalizationFrom: '2025-01-01',
          finalizationTo: '2025-12-31',
          outcomes: ['accepted'],
          counted: true,
          code: 'DA1',
          nativeId: '1',
        },
        ...PAGE,
      }),
  ],
  ['purchaseById', (r) => r.purchaseById(ID)],
  ['itemsOf', (r) => r.itemsOf(ID)],
  ['totals by supplier', (r) => r.totals({ filter: {}, groupBy: 'supplier', ...PAGE })],
  ['totals by buyer', (r) => r.totals({ filter: {}, groupBy: 'buyer', ...PAGE })],
  ['totals by month', (r) => r.totals({ filter: {}, groupBy: 'month', ...PAGE })],
];

/** Columns the contract keeps unserved, and party contact data. */
const UNSERVED = [
  'estimate_reported',
  'list_estimate_reported',
  'vat_basis',
  'measure_state',
  'cond_',
  'list_key',
  'detail_key',
  'source_key',
  'raw_item_ref',
  'value_under_review',
  'value_review_state',
  'value_review_flag',
  'value_review_description',
  'estimated_price',
  'address',
  'phone',
  'email',
  'contact',
];

describe('snapshot', () => {
  it('a disabled repo refuses without a query', async () => {
    const captured: CapturedQuery[] = [];
    const repo = makeDaReleaseRepo(makeCapturingDb(captured), false);
    const result = await repo.snapshot(() => Promise.reject(new Error('must not run')));
    expect(result._unsafeUnwrapErr().type).toBe('ServiceUnavailable');
    expect(captured).toHaveLength(0);
  });

  it.each(READS)(
    '%s runs inside one read-only repeatable-read transaction',
    async (_name, read) => {
      const { captured, transactions, result } = await run(read);
      expect(result.isOk()).toBe(true);
      expect(transactions).toEqual(['repeatable read']);
      expect(captured[0]?.sql).toBe('set transaction read only');
      expect(captured[1]?.sql).toMatch(/^set local statement_timeout = \d+$/u);
    }
  );

  it.each(READS)('%s names only procurement_v3 tables and served columns', async (_name, read) => {
    const { sql } = await run(read);
    const tables = [...sql.matchAll(/(?:from|join)\s+"?([a-z_0-9]+)"?\."?([a-z_0-9]+)"?/gu)].map(
      (match) => `${match[1] ?? ''}.${match[2] ?? ''}`
    );
    expect(tables.length).toBeGreaterThan(0);
    for (const name of tables) expect(name.startsWith('procurement_v3.')).toBe(true);
    for (const column of UNSERVED) expect(sql).not.toContain(column);
  });
});

describe('joins and D6', () => {
  it('joins parties on source, kind and portal party id', async () => {
    const { sql } = await run((r) => r.purchaseById(ID));
    expect(sql).toContain(`b.source_name = p.source_name and b.party_kind = 'buyer'`);
    expect(sql).toContain('b.portal_party_id = p.buyer_party_id');
    expect(sql).toContain(`s.source_name = p.source_name and s.party_kind = 'supplier'`);
    expect(sql).toContain('s.portal_party_id = p.supplier_party_id');
  });

  it('a supplier filter only matches suppliers public in supplier_privacy', async () => {
    const { sql } = await run((r) =>
      r.listPurchases({
        sort: 'finalizationDesc',
        filter: { supplierFiscalCode: '14399840' },
        ...PAGE,
      })
    );
    expect(sql).toContain(
      'left join "procurement_v3"."supplier_privacy" sv on sv.fiscal_code_clean = s.fiscal_code_clean'
    );
    expect(sql).toMatch(
      /s\.fiscal_code_clean = \$\d+ and \(sv\.public is true and s\.fiscal_code_status = 'valid' and s\.fiscal_code_clean is not null\)/u
    );
  });

  it('withholds every supplier, and names no pending column, before supplier_privacy and the columns exist', async () => {
    const { captured } = await run(
      async (r) => {
        await r.listPurchases({
          sort: 'finalizationDesc',
          filter: { supplierFiscalCode: '14399840' },
          ...PAGE,
        });
        await r.totals({ filter: {}, groupBy: 'supplier', ...PAGE });
      },
      { supplier_privacy: false, listed_now: false }
    );
    // The catalog probes name the objects; no data statement may.
    const sql = captured
      .map((query) => query.sql)
      .filter((text) => !text.includes('from pg_attribute') && !text.includes('to_regclass'))
      .join('\n');
    expect(sql).not.toContain('supplier_privacy');
    expect(sql).not.toMatch(/"?p"?\."?listed_now/u);
    // The supplier filter and every named bucket are constant false.
    expect(sql).toMatch(/s\.fiscal_code_clean = \$\d+ and false/u);
    expect(sql).toContain(`case when false then`);
  });

  it('buckets withheld suppliers together and selects their columns only when named', async () => {
    const { sql } = await run((r) => r.totals({ filter: {}, groupBy: 'supplier', ...PAGE }));
    expect(sql).toContain(`else 'withheld' end as g_bucket`);
    for (const column of ['portal_party_id', 'name_as_written', 'fiscal_code_clean'])
      expect(sql).toMatch(
        new RegExp(`case when \\(sv\\.public is true[^)]*\\) then "s"\\."${column}" end`, 'u')
      );
  });

  it('a buyer filter matches valid codes only', async () => {
    const { sql } = await run((r) =>
      r.listPurchases({ sort: 'finalizationDesc', filter: { buyerFiscalCode: '4305857' }, ...PAGE })
    );
    expect(sql).toMatch(/b\.fiscal_code_clean = \$\d+ and b\.fiscal_code_status = 'valid'/u);
  });

  it('sums counted values only', async () => {
    const { sql } = await run((r) => r.totals({ filter: {}, groupBy: null, ...PAGE }));
    expect(sql).toContain('sum(p.counted_value) filter (where p.counted)');
    expect(sql).not.toContain('sum(p.reported_value');
  });
});

describe('review fixes', () => {
  it('serves only current item lines once superseded_at exists, and computes line values in SQL', async () => {
    const present = await run((r) => r.itemsOf(ID));
    expect(present.sql).toContain('and i.superseded_at is null');
    expect(present.sql).toContain('(i.quantity * i.unit_price)::text as reported_line_value');
    const absent = await run((r) => r.itemsOf(ID), {
      supplier_privacy: true,
      listed_now: true,
      superseded_at: false,
    });
    expect(absent.sql).not.toContain('superseded_at is null');
  });

  it('never selects free text before its public flag exists, and gates it per row after', async () => {
    const before = await run((r) => r.purchaseById(ID).then(() => r.itemsOf(ID)));
    expect(before.sql).toContain('null::text as "title"');
    expect(before.sql).toContain('null::text as "description"');
    expect(before.sql).toContain('null::text as "name"');
    expect(before.sql).not.toMatch(/"?p"?\."?title"?[ ,]/u);
    expect(before.sql).not.toMatch(/"?p"?\."?description"?[ ,]/u);
    expect(before.sql).not.toMatch(/"?i"?\."?name"?[ ,]/u);
  });

  it('formats timestamps with microseconds', async () => {
    const { sql } = await run((r) => r.purchaseById(ID));
    expect(sql).toContain(`'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'`);
    expect(sql).not.toContain(`HH24:MI:SS"Z"`);
  });

  it('clamps the last page of a list to row 10000', async () => {
    const { captured } = await run((r) =>
      r.listPurchases({ sort: 'finalizationDesc', filter: {}, page: 334, pageSize: 30 })
    );
    const list = captured.find((query) => query.sql.includes('order by p.finalization_day'));
    // offset 9990, so at most 10 rows.
    expect(list?.parameters).toEqual(expect.arrayContaining([10, 9990]));
  });

  it.each([
    ['finalizationDesc', 'order by p.finalization_day desc nulls last, p.purchase_id desc'],
    ['finalizationAsc', 'order by p.finalization_day asc nulls last, p.purchase_id asc'],
    ['countedValueDesc', 'order by p.counted_value desc nulls last, p.purchase_id desc'],
  ] as const)('orders a list %s with purchase_id breaking ties', async (sort, order) => {
    const { sql } = await run((r) => r.listPurchases({ sort, filter: {}, ...PAGE }));
    expect(sql).toContain(order);
  });

  it('orders tied supplier buckets by their bucket label', async () => {
    const { sql } = await run((r) => r.totals({ filter: {}, groupBy: 'supplier', ...PAGE }));
    expect(sql).toContain('group_key asc nulls last, g_bucket asc nulls last');
  });
});

describe('results and faults', () => {
  it('reads groups and party columns from one grouped statement', async () => {
    let groups: unknown;
    await run(
      async (r) => {
        groups = (await r.totals({ filter: {}, groupBy: 'supplier', ...PAGE }))._unsafeUnwrap()
          .groups;
      },
      undefined,
      (text) =>
        text.includes('group_count')
          ? [
              {
                group_key: null,
                g_bucket: 'withheld',
                g_portal_party_id: null,
                g_name_as_written: null,
                g_fiscal_code_clean: null,
                g_fiscal_code_status: null,
                g_supplier_public: false,
                counted_value: '10.00',
                counted_count: '1',
                symbolic_price_count: '0',
                purchase_count: '2',
                group_count: '2',
              },
              {
                group_key: 'elicitatie_api_pub:900',
                g_bucket: 'named',
                g_portal_party_id: '900',
                g_name_as_written: 'FIRMA SRL',
                g_fiscal_code_clean: '14399840',
                g_fiscal_code_status: 'valid',
                g_supplier_public: true,
                counted_value: '5.00',
                counted_count: '1',
                symbolic_price_count: '0',
                purchase_count: '1',
                group_count: '2',
              },
            ]
          : [
              {
                counted_value: '15.00',
                counted_count: '2',
                symbolic_price_count: '0',
                purchase_count: '3',
              },
            ]
    );
    expect(groups).toEqual([
      expect.objectContaining({ supplierBucket: 'withheld', party: null }),
      expect.objectContaining({
        supplierBucket: 'named',
        party: expect.objectContaining({ portalPartyId: '900' }),
      }),
    ]);
  });

  /** Fails the purchase read only; the transaction's own statements succeed. */
  const fault = (code: string) => (text: string) => {
    if (text.includes('p.purchase_id =')) throw Object.assign(new Error('driver'), { code });
    return [];
  };
  it.each([
    ['42P01', 'ServiceUnavailable'],
    ['3F000', 'ServiceUnavailable'],
    ['57014', 'Timeout'],
    ['XX000', 'Database'],
  ])('maps driver code %s to %s', async (code, type) => {
    let read: unknown;
    await run(
      async (r) => {
        read = (await r.purchaseById(ID))._unsafeUnwrapErr().type;
      },
      undefined,
      fault(code)
    );
    expect(read).toBe(type);
  });
});
