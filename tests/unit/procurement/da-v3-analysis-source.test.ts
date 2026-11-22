/**
 * The procurement_v3 direct-acquisition analysis source's compiled SQL over a
 * capturing driver: one read-only repeatable-read snapshot per read that
 * refuses a moved publication; D6 keys withheld suppliers as one
 * `natural_person` key and fails closed without supplier_disclosure; parties
 * come from da_parties_public and supplier names from party_public_names by
 * code; a supplier scope matches only public suppliers; free text is never
 * selected; buyer
 * geography joins only when asked; refused scope fields run no query.
 */
import { describe, expect, it } from 'vitest';

import { makeDaV3AnalysisSource } from '@/modules/procurement/shell/repo/da-v3-analysis-source.js';

import { makeCapturingDb, type CapturedQuery } from '../../fixtures/capturing-db.js';

import type { AnalysisScope } from '@/modules/procurement/core/analysis-scope.js';
import type { ActiveGeneration } from '@/modules/procurement/core/ports.js';

const BUILD = '1763435400123456';
const GEN = { buildId: BUILD } as unknown as ActiveGeneration;
const ROUTE = { grain: 'direct_acquisition' } as const;

const run = async (
  read: (source: ReturnType<typeof makeDaV3AnalysisSource>) => Promise<unknown>,
  options: {
    privacy?: boolean;
    build?: string;
    rollups?: readonly string[];
    names?: readonly { code: string; name: string }[];
    records?: readonly Record<string, unknown>[];
  } = {}
) => {
  const captured: CapturedQuery[] = [];
  const isolation: unknown[] = [];
  const db = makeCapturingDb(captured, {
    respond: (text) => {
      if (text.includes('as build_id'))
        return [
          { build_id: options.build ?? BUILD, as_of: null, privacy: options.privacy ?? true },
        ];
      if (text.includes('from unnest')) return (options.rollups ?? []).map((name) => ({ name }));
      if (text.includes('has_table_privilege')) return [{ present: options.privacy ?? true }];
      if (text.includes('party_public_names')) return options.names ?? [];
      // The page's keyed phase answers the records; the rest phase none.
      if (text.includes('as supplier_display_kind'))
        return text.includes('and not (') ? [] : (options.records ?? []);
      if (text.includes('as total')) return [{ total: '0' }];
      if (text.includes('as rows'))
        return [
          {
            rows: '0',
            with_value: '0',
            awarded: null,
            min_month: null,
            max_month: null,
            undated_count: '0',
            undated_value: null,
          },
        ];
      if (text.includes('as cnt')) return [{ cnt: '0', wv: '0', awarded: '0.00' }];
      if (text.includes('as supplier_count'))
        return [
          {
            supplier_count: '0',
            positive: '0',
            total: '0',
            top1: '0',
            top5: '0',
            squares: '0',
            unknown: null,
          },
        ];
      return [];
    },
    onBeginTransaction: (settings) => isolation.push(settings.isolationLevel),
  });
  const result = await read(makeDaV3AnalysisSource(db));
  const data = captured
    .map((query) => query.sql)
    .filter(
      (text) =>
        !text.startsWith('set ') && !text.includes('to_regclass') && !text.includes('as build_id')
    );
  return { captured, isolation, result, sql: data.join('\n'), data };
};

const AUTHORITY: AnalysisScope = { grain: 'direct_acquisition', authorityCui: '4305857' };

describe('snapshots', () => {
  it('reads in one read-only repeatable-read transaction that first re-checks the publication', async () => {
    const { captured, isolation } = await run((s) => s.statsFor(ROUTE, AUTHORITY, GEN));
    expect(isolation).toEqual(['repeatable read']);
    expect(captured[0]?.sql).toBe('set transaction read only');
    expect(captured[2]?.sql).toBe('set local jit = off');
    expect(captured[3]?.sql).toContain('as build_id');
  });

  it('refuses a read when the publication moved since the request resolved it', async () => {
    const { result, data } = await run((s) => s.statsFor(ROUTE, AUTHORITY, GEN), {
      build: '1763500000000000',
    });
    const error = (
      result as { _unsafeUnwrapErr: () => { type: string; message: string } }
    )._unsafeUnwrapErr();
    expect(error.type).toBe('ServiceUnavailable');
    expect(error.message).toContain('republished');
    expect(data).toEqual([]);
  });
});

