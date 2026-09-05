/** These cases hydrate actual SQL rows against the content-pinned producer DDL. */
import { sql, type Kysely } from 'kysely';
import { expect } from 'vitest';

import { listObservations } from '@/modules/ins-native/core/usecases.js';
import {
  makeInsLegacyResolvers,
  type GqlObservation,
} from '@/modules/ins-native/shell/graphql/legacy/resolvers.js';
import { makeInsMcpTools } from '@/modules/ins-native/shell/mcp/tools.js';

import { inInsFixture } from './ins-native-fixture.js';

import type { InsFactQuery } from '@/modules/ins-native/core/types.js';
import type { ProdDatabase } from '@/modules/shared/index.js';

type RegisterCase = (name: string, fn: () => Promise<void>) => void;
const query: InsFactQuery = {
  datasetCode: 'POPTEST',
  geoScope: {
    kind: 'explicitSource',
    pairs: [
      [
        [2, 3075],
        [3, 931],
      ],
    ],
  },
  pinGroups: [
    new Map([
      [1, [1]],
      [2, [105]],
      [3, [3075]],
      [4, [931]],
    ]),
  ],
  unitNomItemIds: [9685],
  limit: 10,
  offset: 0,
};
const historicalRule = sql`
  insert into ins.geo_tuple_rules(dataset_code,geo_pairs,rule_id,applies_from,applies_to,
    flag,kind,evidence_url,rationale,contract_version,custody_sha256)
  values('POPTEST','[[2,3075],[3,931]]','test-history','2019-01-01','2020-12-31',
    'includes_ilfov_historical','coverage','https://statistici.insse.ro/test-methodology',
    'Test source methodology interval','ins-geography-v1',repeat('b',64));
  update ins.dataset_geo_tuples set has_qualified_facts=true
    where dataset_code='POPTEST' and geo_pairs='[[2,3075],[3,931]]';
  update ins.dataset_coverage set geo_rule_count=1 where dataset_code='POPTEST';`;

