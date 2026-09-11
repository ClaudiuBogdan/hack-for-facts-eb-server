/**
 * Native INS repository — the TERRITORY reads (codebase plan §WP5): the
 * territory node tree (lists, code, SIRUTA and kernel-id lookups), the county
 * aliases and the datasets published for a territory. Every read runs through
 * the repository's runner. Moved out of `ins-repo.ts` unchanged.
 */
import { sql, type RawBuilder } from 'kysely';
import { ok } from 'neverthrow';

import { readCountyAliases } from './county-aliases.js';
import { geographicCatalogScopeSql } from './geography-sql.js';
import { datasetFrom, likeNeedle, page } from './ins-publication.js';
import { type Runner } from './snapshot.js';
import { nodeSelect, territoryQuerySql, toNode, type NodeRow } from './territory.js';

import type { InsRepo } from '../../core/ports.js';

export const makeTerritoryReads = (readTx: Runner) => {
  const territoryQuery = (
    where: RawBuilder<unknown>,
    order: RawBuilder<unknown>,
    limit?: number,
    offset?: number
  ) =>
    sql<NodeRow & { total: string }>`
      select ${nodeSelect}, count(*) over() as total
      from ins.territory_nodes t
      left join ins.territory_nodes p on p.territory_id = t.parent_id
      where ${where}
      ${order}
      ${limit === undefined ? sql`` : sql`limit ${limit} offset ${offset ?? 0}`}`;

  const levelOrder = sql`order by array_position(array['NATIONAL','NUTS1','NUTS2','NUTS3','LAU']::text[], t.level), t.name_search, t.territory_id`;

  const repository: Pick<
    InsRepo,
    | 'listTerritories'
    | 'territoriesByCodes'
    | 'territoriesBySiruta'
    | 'territoriesByCoreId'
    | 'territoriesByCoreIds'
    | 'countyAliases'
    | 'datasetsForTerritory'
  > = {
    async listTerritories(filter, limit, offset) {
      return readTx('listTerritories', async (trx) => {
        const parts: RawBuilder<unknown>[] = [sql`true`];
        if (filter.search !== undefined && filter.search.trim() !== '') {
          parts.push(sql`t.name_search like ${likeNeedle(filter.search)}`);
        }
        if (filter.levels !== undefined && filter.levels.length > 0) {
          parts.push(sql`t.level in (${sql.join(filter.levels.map((l) => sql`${l}`))})`);
        }
        if (filter.territoryIds !== undefined)
          parts.push(sql`t.territory_id = any(${filter.territoryIds}::bigint[])`);
        if (filter.parentCode !== undefined && filter.parentCode !== '')
          parts.push(sql`p.code = ${filter.parentCode}`);
        if (filter.sirutaCodes !== undefined && filter.sirutaCodes.length > 0) {
          parts.push(
            sql`t.siruta_code in (${sql.join(filter.sirutaCodes.map((s) => sql`${s.trim()}`))})`
          );
        }
        const res = await territoryQuery(
          sql.join(parts, sql` and `),
          levelOrder,
          limit,
          offset
        ).execute(trx);
        const total = Number(res.rows[0]?.total ?? 0);
        return page(res.rows.map(toNode), total, limit, offset);
      });
    },

    async territoriesByCodes(codes, levels) {
      if (codes.length === 0) return ok([]);
      return readTx('territoriesByCodes', async (trx) => {
        const levelPart =
          levels === undefined || levels.length === 0
            ? sql`true`
            : sql`t.level in (${sql.join(levels.map((l) => sql`${l}`))})`;
        const res = await territoryQuery(
          sql`t.code in (${sql.join(codes.map((c) => sql`${c.trim().toUpperCase()}`))}) and ${levelPart}`,
          levelOrder
        ).execute(trx);
        return res.rows.map(toNode);
      });
    },

    async territoriesBySiruta(sirutaCodes) {
      if (sirutaCodes.length === 0) return ok([]);
      return readTx('territoriesBySiruta', async (trx) => {
        const res = await territoryQuery(
          sql`t.siruta_code in (${sql.join(sirutaCodes.map((s) => sql`${s.trim()}`))})`,
          levelOrder
        ).execute(trx);
        return res.rows.map(toNode);
      });
    },

    async territoriesByCoreId(coreTerritoryId) {
      return readTx('territoriesByCoreId', async (trx) => {
        const result =
          await sql<NodeRow>`${territoryQuerySql(sql`t.core_territory_id=${coreTerritoryId}`)} order by t.territory_id`.execute(
            trx
          );
        return result.rows.map(toNode);
      });
    },

    async territoriesByCoreIds(coreTerritoryIds) {
      if (coreTerritoryIds.length === 0) return ok([]);
      return readTx('territoriesByCoreIds', async (trx) => {
        const result =
          await sql<NodeRow>`${territoryQuerySql(sql`t.core_territory_id = any(${coreTerritoryIds}::integer[])`)} order by t.territory_id`.execute(
            trx
          );
        return result.rows.map(toNode);
      });
    },

    async countyAliases() {
      return readTx('countyAliases', readCountyAliases);
    },

    async datasetsForTerritory(territoryId, contextCode) {
      return readTx('datasetsForTerritory', async (trx) => {
        const context =
          contextCode === undefined
            ? sql``
            : sql`with recursive selected_contexts as (
          select context_code from ins.contexts where context_code=${contextCode}
          union select child.context_code from ins.contexts child join selected_contexts parent on child.parent_code=parent.context_code
        )`;
        const res = await sql<{ dataset_code: string }>`
          ${context} select d.dataset_code ${datasetFrom}
          where publication.facts_ready and (
            exists (select 1 from ins.dataset_geo_tuples g where g.dataset_code=d.dataset_code
              and g.has_modern_facts and ${geographicCatalogScopeSql({ kind: 'modern', territoryIds: [territoryId] })})
            or (c.geo_dimension_count=0 and exists(select 1 from ins.territory_nodes node where node.territory_id=${territoryId} and node.level='NATIONAL'))
          ) and ${contextCode === undefined ? sql`true` : sql`d.context_code in (select context_code from selected_contexts)`}
          order by d.dataset_code`.execute(trx);
        return res.rows.map((row) => row.dataset_code);
      });
    },
  };

  return repository;
};
