/**
 * The native INS repo's SQL and read policy, pinned over the capturing driver
 * (no DB) before the plan's WP5 relocates the module (codebase plan §WP3):
 *  - every read opens a repeatable-read snapshot and sets `read only`, the
 *    30 s statement timeout and `jit = off` before its first statement; a
 *    composed snapshot adds the 35 s transaction timeout and shares one
 *    transaction across reads;
 *  - the driver-error mapping of the per-read runner (timeout / missing
 *    schema / publication signal / anything else);
 *  - `listObservations`: publication guard first, then the full flattened
 *    fact statement with every period narrowing (`periodStart`, `periodEnd`,
 *    `periodRanges`, `periodicities`, `periodIds`, `hasValue`), pins, units,
 *    `limit + 1`; hydration's member-territory join and its statement order;
 *  - `readDefaultSeries`: the candidate and winner statements, NO_DATA without
 *    a candidate, AMBIGUOUS_GEOGRAPHY with two;
 *  - `listDatasets`: one publication relation and one predicate for the page
 *    and for the count fallback.
 */

import { describe, expect, it } from 'vitest';

import { makeInsRepo, withInsReadSnapshot } from '@/modules/ins-native/shell/repo/ins-repo.js';
import { InsPublicationUnavailable } from '@/modules/ins-native/shell/repo/publication-error.js';
import {
  INS_GEOGRAPHY_VERSION,
  INS_SUPPORTED_TRANSFORMS,
} from '@/modules/ins-native/shell/repo/publication.js';
import {
  INS_READ_TIMEOUT_MS,
  INS_TRANSACTION_TIMEOUT_MS,
} from '@/modules/ins-native/shell/repo/snapshot.js';

import { makeCapturingDb, type CapturedQuery } from '../../fixtures/capturing-db.js';

import type { InsFactQuery } from '@/modules/ins-native/core/types.js';
import type { TransactionSettings } from 'kysely';

const flat = (s: string): string => s.replace(/\s+/gu, ' ').trim();

const DATASET = 'POPTEST';

/**
 * Which relation a captured statement reads: the discriminator the scripted
 * rows key on. Order matters where texts overlap (candidates/winners before
 * facts; the hydration node read before the territory queries). An unknown
 * statement is `other`, which `world` refuses, so a changed statement fails
 * loud instead of answering no rows.
 */
const reads = (sql: string): string => {
  const f = flat(sql);
  if (f.startsWith('set ')) return f;
  if (f.includes('publication.facts_ready') && f.includes('where d.dataset_code = any('))
    return 'publicationGuard';
  if (f.includes('count(*) over() as total from ins.datasets d')) return 'datasetPage';
  if (f.startsWith('select count(*)::text as n from ins.datasets d')) return 'datasetCount';
  if (f.includes('from ins.datasets d') && /where d\.dataset_code = \$\d+$/u.test(f))
    return 'datasetOne';
  if (f.includes('from ins.contexts c where')) return 'contexts';
  if (f.startsWith('select dataset_code, dim_index, slot_index from ins.dataset_geo_dimensions'))
    return 'geoDimensions';
  if (f.includes('from ins.dataset_dimensions dd left join ins.dataset_geo_dimensions gd'))
    return 'layouts';
  if (f.startsWith('select dataset_code, unit_nom_item_id from ins.measures')) return 'layoutUnits';
  if (f.includes('candidates order by series_key')) return 'candidates';
  if (f.includes(') o order by o.series_key')) return 'winners';
  if (f.includes('from ins.observations o')) return 'facts';
  if (
    f.includes(
      "from ins.dataset_dimensions where dataset_code = any($1::text[]) and semantic_role = 'classification'"
    )
  )
    return 'classificationSlots';
  if (f.includes('from ins.dataset_dimension_members m')) return 'members';
  if (f.includes('from ins.measures ms')) return 'units';
  if (f.includes('from ins.dataset_geo_tuples g join jsonb_to_recordset')) return 'geoTuples';
  if (f.includes('from ins.geo_tuple_rules r join jsonb_to_recordset')) return 'geoRules';
  if (
    f.includes('from ins.territory_nodes t left join ins.territory_nodes p') &&
    f.includes('where t.territory_id in (')
  )
    return 'nodes';
  return 'other';
};

const FACT = {
  dataset_code: DATASET,
  dim1_member_id: 1,
  dim2_member_id: 500,
  dim3_member_id: null,
  dim4_member_id: null,
  dim5_member_id: null,
  dim6_member_id: null,
  dim7_member_id: null,
  time_nom_item_id: 77,
  unit_nom_item_id: 9685,
  period_id: 7,
  period_start: '2019-01-01',
  period_end: '2019-12-31',
  currency_code: null,
  value: '710001',
  value_status: null,
  periodicity: 'ANNUAL',
  period_label_ro: 'Anul 2019',
};

