import { afterEach, describe, expect, it, vi } from 'vitest';

import { makeClickhouseAnalysisRepo } from '@/modules/procurement/shell/repo/clickhouse-analysis-repo.js';

import { compactResponse, generationWithoutFrameworkRole as GEN } from './clickhouse-response.js';

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

describe('ClickHouse accepted monetary states', () => {
  it.each(['direct_acquisition', 'procedure'] as const)(
    'includes recovered and cross-source values for %s',
    async (grain) => {
      let query = '';
      vi.stubGlobal('fetch', (_url: string, request: RequestInit) => {
        query = typeof request.body === 'string' ? request.body : '';
        return Promise.resolve(emptyStatsResponse());
      });
      const repo = makeClickhouseAnalysisRepo(
        { url: 'http://clickhouse.test', database: 'proto' },
        activeGeneration
      );

      const result = await repo.statsFor(route(grain), {}, GEN);

      expect(result.isOk()).toBe(true);
      expect(query).toContain(
        "value_state IN ('official_exact', 'official_ron_equivalent', 'cross_source_exact', 'official_document_recovered')"
      );
    }
  );
});

describe('ClickHouse procurement SIRUTA scope compilation', () => {
  it('filters contract analytics by supplier UAT SIRUTA', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(emptyStatsResponse());
    vi.stubGlobal('fetch', fetchSpy);
    const repo = makeClickhouseAnalysisRepo(
      { url: 'http://clickhouse.test', database: 'proto' },
      activeGeneration
    );

    const result = await repo.statsFor(route('contract'), { supplierSiruta: '057706' }, GEN);

    expect(result.isOk()).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const request = fetchSpy.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(request?.body).toContain('supplier_siruta_uat = 57706');
    // A supplier place never selects a withheld (natural-person) identity.
    expect(request?.body).toContain('(supplier_cui IS NOT NULL AND length(supplier_cui) <= 10)');
  });

  it('rejects non-numeric supplier SIRUTA without querying ClickHouse', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const repo = makeClickhouseAnalysisRepo(
      { url: 'http://clickhouse.test', database: 'proto' },
      activeGeneration
    );

    const result = await repo.statsFor(route('contract'), { supplierSiruta: 'CJ' }, GEN);

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

    const result = await repo.statsFor(route('procedure'), { supplierSiruta: '57706' }, GEN);

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
    const result = await repo.statsFor(route('contract'), scope, GEN);
    expect(result.isOk()).toBe(true);
    const request = fetchSpy.mock.calls[0]?.[1] as { body?: string } | undefined;
    return request?.body ?? '';
  };

  it('filters contracts by record_kind equality', async () => {
    const body = await statsBody({ recordKind: 'framework_agreement' });
    expect(body).toContain("record_kind = 'framework_agreement'");
  });

  it('does not reference the unavailable framework_role column in compatibility mode', async () => {
    const body = await statsBody({});
    expect(body).not.toContain('framework_role');
  });

  it('defensively refuses an explicit framework role without querying ClickHouse', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(emptyStatsResponse());
    vi.stubGlobal('fetch', fetchSpy);
    const repo = makeClickhouseAnalysisRepo(
      { url: 'http://clickhouse.test', database: 'proto' },
      activeGeneration
    );
    const result = await repo.statsFor(
      route('contract'),
      { frameworkRole: 'framework_ceiling' },
      GEN
    );
    expect(result._unsafeUnwrap().rows).toBe('0');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('never applies the role predicate to grains that have no such column', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(emptyStatsResponse());
    vi.stubGlobal('fetch', fetchSpy);
    const repo = makeClickhouseAnalysisRepo(
      { url: 'http://clickhouse.test', database: 'proto' },
      activeGeneration
    );
    for (const grain of ['direct_acquisition', 'procedure'] as const) {
      fetchSpy.mockClear();
      await repo.statsFor(route(grain), {}, GEN);
      const request = fetchSpy.mock.calls[0]?.[1] as { body?: string } | undefined;
      expect(request?.body ?? '').not.toContain('framework_role');
    }
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

    const result = await repo.breakdownFor(route('contract'), {}, GEN, 'cpvGroup', 3300, 'count');

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
    await repo.statsFor(route('contract'), {}, GEN);
    const body = bodyOf(fetchSpy);
    expect(body).toContain('value_awarded_attributed_bani');
    expect(body).not.toContain('value_awarded_supplier_bani');
  });

  it('supplier-scoped contract stats aggregate SUPPLIER money (M1 invariant)', async () => {
    const { repo, fetchSpy } = makeRepo();
    await repo.statsFor(route('contract'), { supplierCui: '123' }, GEN);
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
    await repo.statsFor(route('contract'), { supplierCui: '123' }, GEN);
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
    await repo.statsFor(route('contract'), {}, GEN);
    const body = bodyOf(fetchSpy);
    expect(body).toContain('NULL AS withheld_bani_out');
  });

  it('supplier breakdown totals AND buckets share the supplier-money basis', async () => {
    const { repo, fetchSpy } = makeRepo();
    await repo.breakdownFor(route('contract'), {}, GEN, 'supplier', 10, 'value');
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
    await repo.breakdownFor(route('contract'), {}, GEN, 'authority', 10, 'value');
    for (let i = 0; i < fetchSpy.mock.calls.length; i += 1) {
      expect(bodyOf(fetchSpy, i)).toContain('value_awarded_attributed_bani');
    }
  });

  it('concentration always uses supplier money (association money never enters HHI)', async () => {
    const { repo, fetchSpy } = makeRepo();
    await repo.concentrationFor(route('contract'), {}, GEN, 'value');
    for (let i = 0; i < fetchSpy.mock.calls.length; i += 1) {
      const body = bodyOf(fetchSpy, i);
      if (body.includes('sumIf')) expect(body).toContain('value_awarded_supplier_bani');
    }
  });

  it('DA grain is untouched by the association flip (raw awarded column)', async () => {
    const { repo, fetchSpy } = makeRepo();
    await repo.statsFor(route('direct_acquisition'), { supplierCui: '123' }, GEN);
    expect(bodyOf(fetchSpy)).toContain('value_awarded_bani');
  });
});

