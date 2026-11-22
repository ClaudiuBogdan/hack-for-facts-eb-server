/**
 * Direct acquisitions release 1 — the repository's compiled SQL over a
 * capturing driver: a disabled repo runs nothing; each request is ONE
 * read-only, repeatable-read transaction in which every statement runs; only
 * `procurement_v3` tables and served columns are named; parties come from
 * `da_parties_public` and join on (source_name, party_kind, portal_party_id);
 * D6 shapes the supplier filter and the supplier buckets; named suppliers'
 * names come from `party_public_names` by code; free text is read only from
 * the `*_shown` columns once present; driver faults map to typed errors.
 */
import { describe, expect, it } from 'vitest';

import { makeDaReleaseRepo } from '@/modules/procurement/shell/repo/da-release-repo.js';

import { makeCapturingDb, type CapturedQuery } from '../../fixtures/capturing-db.js';

import type { DaReleaseReader } from '@/modules/procurement/core/da-release-ports.js';

const ID = 'a'.repeat(64);
const PAGE = { page: 1, pageSize: 20 };

const run = async (
  read: (reader: DaReleaseReader) => Promise<unknown>,
  probe: {
    supplier_disclosure: boolean;
    listed_now: boolean;
    superseded_at?: boolean;
    /** The *_shown text columns and their flags (title, item name, item unit). */
    shown?: boolean;
  } = {
    supplier_disclosure: true,
    listed_now: true,
    superseded_at: true,
  },
  respond?: (text: string) => readonly unknown[]
) => {
  const captured: CapturedQuery[] = [];
  const transactions: unknown[] = [];
  const db = makeCapturingDb(captured, {
    respond: (text) => {
      if (text.includes('has_table_privilege')) return [{ present: probe.supplier_disclosure }];
      if (text.includes('from pg_attribute')) {
        const present: [string, string, boolean | undefined][] = [
          ['da_purchases', 'listed_now', probe.listed_now],
          ['da_items', 'superseded_at', probe.superseded_at],
          ['da_purchases', 'title_shown', probe.shown],
          ['da_purchases', 'title_public', probe.shown],
          ['da_items', 'item_name_shown', probe.shown],
          ['da_items', 'item_name_public', probe.shown],
          ['da_items', 'item_unit_shown', probe.shown],
          ['da_items', 'item_unit_public', probe.shown],
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
    // Only the public views: never the party table or the classification table.
    expect(sql).not.toContain('"da_parties"');
    expect(sql).not.toContain('supplier_privacy');
  });
});

describe('joins and D6', () => {
  /** A fenced lateral probe of the public party view for one purchase's buyer or supplier. */
  const lateralProbe = (alias: string, kind: string, column: string) =>
    new RegExp(
      `left join lateral \\(\\s+select x\\.source_name, x\\.portal_party_id, x\\.name_as_written, x\\.fiscal_code_clean, x\\.fiscal_code_status\\s+from "procurement_v3"\\."da_parties_public" x\\s+where x\\.source_name = p\\.source_name and x\\.party_kind = '${kind}'\\s+and x\\.portal_party_id = p\\.${column}\\s+offset 0\\) "${alias}" on true`,
      'u'
    );

  it("probes each purchase's parties through fenced lateral subqueries on point reads", async () => {
    for (const read of [
      (r: DaReleaseReader) => r.purchaseById(ID),
      (r: DaReleaseReader) => r.listPurchases({ sort: 'finalizationDesc', filter: {}, ...PAGE }),
    ]) {
      const { sql } = await run(read);
      expect(sql).toMatch(lateralProbe('b', 'buyer', 'buyer_party_id'));
      expect(sql).toMatch(lateralProbe('s', 'supplier', 'supplier_party_id'));
      expect(sql).not.toMatch(/left join "procurement_v3"\."da_parties_public" [bs]\b/u);
    }
  });

  it('joins parties plainly for whole-table totals', async () => {
    const { sql } = await run((r) => r.totals({ filter: {}, groupBy: 'supplier', ...PAGE }));
    expect(sql).toContain(`left join "procurement_v3"."da_parties_public" b
    on b.source_name = p.source_name and b.party_kind = 'buyer'
   and b.portal_party_id = p.buyer_party_id`);
    expect(sql).toContain(`left join "procurement_v3"."da_parties_public" s
    on s.source_name = p.source_name and s.party_kind = 'supplier'
   and s.portal_party_id = p.supplier_party_id`);
    expect(sql).not.toContain('left join lateral');
  });

  it('counts a list without a party join, supplier filter included', async () => {
    /** The capped count statement's inner select. */
    const count = (sql: string): string =>
      /select count\(\*\)::text as total from \(([\s\S]*?)\) as capped/u.exec(sql)?.[1] ?? '';
    const plain = await run((r) =>
      r.listPurchases({ sort: 'finalizationDesc', filter: { cpvDivision: '44' }, ...PAGE })
    );
    expect(count(plain.sql)).toContain('from "procurement_v3"."da_purchases" p');
    expect(count(plain.sql)).not.toContain('da_parties_public');
    const bySupplier = await run((r) =>
      r.listPurchases({
        sort: 'finalizationDesc',
        filter: { supplierFiscalCode: '14399840' },
        ...PAGE,
      })
    );
    // The supplier filter goes by party ids: still no party row in the count.
    expect(count(bySupplier.sql)).toContain('pp.party_kind');
    expect(count(bySupplier.sql)).not.toContain('left join');
  });

  it('a supplier filter only matches suppliers with a public party row', async () => {
    const { sql } = await run((r) =>
      r.listPurchases({
        sort: 'finalizationDesc',
        filter: { supplierFiscalCode: '14399840' },
        ...PAGE,
      })
    );
    expect(sql).toMatch(lateralProbe('s', 'supplier', 'supplier_party_id'));
    expect(sql).not.toContain(' sv ');
    // The public view holds a supplier row only when D6 names it: the party-id match is the test,
    // with no per-row probe of `s` in the filter.
    expect(sql).toMatch(
      /where true and \(p\.source_name, p\.supplier_party_id\) in \(select pp\.source_name, pp\.portal_party_id from "procurement_v3"\."da_parties_public" pp\s+where pp\.party_kind = \$\d+ and pp\.fiscal_code_status = 'valid' and pp\.fiscal_code_clean = \$\d+\)\s+order by/u
    );
  });

  it("reads a withheld supplier as a party by the purchase's own id, never from a party row", async () => {
    const { sql } = await run((r) => r.purchaseById(ID));
    expect(sql).toContain('p.supplier_party_id as "s_portal_party_id"');
    expect(sql).toContain('b.portal_party_id as "b_portal_party_id"');
    expect(sql).not.toContain('"s"."portal_party_id" as');
  });

  it('withholds every supplier, and names no pending column, while supplier_disclosure is unreadable and before the columns exist', async () => {
    const { captured } = await run(
      async (r) => {
        await r.listPurchases({
          sort: 'finalizationDesc',
          filter: { supplierFiscalCode: '14399840' },
          ...PAGE,
        });
        await r.totals({ filter: {}, groupBy: 'supplier', ...PAGE });
      },
      { supplier_disclosure: false, listed_now: false }
    );
    // The catalog probes name the objects; no data statement may.
    const sql = captured
      .map((query) => query.sql)
      .filter((text) => !text.includes('from pg_attribute') && !text.includes('to_regclass'))
      .join('\n');
    expect(sql).not.toContain('supplier_privacy');
    expect(sql).not.toContain('supplier_disclosure');
    expect(sql).not.toMatch(/"?p"?\."?listed_now/u);
    // The supplier filter and every named bucket are constant false.
    expect(sql).toMatch(/where true and false\s+order by/u);
    expect(sql).not.toContain('pp.party_kind');
    expect(sql).toContain(`case when false then`);
  });

  it('buckets withheld suppliers together and selects their columns only when named', async () => {
    const { sql } = await run((r) => r.totals({ filter: {}, groupBy: 'supplier', ...PAGE }));
    expect(sql).toContain(`else 'withheld' end as g_bucket`);
    // "No supplier" is the purchase's own null id: a withheld supplier has no public row.
    expect(sql).toContain(`case when p.supplier_party_id is null then 'none'`);
    for (const column of ['portal_party_id', 'name_as_written', 'fiscal_code_clean'])
      expect(sql).toMatch(
        new RegExp(
          `case when \\(s\\.portal_party_id is not null[^)]*\\) then "s"\\."${column}" end`,
          'u'
        )
      );
  });

  it('a buyer filter matches valid codes only', async () => {
    const { sql } = await run((r) =>
      r.listPurchases({ sort: 'finalizationDesc', filter: { buyerFiscalCode: '4305857' }, ...PAGE })
    );
    // The buyer's purchases by party id (a valid code only), not by the joined party row.
    expect(sql).toMatch(
      /\(p\.source_name, p\.buyer_party_id\) in \(select pp\.source_name, pp\.portal_party_id from "procurement_v3"\."da_parties_public" pp\s+where pp\.party_kind = \$\d+ and pp\.fiscal_code_status = 'valid' and pp\.fiscal_code_clean = \$\d+\)/u
    );
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
      supplier_disclosure: true,
      listed_now: true,
      superseded_at: false,
    });
    expect(absent.sql).not.toContain('superseded_at is null');
  });

  /** Raw free text the grant does not cover: never named in any statement. */
  const RAW_TEXT = [
    /"?p"?\."?title"?[ ,]/u,
    /"?p"?\."?description/u,
    /"?i"?\."?name"?[ ,]/u,
    /"?i"?\."?unit"?[ ,]/u,
  ];

  it('never selects free text before its shown column and flag exist', async () => {
    const before = await run((r) => r.purchaseById(ID).then(() => r.itemsOf(ID)));
    expect(before.sql).toContain('null::text as "title"');
    expect(before.sql).toContain('null::text as description, false as description_public');
    expect(before.sql).toContain('null::text as "name"');
    expect(before.sql).toContain('null::text as "unit"');
    for (const raw of RAW_TEXT) expect(before.sql).not.toMatch(raw);
    expect(before.sql).not.toContain('_shown');
  });

  it('serves only the shown text, gated per row, once present; never a description', async () => {
    const after = await run((r) => r.purchaseById(ID).then(() => r.itemsOf(ID)), {
      supplier_disclosure: true,
      listed_now: true,
      superseded_at: true,
      shown: true,
    });
    expect(after.sql).toContain(
      'case when "p"."title_public" is true then "p"."title_shown" end as "title"'
    );
    expect(after.sql).toContain(
      'case when "i"."item_name_public" is true then "i"."item_name_shown" end as "name"'
    );
    expect(after.sql).toContain(
      'case when "i"."item_unit_public" is true then "i"."item_unit_shown" end as "unit"'
    );
    expect(after.sql).toContain('null::text as description, false as description_public');
    for (const raw of RAW_TEXT) expect(after.sql).not.toMatch(raw);
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
        text.includes('party_public_names')
          ? [{ code: '14399840', name: 'FIRMA REGISTRY SRL' }]
          : text.includes('group_count')
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
                  // The view carries no supplier name; the registry name replaces it.
                  g_name_as_written: null,
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
        party: expect.objectContaining({ portalPartyId: '900', name: 'FIRMA REGISTRY SRL' }),
      }),
    ]);
  });

  it('names a named supplier by code from party_public_names, after the page, and only then', async () => {
    const supplierRow = (code: string | null, named: boolean) => ({
      purchase_id: ID,
      outcome: 'accepted',
      counted: true,
      value_corrected: false,
      symbolic_price: false,
      title_public: false,
      description_public: false,
      s_portal_party_id: '900',
      s_name_as_written: null,
      s_fiscal_code_clean: code,
      s_fiscal_code_status: code === null ? null : 'valid',
      s_supplier_public: named,
    });
    let served: unknown;
    const named = await run(
      async (r) => {
        served = (await r.listPurchases({ sort: 'finalizationDesc', filter: {}, ...PAGE }))
          ._unsafeUnwrap()
          .rows.map((row) => row.supplier?.name);
      },
      undefined,
      (text) =>
        text.includes('party_public_names')
          ? [{ code: '14399840', name: 'FIRMA REGISTRY SRL' }]
          : text.includes('as total')
            ? [{ total: '1' }]
            : text.includes('order by p.finalization_day')
              ? [supplierRow('14399840', true)]
              : []
    );
    expect(named.result.isOk()).toBe(true);
    expect(served).toEqual(['FIRMA REGISTRY SRL']);
    const lookup = named.captured.find((query) => query.sql.includes('party_public_names'));
    expect(lookup?.sql).toContain(
      'where n.fiscal_code_clean = any($1::text[]) and n.supplier_name_public is true'
    );
    expect(lookup?.parameters).toEqual([['14399840']]);

    // A withheld supplier is never looked up.
    const withheld = await run(
      async (r) => {
        await r.listPurchases({ sort: 'finalizationDesc', filter: {}, ...PAGE });
      },
      undefined,
      (text) =>
        text.includes('as total')
          ? [{ total: '1' }]
          : text.includes('order by p.finalization_day')
            ? [supplierRow(null, false)]
            : []
    );
    expect(withheld.sql).not.toContain('party_public_names');
  });

  /** Fails the purchase read only; the transaction's own statements succeed. */
  const fault = (code: string) => (text: string) => {
    if (text.includes('p.purchase_id =')) throw Object.assign(new Error('driver'), { code });
    return [];
  };
  it.each([
    ['42P01', 'ServiceUnavailable'],
    ['3F000', 'ServiceUnavailable'],
    ['42501', 'ServiceUnavailable'],
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

describe('settled snapshots (the after-read rule)', () => {
  const P1 = '2026-11-18T03:10:00.000000Z';
  const P2 = '2026-11-19T03:10:00.000000Z';
  /** One read; `after` changes the world once the read is done (a publish, a revoked grant). */
  const settledRead = async (
    world: { asOf: string; privacy: boolean },
    after: (world: { asOf: string; privacy: boolean }) => void,
    settle: boolean
  ) => {
    const db = makeCapturingDb([], {
      respond: (text) => {
        if (text.includes('as privacy')) return [{ as_of: world.asOf, privacy: world.privacy }];
        if (text.includes('has_table_privilege')) return [{ present: world.privacy }];
        if (text.includes('as data_as_of')) return [{ data_as_of: world.asOf }];
        if (text.includes('as as_of')) return [{ as_of: world.asOf }];
        return [];
      },
    });
    return makeDaReleaseRepo(db, true).snapshot(
      async (reader) => {
        const asOf = await reader.dataAsOf();
        after(world);
        return asOf;
      },
      { settle }
    );
  };
  /** The retryable answer: ServiceUnavailable (503 / SERVICE_UNAVAILABLE), "repeat the request". */
  const republished = (result: {
    isErr: () => boolean;
    _unsafeUnwrapErr: () => { type: string; message: string };
  }) =>
    result.isErr() &&
    result._unsafeUnwrapErr().type === 'ServiceUnavailable' &&
    result._unsafeUnwrapErr().message.includes('republished');

  it('answers when nothing moved', async () => {
    const read = await settledRead({ asOf: P1, privacy: true }, () => undefined, true);
    expect(read._unsafeUnwrap()).toBe(P1);
  });

  it('refuses (retryable) a read a publish overtook', async () => {
    const read = await settledRead({ asOf: P1, privacy: true }, (w) => (w.asOf = P2), true);
    expect(republished(read)).toBe(true);
  });

  it('refuses a read that could name suppliers once the grant is revoked', async () => {
    const read = await settledRead({ asOf: P1, privacy: true }, (w) => (w.privacy = false), true);
    expect(republished(read)).toBe(true);
  });

  it('answers a read made with supplier_disclosure unreadable (everyone withheld)', async () => {
    const read = await settledRead({ asOf: P1, privacy: false }, () => undefined, true);
    expect(read._unsafeUnwrap()).toBe(P1);
  });

  it('does not settle an unsettled snapshot (the status)', async () => {
    const read = await settledRead({ asOf: P1, privacy: true }, (w) => (w.asOf = P2), false);
    expect(read._unsafeUnwrap()).toBe(P1);
  });
});