describe('D6', () => {
  it('keys every withheld supplier as natural_person and names only public ones', async () => {
    const { sql } = await run((s) =>
      s.breakdownFor(ROUTE, AUTHORITY, GEN, 'supplier', 10, 'value')
    );
    expect(sql).toContain(`left join "procurement_v3"."da_parties_public" s`);
    expect(sql).not.toContain('"da_parties"');
    expect(sql).not.toContain('supplier_privacy');
    expect(sql).not.toContain(' sv ');
    // A withheld supplier has no public row: "no supplier" is the purchase's own null id.
    expect(sql).toMatch(
      /case when p\.supplier_party_id is null then null\s+when \(s\.portal_party_id is not null and s\.fiscal_code_status = 'valid' and s\.fiscal_code_clean is not null\) then s\.fiscal_code_clean\s+else \$\d+ end/u
    );
  });

  it('keys rollup suppliers by supplier_disclosure, joined only after summing per supplier', async () => {
    const { data } = await run(
      (s) => s.breakdownFor(ROUTE, AUTHORITY, GEN, 'supplier', 10, 'value'),
      { rollups: ['da_rollup_authority_supplier_month'] }
    );
    const joined = data.filter((text) => text.includes('supplier_disclosure'));
    // Only the ranked groups meet the view: the totals and the unknown bucket read the rollup alone.
    expect(joined).toHaveLength(1);
    expect(data.find((text) => text.includes('as rows'))).not.toContain(' sv');
    const unknown = data.find(
      (text) => text.includes('as cnt') && text.includes('supplier_ref is null')
    );
    expect(unknown).toContain('from "procurement_v3"."da_rollup_authority_supplier_month" r');
    expect(unknown).not.toContain('supplier_disclosure');
    // PROC-C4HN: the rollup rows are summed per supplier_ref first; the view is joined to the sums.
    expect(joined[0]).toMatch(
      /from \(select null::text as bucket,\s+r\.supplier_ref,[\s\S]*from "procurement_v3"\."da_rollup_authority_supplier_month" r\s+where [\s\S]*group by 1, 2\) r\s+left join lateral \(select x\.fiscal_code_clean from "procurement_v3"\."supplier_disclosure" x\s+where x\.supplier_id = r\.supplier_ref offset 0\) sv on true/u
    );
    // The whole release's sums (a window, no bucket) take one plain join instead.
    const whole = await run(
      (s) =>
        s.breakdownFor(
          ROUTE,
          { grain: 'direct_acquisition', year: 2025 },
          GEN,
          'supplier',
          10,
          'value'
        ),
      { rollups: ['da_rollup_supplier_month'] }
    );
    const wholeJoined = whole.data.filter((text) => text.includes('supplier_disclosure'));
    expect(wholeJoined).toHaveLength(1);
    expect(wholeJoined[0]).toMatch(
      /group by 1, 2\) r\s+left join "procurement_v3"\."supplier_disclosure" sv on sv\.supplier_id = r\.supplier_ref/u
    );
    expect(wholeJoined[0]).not.toContain('lateral');
    expect(joined[0]).toContain(
      'when r.supplier_ref > 0 and sv.fiscal_code_clean is not null then sv.fiscal_code_clean'
    );
    expect(joined[0]).not.toMatch(/\bpublic is\b/u);
    expect(joined[0]).not.toContain('supplier_privacy');
  });

  it('sums concentration and distinct-supplier series per supplier before the view', async () => {
    const concentration = await run((s) => s.concentrationFor(ROUTE, AUTHORITY, GEN, 'value'), {
      rollups: ['da_rollup_authority_supplier_month'],
    });
    const g = concentration.data.find((text) => text.includes('as supplier_count'));
    expect(g).toMatch(/group by 1, 2\) r\s+left join lateral \(select x\.fiscal_code_clean/u);
    expect(concentration.data.find((text) => text.includes('as rows'))).not.toContain(
      'supplier_disclosure'
    );
    const series = await run(
      (s) => s.distinctSeriesFor(ROUTE, AUTHORITY, GEN, 'supplier', 'quarter'),
      { rollups: ['da_rollup_authority_supplier_month'] }
    );
    const read = series.data.find((text) => text.includes('count(distinct'));
    // Bucketed inside the sums (by the rollup month), selected outside by that column.
    expect(read).toMatch(
      /from \(select to_char\(r\.month, 'YYYY'\)[\s\S]*as bucket,\s+r\.supplier_ref/u
    );
    expect(read).toMatch(
      /select r\.bucket as bucket,\s+count\(distinct case when r\.supplier_ref is null/u
    );
  });

  it('scopes a rollup supplier through supplier_disclosure only, never joining it', async () => {
    const { sql } = await run(
      (s) => s.statsFor(ROUTE, { grain: 'direct_acquisition', supplierCui: '14399840' }, GEN),
      { rollups: ['da_rollup_supplier_month'] }
    );
    expect(sql).toMatch(
      /r\.supplier_ref > 0 and r\.supplier_ref = \(select sp\.supplier_id from "procurement_v3"\."supplier_disclosure" sp\s+where sp\.fiscal_code_clean = \$\d+\)/u
    );
    expect(sql).not.toMatch(/\bsv\b/u);
  });

  it('withholds every rollup supplier without supplier_disclosure, joining nothing', async () => {
    const { data } = await run(
      (s) => s.breakdownFor(ROUTE, AUTHORITY, GEN, 'supplier', 10, 'value'),
      { rollups: ['da_rollup_authority_supplier_month'], privacy: false }
    );
    const top = data.find((text) => text.includes('limit'));
    expect(top).toContain('case when r.supplier_ref is null then null else $');
    // Nothing names the unjoined view alias.
    expect(data.join('\n')).not.toMatch(/\bsv\./u);
    expect(data.join('\n')).not.toContain('supplier_disclosure');
  });

  it('withholds every supplier without supplier_disclosure', async () => {
    const { sql } = await run(
      (s) => s.breakdownFor(ROUTE, AUTHORITY, GEN, 'supplier', 10, 'value'),
      {
        privacy: false,
      }
    );
    expect(sql).not.toContain('supplier_disclosure');
    expect(sql).not.toContain('supplier_privacy');
    expect(sql).toContain('when false then s.fiscal_code_clean');
  });

  it('matches a supplier scope only when the supplier is public', async () => {
    const { sql } = await run((s) =>
      s.statsFor(ROUTE, { grain: 'direct_acquisition', supplierCui: '14399840' }, GEN)
    );
    expect(sql).toMatch(
      /\(p\.source_name, p\.supplier_party_id\) in \(select pp\.source_name, pp\.portal_party_id from "procurement_v3"\."da_parties_public" pp\s+where pp\.party_kind = \$\d+ and pp\.fiscal_code_status = 'valid' and pp\.fiscal_code_clean = \$\d+\)/u
    );
    // The match is the D6 test; unreadable supplier_disclosure matches nothing.
    const closed = await run(
      (s) => s.statsFor(ROUTE, { grain: 'direct_acquisition', supplierCui: '14399840' }, GEN),
      { privacy: false }
    );
    expect(closed.sql).not.toContain('pp.party_kind');
    // And the scope is constant false (fail closed), not dropped: the read matches no row.
    const counted = closed.data.filter((text) => /\bwhere\b/u.test(text));
    expect(counted.length).toBeGreaterThan(0);
    for (const text of counted)
      expect(text).toMatch(/\bwhere\b[\s\S]*\band false\b|\bwhere false\b/u);
  });

  it('records carry a supplier code and name only when named, and never select free text', async () => {
    const { sql } = await run((s) =>
      s.recordsFor(ROUTE, AUTHORITY, GEN, { sort: 'value_desc', offset: 0, limit: 25 })
    );
    expect(sql).toMatch(
      /case when \(s\.portal_party_id is not null[^)]*\) then s\.fiscal_code_clean end as supplier_cui/u
    );
    // Supplier names never come from a party row (the view carries none for suppliers).
    expect(sql).not.toContain('supplier_name');
    expect(sql).toContain(`case when p.supplier_party_id is null then null`);
    expect(sql).toContain('as supplier_display_kind');
    expect(sql).toContain('p.category_as_written as cpv_label');
    expect(sql).not.toMatch(/p\.(title|description)\b/u);
    // Two phases the where-counted (counted_value, purchase_id) index serves: valued rows first.
    expect(sql).toContain('p.counted and p.counted_value is not null');
    expect(sql).toContain('order by p.counted_value desc, p.purchase_id desc');
  });
});

