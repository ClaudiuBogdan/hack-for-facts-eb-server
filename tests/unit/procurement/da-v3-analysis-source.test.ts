/**
 * The procurement_v3 direct-acquisition analysis source's compiled SQL over a
 * capturing driver: one read-only repeatable-read snapshot per read that
 * refuses a moved publication; D6 keys withheld suppliers as one
 * `natural_person` key and fails closed without supplier_privacy; a supplier
 * scope matches only public suppliers; free text is never selected; buyer
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
  options: { privacy?: boolean; build?: string } = {}
) => {
  const captured: CapturedQuery[] = [];
  const isolation: unknown[] = [];
  const db = makeCapturingDb(captured, {
    respond: (text) => {
      if (text.includes('as build_id')) return [{ build_id: options.build ?? BUILD, as_of: null }];
      if (text.includes('has_table_privilege')) return [{ present: options.privacy ?? true }];
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
    expect(captured[2]?.sql).toContain('as build_id');
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
    expect(sql).toContain(
      'left join "procurement_v3"."supplier_privacy" sv on sv.fiscal_code_clean = s.fiscal_code_clean'
    );
    expect(sql).toMatch(
      /when \(sv\.public is true and s\.fiscal_code_status = 'valid' and s\.fiscal_code_clean is not null\) then s\.fiscal_code_clean\s+else \$\d+ end/u
    );
  });

  it('withholds every supplier without supplier_privacy', async () => {
    const { sql } = await run(
      (s) => s.breakdownFor(ROUTE, AUTHORITY, GEN, 'supplier', 10, 'value'),
      {
        privacy: false,
      }
    );
    expect(sql).not.toContain('supplier_privacy');
    expect(sql).toContain('when false then s.fiscal_code_clean');
  });

  it('matches a supplier scope only when the supplier is public', async () => {
    const { sql } = await run((s) =>
      s.statsFor(ROUTE, { grain: 'direct_acquisition', supplierCui: '14399840' }, GEN)
    );
    expect(sql).toMatch(/s\.fiscal_code_clean = \$\d+ and \(sv\.public is true/u);
  });

  it('records carry a supplier code and name only when named, and never select free text', async () => {
    const { sql } = await run((s) =>
      s.recordsFor(ROUTE, AUTHORITY, GEN, { sort: 'value_desc', offset: 0, limit: 25 })
    );
    expect(sql).toMatch(
      /case when \(sv\.public is true[^)]*\) then s\.name_as_written end as supplier_name/u
    );
    expect(sql).toContain('as supplier_display_kind');
    expect(sql).toContain('p.category_as_written as cpv_label');
    expect(sql).not.toMatch(/p\.(title|description)\b/u);
    expect(sql).toContain(
      'case when p.counted then p.counted_value end desc nulls last, p.purchase_id desc'
    );
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

  it('reuses an unfiltered answer only while the build is current and supplier_privacy is readable', async () => {
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
