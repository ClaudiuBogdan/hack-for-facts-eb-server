/** Publication admission regressions share the actual content-pinned INS DDL fixture. */
import { sql, type Kysely } from 'kysely';
import { expect } from 'vitest';

import { listLatestValues, listObservations } from '@/modules/ins-native/core/usecases.js';
import { datasetPublicationFrom } from '@/modules/ins-native/shell/repo/publication.js';

import { inInsFixture as inFixture } from './ins-native-fixture.js';

import type { ProdDatabase } from '@/modules/shared/index.js';

type RegisterCase = (name: string, fn: () => Promise<void>) => void;

const mismatches: readonly (readonly [string, string])[] = [
  [
    'tuple arity',
    "update ins.dataset_geo_tuples set geo_pairs='[[2,3075]]' where dataset_code='POPTEST' and territory_id=931",
  ],
  [
    'tuple dimension order coherence',
    "update ins.dataset_geo_tuples set geo_pairs='[[1,3075],[3,931]]' where dataset_code='POPTEST' and territory_id=931",
  ],
  [
    'geographic physical mapping',
    "update ins.dataset_geo_dimensions set slot_index=1 where dataset_code='POPTEST' and dim_index=2",
  ],
  ['missing coverage', "delete from ins.dataset_coverage where dataset_code='POPTEST'"],
  [
    'positive geography without tuples',
    "delete from ins.dataset_geo_tuples where dataset_code='POPTEST'; update ins.dataset_coverage set geo_tuple_count=0 where dataset_code='POPTEST'",
  ],
  [
    'logical completeness',
    "update ins.datasets set current_unresolved_rows=1 where dataset_code='POPTEST'",
  ],
  [
    'source custody',
    "update ins.datasets set pivot_custody_sha256=repeat('c',64) where dataset_code='POPTEST'",
  ],
  [
    'custody algorithm',
    "update ins.datasets set pivot_custody_algo=1 where dataset_code='POPTEST'",
  ],
  [
    'request count',
    "update ins.datasets set pivot_custody_requests=2 where dataset_code='POPTEST'",
  ],
  [
    'applied generation',
    "update ins.datasets set pivot_custody_applied_generation=2 where dataset_code='POPTEST'",
  ],
  [
    'applied rows',
    "update ins.datasets set pivot_custody_applied_rows=134 where dataset_code='POPTEST'",
  ],
  [
    'catalog generation',
    "insert into ins.harvest_generations(generation_id,matrix_code,metadata_sha256,dimension_fingerprint,source_url) values (4,'POPTEST',repeat('b',64),repeat('b',64),'http://x/new-generation'); update ins.datasets set generation_id=4 where dataset_code='POPTEST'",
  ],
  ['catalog rows', "update ins.datasets set rows_loaded=134 where dataset_code='POPTEST'"],
  [
    'coverage custody',
    "update ins.dataset_coverage set custody_sha256=repeat('c',64) where dataset_code='POPTEST'",
  ],
  [
    'coverage rows',
    "update ins.dataset_coverage set observation_count=134 where dataset_code='POPTEST'",
  ],
  ['missing revision', "delete from ins.dataset_revisions where dataset_code='POPTEST'"],
  [
    'unsupported transform',
    "update ins.dataset_revisions set transform_contract_sha256=repeat('c',64) where dataset_code='POPTEST'",
  ],
  [
    'unbuilt geography',
    "update ins.dataset_coverage set geo_contract_version=null,geo_dimension_count=null,geo_tuple_count=null,geo_rule_count=null where dataset_code='POPTEST'",
  ],
  [
    'unsupported geography version',
    "update ins.dataset_coverage set geo_contract_version='future-version' where dataset_code='POPTEST'",
  ],
  [
    'dimension count',
    "update ins.dataset_coverage set geo_dimension_count=3 where dataset_code='POPTEST'",
  ],
  ['tuple count', "update ins.dataset_coverage set geo_tuple_count=6 where dataset_code='POPTEST'"],
  ['rule count', "update ins.dataset_coverage set geo_rule_count=1 where dataset_code='POPTEST'"],
  [
    'missing tuple',
    "delete from ins.dataset_geo_tuples where dataset_code='POPTEST' and territory_id=1",
  ],
  [
    'dimension custody',
    "update ins.dataset_geo_dimensions set custody_sha256=repeat('c',64) where dataset_code='POPTEST'",
  ],
  [
    'tuple custody',
    "update ins.dataset_geo_tuples set custody_sha256=repeat('c',64) where dataset_code='POPTEST'",
  ],
  [
    'dimension contract',
    "update ins.dataset_geo_dimensions set contract_version='future-version' where dataset_code='POPTEST'",
  ],
  [
    'tuple contract',
    "update ins.dataset_geo_tuples set contract_version='future-version' where dataset_code='POPTEST'",
  ],
  [
    'unknown flag',
    "update ins.dataset_geo_tuples set flags=array['unknown'] where dataset_code='POPTEST'",
  ],
  [
    'defect flag',
    "update ins.dataset_geo_tuples set flags=array['unmanifested'] where dataset_code='POPTEST'",
  ],
  [
    'unreviewed role',
    "update ins.dataset_geo_dimensions set role='unreviewed' where dataset_code='POPTEST'",
  ],
  [
    'invalid nested role shape',
    "update ins.dataset_geo_dimensions set role='nested_parent' where dataset_code='POPTEST'",
  ],
  [
    'incoherent tuple',
    "update ins.dataset_geo_tuples set resolution='INCOHERENT',territory_id=null,has_modern_facts=false,has_incoherent_facts=true where dataset_code='POPTEST'",
  ],
];