const NODE_25 = {
  territory_id: '25',
  code: 'CJ',
  siruta_code: null,
  level: 'NUTS3',
  name_ro: 'Cluj',
  parent_id: '6',
  core_territory_id: 42,
  parent_code: 'RO11',
  parent_name_ro: 'Nord-Vest',
};

const member = (dimIndex: number, nomItemId: number, labelRo: string, territory = false) => ({
  dataset_code: DATASET,
  dim_index: dimIndex,
  dim_label_ro: `Dim ${String(dimIndex)}`,
  dim_label_en: null,
  nom_item_id: nomItemId,
  ordinal: 1,
  member_role: dimIndex === 0 ? 'TOTAL' : 'LEAF',
  label_override: null,
  parent_nom_item_id: null,
  label_ro: labelRo,
  label_en: null,
  territory_resolution: territory ? 'EXACT' : null,
  ...(territory
    ? NODE_25
    : {
        territory_id: null,
        code: null,
        siruta_code: null,
        level: null,
        name_ro: null,
        parent_id: null,
        core_territory_id: null,
        parent_code: null,
        parent_name_ro: null,
      }),
});

const UNIT = {
  dataset_code: DATASET,
  unit_nom_item_id: 9685,
  unit_label_ro: 'Numar persoane',
  label_en: 'Persons',
  base_unit: null,
  scale_factor: '1',
  unit_kind: 'non-monetary',
  regime: null,
};

/**
 * One published dataset with two classification dimensions: dim 0 on slot 1
 * (non-geographic) and dim 2 on slot 2 (geographic, one EXACT tuple on node 25).
 */
const world = (
  over: Partial<Record<string, (parameters: readonly unknown[]) => readonly unknown[]>> = {}
): ((sql: string, parameters: readonly unknown[]) => readonly unknown[]) => {
  const rows: Record<string, (parameters: readonly unknown[]) => readonly unknown[]> = {
    publicationGuard: (parameters) =>
      (parameters[6] as string[]).map((code) => ({ dataset_code: code, facts_ready: true })),
    geoDimensions: () => [{ dataset_code: DATASET, dim_index: 2, slot_index: 2 }],
    layouts: () => [
      { dataset_code: DATASET, dim_index: 0, slot_index: 1, geographic: false },
      { dataset_code: DATASET, dim_index: 2, slot_index: 2, geographic: true },
    ],
    layoutUnits: () => [{ dataset_code: DATASET, unit_nom_item_id: 9685 }],
    classificationSlots: () => [
      { dataset_code: DATASET, dim_index: 0, slot_index: 1 },
      { dataset_code: DATASET, dim_index: 2, slot_index: 2 },
    ],
    members: () => [member(0, 1, 'Total'), member(2, 500, 'Cluj', true)],
    units: () => [UNIT],
    geoTuples: () => [
      {
        dataset_code: DATASET,
        geo_pairs: [[2, 500]],
        resolution: 'EXACT',
        flags: [],
        territory_id: '25',
        context_territory_id: null,
      },
    ],
    geoRules: () => [],
    nodes: () => [NODE_25],
    ...over,
  };
  return (sql, parameters) => {
    const relation = reads(sql);
    if (relation === 'other') throw new Error(`unrouted statement: ${flat(sql).slice(0, 100)}`);
    return rows[relation]?.(parameters) ?? [];
  };
};

const harness = (
  respond: (sql: string, parameters: readonly unknown[]) => readonly unknown[] = world()
) => {
  const captured: CapturedQuery[] = [];
  const transactions: TransactionSettings[] = [];
  const db = makeCapturingDb(captured, {
    respond,
    onBeginTransaction: (settings) => transactions.push(settings),
  });
  return { captured, transactions, db, repo: makeInsRepo(db) };
};

const factQuery = (over: Partial<InsFactQuery> = {}): InsFactQuery => ({
  datasetCode: DATASET,
  geoScope: { kind: 'modern', territoryIds: [25] },
  pinGroups: [],
  limit: 10,
  offset: 0,
  ...over,
});

const PUBLICATION_PARAMETERS = [
  INS_GEOGRAPHY_VERSION,
  INS_GEOGRAPHY_VERSION,
  ['includes_sai', 'spelling_variant'],
  INS_GEOGRAPHY_VERSION,
  [...INS_SUPPORTED_TRANSFORMS],
  INS_GEOGRAPHY_VERSION,
];