describe('party place anchors and withheld identities', () => {
  const makeRepo = (fetchSpy: ReturnType<typeof vi.fn>): AnalysisRepo => {
    vi.stubGlobal('fetch', fetchSpy);
    return makeClickhouseAnalysisRepo(
      { url: 'http://clickhouse.test', database: 'proto' },
      activeGeneration
    );
  };
  const bodyOf = (fetchSpy: ReturnType<typeof vi.fn>, call = 0): string =>
    (fetchSpy.mock.calls[call]?.[1] as { body?: string } | undefined)?.body ?? '';

  it('matches a SIRUTA exactly: a UAT, a sector, or a county node (its own institutions)', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(emptyStatsResponse());
    const repo = makeRepo(fetchSpy);
    await repo.statsFor(route('contract'), { buyerSiruta: '179132' }, GEN);
    await repo.statsFor(route('contract'), { buyerSiruta: '179141' }, GEN);
    await repo.statsFor(route('contract'), { buyerSiruta: '323' }, GEN);
    expect(bodyOf(fetchSpy, 0)).toContain('buyer_siruta_uat = 179132');
    expect(bodyOf(fetchSpy, 0)).not.toContain('179141');
    expect(bodyOf(fetchSpy, 1)).toContain('buyer_siruta_uat = 179141');
    expect(bodyOf(fetchSpy, 2)).toContain('buyer_siruta_uat = 323');
  });

  it('combines a buyer place and a supplier place as one conjunction', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(emptyStatsResponse());
    const repo = makeRepo(fetchSpy);
    await repo.statsFor(
      route('direct_acquisition'),
      { buyerCounty: 'SB', supplierRegion: 'Bucuresti-Ilfov' },
      GEN
    );
    const body = bodyOf(fetchSpy);
    expect(body).toContain("buyer_county_code = 'SB'");
    expect(body).toContain("supplier_region = 'Bucuresti-Ilfov'");
    expect(body).toContain('(supplier_cui IS NOT NULL AND length(supplier_cui) <= 10)');
  });

  it('does not add the supplier identity guard to a buyer-only place filter', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(emptyStatsResponse());
    const repo = makeRepo(fetchSpy);
    await repo.statsFor(route('direct_acquisition'), { buyerRegion: 'Centru' }, GEN);
    expect(bodyOf(fetchSpy)).not.toContain('supplier_cui');
  });

  it.each(['supplier', 'supplierCounty', 'supplierRegion', 'supplierSiruta', 'authority'])(
    'keys a %s breakdown so a withheld identity falls into the unknown bucket',
    async (dimension) => {
      const fetchSpy = vi
        .fn()
        .mockResolvedValueOnce(emptyStatsResponse())
        .mockResolvedValueOnce(compactResponse([{ cnt: '0', wv: '0', awarded_bani: '0' }]))
        .mockResolvedValueOnce(compactResponse([], ['key', 'cnt', 'wv', 'awarded_bani']));
      const repo = makeRepo(fetchSpy);
      const result = await repo.breakdownFor(route('contract'), {}, GEN, dimension, 10, 'count');
      expect(result.isOk()).toBe(true);
      const party = dimension === 'authority' ? 'authority_cui' : 'supplier_cui';
      const guard = `if((${party} IS NOT NULL AND length(${party}) <= 10),`;
      expect(bodyOf(fetchSpy, 1)).toContain(guard);
      expect(bodyOf(fetchSpy, 2)).toContain(guard);
    }
  );
});