export const registerInsGeographyCases = (
  it: RegisterCase,
  database: () => Kysely<ProdDatabase>
): void => {
  it('geography selection rejects an internal modern scope without an explicit bound', () =>
    inInsFixture(database(), async (_trx, repo) => {
      const result = await repo.listObservations({ ...query, geoScope: { kind: 'modern' } });
      expect(result._unsafeUnwrapErr().type).toBe('ServiceUnavailable');
    }));

  it('geography selection applies rules to actual cell periods and preserves explicit source access', () =>
    inInsFixture(database(), async (trx, repo) => {
      await historicalRule.execute(trx);
      const modern = (
        await listObservations(repo, 'POPTEST', {
          sirutaCodes: ['54975'],
          classificationValueCodes: ['TOTAL'],
        })
      )._unsafeUnwrap().nodes;
      expect(modern.map((r) => r.period.periodStart)).toEqual(['2021-01-01']);
      const old = (
        await listObservations(repo, 'POPTEST', {
          territoryLevels: ['LAU'],
          classificationValueCodes: ['TOTAL'],
          period: { start: '2019', end: '2020' },
        })
      )._unsafeUnwrap().nodes;
      expect(old).toHaveLength(2);
      expect(old.every((r) => r.territory?.code === '1017')).toBe(true);
      const original = (
        await listObservations(repo, 'POPTEST', {
          classificationValueCodes: ['1', '105', '3075', '931'],
        })
      )._unsafeUnwrap().nodes;
      expect(original).toHaveLength(3);
      expect(original.filter((r) => r.geography?.qualified === true)).toHaveLength(2);
      // Even complete source pins do not bypass an explicitly requested modern scope.
      const intersection = (
        await listObservations(repo, 'POPTEST', {
          territoryCodes: ['54975'],
          classificationValueCodes: ['1', '105', '3075', '931'],
        })
      )._unsafeUnwrap().nodes;
      expect(intersection).toHaveLength(1);
      await sql`update ins.observations set period_start='2020-12-31'
        where dataset_code='POPTEST' and time_nom_item_id=4437`.execute(trx);
      const overlapping = (
        await listObservations(repo, 'POPTEST', {
          territoryCodes: ['54975'],
          classificationValueCodes: ['TOTAL'],
        })
      )._unsafeUnwrap().nodes;
      expect(overlapping).toEqual([]);
    }));

  for (const [flag, count] of [
    ['includes_sai', 0],
    ['spelling_variant', 3],
  ] as const) {
    it(`geography selection distinguishes coverage and label flag ${flag}`, () =>
      inInsFixture(database(), async (trx, repo) => {
        await sql`update ins.dataset_geo_tuples set flags=${[flag]}::text[]
          where dataset_code='POPTEST' and territory_id=931`.execute(trx);
        const modern = (
          await listObservations(repo, 'POPTEST', {
            territoryCodes: ['54975'],
            classificationValueCodes: ['TOTAL'],
          })
        )._unsafeUnwrap().nodes;
        expect(modern).toHaveLength(count);
        expect((await repo.listObservations(query))._unsafeUnwrap().nodes).toHaveLength(3);
      }));
  }
  for (const resolution of ['CONTEXTUAL', 'UNRESOLVED'] as const) {
    it(`geography selection excludes ${resolution} from modern nodes and levels`, () =>
      inInsFixture(database(), async (trx, repo) => {
        await sql`update ins.dataset_geo_tuples set resolution=${resolution},territory_id=null,
          context_territory_id=${resolution === 'CONTEXTUAL' ? 25 : null},has_modern_facts=false
          where dataset_code='POPTEST' and geo_pairs='[[2,3075],[3,931]]'`.execute(trx);
        expect(
          (
            await listObservations(repo, 'POPTEST', {
              territoryCodes: ['54975'],
              classificationValueCodes: ['TOTAL'],
            })
          )._unsafeUnwrap().nodes
        ).toEqual([]);
        const levels = (
          await listObservations(repo, 'POPTEST', {
            territoryLevels: ['LAU'],
            classificationValueCodes: ['TOTAL'],
          })
        )._unsafeUnwrap().nodes;
        expect(levels).toHaveLength(3);
        expect(levels.every((r) => r.territory?.code === '1017')).toBe(true);
        expect((await repo.listObservations(query))._unsafeUnwrap().nodes).toHaveLength(3);
      }));
  }
  it('geography selection lists every exact source tuple for a node without merging values', () =>
    inInsFixture(database(), async (trx, repo) => {
      await sql`update ins.dataset_geo_tuples set territory_id=931
        where dataset_code='POPTEST' and geo_pairs='[[2,3065],[3,113]]'`.execute(trx);
      const rows = (
        await listObservations(repo, 'POPTEST', {
          territoryCodes: ['54975'],
          classificationValueCodes: ['TOTAL'],
        })
      )._unsafeUnwrap().nodes;
      expect(rows).toHaveLength(6);
      expect(new Set(rows.map((r) => JSON.stringify(r.geography?.pairs))).size).toBe(2);
      expect(new Set(rows.map((r) => JSON.stringify(r.coordinate))).size).toBe(6);
    }));
  it('geography selection requires complete explicit pins, and never interprets implicit TOTAL as source access', () =>
    inInsFixture(database(), async (_trx, repo) => {
      for (const classificationValueCodes of [
        ['TOTAL'],
        ['931'],
        ['3075'],
        ['3075', '3065', '931'],
      ]) {
        const result = await listObservations(repo, 'POPTEST', { classificationValueCodes });
        expect(result._unsafeUnwrapErr().type).toBe('InvalidInput');
      }
      const national = (
        await listObservations(repo, 'POPTEST', {
          classificationTypeCodes: ['D0', 'D1', 'D2', 'D3'],
          classificationValueCodes: ['TOTAL'],
        })
      )._unsafeUnwrap().nodes;
      expect(national).toHaveLength(3);
      expect(national.every((r) => r.territory?.code === 'RO')).toBe(true);
      // Both members exist, but this complete source combination was never observed.
      const absent = (
        await listObservations(repo, 'POPTEST', {
          classificationValueCodes: ['1', '105', '3065', '931'],
        })
      )._unsafeUnwrap().nodes;
      expect(absent).toEqual([]);
    }));
  it('geography selection permits national non-geographic data and rejects lower-level attribution', () =>
    inInsFixture(database(), async (trx, repo) => {
      await sql`delete from ins.dataset_geo_tuples where dataset_code='CNTTEST';
        delete from ins.dataset_geo_dimensions where dataset_code='CNTTEST';
        update ins.dataset_coverage set geo_dimension_count=0,geo_tuple_count=0 where dataset_code='CNTTEST'`.execute(
        trx
      );
      for (const territoryCodes of [undefined, ['RO'], ['RO', 'CJ']]) {
        const rows = (
          await listObservations(repo, 'CNTTEST', {
            ...(territoryCodes === undefined ? {} : { territoryCodes }),
            classificationValueCodes: ['8000'],
            unitCodes: ['9507'],
          })
        )._unsafeUnwrap().nodes;
        expect(rows).toHaveLength(2);
        expect(rows.every((r) => r.territory === null && r.geography === null)).toBe(true);
      }
      for (const filter of [{ territoryCodes: ['CJ'] }, { territoryLevels: ['LAU'] as const }]) {
        expect(
          (
            await listObservations(repo, 'CNTTEST', {
              ...filter,
              classificationValueCodes: ['8000'],
              unitCodes: ['9507'],
            })
          )._unsafeUnwrap().nodes
        ).toEqual([]);
      }
    }));

  it('geography hydration preserves whole source coordinates and exact modern identity', () =>
    inInsFixture(database(), async (_trx, repo) => {
      const page = (await repo.listObservations(query))._unsafeUnwrap();
      expect(page.nodes).toHaveLength(3);
      for (const row of page.nodes) {
        expect(row.geography).toMatchObject({
          pairs: [
            [2, 3075],
            [3, 931],
          ],
          resolution: 'EXACT',
          qualified: false,
          applicableRules: [],
        });
        expect(row.territory?.code).toBe('54975');
        expect(row.members.map((m) => m.dimIndex)).toEqual([0, 1, 2, 3]);
        expect(typeof row.value).toBe('string');
        expect(row.unit.scaleFactor).toBe('1');
      }
    }));

  it('geography hydration qualifies inclusive historical boundaries without changing source identity', () =>
    inInsFixture(database(), async (trx, repo) => {
      await historicalRule.execute(trx);
      const rows = (await repo.listObservations(query))._unsafeUnwrap().nodes;
      expect(rows.map((r) => r.period.periodStart)).toEqual([
        '2021-01-01',
        '2020-01-01',
        '2019-01-01',
      ]);
      expect(rows.map((r) => r.territory?.code ?? null)).toEqual(['54975', null, null]);
      expect(rows.map((r) => r.geography?.applicableRules.length)).toEqual([0, 1, 1]);
      expect(rows[1]?.geography?.resolvedTerritory?.code).toBe('54975');
      expect(rows[1]?.geography?.applicableRules[0]?.evidenceUrl).toBe(
        'https://statistici.insse.ro/test-methodology'
      );
    }));

  it('geography hydration qualifies a range cell when any part overlaps the source rule', () =>
    inInsFixture(database(), async (trx, repo) => {
      await historicalRule.execute(trx);
      await sql`update ins.observations set period_start='2020-12-31'
        where dataset_code='POPTEST' and time_nom_item_id=4437;
        update ins.periods set periodicity='RANGE' where period_id=30`.execute(trx);
      const row = (await repo.listObservations(query))._unsafeUnwrap().nodes[0];
      expect(row?.period.periodicity).toBe('RANGE');
      expect(row?.territory).toBeNull();
      expect(row?.geography?.applicableRules).toHaveLength(1);
    }));

  for (const resolution of ['CONTEXTUAL', 'UNRESOLVED'] as const) {
    it(`geography hydration preserves ${resolution} cells without borrowing a member's territory`, () =>
      inInsFixture(database(), async (trx, repo) => {
        await sql`update ins.dataset_geo_tuples set resolution=${resolution},territory_id=null,
          context_territory_id=${resolution === 'CONTEXTUAL' ? 25 : null},has_modern_facts=false
          where dataset_code='POPTEST' and geo_pairs='[[2,3075],[3,931]]'`.execute(trx);
        const rows = (await repo.listObservations(query))._unsafeUnwrap().nodes;
        expect(rows).toHaveLength(3);
        expect(
          rows.every((r) => r.territory === null && r.geography?.resolution === resolution)
        ).toBe(true);
        expect(rows[0]?.members.at(-1)?.territory?.code).toBe('54975');
        expect(rows[0]?.geography?.contextTerritory?.code ?? null).toBe(
          resolution === 'CONTEXTUAL' ? 'CJ' : null
        );
      }));
  }

  it('geography hydration never treats a TOTAL member as a national interpretation', () =>
    inInsFixture(database(), async (trx, repo) => {
      await sql`update ins.dataset_geo_tuples set resolution='CONTEXTUAL',territory_id=null,
        context_territory_id=25,has_modern_facts=false,flags='{includes_sai}'
        where dataset_code='POPTEST' and geo_pairs='[[2,3064],[3,112]]'`.execute(trx);
      const rows = (
        await repo.listObservations({
          ...query,
          geoScope: {
            kind: 'explicitSource',
            pairs: [
              [
                [2, 3064],
                [3, 112],
              ],
            ],
          },
          pinGroups: [
            new Map([
              [3, [3064]],
              [4, [112]],
            ]),
          ],
        })
      )._unsafeUnwrap().nodes;
      expect(rows.length).toBeGreaterThan(0);
      expect(
        rows.every((r) => r.territory === null && r.geography?.contextTerritory?.code === 'CJ')
      ).toBe(true);
    }));

  for (const [flag, qualified] of [
    ['spelling_variant', false],
    ['includes_sai', true],
  ] as const) {
    it(`geography hydration respects ${flag} flag semantics`, () =>
      inInsFixture(database(), async (trx, repo) => {
        await sql`update ins.dataset_geo_tuples set flags=${[flag]}::text[]
          where dataset_code='POPTEST' and geo_pairs='[[2,3075],[3,931]]'`.execute(trx);
        const row = (await repo.listObservations(query))._unsafeUnwrap().nodes[0];
        expect(row?.geography?.qualified).toBe(qualified);
        expect(row?.territory?.code ?? null).toBe(qualified ? null : '54975');
      }));
  }

  it('geography hydration retains confidential and unavailable cells with stable coordinates', () =>
    inInsFixture(database(), async (trx, repo) => {
      const before = (await repo.listObservations(query))._unsafeUnwrap().nodes;
      await sql`update ins.observations set value=null,value_status='c'
        where dataset_code='POPTEST' and time_nom_item_id=4437`.execute(trx);
      const after = (await repo.listObservations(query))._unsafeUnwrap().nodes;
      expect(after.map((r) => r.coordinate)).toEqual(before.map((r) => r.coordinate));
      expect(after[0]?.value).toBeNull();
      expect(after[0]?.valueStatus).toBe('c');
      expect(after[0]?.geography).toEqual(before[0]?.geography);
    }));

  const defects: readonly (readonly [string, string])[] = [
    [
      'unregistered complete pair',
      "delete from ins.dataset_geo_tuples where dataset_code='POPTEST' and geo_pairs='[[2,3075],[3,931]]'; update ins.dataset_coverage set geo_tuple_count=4 where dataset_code='POPTEST'",
    ],
    [
      'missing classification member',
      "delete from ins.dataset_dimension_members where dataset_code='POPTEST' and dim_index=0 and nom_item_id=2",
    ],
    ['missing measure', "delete from ins.measures where dataset_code='POPTEST'"],
    [
      'wrong geographic physical slot',
      "update ins.dataset_geo_dimensions set slot_index=1 where dataset_code='POPTEST' and dim_index=2",
    ],
    [
      'undeclared populated slot',
      "update ins.observations set dim5_member_id=999 where dataset_code='POPTEST'",
    ],
  ];
  for (const [name, mutation] of defects) {
    it(`geography hydration fails the page for ${name} instead of dropping rows`, () =>
      inInsFixture(database(), async (trx, repo) => {
        await sql.raw(mutation).execute(trx);
        const result = await repo.listObservations({
          ...query,
          pinGroups: [
            new Map([
              [1, [2]],
              [2, [105]],
              [3, [3075]],
              [4, [931]],
            ]),
          ],
        });
        expect(result.isErr()).toBe(true);
        if (result.isErr()) expect(result.error.type).toBe('ServiceUnavailable');
      }));
  }

  it('geography dimensions use published declarations, not individual picker bindings', () =>
    inInsFixture(database(), async (trx, repo) => {
      await sql`delete from ins.dataset_geo_tuples where dataset_code='CNTTEST';
        delete from ins.dataset_geo_dimensions where dataset_code='CNTTEST';
        update ins.dataset_coverage set geo_dimension_count=0,geo_tuple_count=0 where dataset_code='CNTTEST'`.execute(
        trx
      );
      expect((await repo.listDimensions('CNTTEST'))._unsafeUnwrap()[0]?.isTerritorial).toBe(false);
      const rows = (
        await repo.listObservations({
          datasetCode: 'CNTTEST',
          geoScope: { kind: 'nonGeographic' },
          pinGroups: [new Map([[1, [8000]]])],
          limit: 10,
          offset: 0,
        })
      )._unsafeUnwrap().nodes;
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r) => r.geography === null && r.territory === null)).toBe(true);
    }));
  it('geography hydration retains distinct source pairs sharing a child without deduplication', () =>
    inInsFixture(database(), async (trx, repo) => {
      await sql`insert into ins.dataset_geo_tuples(dataset_code,geo_pairs,resolution,flags,
        has_modern_facts,has_qualified_facts,has_incoherent_facts,contract_version,custody_sha256)
        values('POPTEST','[[2,3065],[3,931]]','UNRESOLVED','{}',false,false,false,'ins-geography-v1',repeat('b',64));
        insert into ins.observations(dataset_code,dim1_member_id,dim2_member_id,dim3_member_id,dim4_member_id,
          time_nom_item_id,unit_nom_item_id,period_id,period_start,period_end,value,response_id)
        values('POPTEST',1,105,3065,931,4437,9685,30,'2021-01-01','2021-12-31',301105,1);
        update ins.dataset_coverage set observation_count=136,geo_tuple_count=6 where dataset_code='POPTEST';
        update ins.datasets set rows_loaded=136,pivot_custody_applied_rows=136 where dataset_code='POPTEST';
        update ins.dataset_revisions set rows_after=136,coordinates_added=136 where dataset_code='POPTEST'`.execute(
        trx
      );
      const rows = (
        await repo.listObservations({
          ...query,
          geoScope: {
            kind: 'explicitSource',
            pairs: [
              [
                [2, 3075],
                [3, 931],
              ],
              [
                [2, 3065],
                [3, 931],
              ],
            ],
          },
          pinGroups: [
            new Map([
              [1, [1]],
              [2, [105]],
              [4, [931]],
            ]),
          ],
        })
      )._unsafeUnwrap().nodes;
      expect(rows).toHaveLength(4);
      expect(new Set(rows.map((r) => JSON.stringify(r.coordinate))).size).toBe(4);
      const sameYear = rows.filter((r) => r.period.periodStart === '2021-01-01');
      expect(sameYear).toHaveLength(2);
      expect(sameYear.map((r) => r.geography?.pairs)).toEqual([
        [
          [2, 3065],
          [3, 931],
        ],
        [
          [2, 3075],
          [3, 931],
        ],
      ]);
      expect(sameYear.map((r) => r.territory?.code ?? null)).toEqual([null, '54975']);
    }));

  it('geography hydration rejects a null member in an expected classification slot', () =>
    inInsFixture(database(), async (trx, repo) => {
      await sql`update ins.observations set dim1_member_id=null where dataset_code='POPTEST' and dim1_member_id=2`.execute(
        trx
      );
      const result = await repo.listObservations({
        ...query,
        pinGroups: [
          new Map([
            [2, [105]],
            [3, [3075]],
            [4, [931]],
          ]),
        ],
      });
      expect(result.isErr()).toBe(true);
      if (result.isErr()) expect(result.error.type).toBe('ServiceUnavailable');
    }));

  it('geography hydration exposes identical qualifications through GraphQL JSON and MCP', () =>
    inInsFixture(database(), async (trx, repo) => {
      await historicalRule.execute(trx);
      const roots = makeInsLegacyResolvers({ repo })['Query'] as Record<
        string,
        (parent: unknown, args: unknown, context: unknown) => Promise<{ nodes: GqlObservation[] }>
      >;
      const resolver = roots['insObservations'];
      if (resolver === undefined) throw new Error('observation resolver missing');
      const graphql = await resolver(
        null,
        {
          datasetCode: 'POPTEST',
          filter: {
            classificationTypeCodes: ['D0', 'D1', 'D2', 'D3'],
            classificationValueCodes: ['1', '105', '3075', '931'],
          },
          limit: 10,
        },
        {}
      );
      const tool = makeInsMcpTools({ repo, clientBaseUrl: 'https://example.test' }).find(
        (t) => t.name === 'get_ins_series'
      );
      if (tool === undefined) throw new Error('series tool missing');
      const mcp = await tool.handler({
        datasetCode: 'POPTEST',
        classificationTypeCodes: ['D0', 'D1', 'D2', 'D3'],
        classificationValueCodes: ['1', '105', '3075', '931'],
        limit: 10,
      });
      expect(mcp.ok).toBe(true);
      const items = mcp.items as readonly Record<string, unknown>[];
      expect(items.map((i) => i['geography'])).toEqual(
        graphql.nodes.map((r) => r.dimensions['geography'])
      );
      expect(items).toHaveLength(3);
      expect(graphql.nodes.filter((r) => r.territory === null)).toHaveLength(2);
      expect(items.filter((r) => r['territory'] === null)).toHaveLength(2);
    }));
  it('geography hydration agrees with the pinned producer pair ordering constraint', () =>
    inInsFixture(database(), async (trx) => {
      const result = await sql<{ ordered: boolean; reversed: boolean; duplicate: boolean }>`
        select ins.geo_pairs_valid('[[2,3075],[3,931]]'::jsonb) ordered,
        ins.geo_pairs_valid('[[3,931],[2,3075]]'::jsonb) reversed,
        ins.geo_pairs_valid('[[2,3075],[2,931]]'::jsonb) duplicate`.execute(trx);
      expect(result.rows[0]).toEqual({ ordered: true, reversed: false, duplicate: false });
    }));

  it('geography hydration relies on the pinned producer constraint rejecting EXACT without a node', () =>
    inInsFixture(database(), async (trx) => {
      await expect(
        sql`update ins.dataset_geo_tuples set territory_id=null
        where dataset_code='POPTEST' and resolution='EXACT'`.execute(trx)
      ).rejects.toMatchObject({ code: '23514', constraint: 'geo_tuples_effective_only_exact' });
    }));

  it('geography hydration preserves fractional numeric values exactly', () =>
    inInsFixture(database(), async (trx, repo) => {
      await sql`update ins.observations set value='1234567890123.456789'
        where dataset_code='POPTEST' and time_nom_item_id=4437`.execute(trx);
      const row = (await repo.listObservations(query))._unsafeUnwrap().nodes[0];
      expect(row?.value).toBe('1234567890123.456789');
    }));

  it('geography hydration rejects nonfinite observation dates', () =>
    inInsFixture(database(), async (trx, repo) => {
      await sql`update ins.observations set period_end='infinity'
        where dataset_code='POPTEST' and time_nom_item_id=4437`.execute(trx);
      const result = await repo.listObservations(query);
      expect(result.isErr()).toBe(true);
      if (result.isErr()) expect(result.error.type).toBe('ServiceUnavailable');
    }));
};
