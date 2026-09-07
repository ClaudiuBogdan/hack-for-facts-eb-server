/** Public county input aliases; exact INS source lookups remain unchanged. */
import { err, ok, type Result } from 'neverthrow';

import type { InsRepo } from './ports.js';
import type { InsTerritoryLevel, InsTerritoryNode } from './types.js';
import type { ApiError } from '@/modules/shared/index.js';

export interface InsTerritoryInputs {
  readonly nodes: readonly InsTerritoryNode[];
  readonly unresolvedCodes: readonly string[];
}
const inconsistent = (): ApiError => ({
  type: 'ServiceUnavailable',
  message: 'INS territory aliases are inconsistent',
});

export const resolveInsTerritoryInputs = (
  outer: InsRepo,
  codes: readonly string[],
  mode: 'code' | 'siruta',
  levels?: readonly InsTerritoryLevel[]
): Promise<Result<InsTerritoryInputs, ApiError>> =>
  outer.withSnapshot(async (repo) => {
    if (codes.length === 0) return ok({ nodes: [], unresolvedCodes: [] });
    const normalized = [...new Set(codes.map((code) => code.trim().toUpperCase()))];
    const exact =
      mode === 'code'
        ? await repo.territoriesByCodes(normalized, levels)
        : await repo.territoriesBySiruta(normalized);
    if (exact.isErr()) return err(exact.error);
    const allowsCounty = levels === undefined || levels.length === 0 || levels.includes('NUTS3');
    const aliases = allowsCounty ? await repo.countyAliases() : ok([]);
    if (aliases.isErr()) return err(aliases.error);
    // Source-only counties such as B remain valid legacy inputs even before a
    // distinct canonical county exists. They acquire no invented numeric alias.
    const letters = normalized.filter((code) => /^[A-Z]{1,2}$/u.test(code));
    const sourceCounties =
      allowsCounty && mode === 'siruta' && letters.length > 0
        ? await repo.territoriesByCodes(letters, ['NUTS3'])
        : ok([]);
    if (sourceCounties.isErr()) return err(sourceCounties.error);
    const byInput = new Map<string, Map<number, InsTerritoryNode>>();
    for (const code of normalized) {
      const matched = new Map<number, InsTerritoryNode>();
      for (const node of [...exact.value, ...sourceCounties.value]) {
        if (levels !== undefined && levels.length > 0 && !levels.includes(node.level)) continue;
        if (
          (mode === 'code' ? node.code : node.sirutaCode) === code ||
          (node.level === 'NUTS3' && node.code === code)
        )
          matched.set(node.territoryId, node);
      }
      for (const alias of aliases.value) {
        if (alias.sirutaCode !== code && alias.node.code !== code) continue;
        if (alias.node.level !== 'NUTS3' || !/^[1-9][0-9]*$/u.test(alias.sirutaCode))
          return err(inconsistent());
        if ([...matched.keys()].some((id) => id !== alias.node.territoryId))
          return err(inconsistent());
        matched.set(alias.node.territoryId, alias.node);
      }
      if (matched.size > 1) return err(inconsistent());
      byInput.set(code, matched);
    }
    const nodes = new Map<number, InsTerritoryNode>();
    for (const matched of byInput.values()) for (const [id, node] of matched) nodes.set(id, node);
    return ok({
      nodes: [...nodes.values()],
      unresolvedCodes: normalized.filter((code) => byInput.get(code)?.size === 0),
    });
  });
