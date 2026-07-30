import { afterEach, describe, expect, it, vi } from 'vitest';

import { makeClickhouseAnalysisRepo } from '@/modules/procurement/shell/repo/clickhouse-analysis-repo.js';

import { compactResponse } from './clickhouse-response.js';

import type { AnalysisRoute } from '@/modules/procurement/core/combinations.js';
import type { AnalysisRepo } from '@/modules/procurement/core/ports.js';

const route = (grain: AnalysisRoute['grain']): AnalysisRoute => ({ grain });

const activeGeneration: AnalysisRepo['activeGeneration'] = () =>
  Promise.reject(new Error('activeGeneration is not used by these tests'));

const emptyStatsResponse = (): Response =>
  compactResponse([
    {
      rows: '0',
      with_value: '0',
      with_estimated: '0',
      awarded_bani_out: null,
      estimated_bani_out: null,
      ceiling_bani_out: null,
      mod_adjusted_bani_out: null,
      awarded_matched_bani_out: null,
      min_month: null,
      max_month: null,
      undated_count: '0',
      undated_bani_out: null,
      withheld_bani_out: null,
    },
  ]);

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ClickHouse procurement SIRUTA scope compilation', () => {
  it('filters contract analytics by supplier UAT SIRUTA', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(emptyStatsResponse());
    vi.stubGlobal('fetch', fetchSpy);
    const repo = makeClickhouseAnalysisRepo(
      { url: 'http://clickhouse.test', database: 'proto' },
      activeGeneration
    );

    const result = await repo.statsFor(route('contract'), { supplierSiruta: '057706' }, '1');

    expect(result.isOk()).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const request = fetchSpy.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(request?.body).toContain('supplier_siruta_uat = 57706');
  });

  it('rejects non-numeric supplier SIRUTA without querying ClickHouse', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const repo = makeClickhouseAnalysisRepo(
      { url: 'http://clickhouse.test', database: 'proto' },
      activeGeneration
    );

    const result = await repo.statsFor(route('contract'), { supplierSiruta: 'CJ' }, '1');

    expect(result._unsafeUnwrap().rows).toBe('0');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('treats supplier SIRUTA as structurally unavailable on procedures', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const repo = makeClickhouseAnalysisRepo(
      { url: 'http://clickhouse.test', database: 'proto' },
      activeGeneration
    );

    const result = await repo.statsFor(route('procedure'), { supplierSiruta: '57706' }, '1');

    expect(result._unsafeUnwrap().rows).toBe('0');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('ClickHouse row-filter and dimension scope compilation', () => {
  const statsBody = async (scope: Parameters<AnalysisRepo['statsFor']>[1]): Promise<string> => {
    const fetchSpy = vi.fn().mockResolvedValue(emptyStatsResponse());
    vi.stubGlobal('fetch', fetchSpy);
    const repo = makeClickhouseAnalysisRepo(
      { url: 'http://clickhouse.test', database: 'proto' },
      activeGeneration
    );
    const result = await repo.statsFor(route('contract'), scope, '1');
    expect(result.isOk()).toBe(true);
    const request = fetchSpy.mock.calls[0]?.[1] as { body?: string } | undefined;
    return request?.body ?? '';
  };

  it('filters contracts by record_kind equality', async () => {
    const body = await statsBody({ recordKind: 'framework_agreement' });
    expect(body).toContain("record_kind = 'framework_agreement'");
  });

  it('compiles CPV level scopes as cpv_code prefix matches at the level length', async () => {
    expect(await statsBody({ cpvGroup: '45200000' })).toContain(
      "startsWith(ifNull(cpv_code, ''), '452')"
    );
    expect(await statsBody({ cpvClass: '45230000' })).toContain(
      "startsWith(ifNull(cpv_code, ''), '4523')"
    );
    expect(await statsBody({ cpvCategory: '45233000' })).toContain(
      "startsWith(ifNull(cpv_code, ''), '45233')"
    );
  });

  it('compiles q as a case-insensitive title predicate with escaping', async () => {
    const body = await statsBody({ q: "drum judetean 'DJ'" });
    expect(body).toContain(
      "positionCaseInsensitiveUTF8(ifNull(title, ''), 'drum judetean \\'DJ\\'') > 0"
    );
  });

  it('compiles value bounds as attributed-money bani predicates (association dedup r3)', async () => {
    const body = await statsBody({ valueMin: 1000.5, valueMax: 5_000_000 });
    // Bounds range over the SERVED money rows: the attributed column is the
    // carrier-only value (suppressed/quarantined member rows are never money
    // rows), and its non-NULL test IS the acceptance predicate.
    expect(body).toContain('value_awarded_attributed_bani IS NOT NULL');
    expect(body).toContain('value_awarded_attributed_bani >= 100050');
    expect(body).toContain('value_awarded_attributed_bani <= 500000000');
  });

  it('keeps value bounds at the top level of a bounded window (undated rows filtered too)', async () => {
    const body = await statsBody({ valueMin: 1000, year: 2025 });
    // Row filters precede the dated/undated OR-composition: they constrain the
    // WHOLE population, including the undated bucket — not just dated rows.
    expect(body).toContain(
      "value_awarded_attributed_bani >= 100000 AND ((NOT is_undated AND date_basis >= toDate('2025-01-01') AND date_basis < toDate('2026-01-01')) OR is_undated)"
    );
  });

  it('exact bani conversion (binary float 1.05 RON compiles to 105 bani)', async () => {
    const body = await statsBody({ valueMin: 1.05 });
    expect(body).toContain('value_awarded_attributed_bani >= 105');
  });

  it('keys CPV level breakdowns on canonical 8-digit codes and honors SIRUTA topN', async () => {
    // Statement order: totals → unknown (NULL-key) → top-N. The unknown read
    // runs before the top-N because it decides the ranking basis (§ honest
    // value-ranking fallback), so it is call 1 and the top-N is call 2.
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(emptyStatsResponse())
      .mockResolvedValueOnce(compactResponse([{ cnt: '0', wv: '0', awarded_bani: '0' }]))
      .mockResolvedValueOnce(compactResponse([], ['key', 'cnt', 'wv', 'awarded_bani']));
    vi.stubGlobal('fetch', fetchSpy);
    const repo = makeClickhouseAnalysisRepo(
      { url: 'http://clickhouse.test', database: 'proto' },
      activeGeneration
    );

    const result = await repo.breakdownFor(route('contract'), {}, '1', 'cpvGroup', 3300, 'count');

    expect(result.isOk()).toBe(true);
    const topBody = (fetchSpy.mock.calls[2]?.[1] as { body?: string } | undefined)?.body ?? '';
    // Canonical 8-digit group keys; coarser-level codes (zero group digit,
    // e.g. a bare division 45000000) fall to NULL → the unknown bucket.
    expect(topBody).toContain(
      "if(length(cpv_code) = 8 AND substring(cpv_code, 3, 1) != '0', concat(substring(cpv_code, 1, 3), '00000'), NULL) AS key"
    );
    expect(topBody).toContain('LIMIT 3300');
  });
});

describe('association-dedup money routing (design r3, user decisions D3=C/D8)', () => {
  const makeRepo = (): { repo: AnalysisRepo; fetchSpy: ReturnType<typeof vi.fn> } => {
    const fetchSpy = vi.fn().mockResolvedValue(emptyStatsResponse());
    vi.stubGlobal('fetch', fetchSpy);
    const repo = makeClickhouseAnalysisRepo(
      { url: 'http://clickhouse.test', database: 'proto' },
      activeGeneration
    );
    return { repo, fetchSpy };
  };
  const bodyOf = (fetchSpy: ReturnType<typeof vi.fn>, call = 0): string =>
    (fetchSpy.mock.calls[call]?.[1] as { body?: string } | undefined)?.body ?? '';

  it('unscoped contract stats aggregate ATTRIBUTED money (one copy per award)', async () => {
    const { repo, fetchSpy } = makeRepo();
    await repo.statsFor(route('contract'), {}, '1');
    const body = bodyOf(fetchSpy);
    expect(body).toContain('value_awarded_attributed_bani');
    expect(body).not.toContain('value_awarded_supplier_bani');
  });

  it('supplier-scoped contract stats aggregate SUPPLIER money (M1 invariant)', async () => {
    const { repo, fetchSpy } = makeRepo();
    await repo.statsFor(route('contract'), { supplierCui: '123' }, '1');
    const body = bodyOf(fetchSpy);
    expect(body).toContain('value_awarded_supplier_bani');
    // The attributed column appears ONLY in the withheld disclosure output —
    // never as the anchor money (M1) — and the anchor sum stays supplier.
    expect(body).toContain('withheld_bani_out');
    expect(body).toContain(
      'toString(sumIf(toInt128(value_awarded_supplier_bani), is_undated AND value_awarded_supplier_bani IS NOT NULL))) AS undated_bani_out'
    );
    const beforeWithheld = body.slice(0, body.indexOf('withheld_bani_out'));
    const afterWithheld = body.slice(beforeWithheld.length + 'withheld_bani_out'.length);
    expect(beforeWithheld.split('AS awarded_bani_out')[0]).not.toContain(
      'value_awarded_attributed_bani'
    );
    expect(afterWithheld).not.toContain('value_awarded_attributed_bani');
  });

  it('supplier-scoped stats DISCLOSE the withheld association mass (finding 2)', async () => {
    const { repo, fetchSpy } = makeRepo();
    await repo.statsFor(route('contract'), { supplierCui: '123' }, '1');
    const body = bodyOf(fetchSpy);
    // Withheld = Σ attributed − Σ supplier over the SAME scope; NULL when the
    // scope holds no attributed money (never a fabricated zero).
    expect(body).toContain(
      'if(countIf(1 AND value_awarded_attributed_bani IS NOT NULL) = 0, NULL,'
    );
    expect(body).toMatch(
      /sumIf\(toInt128\(value_awarded_attributed_bani\)[\s\S]*-\s*ifNull\(sumIf\(toInt128\(value_awarded_supplier_bani\)/
    );
  });

  it('attributed-basis stats carry NO withheld output (the field doubles as the supplier-read signal)', async () => {
    const { repo, fetchSpy } = makeRepo();
    await repo.statsFor(route('contract'), {}, '1');
    const body = bodyOf(fetchSpy);
    expect(body).toContain('NULL AS withheld_bani_out');
  });

  it('supplier breakdown totals AND buckets share the supplier-money basis', async () => {
    const { repo, fetchSpy } = makeRepo();
    await repo.breakdownFor(route('contract'), {}, '1', 'supplier', 10, 'value');
    for (let i = 0; i < fetchSpy.mock.calls.length; i += 1) {
      const body = bodyOf(fetchSpy, i);
      expect(body).toContain('value_awarded_supplier_bani');
      // Attributed money may appear ONLY in the totals' withheld disclosure;
      // every aggregation of it must sit inside the withheld_bani_out output.
      if (body.includes('value_awarded_attributed_bani')) {
        expect(body).toContain('withheld_bani_out');
        expect(body.split('AS awarded_bani_out')[0]).not.toContain('value_awarded_attributed_bani');
      }
    }
  });

  it('authority breakdown stays on attributed money', async () => {
    const { repo, fetchSpy } = makeRepo();
    await repo.breakdownFor(route('contract'), {}, '1', 'authority', 10, 'value');
    for (let i = 0; i < fetchSpy.mock.calls.length; i += 1) {
      expect(bodyOf(fetchSpy, i)).toContain('value_awarded_attributed_bani');
    }
  });

  it('concentration always uses supplier money (association money never enters HHI)', async () => {
    const { repo, fetchSpy } = makeRepo();
    await repo.concentrationFor(route('contract'), {}, '1', 'value');
    for (let i = 0; i < fetchSpy.mock.calls.length; i += 1) {
      const body = bodyOf(fetchSpy, i);
      if (body.includes('sumIf')) expect(body).toContain('value_awarded_supplier_bani');
    }
  });

  it('DA grain is untouched by the association flip (raw awarded column)', async () => {
    const { repo, fetchSpy } = makeRepo();
    await repo.statsFor(route('direct_acquisition'), { supplierCui: '123' }, '1');
    expect(bodyOf(fetchSpy)).toContain('value_awarded_bani');
  });
});
