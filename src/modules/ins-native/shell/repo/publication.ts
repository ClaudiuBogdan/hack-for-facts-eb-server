import { sql, type RawBuilder } from 'kysely';

import { InsPublicationUnavailable } from './publication-error.js';

import type { Trx } from './snapshot.js';

/** Exact transform bytes reviewed with the complete-coordinate producer (669746b5).
 * A new source custody can use this contract; a changed transform needs review.
 * This is not a Git SHA, and an unsupported latest revision never falls back.
 */
export const INS_SUPPORTED_TRANSFORMS = [
  '9eea2017d660a114bd404ebe30b1b8c45cbed84f4069018d43bd5814f6c490fc',
] as const;
export const INS_GEO_FLAG_KINDS: Readonly<Record<string, 'coverage' | 'label'>> = {
  includes_sai: 'coverage',
  spelling_variant: 'label',
};
export const INS_SUPPORTED_GEO_FLAGS = Object.keys(INS_GEO_FLAG_KINDS);
export const INS_GEOGRAPHY_VERSION = 'ins-geography-v1';

/** Small, dataset-keyed catalog checks. Publication gates validate the facts;
 * requests validate the publication stamps, never recount the fact partitions.
 * Keep this relation shared by row selection, filtering, counting and admission.
 */
export const datasetPublicationFrom = (
  supportedTransforms: readonly string[] = INS_SUPPORTED_TRANSFORMS
): RawBuilder<unknown> => sql`
  from ins.datasets d
  left join ins.dataset_coverage c on c.dataset_code = d.dataset_code
  left join ins.contexts ctx on ctx.context_code = d.context_code
  left join lateral (
    select r.* from ins.dataset_revisions r
    where r.dataset_code = d.dataset_code
    order by r.revision_id desc limit 1
  ) r on true
  cross join lateral (
    select count(*) as n,
      count(*) filter (where g.role = 'single') as singles,
      count(*) filter (where g.role = 'nested_parent') as parents,
      count(*) filter (where g.role = 'nested_child') as children,
      coalesce(bool_and(g.custody_sha256 = d.pivot_custody_sha256
        and g.contract_version = ${INS_GEOGRAPHY_VERSION}
        and g.privacy_class = 'public'
        and g.role in ('single','nested_parent','nested_child')), true) as valid
    from ins.dataset_geo_dimensions g where g.dataset_code = d.dataset_code
  ) gd
  cross join lateral (
    select count(*) as n,
      coalesce(bool_and(g.custody_sha256 = d.pivot_custody_sha256
        and g.contract_version = ${INS_GEOGRAPHY_VERSION}
        and g.privacy_class = 'public'
        and g.resolution in ('EXACT','CONTEXTUAL','UNRESOLVED')
        and not g.has_incoherent_facts
        and g.flags <@ ${INS_SUPPORTED_GEO_FLAGS}::text[]), true) as valid
    from ins.dataset_geo_tuples g where g.dataset_code = d.dataset_code
  ) gt
  cross join lateral (
    select count(*) as n,
      coalesce(bool_and(g.custody_sha256 = d.pivot_custody_sha256
        and g.contract_version = ${INS_GEOGRAPHY_VERSION}
        and g.privacy_class = 'public'
        and g.kind = 'coverage' and g.flag = 'includes_ilfov_historical'), true) as valid
    from ins.geo_tuple_rules g where g.dataset_code = d.dataset_code
  ) gr
  cross join lateral (
    select (
      d.is_complete
      and d.pivot_custody_algo = 2
      and d.pivot_custody_sha256 ~ '^[0-9a-f]{64}$'
      and d.pivot_custody_requests is not null
      and d.pivot_custody_applied_generation is not null
      and d.pivot_custody_applied_rows is not null
      and d.pivot_custody_sha256 = r.to_custody_sha256
      and d.pivot_custody_algo = r.to_custody_algo
      and d.pivot_custody_requests = r.to_custody_requests
      and d.pivot_custody_applied_generation = r.to_applied_generation
      and d.pivot_custody_applied_rows = r.rows_after
      and d.generation_id = d.pivot_custody_applied_generation
      and d.rows_loaded = d.pivot_custody_applied_rows
      and r.rows_after > 0
      and r.transform_contract_sha256 = any(${supportedTransforms}::text[])
      and c.custody_sha256 = d.pivot_custody_sha256
      and c.observation_count = r.rows_after
      and c.geo_contract_version = ${INS_GEOGRAPHY_VERSION}
      and c.geo_dimension_count = gd.n and c.geo_tuple_count = gt.n
      and c.geo_rule_count = gr.n and gd.valid and gt.valid and gr.valid
      and (
        (gd.n = 0 and gt.n = 0 and gr.n = 0)
        or (gt.n > 0 and (
          (gd.n = 1 and gd.singles = 1)
          or (gd.n = 2 and gd.parents = 1 and gd.children = 1)
        ))
      )
    ) is true as facts_ready,
    (d.rows_loaded = 0 and d.pivot_custody_sha256 is null
      and d.pivot_custody_applied_generation is null
      and d.pivot_custody_applied_rows is null and r.revision_id is null
      and (c.dataset_code is null or c.observation_count = 0)) is true as not_loaded
  ) publication`;

/** Presentation and filter predicates must use the same source/observed choice. */
export const datasetPeriodicities = sql`
  case when publication.facts_ready and cardinality(c.periodicities_observed) > 0
    then c.periodicities_observed else d.periodicities end`;

/** Direct internal reads require a publication; public usecases handle NOT_LOADED first. */
export const assertDatasetsPublished = async (
  trx: Trx,
  datasetCodes: readonly string[]
): Promise<void> => {
  const codes = [...new Set(datasetCodes)];
  if (codes.length === 0) return;
  const result = await sql<{ dataset_code: string; facts_ready: boolean }>`
    select d.dataset_code, publication.facts_ready ${datasetPublicationFrom()}
    where d.dataset_code = any(${codes}::text[])`.execute(trx);
  if (result.rows.length !== codes.length || result.rows.some((r) => !r.facts_ready)) {
    throw new InsPublicationUnavailable();
  }
};
