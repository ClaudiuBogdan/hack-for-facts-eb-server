import { ok } from 'neverthrow';
import { afterEach, describe, expect, it } from 'vitest';

import {
  analysisBreakdown,
  analysisShare,
  analysisStats,
} from '@/modules/procurement/core/analysis-usecases.js';
import { makeClickhouseAnalysisRepo } from '@/modules/procurement/shell/repo/clickhouse-analysis-repo.js';

import { compactResponse } from './clickhouse-response.js';

import type { AnalysisRoute } from '@/modules/procurement/core/combinations.js';
import type { ActiveGeneration, PublishedGeneration } from '@/modules/procurement/core/ports.js';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const legacyTables = [
  'facts_contracts_v2',
  'facts_da_v2',
  'facts_procedures_v2',
  'facts_frameworks_v2',
  'facts_calloffs_v2',
  'facts_contract_mods_v2',
];
const published = (buildId: string): PublishedGeneration => ({
  buildId,
  publishedAt: '2026-09-24T00:00:00Z',
  quality: {
    contract: {
      coverage: { date: 1, value: 1, geo: 1, cpv: 1 },
      classes: { spend: 'allow', time: 'allow', geo: 'allow' },
    },
  },
  matrixHash: null,
});
const generation = (buildId: string): ActiveGeneration => ({
  ...published(buildId),
  capabilities: { frameworkRole: false },
});

function harness(
  options: { missingTable?: string; emptyCoverage?: boolean; duplicateCoverage?: boolean } = {}
) {
  const queries: string[] = [];
  let active = '8';
  let generationReads = 0;
  let afterDataRead: (() => void) | undefined;
  globalThis.fetch = (_url, init) => {
    const body = typeof init?.body === 'string' ? init.body : '';
    queries.push(body);
    const tables = [
      ...legacyTables,
      ...legacyTables.map((name) => `${name}_b9`),
      'meta_value_coverage_v2',
    ].filter((name) => name !== options.missingTable);
    if (body.includes('system.tables'))
      return Promise.resolve(
        compactResponse(
          tables.filter((name) => body.includes(`'${name}'`)).map((name) => ({ name })),
          ['name']
        )
      );
    if (body.includes('system.columns')) return Promise.resolve(compactResponse([], ['name']));
    if (body.includes('meta_value_coverage_v2') && options.duplicateCoverage === true) {
      return Promise.resolve(
        compactResponse([
          { grain: 'contract', basis: 'awarded', population: 'awards_canonical', coverage: 0.5 },
          { grain: 'contract', basis: 'awarded', population: 'awards_canonical', coverage: 0.9 },
        ])
      );
    }
    if (body.includes('meta_value_coverage_v2'))
      return Promise.resolve(
        compactResponse(
          options.emptyCoverage === true
            ? []
            : [
                {
                  grain: 'contract',
                  basis: 'awarded',
                  population: 'awards_canonical',
                  coverage: body.includes("build_id = '9'") ? 0.5 : 1,
                },
              ],
          ['grain', 'basis', 'population', 'coverage']
        )
      );
    if (options.missingTable !== undefined && body.includes(`FROM ${options.missingTable}`)) {
      return Promise.resolve(new Response('Unknown table', { status: 404 }));
    }
    // Different snapshots deliberately produce different money: an accidental
    // fallback or a mixed totals/buckets read is observable in returned values.
    const bani = body.includes('facts_contracts_v2_b9') ? '900' : '800';
    afterDataRead?.();
    if (body.includes('GROUP BY month'))
      return Promise.resolve(
        compactResponse([
          {
            month: '2025-01',
            value: bani,
            record_count: '1',
            with_value: '1',
            awarded_bani_out: bani,
          },
        ])
      );
    if (body.includes('GROUP BY bucket'))
      return Promise.resolve(
        compactResponse([
          {
            bucket: '2025-01',
            value: '1',
            record_count: '1',
            with_value: '1',
            awarded_bani_out: bani,
          },
        ])
      );
    if (body.includes('AS supplier_count'))
      return Promise.resolve(
        compactResponse([
          {
            supplier_count: '1',
            positive_supplier_count: '1',
            measure_total: bani,
            top1_measure: bani,
            top5_measure: bani,
            measure_squared_sum: (BigInt(bani) * BigInt(bani)).toString(),
            unknown_measure: '0',
          },
        ])
      );
    if (body.includes('AS cnt'))
      return Promise.resolve(
        compactResponse(
          body.includes('GROUP BY key')
            ? [{ key: 'CJ', cnt: '1', wv: '1', awarded_bani: bani }]
            : [{ cnt: '0', wv: '0', awarded_bani: '0' }]
        )
      );
    return Promise.resolve(
      compactResponse([
        {
          rows: '1',
          with_value: '1',
          with_estimated: '0',
          awarded_bani_out: bani,
          estimated_bani_out: null,
          ceiling_bani_out: null,
          mod_adjusted_bani_out: null,
          awarded_matched_bani_out: null,
          min_month: '2025-01',
          max_month: '2025-01',
          undated_count: '0',
          undated_bani_out: null,
          withheld_bani_out: null,
        },
      ])
    );
  };
  const repo = makeClickhouseAnalysisRepo({ url: 'http://ch.fixture', database: 'proto' }, () => {
    generationReads += 1;
    return Promise.resolve(ok(published(active)));
  });
  return {
    repo,
    queries,
    setActive: (id: string) => {
      active = id;
    },
    onDataRead: (callback: () => void) => {
      afterDataRead = callback;
    },
    reads: () => generationReads,
  };
}

