/**
 * GraphQL owning-result finalization, installed on the kernel GraphQL surface
 * (first consumer: the companies registry/parent-privacy guard).
 *
 * Each request's Mercurius context carries ONE `OwningResultGuard`. A resolver
 * that served guarded facts registers, for the result that owns them, the
 * fresh check that must still hold, or a guard refusal already known (the
 * companies `Entity.company` slice and the kernel `Entity.presence` fan-out).
 * `onResolution` runs after GraphQL execution settled — every selected field,
 * so after every pending promise of the operation — and there the checks run
 * once. Each refused owning result is withheld: its value becomes null and one
 * error at its path replaces the errors reported beneath it, so no earlier
 * fact of a refused entity stays in `data`.
 *
 * A request whose resolvers registered nothing does no extra work (no
 * database call). Nothing outlives the request: no memo, no global state.
 */

import { err } from 'neverthrow';

import {
  GRAPHQL_ERROR_CODE,
  OWNING_RESULT_GUARD,
  databaseError,
  type ApiError,
  type OwningResultGuard,
  type ResponsePath,
  type ServedFactsCheck,
} from '../modules/shared/index.js';

import type { GraphQLContextBuilder } from '../infra/graphql/index.js';
import type { FastifyInstance } from 'fastify';

interface Withheld {
  readonly owner: ResponsePath;
  readonly error: ApiError;
}

/** The guard of one request, with the settle step only the transport calls. */
export interface RequestOwningResultGuard extends OwningResultGuard {
  /** Run every registered check once; every owning result to withhold, with its reason. */
  settle(): Promise<readonly Withheld[]>;
}

export const makeRequestOwningResultGuard = (): RequestOwningResultGuard => {
  const refused: Withheld[] = [];
  const checks: { readonly owner: ResponsePath; readonly check: ServedFactsCheck }[] = [];
  return {
    refuse: (owner, error) => {
      refused.push({ owner: [...owner], error });
    },
    confirm: (owner, check) => {
      checks.push({ owner: [...owner], check });
    },
    settle: async () => {
      const outcomes = await Promise.all(
        checks.map(async ({ owner, check }) => {
          try {
            return { owner, res: await check() };
          } catch (cause) {
            // A decision that could not be taken is never a pass.
            return { owner, res: err(databaseError('access check failed', cause)) };
          }
        })
      );
      const failed = outcomes.flatMap(({ owner, res }) =>
        res.isErr() ? [{ owner, error: res.error }] : []
      );
      return [...refused, ...failed];
    },
  };
};

/** The context builder, extended with a fresh guard for every request. */
export const withOwningResultGuard =
  (base: GraphQLContextBuilder | undefined): GraphQLContextBuilder =>
  async (request, reply) => ({
    ...((base === undefined ? {} : await base(request, reply)) as object),
    [OWNING_RESULT_GUARD]: makeRequestOwningResultGuard(),
  });

const startsWith = (path: ResponsePath, prefix: ResponsePath): boolean =>
  prefix.length <= path.length && prefix.every((key, index) => path[index] === key);

/** Null the value at `owner` in `data`; false when it is gone already (an ancestor is null). */
const nullAt = (data: unknown, owner: ResponsePath): boolean => {
  const last = owner[owner.length - 1];
  if (last === undefined) return false;
  let container: unknown = data;
  for (const key of owner.slice(0, -1)) {
    if (typeof container !== 'object' || container === null) return false;
    container = (container as Record<string | number, unknown>)[key];
  }
  if (typeof container !== 'object' || container === null) return false;
  (container as Record<string | number, unknown>)[last] = null;
  return true;
};

/**
 * One client-facing error for a withheld result. Only the module-written
 * messages of a ServiceUnavailable or an InvalidInput (with its `field`, e.g.
 * analytics' stale `release`) are kept; every other type reads "Internal
 * server error" — never driver text, a cause or SQL.
 */
const withheldError = (owner: ResponsePath, error: ApiError) => ({
  message:
    error.type === 'ServiceUnavailable' || error.type === 'InvalidInput'
      ? error.message
      : 'Internal server error',
  path: [...owner],
  extensions: {
    code: GRAPHQL_ERROR_CODE[error.type],
    type: error.type,
    ...(error.type === 'InvalidInput' && error.field !== undefined && { field: error.field }),
  },
});

interface MutableExecution {
  data?: Record<string, unknown> | null;
  errors?: readonly unknown[];
}

/**
 * Withhold every refused owning result of a settled execution. Exported for
 * the transport tests; `registerOwningResultFinalizer` installs it.
 */
export const finalizeOwningResults = async (
  execution: MutableExecution,
  context: unknown
): Promise<void> => {
  const guard =
    typeof context === 'object' && context !== null
      ? (context as { [OWNING_RESULT_GUARD]?: RequestOwningResultGuard })[OWNING_RESULT_GUARD]
      : undefined;
  if (guard === undefined) return;
  const withheld = await guard.settle();
  if (withheld.length === 0 || execution.data === null || execution.data === undefined) return;
  let errors: readonly unknown[] = execution.errors ?? [];
  const done: ResponsePath[] = [];
  for (const { owner, error } of withheld) {
    // An owner inside an already withheld result is gone with it.
    if (done.some((prefix) => startsWith(owner, prefix))) continue;
    if (!nullAt(execution.data, owner)) continue;
    done.push(owner);
    const beneath = (e: unknown): boolean => {
      const path = (e as { path?: unknown }).path;
      return Array.isArray(path) && startsWith(path as ResponsePath, owner);
    };
    errors = [...errors.filter((e) => !beneath(e)), withheldError(owner, error)];
  }
  execution.errors = errors;
};

/** Install the finalizer on the registered Mercurius surface (after its other onResolution hooks). */
export const registerOwningResultFinalizer = (app: FastifyInstance): void => {
  app.graphql.addHook('onResolution', async (execution, context) => {
    await finalizeOwningResults(execution as MutableExecution, context);
  });
};
