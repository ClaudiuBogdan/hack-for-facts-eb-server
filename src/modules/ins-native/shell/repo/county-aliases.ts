/** Read-only county aliases from the existing canonical territory spine. */
import { sql } from 'kysely';

import { InsPublicationUnavailable } from './publication-error.js';
import { nodeSelect, toNode, type NodeRow } from './territory.js';
import { insIdentityForTerritory } from '../../core/entity-territory.js';

import type { Trx } from './snapshot.js';
import type { InsTerritoryNode } from '../../core/types.js';
import type { Territory } from '@/modules/shared/index.js';

export const readCountyAliases = async (
  trx: Trx
): Promise<readonly { sirutaCode: string; node: InsTerritoryNode }[]> => {
  const rows = await sql<
    Omit<NodeRow, 'territory_id'> & {
      territory_id: string | null;
      canonical: Territory;
      conflicting_links: string;
    }
  >`
    select ${nodeSelect},
      json_build_object('id', c.id, 'level', c.level, 'kind', c.kind,
        'territoryKey', c.territory_key, 'parentId', c.parent_id, 'nutsCode', c.nuts_code,
        'territorialSirutaCode', c.territorial_siruta_code, 'sirutaCode', c.siruta_code,
        'countySirutaCode', c.county_siruta_code, 'uatCode', c.uat_code,
        'name', c.name, 'countyCode', c.county_code, 'countyName', c.county_name,
        'region', c.region, 'population', null) as canonical,
      (select count(*)::text from ins.territory_nodes reverse_node
       where reverse_node.core_territory_id = c.id
         and (t.territory_id is null or reverse_node.territory_id <> t.territory_id)) as conflicting_links
    from core.territories c
    left join ins.territory_nodes t on t.level = 'NUTS3' and t.code = c.county_code
    left join ins.territory_nodes p on p.territory_id = t.parent_id
    where c.level = 'county' and c.privacy_class = 'public'
    order by c.id, t.territory_id
  `.execute(trx);
  const aliases: { sirutaCode: string; node: InsTerritoryNode }[] = [];
  const codes = new Set<string>(),
    sirutas = new Set<string>(),
    nodes = new Set<number>();
  for (const row of rows.rows) {
    const identity = insIdentityForTerritory(row.canonical);
    const siruta = row.canonical.territorialSirutaCode;
    if (
      identity?.level !== 'NUTS3' ||
      siruta === null ||
      row.conflicting_links !== '0' ||
      codes.has(identity.code) ||
      sirutas.has(siruta)
    )
      throw new InsPublicationUnavailable();
    codes.add(identity.code);
    sirutas.add(siruta);
    // No source node means no alias: never turn a missing county into its city.
    if (row.territory_id === null) continue;
    const node = toNode({ ...row, territory_id: row.territory_id });
    if (
      node.level !== 'NUTS3' ||
      node.code !== identity.code ||
      (node.coreTerritoryId !== null && node.coreTerritoryId !== row.canonical.id) ||
      nodes.has(node.territoryId)
    )
      throw new InsPublicationUnavailable();
    nodes.add(node.territoryId);
    aliases.push({ sirutaCode: siruta, node });
  }
  return aliases;
};