describe('party joins', () => {
  it('probes parties per row on a records page and joins them plainly for aggregates', async () => {
    const records = await run((s) =>
      s.recordsFor(ROUTE, AUTHORITY, GEN, { sort: 'date_desc', offset: 0, limit: 25 })
    );
    const page = records.data.find((text) => text.includes('as supplier_display_kind')) ?? '';
    expect(page).toMatch(
      /left join lateral \(\s+select x\.source_name[\s\S]+offset 0\) "b" on true/u
    );
    expect(page).toMatch(
      /left join lateral \(\s+select x\.source_name[\s\S]+offset 0\) "s" on true/u
    );
    const stats = await run((s) => s.statsFor(ROUTE, AUTHORITY, GEN));
    expect(stats.sql).toContain(`left join "procurement_v3"."da_parties_public" b`);
    expect(stats.sql).not.toContain('left join lateral');
  });

  it('chooses a records page from da_purchases alone, then probes only its rows', async () => {
    const { data } = await run((s) =>
      s.recordsFor(ROUTE, { grain: 'direct_acquisition', supplierCui: '14399840' }, GEN, {
        sort: 'date_desc',
        offset: 0,
        limit: 25,
      })
    );
    const page = data.find((text) => text.includes('as supplier_display_kind')) ?? '';
    expect(page).toMatch(
      /from \(\s+select p\.purchase_id, p\.source_name[\s\S]+from "procurement_v3"\."da_purchases" p\s+where [\s\S]+limit \$\d+ offset \$\d+\) p\s+left join lateral/u
    );
    // A geography scope reads the buyer's place in the filter: the parties join first.
    const geo = await run((s) =>
      s.recordsFor(ROUTE, { grain: 'direct_acquisition', buyerCounty: 'CJ' }, GEN, {
        sort: 'date_desc',
        offset: 0,
        limit: 25,
      })
    );
    const geoPage = geo.data.find((text) => text.includes('as supplier_display_kind')) ?? '';
    expect(geoPage).not.toMatch(/from \(\s+select p\.purchase_id/u);
    expect(geoPage).toMatch(/offset 0\) "b" on true[\s\S]+where [\s\S]+limit \$\d+ offset \$\d+$/u);
  });

  it('counts the keyed rows past the first page over the purchases alone, capped at the offset', async () => {
    const { captured } = await run((s) =>
      s.recordsFor(ROUTE, AUTHORITY, GEN, { sort: 'value_desc', offset: 50, limit: 25 })
    );
    const carry = captured.find((query) => query.sql.includes('as n from'));
    expect(carry?.sql).toContain('p.counted and p.counted_value is not null');
    expect(carry?.sql).toContain('from "procurement_v3"."da_purchases" p');
    expect(carry?.sql).not.toContain('left join');
    expect(carry?.parameters.at(-1)).toBe(50);
  });

  it.each([
    ['date_desc', 'p.finalization_day desc, p.purchase_id desc', 'p.purchase_id desc'],
    ['date_asc', 'p.finalization_day asc, p.purchase_id asc', 'p.purchase_id asc'],
  ] as const)(
    'orders a records page %s in two phases: dated rows by the index, then undated by id',
    async (sort, keyedOrder, restOrder) => {
      const { data } = await run((s) =>
        s.recordsFor(ROUTE, AUTHORITY, GEN, { sort, offset: 0, limit: 25 })
      );
      const pages = data.filter((text) => text.includes('as supplier_display_kind'));
      expect(pages).toHaveLength(2);
      expect(pages[0]).toContain('and p.finalization_day is not null');
      expect(pages[0]).toContain(`order by ${keyedOrder}`);
      expect(pages[1]).toContain('and not (p.finalization_day is not null)');
      expect(pages[1]).toContain(`order by ${restOrder}`);
      for (const text of pages) expect(text).not.toContain('is null asc');
    }
  );
});

