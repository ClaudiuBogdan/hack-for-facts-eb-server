/**
 * Legal module — the kernel `LegalActByIdLoader` implementation (plan §11, kernel
 * §15.4). Parliament (04) + judicial (08) resolve `act_id → LegalAct` through THIS
 * without importing the legal module; `build-redesign-app.ts` registers it via
 * `kernel.registerLegalActLoader(loader)`.
 *
 * DANGLING TOLERANCE (BINDING): `acts` is the source of truth, so an `act_id` that
 * does not exist there is simply unresolvable → `load` returns `null` and
 * `loadMany` returns `null` in that slot. It NEVER throws and NEVER rejects — a
 * DB failure also degrades to `null` (logged), because a dangling-FK consumer must
 * never be broken by the legal module. The `resolutionStatus:'dangling'` field on
 * the kernel `LegalActRef` exists for symmetry; this loader only ever returns
 * `'resolved'` refs (a resolved act) or `null` (no such act) — it never fabricates
 * a dangling ref, which would be a lie about an act that doesn't exist.
 */

import type { LegalActsRepo } from '../../core/ports.js';
import type { LegalActByIdLoader, LegalActRef } from '@/modules/shared/index.js';

/** Minimal logger surface (the kernel exposes Fastify's logger; only `warn` is used). */
export interface LegalLogger {
  warn?: (obj: Record<string, unknown>, msg: string) => void;
}

export interface LegalActLoaderDeps {
  readonly acts: LegalActsRepo;
  readonly logger?: LegalLogger;
}

/** Map a resolved domain act to the kernel's minimal cross-module ref. */
const toRef = (act: { actId: string; displayCitation: string; actType: string }): LegalActRef => ({
  actId: act.actId,
  title: act.displayCitation,
  actType: act.actType,
  resolutionStatus: 'resolved',
});

export const makeLegalActLoader = (deps: LegalActLoaderDeps): LegalActByIdLoader => {
  const { acts, logger } = deps;

  // The repos return `Result` (never throw), but the loader contract is "NEVER
  // throws/rejects" for a dangling-FK consumer — so we also guard against an
  // unexpected promise rejection (a bug, a pool failure) and degrade to null.
  const load = async (actId: string): Promise<LegalActRef | null> => {
    try {
      const res = await acts.findActById(actId);
      if (res.isErr()) {
        logger?.warn?.({ actId, err: res.error.message }, 'legalActLoader.load degraded to null');
        return null;
      }
      return res.value === null ? null : toRef(res.value);
    } catch (error) {
      logger?.warn?.({ actId, err: error instanceof Error ? error.message : String(error) }, 'legalActLoader.load rejected → null');
      return null;
    }
  };

  const loadMany = async (ids: readonly string[]): Promise<readonly (LegalActRef | null)[]> => {
    if (ids.length === 0) return [];
    try {
      const res = await acts.findActsByIds(ids);
      if (res.isErr()) {
        logger?.warn?.({ count: ids.length, err: res.error.message }, 'legalActLoader.loadMany degraded to null');
        return ids.map(() => null);
      }
      const byId = new Map(res.value.map((a) => [a.actId, toRef(a)]));
      // Preserve request order + arity (one slot per requested id; dangling → null).
      return ids.map((id) => byId.get(id) ?? null);
    } catch (error) {
      logger?.warn?.({ count: ids.length, err: error instanceof Error ? error.message : String(error) }, 'legalActLoader.loadMany rejected → all-null');
      return ids.map(() => null);
    }
  };

  return { load, loadMany };
};
