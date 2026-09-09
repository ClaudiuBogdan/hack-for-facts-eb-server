/**
 * Resolve cold immutable money factors BEFORE a request reserves a snapshot
 * connection (review X/F6: the pattern was copied four times under `src/app/`).
 * The serving pool can hold a single connection; a factor read inside the
 * snapshot would then wait on itself.
 */
import { err, ok, type Result } from 'neverthrow';

import { loadMoneyContext } from '../../core/legacy-analytics/money-context.js';

import type { FactorKind, FactorSource } from '../../core/legacy-analytics/ports.js';
import type { NormalizationPlan } from '../../core/legacy-analytics/types.js';
import type { ApiError } from '@/modules/shared/index.js';

/**
 * Loads every factor kind the plans need through `factors`, then answers a
 * `FactorSource` that serves ONLY those kinds from memory — any other kind is a
 * programming error surfaced as ServiceUnavailable, never a silent late read.
 */
export const preloadFactors = async (
  factors: FactorSource,
  plans: readonly NormalizationPlan[]
): Promise<Result<FactorSource, ApiError>> => {
  const loaded = new Map<FactorKind, ReturnType<FactorSource['yearly']>>();
  const recording: FactorSource = {
    yearly: (kind) => {
      let value = loaded.get(kind);
      if (value === undefined) {
        value = factors.yearly(kind);
        loaded.set(kind, value);
      }
      return value;
    },
  };
  for (const plan of plans) {
    const ready = await loadMoneyContext(recording, plan);
    if (ready.isErr()) return err(ready.error);
  }
  return ok({
    yearly: (kind) =>
      loaded.get(kind) ??
      Promise.resolve(
        err({ type: 'ServiceUnavailable' as const, message: 'Unexpected monetary factor kind' })
      ),
  });
};
