import { sql, type RawBuilder } from 'kysely';

import type { InsTerritoryLevel, InsTerritoryNode } from '../../core/types.js';

export interface NodeRow {
  territory_id: string;
  code: string;
  siruta_code: string | null;
  level: string;
  name_ro: string;
  parent_id: string | null;
  core_territory_id: number | null;
  parent_code: string | null;
  parent_name_ro: string | null;
}

export const toNode = (r: NodeRow): InsTerritoryNode => ({
  territoryId: Number(r.territory_id),
  code: r.code,
  sirutaCode: r.siruta_code,
  level: r.level as InsTerritoryLevel,
  nameRo: r.name_ro,
  parentId: r.parent_id === null ? null : Number(r.parent_id),
  parentCode: r.parent_code,
  parentNameRo: r.parent_name_ro,
  coreTerritoryId: r.core_territory_id,
});

/** The node select with its parent joined — the one shape every territory read returns. */
export const nodeSelect = sql`
  t.territory_id, t.code, t.siruta_code, t.level, t.name_ro, t.parent_id, t.core_territory_id,
  p.code as parent_code, p.name_ro as parent_name_ro`;

export const territoryQuerySql = (where: RawBuilder<unknown>): RawBuilder<NodeRow> => sql<NodeRow>`
  select ${nodeSelect}
  from ins.territory_nodes t
  left join ins.territory_nodes p on p.territory_id = t.parent_id
  where ${where}`;
