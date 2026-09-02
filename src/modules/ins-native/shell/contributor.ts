/**
 * INS native module — cross-source contributor. An entity has an INS presence
 * when it is a territorial executive whose UAT (SIRUTA) resolves to a spine node
 * with at least one dataset bound at LAU. The kernel identity hub resolves the
 * CUI → territory; this contributor only asks the INS catalogs.
 */

import { err, ok, type Result } from 'neverthrow';

import type { InsRepo } from '../core/ports.js';
import type { ApiError, Cui, SourceContributor, SourcePresence } from '@/modules/shared/index.js';

const INS_SOURCE = 'ins';

export interface InsContributorDeps {
  /** CUI → SIRUTA of the entity's UAT, or null; injected by the app (kernel identity hub). */
  sirutaForCui?(cui: Cui): Promise<Result<string | null, ApiError>>;
}

export const makeInsContributor = (
  repo: InsRepo,
  deps: InsContributorDeps = {}
): SourceContributor => ({
  source: INS_SOURCE,

  async presenceFor(cui: Cui): Promise<Result<SourcePresence | null, ApiError>> {
    if (deps.sirutaForCui === undefined) return ok(null);
    const siruta = await deps.sirutaForCui(cui);
    if (siruta.isErr()) return err(siruta.error);
    if (siruta.value === null) return ok(null);
    const nodes = await repo.territoriesBySiruta([siruta.value]);
    if (nodes.isErr()) return err(nodes.error);
    const node = nodes.value[0];
    if (node === undefined) return ok(null);
    const lau = await repo.datasetsWithLevel('LAU');
    if (lau.isErr()) return err(lau.error);
    if (lau.value.length === 0) return ok(null);
    return ok({
      source: INS_SOURCE,
      present: true,
      label: 'Statistici INS',
      count: lau.value.length,
      badges: ['ins', node.level.toLowerCase()],
      attrs: { sirutaCode: siruta.value, territoryCode: node.code, territoryName: node.nameRo },
    });
  },
});