describe('ins repo: snapshot policy', () => {
  it('opens a repeatable-read snapshot and sets read only, the read timeout and jit off first', async () => {
    const { captured, transactions, repo } = harness();
    (await repo.getDataset(DATASET))._unsafeUnwrap();
    expect(transactions).toEqual([{ isolationLevel: 'repeatable read' }]);
    expect(captured.slice(0, 3).map((c) => flat(c.sql))).toEqual([
      'set transaction read only',
      `set local statement_timeout = ${String(INS_READ_TIMEOUT_MS)}`,
      'set local jit = off',
    ]);
    expect(captured.slice(0, 3).map((c) => c.parameters)).toEqual([[], [], []]);
    expect(INS_READ_TIMEOUT_MS).toBe(30_000);
  });

  it('opens one snapshot per plain read, but one for every read inside withSnapshot', async () => {
    const plain = harness();
    await plain.repo.getDataset(DATASET);
    await plain.repo.listUnits(DATASET);
    expect(plain.transactions).toHaveLength(2);
    expect(plain.captured.filter((c) => reads(c.sql) === 'set transaction read only')).toHaveLength(
      2
    );

    const bound = harness();
    const outcome = await bound.repo.withSnapshot(async (repo) => {
      expect((await repo.getDataset(DATASET)).isOk()).toBe(true);
      expect((await repo.listUnits(DATASET)).isOk()).toBe(true);
      // Nesting stays on the same snapshot.
      return repo.withSnapshot((inner) => inner.listContexts({}, 1, 0));
    });
    expect(outcome.isOk()).toBe(true);
    expect(bound.captured.map((c) => reads(c.sql)).slice(3)).toEqual([
      'datasetOne',
      'units',
      'contexts',
    ]);
    expect(bound.transactions).toHaveLength(1);
    expect(bound.captured.filter((c) => reads(c.sql) === 'set transaction read only')).toHaveLength(
      1
    );
  });

  it('a composed read snapshot adds the transaction timeout as its fourth statement', async () => {
    const { captured, transactions, db } = harness();
    const outcome = await withInsReadSnapshot(db, async ({ repo }) => {
      expect((await repo.listUnits(DATASET)).isOk()).toBe(true);
      return repo.getDataset(DATASET);
    });
    expect(outcome.isOk()).toBe(true);
    expect(transactions).toEqual([{ isolationLevel: 'repeatable read' }]);
    expect(captured.map((c) => reads(c.sql)).slice(4)).toEqual(['units', 'datasetOne']);
    expect(captured.slice(0, 4).map((c) => flat(c.sql))).toEqual([
      'set transaction read only',
      `set local statement_timeout = ${String(INS_READ_TIMEOUT_MS)}`,
      'set local jit = off',
      `set local transaction_timeout = ${String(INS_TRANSACTION_TIMEOUT_MS)}`,
    ]);
    expect(INS_TRANSACTION_TIMEOUT_MS).toBe(35_000);
  });
});

describe('ins repo: driver-error mapping of the per-read runner', () => {
  const failing = (error: unknown) =>
    harness((sql, parameters) => {
      if (reads(sql) === 'facts') throw error;
      return world()(sql, parameters);
    });

  it('maps a statement timeout to Timeout, by SQLSTATE or by message', async () => {
    for (const error of [
      Object.assign(new Error('canceling statement'), { code: '57014' }),
      new Error('canceling statement due to statement timeout'),
    ]) {
      const { repo } = failing(error);
      expect((await repo.listObservations(factQuery()))._unsafeUnwrapErr()).toEqual({
        type: 'Timeout',
        message: 'ins repository timed out: listObservations',
      });
    }
  });

  it('maps a missing relation or column to ServiceUnavailable', async () => {
    for (const code of ['42P01', '42703']) {
      const { repo } = failing(Object.assign(new Error('missing'), { code }));
      expect((await repo.listObservations(factQuery()))._unsafeUnwrapErr()).toEqual({
        type: 'ServiceUnavailable',
        message: 'INS serving schema is unavailable',
      });
    }
  });

  it('maps the publication signal to ServiceUnavailable with its message', async () => {
    const { repo } = failing(new InsPublicationUnavailable());
    expect((await repo.listObservations(factQuery()))._unsafeUnwrapErr()).toEqual({
      type: 'ServiceUnavailable',
      message: 'INS dataset publication is unavailable',
    });
  });

  it('maps anything else to Database with the cause attached', async () => {
    const cause = new Error('connection reset');
    const { repo } = failing(cause);
    expect((await repo.listObservations(factQuery()))._unsafeUnwrapErr()).toEqual({
      type: 'Database',
      message: 'ins repository failed: listObservations',
      cause,
    });
  });
});

