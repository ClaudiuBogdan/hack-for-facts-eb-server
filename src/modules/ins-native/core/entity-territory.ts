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
    // L2's documented legacy column holds the county LETTER on county rows;
    // only the exact county mnemonic is an alias, not a conflicting SIRUTA.
    const legacySiruta = territory.sirutaCode === code ? null : territory.sirutaCode;
    const identifiers = [siruta, territory.countySirutaCode, legacySiruta].filter(
      (value): value is string => value !== null
    );
    if (identifiers.some((value) => !/^[1-9][0-9]*$/u.test(value)) || new Set(identifiers).size > 1)
      return null;
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
  return validateIdentity(territory, identity, exact.value, linked.value);
};

/** Shared adjudication: absence differs from contradictory source/core links. */
const validateIdentity = (
  territory: Territory,
  identity: InsTerritoryIdentity,
  exact: readonly InsTerritoryNode[],
  linked: readonly InsTerritoryNode[]
): Result<InsTerritoryNode | null, ApiError> => {
  if (exact.length > 1 || linked.length > 1) return err(unavailable());
  const node = exact[0];
  const reverse = linked[0];
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

/** Resolve all canonical anchors in one publication snapshot, without per-node SQL. */
export const resolveInsTerritories = (
  outer: InsRepo,
  territories: readonly Territory[]
): Promise<Result<ReadonlyMap<number, InsTerritoryNode | null>, ApiError>> =>
  outer.withSnapshot(async (repo) => {
    if (new Set(territories.map((territory) => territory.id)).size !== territories.length)
      return err(unavailable());
    const result = new Map<number, InsTerritoryNode | null>();
    const valid: { territory: Territory; identity: InsTerritoryIdentity }[] = [];
    const identities = new Set<string>();
    for (const territory of territories) {
      const identity = insIdentityForTerritory(territory);
      if (identity === null) {
        result.set(territory.id, null);
        continue;
      }
      const key = `${identity.level}:${identity.code}`;
      // Two canonical nodes must never receive the same source population twice.
      if (identities.has(key)) return err(unavailable());
      identities.add(key);
      valid.push({ territory, identity });
    }
    if (valid.length === 0) return ok(result);
    const reverse = await repo.territoriesByCoreIds(valid.map(({ territory }) => territory.id));
    if (reverse.isErr()) return err(reverse.error);
    const linkedByCoreId = new Map<number, InsTerritoryNode[]>();
    const expectedIds = new Set(valid.map(({ territory }) => territory.id));
    for (const node of reverse.value) {
      if (node.coreTerritoryId === null || !expectedIds.has(node.coreTerritoryId))
        return err(unavailable());
      const nodes = linkedByCoreId.get(node.coreTerritoryId) ?? [];
      nodes.push(node);
      linkedByCoreId.set(node.coreTerritoryId, nodes);
    }
    const levels = new Set(valid.map(({ identity }) => identity.level));
    const resolvedNodeIds = new Set<number>();
    for (const level of levels) {
      const group = valid.filter(({ identity }) => identity.level === level);
      // Bound SQL parameters; this is batching, never a sample or truncation.
      for (let offset = 0; offset < group.length; offset += 1000) {
        const batch = group.slice(offset, offset + 1000);
        const codes = batch.map(({ identity }) => identity.code);
        const exact = await repo.territoriesByCodes(codes, [level]);
        if (exact.isErr()) return err(exact.error);
        const byCode = new Map<string, InsTerritoryNode[]>();
        const expectedCodes = new Set(codes);
        for (const node of exact.value) {
          if (node.level !== level || !expectedCodes.has(node.code)) return err(unavailable());
          const nodes = byCode.get(node.code) ?? [];
          nodes.push(node);
          byCode.set(node.code, nodes);
        }
        for (const { territory, identity } of batch) {
          const resolved = validateIdentity(
            territory,
            identity,
            byCode.get(identity.code) ?? [],
            linkedByCoreId.get(territory.id) ?? []
          );
          if (resolved.isErr()) return err(resolved.error);
          const node = resolved.value;
          if (node !== null) {
            if (resolvedNodeIds.has(node.territoryId)) return err(unavailable());
            resolvedNodeIds.add(node.territoryId);
          }
          result.set(territory.id, node);
        }
      }
    }
    return ok(result);
  });
