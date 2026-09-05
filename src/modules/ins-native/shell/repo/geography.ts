/** Published source coordinates and their period qualifications. No member inference. */
import { sql } from 'kysely';

import { InsPublicationUnavailable } from './publication-error.js';
import { INS_GEO_FLAG_KINDS } from './publication.js';
import { territoryQuerySql, toNode } from './territory.js';

import type { Trx } from './snapshot.js';
import type {
  InsGeographicDimension,
  InsGeographicRule,
  InsGeoPairs,
  InsObservationGeography,
  InsTerritoryNode,
} from '../../core/types.js';

interface GeographicTuple {
  readonly pairs: InsGeoPairs;
  readonly resolution: InsObservationGeography['resolution'];
  readonly flags: readonly string[];
  readonly resolvedTerritory: InsTerritoryNode | null;
  readonly contextTerritory: InsTerritoryNode | null;
  readonly rules: readonly InsGeographicRule[];
}

export const readGeographicDimensionsForDatasets = async (
  trx: Trx,
  datasetCodes: readonly string[]
): Promise<ReadonlyMap<string, readonly InsGeographicDimension[]>> => {
  if (datasetCodes.length === 0) return new Map();
  const result = await sql<{ dataset_code: string; dim_index: number; slot_index: number }>`
    select dataset_code, dim_index, slot_index from ins.dataset_geo_dimensions
    where dataset_code = any(${datasetCodes}::text[]) order by dataset_code, dim_index`.execute(
    trx
  );
  const output = new Map<string, InsGeographicDimension[]>();
  for (const row of result.rows) {
    const dimensions = output.get(row.dataset_code) ?? [];
    dimensions.push({ dimIndex: row.dim_index, slotIndex: row.slot_index });
    output.set(row.dataset_code, dimensions);
  }
  return output;
};

export const readGeographicDimensions = async (
  trx: Trx,
  datasetCode: string
): Promise<readonly InsGeographicDimension[]> =>
  (await readGeographicDimensionsForDatasets(trx, [datasetCode])).get(datasetCode) ?? [];

/** Exact JSONB equality uses the catalog's (dataset_code, geo_pairs) primary key.
 * Deduplicate requested tuples only; distinct observation rows are never merged.
 */
