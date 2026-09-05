/** Canonical area context, independent of fiscal authority or entity kind. */
import { err, ok, type Result } from 'neverthrow';

import type { InsRepo } from './ports.js';
import type { InsTerritoryLevel, InsTerritoryNode } from './types.js';
import type { ApiError, Territory } from '@/modules/shared/index.js';

// SIRUTA identity of Bucharest municipality, never a sector's own identity.
const BUCHAREST_MUNICIPALITY_SIRUTA = '179132';

export interface InsTerritoryIdentity {
  readonly code: string;
  readonly level: InsTerritoryLevel;
}

/** Unrecognized or contradictory kernel vocabulary cannot imply INS coverage. */
export const insIdentityForTerritory = (territory: Territory): InsTerritoryIdentity | null => {
  if (!Number.isSafeInteger(territory.id) || territory.id < 1) return null;
  const { level, kind, nutsCode, territorialSirutaCode: siruta } = territory;
  if (level === 'country' || level === 'macroregion' || level === 'region') {
    const expected = level === 'region' ? 'development_region' : level;
    if (kind !== expected || nutsCode === null) return null;
    const valid =
      level === 'country'
        ? nutsCode === 'RO'
        : level === 'macroregion'
          ? /^RO[0-9]$/u.test(nutsCode)
          : /^RO[0-9]{2}$/u.test(nutsCode);
    if (
      !valid ||
      (territory.territoryKey !== null && territory.territoryKey !== `nuts:${nutsCode}`)
    )
      return null;
    return {
      code: nutsCode,
      level: level === 'country' ? 'NATIONAL' : level === 'macroregion' ? 'NUTS1' : 'NUTS2',
    };
  }
  if (level === 'county' && kind === 'county') {
    const code = territory.countyCode;
    if (code === null || !/^[A-Z]{1,2}$/u.test(code)) return null;
    const identifiers = [siruta, territory.countySirutaCode, territory.sirutaCode].filter(
      (value): value is string => value !== null
    );
    if (new Set(identifiers).size > 1) return null;
    return { code, level: 'NUTS3' };
  }
  if (!(
    (level === 'uat' && ['municipality', 'town', 'commune'].includes(kind ?? '')) ||
    (level === 'locality' && kind === 'sector')
  ))
    return null;
  if (siruta === null || !/^[1-9][0-9]*$/u.test(siruta)) return null;
  if (kind === 'sector' && siruta === BUCHAREST_MUNICIPALITY_SIRUTA) return null;
  if (
    (territory.sirutaCode !== null && territory.sirutaCode !== siruta) ||
    (territory.territoryKey !== null && territory.territoryKey !== `siruta:${siruta}`)
  )
    return null;
  return { code: siruta, level: 'LAU' };
};

const unavailable = (): ApiError => ({
  type: 'ServiceUnavailable',
  message: 'INS territory bridge is inconsistent',
});

/** Caller keeps this resolution and subsequent coverage in one INS snapshot. */
export const resolveInsEntityTerritory = async (
  repo: InsRepo,
  territory: Territory
): Promise<Result<InsTerritoryNode | null, ApiError>> => {
  const identity = insIdentityForTerritory(territory);
  if (identity === null) return ok(null);
  const exact = await repo.territoriesByCodes([identity.code], [identity.level]);
  if (exact.isErr()) return err(exact.error);
  // Check reverse links even when no exact source node is present.
  const linked = await repo.territoriesByCoreId(territory.id);
  if (linked.isErr()) return err(linked.error);
  if (exact.value.length > 1 || linked.value.length > 1) return err(unavailable());
  const node = exact.value[0];
  const reverse = linked.value[0];
  if (node === undefined) return reverse === undefined ? ok(null) : err(unavailable());
  if (
    node.code !== identity.code ||
    node.level !== identity.level ||
    (identity.level === 'LAU' && node.sirutaCode !== identity.code) ||
    (node.coreTerritoryId !== null && node.coreTerritoryId !== territory.id) ||
    (reverse !== undefined &&
      (reverse.territoryId !== node.territoryId || reverse.coreTerritoryId !== territory.id))
  )
    return err(unavailable());
  return ok(node);
};