const grains: readonly [AnalysisRoute['grain'], string][] = [
  ['contract', 'facts_contracts_v2'],
  ['direct_acquisition', 'facts_da_v2'],
  ['procedure', 'facts_procedures_v2'],
  ['framework', 'facts_frameworks_v2'],
  ['calloff', 'facts_calloffs_v2'],
  ['modification', 'facts_contract_mods_v2'],
];

describe('ClickHouse publication table binding', () => {
  it.each(grains)('binds %s to legacy build8 or its own revision', async (grain, table) => {
    const h = harness();
    expect((await h.repo.statsFor({ grain }, {}, generation('8'))).isOk()).toBe(true);
    expect(h.queries.at(-1)).toContain(`FROM ${table} WHERE`);
    expect((await h.repo.statsFor({ grain }, {}, generation('9'))).isOk()).toBe(true);
    expect(h.queries.at(-1)).toContain(`FROM ${table}_b9 WHERE`);
  });

  it('keeps totals, buckets, nested award search and coverage on the pinned old build during a pointer flip', async () => {
    const h = harness();
    const pinned = (await h.repo.activeGeneration())._unsafeUnwrap();
    expect(pinned).not.toBeNull();
    h.onDataRead(() => {
      h.setActive('9');
    });
    const result = (
      await h.repo.breakdownFor(
        { grain: 'contract' },
        { q: 'fixture' },
        pinned!,
        'buyerCounty',
        10,
        'value'
      )
    )._unsafeUnwrap();
    const coverage = (await h.repo.basisCoverage(pinned!.buildId))._unsafeUnwrap();
    expect(result.totals.valueAwardedSum).toBe('8.00');
    expect(result.buckets.find((row) => row.kind === 'top')?.valueAwardedSum).toBe('8.00');
    expect(coverage[0]?.coverage).toBe(1);
    expect(
      h.queries.some((sql) =>
        sql.includes('award_key IN (SELECT award_key FROM facts_contracts_v2 WHERE')
      )
    ).toBe(true);
    expect(h.queries.every((sql) => !sql.includes('_b9'))).toBe(true);
    expect(h.reads()).toBe(1);
    const fresh = (await h.repo.activeGeneration())._unsafeUnwrap();
    expect(fresh?.buildId).toBe('9');
    expect(h.queries.at(-1)).toContain("table = 'facts_contracts_v2_b9'");
    expect(
      (await h.repo.statsFor({ grain: 'contract' }, {}, fresh!))._unsafeUnwrap().valueAwardedSum
    ).toBe('9.00');
  });

  it('uses the new table for every multi-query read and its group-aware text search', async () => {
    const h = harness();
    const g = generation('9');
    const scope = { q: 'fixture' };
    expect(
      (
        await h.repo.seriesFor({ grain: 'contract' }, scope, g, 'valueAwardedSum')
      )._unsafeUnwrap()[0]?.value
    ).toBe('9.00');
    expect(
      (await h.repo.distinctSeriesFor({ grain: 'contract' }, scope, g, 'supplier', 'month')).isOk()
    ).toBe(true);
    expect(
      (
        await h.repo.breakdownFor({ grain: 'contract' }, scope, g, 'buyerCounty', 10, 'value')
      )._unsafeUnwrap().totals.valueAwardedSum
    ).toBe('9.00');
    expect(
      (await h.repo.concentrationFor({ grain: 'contract' }, scope, g, 'value'))._unsafeUnwrap()
        .measureTotal
    ).toBe('9.00');
    expect(h.queries.length).toBeGreaterThan(5);
    for (const sql of h.queries) {
      expect(sql).toContain('FROM facts_contracts_v2_b9');
      expect(sql).toContain('award_key IN (SELECT award_key FROM facts_contracts_v2_b9 WHERE');
      expect(sql).not.toMatch(/FROM facts_contracts_v2\s/u);
    }
  });

  it('refuses a partially prepared generation, even when the requested contract table exists', async () => {
    const h = harness({ missingTable: 'facts_da_v2_b9' });
    h.setActive('9');
    expect((await h.repo.activeGeneration()).isErr()).toBe(true);
    expect(h.queries).toHaveLength(1);
    expect(h.queries[0]).toContain('system.tables');
    expect((await h.repo.activeGeneration()).isErr()).toBe(true);
    expect(h.queries).toHaveLength(2); // A failed readiness probe is not cached.
  });

  it('never retries a missing revision table against build8', async () => {
    const h = harness({ missingTable: 'facts_contracts_v2_b9' });
    expect((await h.repo.statsFor({ grain: 'contract' }, {}, generation('9'))).isErr()).toBe(true);
    expect(h.queries).toHaveLength(1);
    expect(h.queries[0]).toContain('facts_contracts_v2_b9');
  });

  it.each(['0', '08', '-1', '9; DROP TABLE x', '9223372036854775808', '1e3'])(
    'refuses invalid build ID %s without any query',
    async (buildId) => {
      const h = harness();
      h.setActive(buildId);
      expect((await h.repo.activeGeneration()).isErr()).toBe(true);
      expect((await h.repo.statsFor({ grain: 'contract' }, {}, generation(buildId))).isErr()).toBe(
        true
      );
      expect((await h.repo.basisCoverage(buildId)).isErr()).toBe(true);
      expect(h.queries).toEqual([]);
    }
  );

  it('isolates immutable coverage caches by publication and does not cache missing coverage', async () => {
    const h = harness();
    expect((await h.repo.basisCoverage('8'))._unsafeUnwrap()[0]?.coverage).toBe(1);
    expect((await h.repo.basisCoverage('9'))._unsafeUnwrap()[0]?.coverage).toBe(0.5);
    await h.repo.basisCoverage('8');
    await h.repo.basisCoverage('9');
    expect(h.queries).toHaveLength(2);
    const missing = harness({ emptyCoverage: true });
    expect((await missing.repo.basisCoverage('9')).isErr()).toBe(true);
    expect((await missing.repo.basisCoverage('9')).isErr()).toBe(true);
    expect(missing.queries).toHaveLength(2);
  });

  it('keeps concurrent old and new reads in separate in-flight requests', async () => {
    const h = harness();
    const answer = globalThis.fetch;
    const pending: (() => void)[] = [];
    globalThis.fetch = (url, init) =>
      new Promise<Response>((resolve, reject) => {
        pending.push(() => {
          void answer(url, init).then(resolve, reject);
        });
      });
    const oldRead = h.repo.statsFor({ grain: 'contract' }, {}, generation('8'));
    const newRead = h.repo.statsFor({ grain: 'contract' }, {}, generation('9'));
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    for (const respond of pending.reverse()) respond();
    const [oldResult, newResult] = await Promise.all([oldRead, newRead]);
    expect(pending).toHaveLength(2);
    expect(oldResult._unsafeUnwrap().valueAwardedSum).toBe('8.00');
    expect(newResult._unsafeUnwrap().valueAwardedSum).toBe('9.00');
  });

  it('rejects and does not cache ambiguous duplicate coverage keys', async () => {
    const h = harness({ duplicateCoverage: true });
    expect((await h.repo.basisCoverage('9')).isErr()).toBe(true);
    expect((await h.repo.basisCoverage('9')).isErr()).toBe(true);
    expect(h.queries).toHaveLength(2);
    expect(h.queries.every((query) => query.includes('ORDER BY grain, basis, population'))).toBe(
      true
    );
  });

  it('pins the real breakdown use case through a flip, including its coverage and envelope', async () => {
    const h = harness();
    h.onDataRead(() => {
      h.setActive('9');
    });
    const blocks = (
      await analysisBreakdown(
        { analysisRepo: h.repo },
        {
          scope: { grain: 'contract', q: 'fixture' },
          dimension: 'buyerCounty',
          rankBy: 'value',
        }
      )
    )._unsafeUnwrap();
    expect(blocks[0]?.meta.buildId).toBe('8');
    expect(blocks[0]?.buckets.find((bucket) => bucket.kind === 'top')?.valueAwardedSum).toBe(
      '8.00'
    );
    expect(h.reads()).toBe(1);
    expect(h.queries.some((query) => query.includes("build_id = '8'"))).toBe(true);
    expect(h.queries.every((query) => !query.includes('_b9'))).toBe(true);
  });

  it('pins both real share operands to one publication across a flip', async () => {
    const h = harness();
    h.onDataRead(() => {
      h.setActive('9');
    });
    const result = (
      await analysisShare(
        { analysisRepo: h.repo },
        {
          numerator: { grain: 'contract', q: 'fixture' },
          denominator: { grain: 'contract' },
        }
      )
    )._unsafeUnwrap();
    expect(result.numerator.meta.buildId).toBe('8');
    expect(result.denominator.meta.buildId).toBe('8');
    expect(result.numerator.valueAwardedSum).toBe('8.00');
    expect(result.denominator.valueAwardedSum).toBe('8.00');
    expect(h.reads()).toBe(1);
  });

  it('retains the existing use-case fallback: ambiguous basis coverage abstains for other money bases', async () => {
    const h = harness({ duplicateCoverage: true });
    const result = (
      await analysisStats({ analysisRepo: h.repo }, { scope: { grain: 'contract' } })
    )._unsafeUnwrap();
    expect(result.blocks[0]?.recordCount).toBe('1');
    expect(result.blocks[0]?.valueAwardedSum).toBe('8.00');
    expect(
      result.blocks[0]?.moneyVerdicts.find((verdict) => verdict.measure === 'valueModAdjustedSum')
        ?.answerability
    ).toBe('abstained');
  });
});