describe('ins repo: listObservations', () => {
  it('asserts the publication of the dataset before reading any fact', async () => {
    const { captured, repo } = harness(world({ publicationGuard: () => [] }));
    expect((await repo.listObservations(factQuery()))._unsafeUnwrapErr()).toEqual({
      type: 'ServiceUnavailable',
      message: 'INS dataset publication is unavailable',
    });
    const guard = captured.find((c) => reads(c.sql) === 'publicationGuard');
    expect(guard?.parameters).toEqual([...PUBLICATION_PARAMETERS, [DATASET]]);
    expect(flat(guard?.sql ?? '')).toMatch(
      /^select d\.dataset_code, publication\.facts_ready from ins\.datasets d left join ins\.dataset_coverage c on c\.dataset_code = d\.dataset_code .* where d\.dataset_code = any\(\$7::text\[\]\)$/u
    );
    expect(flat(guard?.sql ?? '')).toContain(
      'r.transform_contract_sha256 = any($5::text[]) and c.custody_sha256 = d.pivot_custody_sha256'
    );
    expect(captured.map((c) => reads(c.sql))).not.toContain('facts');

    // A catalog row that is not facts-ready is not a publication either.
    const notReady = harness(
      world({ publicationGuard: () => [{ dataset_code: DATASET, facts_ready: false }] })
    );
    expect((await notReady.repo.listObservations(factQuery())).isErr()).toBe(true);
  });

  it('narrows facts by geography, pins, units and every period selector; reads limit + 1', async () => {
    const { captured, repo } = harness();
    const result = (
      await repo.listObservations(
        factQuery({
          geoScope: { kind: 'modern', territoryIds: [25], levels: ['NUTS3'] },
          pinGroups: [new Map([[1, [1, 2]]])],
          unitNomItemIds: [9685],
          periodStart: '2019-01-01',
          periodEnd: '2021-12-31',
          periodRanges: [{ start: '2019-01-01', end: '2019-12-31' }],
          periodicities: ['ANNUAL'],
          periodIds: [7, 8],
          hasValue: true,
          limit: 10,
          offset: 20,
        })
      )
    )._unsafeUnwrap();
    // Offset past the end of an unknown population: the count is unknown, not 20.
    expect(result).toEqual({
      nodes: [],
      totalCount: null,
      hasNextPage: false,
      hasPreviousPage: true,
    });
    const facts = captured.find((c) => reads(c.sql) === 'facts');
    expect(flat(facts?.sql ?? '')).toBe(
      'select o.dataset_code, o.dim1_member_id, o.dim2_member_id, o.dim3_member_id, o.dim4_member_id, o.dim5_member_id, o.dim6_member_id, o.dim7_member_id, o.time_nom_item_id, o.unit_nom_item_id, o.period_id, o.period_start, o.period_end, o.currency_code, o.value, o.value_status, pe.periodicity, pe.label_ro as period_label_ro ' +
        'from ins.observations o join ins.periods pe on pe.period_id = o.period_id ' +
        'where o.dataset_code = $1 ' +
        'and exists (select 1 from ins.dataset_geo_tuples g where g.dataset_code=$2 and "o"."dim2_member_id" = (g.geo_pairs->0->>1)::int ' +
        "and g.resolution = 'EXACT' and not (g.flags && $3::text[]) and g.territory_id = any($4::bigint[]) " +
        'and exists (select 1 from ins.territory_nodes tn where tn.territory_id=g.territory_id and tn.level=any($5::text[])) ' +
        'and not exists ( select 1 from ins.geo_tuple_rules qr where qr.dataset_code=g.dataset_code and qr.geo_pairs=g.geo_pairs and o.period_start <= qr.applies_to and o.period_end >= qr.applies_from)) ' +
        'and (("o"."dim1_member_id" in ($6, $7))) and o.unit_nom_item_id in ($8) ' +
        'and o.period_end >= $9::date and o.period_start <= $10::date ' +
        'and ((o.period_end >= $11::date and o.period_start <= $12::date)) ' +
        'and pe.periodicity in ($13) and o.period_id in ($14, $15) and o.value is not null ' +
        'order by o.period_end desc, o.period_start desc, o.dim1_member_id, o.dim2_member_id, o.dim3_member_id, o.dim4_member_id, o.dim5_member_id, o.dim6_member_id, o.dim7_member_id, o.time_nom_item_id, o.unit_nom_item_id ' +
        'limit $16 offset $17'
    );
    expect(facts?.parameters).toEqual([
      DATASET,
      DATASET,
      ['includes_sai'],
      [25],
      ['NUTS3'],
      1,
      2,
      9685,
      '2019-01-01',
      '2021-12-31',
      '2019-01-01',
      '2019-12-31',
      'ANNUAL',
      7,
      8,
      11,
      20,
    ]);
  });

  it('omits every optional predicate when the query carries none; hasValue false selects nulls', async () => {
    const { captured, repo } = harness();
    (await repo.listObservations(factQuery({ hasValue: false })))._unsafeUnwrap();
    const sql = flat(captured.find((c) => reads(c.sql) === 'facts')?.sql ?? '');
    expect(sql).toContain(
      'and not exists ( select 1 from ins.geo_tuple_rules qr where qr.dataset_code=g.dataset_code and qr.geo_pairs=g.geo_pairs and o.period_start <= qr.applies_to and o.period_end >= qr.applies_from)) and o.value is null order by'
    );
    for (const fragment of [
      'o.period_end >= $',
      'o.period_start <= $',
      'pe.periodicity in',
      'o.period_id in',
      'o.unit_nom_item_id in',
      'tn.level',
    ])
      expect(sql).not.toContain(fragment);
    expect(sql).toContain('limit $5 offset $6');
  });

  it('addresses explicit source pairs directly and refuses a scope that contradicts the geography', async () => {
    const explicit = harness();
    (
      await explicit.repo.listObservations(
        factQuery({
          geoScope: {
            kind: 'explicitSource',
            pairs: [[[2, 500]], [[2, 501]]],
          },
        })
      )
    )._unsafeUnwrap();
    const sql = flat(explicit.captured.find((c) => reads(c.sql) === 'facts')?.sql ?? '');
    expect(sql).toContain(
      'where o.dataset_code = $1 and (("o"."dim2_member_id" = $2) or ("o"."dim2_member_id" = $3)) order by'
    );

    // A non-geographic scope over a dataset that HAS a geographic dimension,
    // and an explicit pair on the wrong dimension, are publication contradictions.
    for (const geoScope of [
      { kind: 'nonGeographic' } as const,
      { kind: 'explicitSource', pairs: [[[3, 500]]] } as const,
    ]) {
      const { captured, repo } = harness();
      expect((await repo.listObservations(factQuery({ geoScope })))._unsafeUnwrapErr()).toEqual({
        type: 'ServiceUnavailable',
        message: 'INS dataset publication is unavailable',
      });
      expect(captured.map((c) => reads(c.sql))).not.toContain('facts');
    }
  });

  it('hydrates a row through the member-territory join, in a fixed statement order', async () => {
    const { captured, repo } = harness(world({ facts: () => [FACT] }));
    const page = (await repo.listObservations(factQuery()))._unsafeUnwrap();
    expect(captured.map((c) => reads(c.sql))).toEqual([
      'set transaction read only',
      'set local statement_timeout = 30000',
      'set local jit = off',
      'publicationGuard',
      'geoDimensions',
      'facts',
      'classificationSlots',
      'members',
      'units',
      'geoDimensions',
      'geoTuples',
      'geoRules',
      'nodes',
    ]);

    const members = captured.find((c) => reads(c.sql) === 'members');
    expect(flat(members?.sql ?? '')).toBe(
      'select m.dataset_code, m.dim_index, dd.label_ro as dim_label_ro, dd.label_en as dim_label_en, m.nom_item_id, m.ordinal, m.member_role, m.label_override, m.parent_nom_item_id, n.label_ro, n.label_en, mt.resolution as territory_resolution, t.territory_id, t.code, t.siruta_code, t.level, t.name_ro, t.parent_id, t.core_territory_id, p.code as parent_code, p.name_ro as parent_name_ro ' +
        'from ins.dataset_dimension_members m ' +
        'join ins.dataset_dimensions dd on dd.dataset_code = m.dataset_code and dd.dim_index = m.dim_index ' +
        'join ins.nomenclature_items n on n.nom_item_id = m.nom_item_id ' +
        'left join ins.member_territory mt on mt.dataset_code = m.dataset_code and mt.dim_index = m.dim_index and mt.nom_item_id = m.nom_item_id ' +
        'left join ins.territory_nodes t on t.territory_id = mt.territory_id ' +
        'left join ins.territory_nodes p on p.territory_id = t.parent_id ' +
        'join jsonb_to_recordset($1::jsonb) as wanted(dataset_code text, dim_index int, nom_item_id int) ' +
        'on wanted.dataset_code=m.dataset_code and wanted.dim_index=m.dim_index and wanted.nom_item_id=m.nom_item_id'
    );
    expect(members?.parameters).toEqual([
      JSON.stringify([
        { dataset_code: DATASET, dim_index: 0, nom_item_id: 1 },
        { dataset_code: DATASET, dim_index: 2, nom_item_id: 500 },
      ]),
    ]);
    const tuples = captured.find((c) => reads(c.sql) === 'geoTuples');
    expect(tuples?.parameters).toEqual([
      JSON.stringify([{ dataset_code: DATASET, geo_pairs: [[2, 500]] }]),
    ]);

    expect(page.totalCount).toBe(1);
    expect(page.hasNextPage).toBe(false);
    const [view] = page.nodes;
    expect(view?.coordinate).toEqual({
      datasetCode: DATASET,
      slots: [1, 500, null, null, null, null, null],
      timeNomItemId: 77,
      unitNomItemId: 9685,
    });
    expect(
      view?.members.map((m) => [m.dimIndex, m.labelRo, m.territory?.territoryId ?? null])
    ).toEqual([
      [0, 'Total', null],
      [2, 'Cluj', 25],
    ]);
    expect(view?.members[1]?.territory).toMatchObject({
      territoryId: 25,
      code: 'CJ',
      level: 'NUTS3',
      parentId: 6,
      parentCode: 'RO11',
      coreTerritoryId: 42,
    });
    expect(view?.geography).toEqual({
      pairs: [[2, 500]],
      resolution: 'EXACT',
      flags: [],
      resolvedTerritory: expect.objectContaining({ territoryId: 25 }),
      contextTerritory: null,
      applicableRules: [],
      qualified: false,
    });
    expect(view?.territory?.territoryId).toBe(25);
    expect(view?.unit).toEqual({
      nomItemId: 9685,
      labelRo: 'Numar persoane',
      labelEn: 'Persons',
      baseUnit: null,
      scaleFactor: '1',
      unitKind: 'non-monetary',
      currencyRegime: null,
    });
    expect(view?.period).toEqual({
      periodId: 7,
      periodicity: 'ANNUAL',
      periodStart: '2019-01-01',
      periodEnd: '2019-12-31',
      labelRo: 'Anul 2019',
    });
    expect(view?.value).toBe('710001');
  });

  it('a member the catalog cannot return is a publication failure, never a partial row', async () => {
    const { repo } = harness(
      world({ facts: () => [FACT], members: () => [member(0, 1, 'Total')] })
    );
    expect((await repo.listObservations(factQuery()))._unsafeUnwrapErr()).toEqual({
      type: 'ServiceUnavailable',
      message: 'INS dataset publication is unavailable',
    });
  });
});