describe('analysis records read', () => {
  const recordRow = {
    id: '17',
    date: '2025-11-03',
    title: 'Furnituri de birou',
    authority_cui: '4270740',
    authority_name: 'Primaria Sibiu',
    supplier_cui: '14399840',
    supplier_name: 'Firma SRL',
    value_bani: '123456',
    status: 'finalized',
    record_kind: null,
    cpv_code: '30192700',
  };
  const makeRepo = (fetchSpy: ReturnType<typeof vi.fn>): AnalysisRepo => {
    vi.stubGlobal('fetch', fetchSpy);
    return makeClickhouseAnalysisRepo(
      { url: 'http://clickhouse.test', database: 'proto' },
      activeGeneration
    );
  };
  const bodies = (fetchSpy: ReturnType<typeof vi.fn>): string[] =>
    fetchSpy.mock.calls.map((call) => (call[1] as { body?: string } | undefined)?.body ?? '');

  it('reads the page and the total over the stats WHERE plus its dated predicate', async () => {
    const fetchSpy = vi.fn((_url: string, request: RequestInit) =>
      Promise.resolve(
        typeof request.body === 'string' && request.body.includes('AS total')
          ? compactResponse([{ total: '3948' }])
          : compactResponse([recordRow])
      )
    );
    const repo = makeRepo(fetchSpy);
    const scope = {
      grain: 'direct_acquisition' as const,
      buyerCounty: 'SB',
      from: '2025-11',
      to: '2025-11',
    };
    const result = await repo.recordsFor(route('direct_acquisition'), scope, GEN, {
      sort: 'value_desc',
      offset: 25,
      limit: 25,
    });
    const read = result._unsafeUnwrap();
    expect(read.total).toBe('3948');
    expect(read.rows).toEqual([
      {
        id: '17',
        date: '2025-11-03',
        title: 'Furnituri de birou',
        authorityCui: '4270740',
        authorityName: 'Primaria Sibiu',
        supplierCui: '14399840',
        supplierName: 'Firma SRL',
        valueRon: '1234.56',
        status: 'finalized',
        recordKind: null,
        cpvCode: '30192700',
      },
    ]);
    const [page, total] = bodies(fetchSpy);
    const dated =
      "(NOT is_undated AND date_basis >= toDate('2025-11-01') AND date_basis < addMonths(toDate('2025-11-01'), 1))";
    for (const body of [page, total]) {
      expect(body).toMatch(/FROM facts_da_v2\s+WHERE is_canonical/u);
      expect(body).toContain("buyer_county_code = 'SB'");
      expect(body).toContain(`AND ${dated}`);
    }
    // Money is the anchor money the figures sum, and orders the value sort.
    const money = `if(value_state IN ('official_exact', 'official_ron_equivalent', 'cross_source_exact', 'official_document_recovered'), value_awarded_bani, NULL)`;
    expect(page).toContain(`toString(${money}) AS value_bani`);
    expect(page).toContain(`ORDER BY ${money} DESC NULLS LAST, da_id DESC`);
    expect(page).toContain('LIMIT 25 OFFSET 25');
    // Village-level supplier location is never read.
    expect(page).not.toContain('supplier_siruta_locality');
  });

  it('orders contracts by date with the pk tiebreak and reads their record kind', async () => {
    const fetchSpy = vi.fn((_url: string, request: RequestInit) =>
      Promise.resolve(
        typeof request.body === 'string' && request.body.includes('AS total')
          ? compactResponse([{ total: '0' }])
          : compactResponse([], Object.keys(recordRow))
      )
    );
    const repo = makeRepo(fetchSpy);
    await repo.recordsFor(route('contract'), { grain: 'contract' }, GEN, {
      sort: 'date_desc',
      offset: 0,
      limit: 25,
    });
    const [page] = bodies(fetchSpy);
    expect(page).toContain('record_kind AS record_kind');
    expect(page).toContain('ORDER BY is_undated ASC, date_sort DESC, contract_id DESC');
    expect(page).toContain('value_awarded_attributed_bani');
  });

  it('reads a blank title as no title, so the display title can stand in', async () => {
    const fetchSpy = vi.fn((_url: string, request: RequestInit) =>
      Promise.resolve(
        typeof request.body === 'string' && request.body.includes('AS total')
          ? compactResponse([{ total: '1' }])
          : compactResponse([{ ...recordRow, title: '   ' }])
      )
    );
    const repo = makeRepo(fetchSpy);
    const result = await repo.recordsFor(route('contract'), { grain: 'contract' }, GEN, {
      sort: 'date_desc',
      offset: 0,
      limit: 25,
    });
    expect(result._unsafeUnwrap().rows[0]?.title).toBeNull();
  });

  it('answers an impossible scope with an empty page without querying', async () => {
    const fetchSpy = vi.fn();
    const repo = makeRepo(fetchSpy);
    const result = await repo.recordsFor(
      route('contract'),
      { grain: 'contract', supplierSiruta: 'CJ' },
      GEN,
      { sort: 'date_desc', offset: 0, limit: 25 }
    );
    expect(result._unsafeUnwrap()).toEqual({ total: '0', rows: [] });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