describe('supplier names', () => {
  const row = (supplierCui: string | null) => ({
    id: 'a',
    date: '2025-01-01',
    authority_cui: '4305857',
    authority_name: 'PRIMARIA',
    supplier_cui: supplierCui,
    supplier_display_kind: supplierCui === null ? 'natural_person' : 'company',
    value_ron: '1.00',
    status: 'accepted',
    cpv_code: null,
    cpv_label: null,
  });

  it('names a named supplier on a records page by code from party_public_names', async () => {
    const { result, captured } = await run(
      (s) => s.recordsFor(ROUTE, AUTHORITY, GEN, { sort: 'date_desc', offset: 0, limit: 25 }),
      {
        records: [row('14399840'), row(null)],
        names: [{ code: '14399840', name: 'FIRMA REGISTRY SRL' }],
      }
    );
    const page = (
      result as { _unsafeUnwrap: () => { rows: { supplierName: string | null }[] } }
    )._unsafeUnwrap();
    expect(page.rows.map((r) => r.supplierName)).toEqual(['FIRMA REGISTRY SRL', null]);
    const lookup = captured.find((q) => q.sql.includes('party_public_names'));
    expect(lookup?.sql).toContain(
      'where n.fiscal_code_clean = any($1::text[]) and n.supplier_name_public is true'
    );
    expect(lookup?.parameters).toEqual([['14399840']]);
  });

  it('looks up no name when the page names no supplier', async () => {
    const { captured } = await run(
      (s) => s.recordsFor(ROUTE, AUTHORITY, GEN, { sort: 'date_desc', offset: 0, limit: 25 }),
      { records: [row(null)] }
    );
    expect(captured.some((q) => q.sql.includes('party_public_names'))).toBe(false);
  });
});