describe('ins repo: readDefaultSeries', () => {
  const request = {
    key: 'CJ',
    datasetCode: DATASET,
    nonGeographicPins: new Map([[1, 1]]),
    unitNomItemId: 9685,
    geoScope: { kind: 'modern', territoryIds: [25] as const },
  } as const;
  const period = {
    periodStart: '2019-01-01',
    periodEnd: '2021-12-31',
    periodicities: ['ANNUAL'] as const,
  };

  it('finds the candidate tuple per request, then reads the winner cells; both statements pinned', async () => {
    const { captured, repo } = harness(
      world({
        candidates: () => [{ series_key: 'CJ', geo_pairs: [[2, 500]] }],
        winners: () => [{ ...FACT, series_key: 'CJ' }],
      })
    );
    const [series] = (await repo.readDefaultSeries([request], 3, period))._unsafeUnwrap();
    expect(series?.status).toBe('SERIES');
    expect(series?.status === 'SERIES' ? series.observations.map((o) => o.value) : []).toEqual([
      '710001',
    ]);

    const candidates = captured.find((c) => reads(c.sql) === 'candidates');
    expect(flat(candidates?.sql ?? '')).toBe(
      'select * from ((select requested.series_key, candidate.geo_pairs from (values ($1::text, $2::bigint)) as requested(series_key, territory_id) ' +
        'cross join lateral ( select g.geo_pairs from ins.dataset_geo_tuples g where g.dataset_code=$3 ' +
        'and exists (select 1 from ins.observations o join ins.periods pe on pe.period_id=o.period_id ' +
        'where o.dataset_code=$4 and o.unit_nom_item_id=$5 and "o"."dim1_member_id"=$6 ' +
        'and "o"."dim3_member_id" is null and "o"."dim4_member_id" is null and "o"."dim5_member_id" is null and "o"."dim6_member_id" is null and "o"."dim7_member_id" is null ' +
        'and o.period_end >= $7::date and o.period_start <= $8::date and pe.periodicity = any($9::text[]) ' +
        'and "o"."dim2_member_id" = (g.geo_pairs->0->>1)::int ' +
        "and g.resolution = 'EXACT' and not (g.flags && $10::text[]) and g.territory_id = requested.territory_id " +
        'and not exists ( select 1 from ins.geo_tuple_rules qr where qr.dataset_code=g.dataset_code and qr.geo_pairs=g.geo_pairs and o.period_start <= qr.applies_to and o.period_end >= qr.applies_from)) ' +
        'order by g.geo_pairs limit 2 ) candidate)) candidates order by series_key, geo_pairs'
    );
    expect(candidates?.parameters).toEqual([
      'CJ',
      25,
      DATASET,
      DATASET,
      9685,
      1,
      '2019-01-01',
      '2021-12-31',
      ['ANNUAL'],
      ['includes_sai'],
    ]);

    const winners = captured.find((c) => reads(c.sql) === 'winners');
    expect(flat(winners?.sql ?? '')).toBe(
      'select * from ((select requested.series_key, winner.* from (values ($1::text, $2::bigint, $3::jsonb)) as requested(series_key, territory_id, geo_pairs) ' +
        'cross join lateral (select o.dataset_code, o.dim1_member_id, o.dim2_member_id, o.dim3_member_id, o.dim4_member_id, o.dim5_member_id, o.dim6_member_id, o.dim7_member_id, o.time_nom_item_id, o.unit_nom_item_id, o.period_id, o.period_start, o.period_end, o.currency_code, o.value, o.value_status, pe.periodicity, pe.label_ro as period_label_ro ' +
        'from ins.observations o join ins.periods pe on pe.period_id=o.period_id ' +
        'join ins.dataset_geo_tuples g on g.dataset_code=$4 and g.geo_pairs=requested.geo_pairs ' +
        'where o.dataset_code=$5 and o.unit_nom_item_id=$6 and "o"."dim1_member_id"=$7 ' +
        'and "o"."dim3_member_id" is null and "o"."dim4_member_id" is null and "o"."dim5_member_id" is null and "o"."dim6_member_id" is null and "o"."dim7_member_id" is null ' +
        'and o.period_end >= $8::date and o.period_start <= $9::date and pe.periodicity = any($10::text[]) ' +
        'and "o"."dim2_member_id" = (g.geo_pairs->0->>1)::int ' +
        "and g.resolution = 'EXACT' and not (g.flags && $11::text[]) and g.territory_id = requested.territory_id " +
        'and not exists ( select 1 from ins.geo_tuple_rules qr where qr.dataset_code=g.dataset_code and qr.geo_pairs=g.geo_pairs and o.period_start <= qr.applies_to and o.period_end >= qr.applies_from) ' +
        'order by o.period_end desc, o.period_start desc, o.dim1_member_id, o.dim2_member_id, o.dim3_member_id, o.dim4_member_id, o.dim5_member_id, o.dim6_member_id, o.dim7_member_id, o.time_nom_item_id, o.unit_nom_item_id limit $12 ) winner)) o ' +
        'order by o.series_key, o.period_end desc, o.period_start desc, o.dim1_member_id, o.dim2_member_id, o.dim3_member_id, o.dim4_member_id, o.dim5_member_id, o.dim6_member_id, o.dim7_member_id, o.time_nom_item_id, o.unit_nom_item_id'
    );
    expect(winners?.parameters).toEqual([
      'CJ',
      25,
      '[[2,500]]',
      DATASET,
      DATASET,
      9685,
      1,
      '2019-01-01',
      '2021-12-31',
      ['ANNUAL'],
      ['includes_sai'],
      3,
    ]);
    expect(captured.map((c) => reads(c.sql)).slice(3, 8)).toEqual([
      'publicationGuard',
      'layouts',
      'layoutUnits',
      'candidates',
      'winners',
    ]);
  });

  it('answers NO_DATA without a candidate (no winner read) and AMBIGUOUS_GEOGRAPHY with two', async () => {
    const none = harness();
    expect((await none.repo.readDefaultSeries([request], 3, period))._unsafeUnwrap()).toEqual([
      { seriesKey: 'CJ', status: 'NO_DATA', observations: [], witnesses: [] },
    ]);
    expect(none.captured.map((c) => reads(c.sql))).not.toContain('winners');

    const two = harness(
      world({
        candidates: () => [
          { series_key: 'CJ', geo_pairs: [[2, 500]] },
          { series_key: 'CJ', geo_pairs: [[2, 501]] },
        ],
      })
    );
    expect((await two.repo.readDefaultSeries([request], 3, period))._unsafeUnwrap()).toEqual([
      {
        seriesKey: 'CJ',
        status: 'AMBIGUOUS_GEOGRAPHY',
        observations: [],
        witnesses: [[[2, 500]], [[2, 501]]],
      },
    ]);
    expect(two.captured.map((c) => reads(c.sql))).not.toContain('winners');
  });

  it('a candidate without a winner row is a publication failure, not an empty series', async () => {
    const { repo } = harness(
      world({ candidates: () => [{ series_key: 'CJ', geo_pairs: [[2, 500]] }] })
    );
    expect((await repo.readDefaultSeries([request], 3, period))._unsafeUnwrapErr()).toEqual({
      type: 'ServiceUnavailable',
      message: 'INS dataset publication is unavailable',
    });
  });
});