export const registerInsPublicationCases = (
  it: RegisterCase,
  getDb: () => Kysely<ProdDatabase>
): void => {
  for (const [name, mutation] of mismatches) {
    it(`publication: ${name} disables facts but preserves catalog metadata`, async () => {
      await inFixture(getDb(), async (trx, repo) => {
        expect((await repo.getDataset('POPTEST'))._unsafeUnwrap()?.dataStatus).toBe('AVAILABLE');
        await sql.raw(mutation).execute(trx); // Fixed test fixture SQL, never external input.
        const row = (await repo.getDataset('POPTEST'))._unsafeUnwrap();
        expect(row).toMatchObject({
          code: 'POPTEST',
          nameRo: 'Populația după domiciliu',
          sourceUrl: 'http://x/matrix/POPTEST',
          dataStatus: 'CATALOG_ONLY',
          publicationStatus: 'UNCERTIFIED',
          observationCount: null,
          yearRange: null,
          computedAt: null,
          custodySha256: null,
          revisionId: null,
          transformContractSha256: null,
          publishedAt: null,
          hasLau: false,
          hasCounty: false,
        });
        expect(
          (await repo.listDatasets({}, 20, 0))._unsafeUnwrap().nodes.map((d) => d.code)
        ).toEqual(['CNTTEST']);
        const beyond = (
          await repo.listDatasets({ dataStatus: ['CATALOG_ONLY'] }, 2, 100)
        )._unsafeUnwrap();
        expect(beyond.nodes).toEqual([]);
        expect(beyond.totalCount).toBe(2);
        expect((await repo.datasetsForTerritory(931))._unsafeUnwrap()).toEqual([]);
        expect(
          (await listObservations(repo, 'POPTEST', { territoryCodes: ['CJ'] }))._unsafeUnwrapErr()
            .type
        ).toBe('ServiceUnavailable');
        expect(
          (
            await repo.listObservations({
              datasetCode: 'POPTEST',
              geoScope: { kind: 'modern', levels: ['LAU'] },
              pinGroups: [new Map([[1, [1]]])],
              limit: 1,
              offset: 0,
            })
          )._unsafeUnwrapErr().type
        ).toBe('ServiceUnavailable');
        expect(
          (
            await repo.readDefaultSeries(
              [
                {
                  key: 'p',
                  datasetCode: 'POPTEST',
                  nonGeographicPins: new Map([
                    [1, 1],
                    [2, 105],
                  ]),
                  geoScope: { kind: 'modern', territoryIds: [931] },
                  unitNomItemId: 9685,
                },
              ],
              1
            )
          )._unsafeUnwrapErr().type
        ).toBe('ServiceUnavailable');
      });
    });
  }

  it('publication: one uncertified dataset fails an explicitly named latest-values batch', async () => {
    await inFixture(getDb(), async (trx, repo) => {
      await sql`update ins.dataset_revisions set transform_contract_sha256=repeat('c',64) where dataset_code='POPTEST'`.execute(
        trx
      );
      const result = await listLatestValues(repo, { territoryCode: 'RO' }, ['CNTTEST', 'POPTEST']);
      expect(result._unsafeUnwrapErr().type).toBe('ServiceUnavailable');
      expect((await repo.listDatasets({ hasUatData: true }, 20, 0))._unsafeUnwrap().nodes).toEqual(
        []
      );
    });
  });

  it('publication: latest revision id wins despite an older timestamp and supported predecessor', async () => {
    await inFixture(getDb(), async (trx, repo) => {
      const before = (await repo.getDataset('POPTEST'))._unsafeUnwrap();
      await sql`insert into ins.dataset_revisions
        (dataset_code,to_custody_sha256,to_custody_algo,to_custody_requests,to_applied_generation,
         transform_contract_sha256,rows_before,rows_after,coordinates_added,coordinates_removed,
         coordinates_changed,after_fact_digest_sha256,load_run_id,applied_at)
        select dataset_code,to_custody_sha256,to_custody_algo,to_custody_requests,to_applied_generation,
          repeat('c',64),rows_after,rows_after,0,0,0,after_fact_digest_sha256,load_run_id,applied_at-interval '1 day'
        from ins.dataset_revisions where dataset_code='POPTEST'`.execute(trx);
      expect((await repo.getDataset('POPTEST'))._unsafeUnwrap()?.dataStatus).toBe('CATALOG_ONLY');
      await sql`update ins.dataset_revisions set transform_contract_sha256=${before?.transformContractSha256}
        where dataset_code='POPTEST'`.execute(trx);
      const after = (await repo.getDataset('POPTEST'))._unsafeUnwrap();
      expect(after?.dataStatus).toBe('AVAILABLE');
      expect(after?.custodySha256).toBe(before?.custodySha256);
      expect(after?.revisionId).not.toBe(before?.revisionId);
    });
  });

  it('publication: empty allowlist and absent schema fail closed', async () => {
    await inFixture(getDb(), async (trx, repo) => {
      const rows = await sql<{
        facts_ready: boolean;
      }>`select publication.facts_ready ${datasetPublicationFrom([])}`.execute(trx);
      expect(rows.rows.every((r) => !r.facts_ready)).toBe(true);
      await sql`alter table ins.dataset_geo_tuples rename to unavailable_geo_tuples`.execute(trx);
      expect((await repo.getDataset('POPTEST'))._unsafeUnwrapErr().type).toBe('ServiceUnavailable');
    });
  });

  it('publication: explicit zero geography is certified and historical quarantine does not block completeness', async () => {
    await inFixture(getDb(), async (trx, repo) => {
      await sql`delete from ins.dataset_geo_tuples where dataset_code='CNTTEST'`.execute(trx);
      await sql`delete from ins.dataset_geo_dimensions where dataset_code='CNTTEST'`.execute(trx);
      await sql`update ins.dataset_coverage set geo_dimension_count=0,geo_tuple_count=0,
        has_county=false,has_region=false,has_national=false where dataset_code='CNTTEST'`.execute(
        trx
      );
      await sql`update ins.datasets set rows_quarantined=5 where dataset_code='CNTTEST'`.execute(
        trx
      );
      expect((await repo.getDataset('CNTTEST'))._unsafeUnwrap()).toMatchObject({
        dataStatus: 'AVAILABLE',
        observationCount: 12,
      });
    });
  });

  it('publication: compatible contextual and unresolved coordinates remain discoverable', async () => {
    await inFixture(getDb(), async (trx, repo) => {
      await sql`update ins.dataset_geo_tuples set resolution='CONTEXTUAL',context_territory_id=territory_id,
        territory_id=null,has_modern_facts=false,has_qualified_facts=true,flags=array['includes_sai']
        where dataset_code='POPTEST' and territory_id=25`.execute(trx);
      await sql`update ins.dataset_geo_tuples set resolution='UNRESOLVED',territory_id=null,has_modern_facts=false
        where dataset_code='POPTEST' and territory_id=14`.execute(trx);
      expect((await repo.getDataset('POPTEST'))._unsafeUnwrap()?.dataStatus).toBe('AVAILABLE');
    });
  });

  it('publication: rule stamps are required even when all tuple stamps match', async () => {
    await inFixture(getDb(), async (trx, repo) => {
      await sql`insert into ins.geo_tuple_rules
        (dataset_code,geo_pairs,rule_id,applies_from,applies_to,flag,kind,evidence_url,rationale,contract_version,custody_sha256)
        select dataset_code,geo_pairs,'synthetic-history','1990-01-01','1999-12-31','includes_ilfov_historical',
          'coverage','https://example.test/source','synthetic fixture',contract_version,custody_sha256
        from ins.dataset_geo_tuples where dataset_code='POPTEST' and territory_id=25`.execute(trx);
      await sql`update ins.dataset_coverage set geo_rule_count=1 where dataset_code='POPTEST'`.execute(
        trx
      );
      expect((await repo.getDataset('POPTEST'))._unsafeUnwrap()?.dataStatus).toBe('AVAILABLE');
      await sql`update ins.geo_tuple_rules set custody_sha256=repeat('c',64)`.execute(trx);
      expect((await repo.getDataset('POPTEST'))._unsafeUnwrap()?.dataStatus).toBe('CATALOG_ONLY');
    });
  });

  it('publication: periodicity fallback, false geography filters and total counts agree', async () => {
    await inFixture(getDb(), async (trx, repo) => {
      await sql`update ins.dataset_coverage set periodicities_observed='{}' where dataset_code='POPTEST'`.execute(
        trx
      );
      const annual = (
        await repo.listDatasets({ periodicities: ['ANNUAL'] }, 20, 0)
      )._unsafeUnwrap();
      expect(annual.totalCount).toBe(2);
      expect(annual.nodes.find((d) => d.code === 'POPTEST')?.periodicities).toEqual(['ANNUAL']);
      const filter = { hasUatData: false, dataStatus: ['AVAILABLE', 'CATALOG_ONLY'] as const };
      expect(
        (await repo.listDatasets(filter, 20, 0))._unsafeUnwrap().nodes.map((d) => d.code)
      ).toEqual(['CNTTEST', 'EMPTYTEST']);
      expect((await repo.listDatasets(filter, 1, 99))._unsafeUnwrap().totalCount).toBe(2);
    });
  });

  it('publication: never-loaded and unknown datasets retain empty semantics', async () => {
    await inFixture(getDb(), async (_trx, repo) => {
      expect((await repo.getDataset('EMPTYTEST'))._unsafeUnwrap()).toMatchObject({
        publicationStatus: 'NOT_LOADED',
        observationCount: null,
      });
      for (const code of ['EMPTYTEST', 'UNKNOWN']) {
        expect((await listObservations(repo, code, {}))._unsafeUnwrap().nodes).toEqual([]);
      }
      expect(
        (await listLatestValues(repo, { territoryCode: 'RO' }, ['EMPTYTEST']))._unsafeUnwrap()[0]
          ?.matchStrategy
      ).toBe('NO_DATA');
    });
  });
};