describe('scope', () => {
  it('sums counted values only and never the reported value', async () => {
    const { sql } = await run((s) => s.statsFor(ROUTE, AUTHORITY, GEN));
    expect(sql).toContain('sum(p.counted_value) filter');
    expect(sql).not.toContain('reported_value');
  });

  it('joins buyer geography only when a buyer place is asked for', async () => {
    const plain = await run((s) => s.statsFor(ROUTE, AUTHORITY, GEN));
    expect(plain.sql).not.toContain('core.territories');
    const placed = await run((s) =>
      s.statsFor(ROUTE, { grain: 'direct_acquisition', buyerCounty: 'CJ' }, GEN)
    );
    expect(placed.sql).toContain('left join core.territories t');
    expect(placed.sql).toContain("t.privacy_class = 'public'");
    expect(placed.sql).toContain('t.county_code = $');
  });

  it.each([
    [{ q: 'beton' }, 'q'],
    [{ supplierCounty: 'CJ' }, 'supplierCounty'],
    [{ status: 'accepted' }, 'status'],
  ] as const)('refuses %j without a data query', async (extra, field) => {
    const { result, data } = await run((s) =>
      s.statsFor(ROUTE, { grain: 'direct_acquisition', ...extra }, GEN)
    );
    const error = (
      result as { _unsafeUnwrapErr: () => { type: string; field?: string } }
    )._unsafeUnwrapErr();
    expect(error.type).toBe('InvalidInput');
    expect(error.field).toBe(field);
    expect(data).toEqual([]);
  });

  it('bounds the period on finalization_day and keeps undated rows for disclosure', async () => {
    const { sql } = await run((s) => s.statsFor(ROUTE, { ...AUTHORITY, year: 2025 }, GEN));
    expect(sql).toMatch(
      /p\.finalization_day >= \$\d+::date and p\.finalization_day < \$\d+::date/u
    );
    expect(sql).toContain('or p.finalization_day is null)');
  });
});