describe('ins repo: listDatasets', () => {
  it('pages over the publication relation with one predicate, and counts with the same one when the page is empty', async () => {
    const { captured, repo } = harness(world({ datasetCount: () => [{ n: '0' }] }));
    const page = (
      await repo.listDatasets(
        {
          codes: [' pop107d '],
          search: 'popul%',
          contextCode: 'C1',
          rootContextCode: 'R',
          periodicities: ['ANNUAL'],
          dataStatus: ['AVAILABLE'],
          hasUatData: true,
          hasCountyData: false,
        },
        5,
        10
      )
    )._unsafeUnwrap();
    expect(page).toEqual({ nodes: [], totalCount: 0, hasNextPage: false, hasPreviousPage: true });

    const [pageRead, countRead] = ['datasetPage', 'datasetCount'].map((kind) =>
      captured.find((c) => reads(c.sql) === kind)
    );
    const where =
      'where true and d.dataset_code in ($7) ' +
      "and coalesce(c.name_search, lower(d.matrix_name_ro) || ' ' || lower(d.dataset_code)) like $8 " +
      'and d.context_code = $9 ' +
      "and d.context_path like (select r.path from ins.contexts r where r.context_code = $10) || '%' " +
      'and case when publication.facts_ready and cardinality(c.periodicities_observed) > 0 then c.periodicities_observed else d.periodicities end && array[$11]::text[] ' +
      'and publication.facts_ready ' +
      'and (publication.facts_ready and coalesce(c.has_lau, false)) = $12 ' +
      'and (publication.facts_ready and coalesce(c.has_county, false)) = $13';
    const filterParameters = ['POP107D', '%popul\\%%', 'C1', 'R', 'ANNUAL', true, false];
    expect(flat(pageRead?.sql ?? '')).toMatch(
      /^select d\.dataset_code, d\.matrix_name_ro, .*, ctx\.name_ro as context_name_ro, ctx\.name_en as context_name_en, count\(\*\) over\(\) as total from ins\.datasets d left join ins\.dataset_coverage c on c\.dataset_code = d\.dataset_code /u
    );
    expect(flat(pageRead?.sql ?? '')).toContain(
      `${where} order by d.dataset_code limit $14 offset $15`
    );
    expect(pageRead?.parameters).toEqual([...PUBLICATION_PARAMETERS, ...filterParameters, 5, 10]);
    expect(flat(countRead?.sql ?? '')).toMatch(
      /^select count\(\*\)::text as n from ins\.datasets d /u
    );
    expect(flat(countRead?.sql ?? '').endsWith(where)).toBe(true);
    expect(countRead?.parameters).toEqual([...PUBLICATION_PARAMETERS, ...filterParameters]);

    // The relation (joins + publication lateral) is byte-identical between the two.
    const relation = (sql: string): string =>
      flat(sql).slice(flat(sql).indexOf(' from ins.datasets d '), flat(sql).indexOf(' where true'));
    expect(relation(countRead?.sql ?? '')).toBe(relation(pageRead?.sql ?? ''));
    expect(relation(pageRead?.sql ?? '')).toContain(
      'r.transform_contract_sha256 = any($5::text[]) and c.custody_sha256 = d.pivot_custody_sha256 and c.observation_count = r.rows_after'
    );
  });

  it('defaults to published datasets only; CATALOG_ONLY alone selects the unpublished', async () => {
    const plain = harness();
    await plain.repo.listDatasets({}, 5, 0);
    expect(flat(plain.captured.find((c) => reads(c.sql) === 'datasetPage')?.sql ?? '')).toContain(
      'where true and publication.facts_ready order by d.dataset_code limit $7 offset $8'
    );
    const catalog = harness();
    await catalog.repo.listDatasets({ dataStatus: ['CATALOG_ONLY'] }, 5, 0);
    expect(flat(catalog.captured.find((c) => reads(c.sql) === 'datasetPage')?.sql ?? '')).toContain(
      'where true and not (publication.facts_ready) order by d.dataset_code'
    );
    const both = harness();
    await both.repo.listDatasets({ dataStatus: ['AVAILABLE', 'CATALOG_ONLY'] }, 5, 0);
    expect(flat(both.captured.find((c) => reads(c.sql) === 'datasetPage')?.sql ?? '')).toContain(
      'where true order by d.dataset_code'
    );
  });
});
