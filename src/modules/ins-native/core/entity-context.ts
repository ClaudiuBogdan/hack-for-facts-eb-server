/** Statistical context of the canonical area, independent of fiscal authority. */
import { err, ok, type Result } from 'neverthrow';

import {
  invalidInput,
  isWithheldOrganizationIdentifier,
  normalizeCui,
  type ApiError,
  type Cui,
  type Territory,
} from '@/modules/shared/index.js';

import { resolveInsEntityTerritory } from './entity-territory.js';

import type { InsRepo } from './ports.js';
import type { InsTerritoryLevel } from './types.js';

export interface InsEntityContext {
  readonly territoryCode: string;
  readonly territoryLevel: InsTerritoryLevel;
  readonly territoryName: string;
  readonly sirutaCode: string | null;
  /** Certified modern-scope datasets, not historical or raw observation coverage. */
  readonly datasetCount: number;
}

export interface InsEntityContextDeps {
  readonly territoryForCui?: (cui: Cui) => Promise<Result<Territory | null, ApiError>>;
}

/** Kernel anchor is a separate read; INS bridge and coverage share one snapshot. */
export const resolveInsEntityContext = async (
  repo: InsRepo,
  deps: InsEntityContextDeps,
  rawCui: string
): Promise<Result<InsEntityContext | null, ApiError>> => {
  const cui = normalizeCui(rawCui);
  if (cui === null) return err(invalidInput('invalid CUI format', 'cui'));
  // Also protect direct profile-slice callers, before any identity or INS read.
  if (isWithheldOrganizationIdentifier(cui)) return ok(null);
  if (deps.territoryForCui === undefined)
    return err({ type: 'ServiceUnavailable', message: 'INS entity identity provider unavailable' });
  const anchor = await deps.territoryForCui(cui);
  if (anchor.isErr()) return err(anchor.error);
  if (anchor.value === null) return ok(null);
  const territory = anchor.value;
  return repo.withSnapshot(async (snapshot) => {
    const resolved = await resolveInsEntityTerritory(snapshot, territory);
    if (resolved.isErr()) return err(resolved.error);
    const node = resolved.value;
    if (node === null) return ok(null);
    const coverage = await snapshot.datasetsForTerritory(node.territoryId);
    if (coverage.isErr()) return err(coverage.error);
    if (new Set(coverage.value).size !== coverage.value.length)
      return err({ type: 'ServiceUnavailable', message: 'INS territory coverage is inconsistent' });
    return ok({
      territoryCode: node.code,
      territoryLevel: node.level,
      territoryName: node.nameRo,
      sirutaCode: node.sirutaCode,
      datasetCount: coverage.value.length,
    });
  });
};