export const readGeographicTuplesForDatasets = async (
  trx: Trx,
  requests: readonly { readonly datasetCode: string; readonly pairs: readonly InsGeoPairs[] }[]
): Promise<ReadonlyMap<string, ReadonlyMap<string, GeographicTuple>>> => {
  const requested = new Map(
    requests.flatMap(({ datasetCode, pairs }) =>
      pairs
        .filter((pair) => pair.length > 0)
        .map(
          (pair) =>
            [
              JSON.stringify([datasetCode, pair]),
              { dataset_code: datasetCode, geo_pairs: pair },
            ] as const
        )
    )
  );
  if (requested.size === 0) return new Map();
  const wanted = sql`jsonb_to_recordset(${JSON.stringify([...requested.values()])}::jsonb)
    as wanted(dataset_code text, geo_pairs jsonb)`;
  const tuples = await sql<{
    dataset_code: string;
    geo_pairs: InsGeoPairs;
    resolution: GeographicTuple['resolution'];
    flags: string[];
    territory_id: string | null;
    context_territory_id: string | null;
  }>`select g.dataset_code, g.geo_pairs, g.resolution, g.flags, g.territory_id, g.context_territory_id
    from ins.dataset_geo_tuples g
    join ${wanted} on wanted.dataset_code=g.dataset_code and wanted.geo_pairs=g.geo_pairs`.execute(
    trx
  );
  if (tuples.rows.length !== requested.size) throw new InsPublicationUnavailable();

  const rules = await sql<{
    dataset_code: string;
    geo_pairs: InsGeoPairs;
    rule_id: string;
    applies_from: string;
    applies_to: string;
    flag: string;
    kind: 'coverage';
    evidence_url: string;
    rationale: string;
  }>`select r.dataset_code, r.geo_pairs, r.rule_id, r.applies_from::text, r.applies_to::text,
      r.flag, r.kind, r.evidence_url, r.rationale
    from ins.geo_tuple_rules r
    join ${wanted} on wanted.dataset_code=r.dataset_code and wanted.geo_pairs=r.geo_pairs
    order by r.dataset_code, r.geo_pairs, r.applies_from, r.applies_to, r.rule_id`.execute(trx);
  const rulesByPair = new Map<string, InsGeographicRule[]>();
  for (const rule of rules.rows) {
    const key = JSON.stringify([rule.dataset_code, rule.geo_pairs]);
    const list = rulesByPair.get(key) ?? [];
    list.push({
      ruleId: rule.rule_id,
      appliesFrom: rule.applies_from,
      appliesTo: rule.applies_to,
      flag: rule.flag,
      kind: rule.kind,
      evidenceUrl: rule.evidence_url,
      rationale: rule.rationale,
    });
    rulesByPair.set(key, list);
  }
  const nodeIds = [
    ...new Set(
      tuples.rows.flatMap((r) =>
        [r.territory_id, r.context_territory_id].filter((id) => id !== null)
      )
    ),
  ];
  const nodes =
    nodeIds.length === 0
      ? []
      : (
          await territoryQuerySql(sql`t.territory_id in (${sql.join(nodeIds)})`).execute(trx)
        ).rows.map(toNode);
  const nodeMap = new Map(nodes.map((n) => [String(n.territoryId), n]));
  const nodeFor = (id: string | null): InsTerritoryNode | null => {
    if (id === null) return null;
    const node = nodeMap.get(id);
    if (node === undefined) throw new InsPublicationUnavailable();
    return node;
  };
  const output = new Map<string, Map<string, GeographicTuple>>();
  for (const row of tuples.rows) {
    const tuplesForDataset = output.get(row.dataset_code) ?? new Map<string, GeographicTuple>();
    tuplesForDataset.set(JSON.stringify(row.geo_pairs), {
      pairs: row.geo_pairs,
      resolution: row.resolution,
      flags: row.flags,
      resolvedTerritory: nodeFor(row.territory_id),
      contextTerritory: nodeFor(row.context_territory_id),
      rules: rulesByPair.get(JSON.stringify([row.dataset_code, row.geo_pairs])) ?? [],
    });
    output.set(row.dataset_code, tuplesForDataset);
  }
  return output;
};

export const readGeographicTuples = async (
  trx: Trx,
  datasetCode: string,
  pairs: readonly InsGeoPairs[]
): Promise<ReadonlyMap<string, GeographicTuple>> =>
  (await readGeographicTuplesForDatasets(trx, [{ datasetCode, pairs }])).get(datasetCode) ??
  new Map();

export const geographicView = (
  pairs: InsGeoPairs,
  tuples: ReadonlyMap<string, GeographicTuple>,
  periodStart: string,
  periodEnd: string
): InsObservationGeography | null => {
  if (pairs.length === 0) return null;
  const tuple = tuples.get(JSON.stringify(pairs));
  if (tuple === undefined) throw new InsPublicationUnavailable();
  const applicableRules = tuple.rules.filter(
    (rule) => periodStart <= rule.appliesTo && periodEnd >= rule.appliesFrom
  );
  return {
    pairs: tuple.pairs,
    resolution: tuple.resolution,
    flags: tuple.flags,
    resolvedTerritory: tuple.resolvedTerritory,
    contextTerritory: tuple.contextTerritory,
    applicableRules,
    qualified:
      tuple.resolution !== 'EXACT' ||
      applicableRules.length > 0 ||
      tuple.flags.some((flag) => INS_GEO_FLAG_KINDS[flag] === 'coverage'),
  };
};