describe('the publication-keyed cache', () => {
  const unfiltered = (source: ReturnType<typeof makeDaV3AnalysisSource>) =>
    source.statsFor(ROUTE, {}, GEN);

  const world = () => {
    const state = { build: BUILD, rowsReads: 0, publishAfterRows: false };
    const captured: CapturedQuery[] = [];
    const db = makeCapturingDb(captured, {
      respond: (text) => {
        if (text.includes('as build_id'))
          return [{ build_id: state.build, as_of: null, privacy: true }];
        if (text.includes('has_table_privilege')) return [{ present: true }];
        if (text.includes('as rows')) {
          state.rowsReads += 1;
          // A nightly publish lands while this fill is in flight.
          if (state.publishAfterRows) state.build = '1763435499999999';
          return [
            {
              rows: '0',
              with_value: '0',
              awarded: null,
              min_month: null,
              max_month: null,
              undated_count: '0',
              undated_value: null,
            },
          ];
        }
        return [];
      },
    });
    return { state, captured, source: makeDaV3AnalysisSource(db) };
  };

  it('never returns a scoped (uncached) read that a publish overtook', async () => {
    const { state, source } = world();
    expect((await source.statsFor(ROUTE, AUTHORITY, GEN)).isOk()).toBe(true);
    state.publishAfterRows = true;
    const overtaken = await source.statsFor(ROUTE, AUTHORITY, GEN);
    expect(overtaken.isErr() && overtaken.error.type).toBe('ServiceUnavailable');
    expect(overtaken.isErr() && overtaken.error.message).toContain('republished');
  });

  it('never returns a records page that a publish overtook', async () => {
    let build = BUILD;
    const db = makeCapturingDb([], {
      respond: (text) => {
        if (text.includes('as build_id')) return [{ build_id: build, as_of: null, privacy: true }];
        if (text.includes('has_table_privilege')) return [{ present: true }];
        if (text.includes('as total')) {
          // The page is read; a nightly publish lands before the answer leaves.
          build = '1763435499999999';
          return [{ total: '1' }];
        }
        return [];
      },
    });
    const page = await makeDaV3AnalysisSource(db).recordsFor(ROUTE, AUTHORITY, GEN, {
      sort: 'date_desc',
      offset: 0,
      limit: 25,
    });
    expect(page.isErr() && page.error.message).toContain('republished');
  });

  it.each([
    ['revoked after a read that could name suppliers', true, false],
    ['unreadable throughout (everyone withheld)', false, true],
  ] as const)(
    'a scoped read with the supplier_disclosure grant %s',
    async (_label, before, served) => {
      let readable = before;
      const db = makeCapturingDb([], {
        respond: (text) => {
          if (text.includes('as build_id'))
            return [{ build_id: BUILD, as_of: null, privacy: readable }];
          if (text.includes('has_table_privilege')) return [{ present: readable }];
          if (text.includes('as rows')) {
            readable = false; // the grant is revoked once the rows are read
            return [{ rows: '1', with_value: '1', awarded: '5', undated_count: '0' }];
          }
          return [];
        },
      });
      const read = await makeDaV3AnalysisSource(db).statsFor(ROUTE, AUTHORITY, GEN);
      expect(read.isOk()).toBe(served);
      if (read.isErr()) expect(read.error.message).toContain('republished');
    }
  );

  it('never returns a records page read with the supplier_disclosure grant later revoked', async () => {
    let readable = true;
    const db = makeCapturingDb([], {
      respond: (text) => {
        if (text.includes('as build_id'))
          return [{ build_id: BUILD, as_of: null, privacy: readable }];
        if (text.includes('has_table_privilege')) return [{ present: readable }];
        if (text.includes('as total')) {
          readable = false; // the page could name suppliers; the grant is revoked after it
          return [{ total: '1' }];
        }
        return [];
      },
    });
    const page = await makeDaV3AnalysisSource(db).recordsFor(ROUTE, AUTHORITY, GEN, {
      sort: 'date_desc',
      offset: 0,
      limit: 25,
    });
    expect(page.isErr() && page.error.message).toContain('republished');
  });

  it('probes the build and the supplier_disclosure grant in one statement', async () => {
    const { captured, source } = world();
    await unfiltered(source);
    const probes = captured.filter(
      (q) => q.sql.includes('as build_id') && q.sql.includes('has_table_privilege')
    );
    expect(probes.length).toBeGreaterThanOrEqual(2); // before the lookup and after the fill
  });

  it('shares one read between identical concurrent misses', async () => {
    const { state, source } = world();
    await Promise.all([unfiltered(source), unfiltered(source), unfiltered(source)]);
    expect(state.rowsReads).toBe(1);
  });

  it('never keeps a fill whose build stopped being current while it ran', async () => {
    const { state, source } = world();
    state.publishAfterRows = true;
    // Never served either: its rows and key are from a publication now known stale.
    const overtaken = await unfiltered(source);
    expect(overtaken.isErr() && overtaken.error.type).toBe('ServiceUnavailable');
    expect(overtaken.isErr() && overtaken.error.message).toContain('republished');
    state.publishAfterRows = false;
    state.build = BUILD;
    await unfiltered(source);
    expect(state.rowsReads).toBe(2);
  });

  it('reuses an unfiltered answer only while the build is current and supplier_disclosure is readable', async () => {
    const reads = async (options: { privacy?: boolean; build?: string }) => {
      const { captured } = await run(async (source) => {
        await unfiltered(source);
        await unfiltered(source);
      }, options);
      return captured.filter((q) => q.sql.includes('as rows')).length;
    };
    expect(await reads({})).toBe(1);
    // Unreadable (revoked grant): never served from or stored in the cache.
    expect(await reads({ privacy: false })).toBe(2);
    // A newer publication than the request's build: no cache.
    expect(await reads({ build: '1763435499999999' })).toBe(0);
  });
});
