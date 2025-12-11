/**
 * Mercurius loaders for Entity nested fields.
 *
 * Mercurius loaders automatically batch queries to avoid N+1 problems.
 * Each loader receives an array of queries and must return a
 * positionally-matched array of results.
 *
 * @see https://github.com/mercurius-js/mercurius/blob/master/docs/loaders.md
 */

import type { Entity } from '../../core/types.js';
import type { BudgetDbClient } from '@/infra/database/client.js';
import type { MercuriusContext, MercuriusLoaders } from 'mercurius';

// ============================================================================
// Types
// ============================================================================

interface LoaderQuery<T> {
  obj: T;
  params: Record<string, unknown>;
}

// ============================================================================
// Loader Factory
// ============================================================================

/**
 * Creates Mercurius loaders for Entity nested fields.
 *
 * @param db - Database client for queries
 * @returns Mercurius loaders object
 */
export const createEntityLoaders = (db: BudgetDbClient): MercuriusLoaders => {
  return {
    Entity: {
      /**
       * Batch load UATs for entities.
       *
       * Only loads UATs for entities that have a uat_id.
       */
      uat: async (queries: LoaderQuery<Entity>[], _context: MercuriusContext) => {
        // Filter out entities without uat_id
        const uatIds = [
          ...new Set(queries.map((q) => q.obj.uat_id).filter((id): id is number => id !== null)),
        ];

        if (uatIds.length === 0) {
          return queries.map(() => null);
        }

        // Query UATs
        const rows = await db
          .selectFrom('uats')
          .select([
            'id',
            'uat_key',
            'uat_code',
            'siruta_code',
            'name',
            'county_code',
            'county_name',
            'region',
            'population',
          ])
          .where('id', 'in', uatIds)
          .execute();

        // Map id to UAT
        const uatMap = new Map(rows.map((u) => [u.id, u]));

        // Return positionally-matched results
        return queries.map((q) => {
          if (q.obj.uat_id === null) {
            return null;
          }
          return uatMap.get(q.obj.uat_id) ?? null;
        });
      },
    },
  };
};
