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

export const readGeographicDimensions = async (
  trx: Trx,
  datasetCode: string
): Promise<readonly InsGeographicDimension[]> => {
  const result = await sql<{ dim_index: number; slot_index: number }>`
    select dim_index, slot_index from ins.dataset_geo_dimensions
    where dataset_code = ${datasetCode} order by dim_index`.execute(trx);
  return result.rows.map((r) => ({ dimIndex: r.dim_index, slotIndex: r.slot_index }));
};

/** Exact JSONB equality uses the catalog's (dataset_code, geo_pairs) primary key.
 * Deduplicate requested tuples only; distinct observation rows are never merged.
 */
export const readGeographicTuples = async (
  trx: Trx,
  datasetCode: string,
  pairs: readonly InsGeoPairs[]
): Promise<ReadonlyMap<string, GeographicTuple>> => {
  const requested = new Map(pairs.filter((p) => p.length > 0).map((p) => [JSON.stringify(p), p]));
  if (requested.size === 0) return new Map();
  const requestedJson = JSON.stringify([...requested.values()]);
  const selectedPairs = sql`select value from jsonb_array_elements(${requestedJson}::jsonb)`;
  const tuples = await sql<{
    geo_pairs: InsGeoPairs;
    resolution: GeographicTuple['resolution'];
    flags: string[];
    territory_id: string | null;
    context_territory_id: string | null;
  }>`select geo_pairs, resolution, flags, territory_id, context_territory_id
    from ins.dataset_geo_tuples
    where dataset_code = ${datasetCode} and geo_pairs in (${selectedPairs})`.execute(trx);
  if (tuples.rows.length !== requested.size) throw new InsPublicationUnavailable();

  const rules = await sql<{
    geo_pairs: InsGeoPairs;
    rule_id: string;
    applies_from: string;
    applies_to: string;
    flag: string;
    kind: 'coverage';
    evidence_url: string;
    rationale: string;
  }>`select geo_pairs, rule_id, applies_from::text, applies_to::text,
      flag, kind, evidence_url, rationale
    from ins.geo_tuple_rules
    where dataset_code = ${datasetCode} and geo_pairs in (${selectedPairs})
    order by geo_pairs, applies_from, applies_to, rule_id`.execute(trx);
  const rulesByPair = new Map<string, InsGeographicRule[]>();
  for (const rule of rules.rows) {
    const key = JSON.stringify(rule.geo_pairs);
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
  return new Map(
    tuples.rows.map((row) => {
      const key = JSON.stringify(row.geo_pairs);
      return [
        key,
        {
          pairs: row.geo_pairs,
          resolution: row.resolution,
          flags: row.flags,
          resolvedTerritory: nodeFor(row.territory_id),
          contextTerritory: nodeFor(row.context_territory_id),
          rules: rulesByPair.get(key) ?? [],
        },
      ];
    })
  );
};

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
