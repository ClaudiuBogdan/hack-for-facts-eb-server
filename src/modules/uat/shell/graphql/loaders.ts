/**
 * Mercurius loaders for UAT nested fields.
 *
 * Mercurius loaders automatically batch queries to avoid N+1 problems.
 * Each loader receives an array of queries and must return a
 * positionally-matched array of results.
 *
 * @see https://github.com/mercurius-js/mercurius/blob/master/docs/loaders.md
 */

import type { UAT } from '../../core/types.js';
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
 * Creates Mercurius loaders for UAT nested fields.
 *
 * @param db - Database client for queries
 * @returns Mercurius loaders object
 */
export const createUATLoaders = (db: BudgetDbClient): MercuriusLoaders => {
  return {
    UAT: {
      /**
       * Batch load county entities for UATs.
       *
       * County-level UATs are identified by:
       * - siruta_code = county_code, OR
       * - county_code = 'B' AND siruta_code = '179132' (Bucharest special case)
       *
       * Returns null for UATs that are themselves counties.
       */
      // eslint-disable-next-line @typescript-eslint/naming-convention -- GraphQL field name
      county_entity: async (queries: LoaderQuery<UAT>[], _context: MercuriusContext) => {
        // Filter out UATs that are themselves counties (they have no parent county entity)
        const nonCountyUATs = queries.filter((q) => {
          const isCounty =
            q.obj.siruta_code === q.obj.county_code ||
            (q.obj.county_code === 'B' && q.obj.siruta_code === '179132');
          return !isCounty;
        });

        // Get unique county codes
        const countyCodes = [...new Set(nonCountyUATs.map((q) => q.obj.county_code))];

        if (countyCodes.length === 0) {
          // All UATs are counties, return null for each
          return queries.map(() => null);
        }

        // Query entities linked to county-level UATs
        // A county entity is an entity where:
        // - entity.uat_id points to a UAT that is a county (siruta_code = county_code)
        const rows = await db
          .selectFrom('entities as e')
          .innerJoin('uats as u', 'e.uat_id', 'u.id')
          .select([
            'e.cui',
            'e.name',
            'e.entity_type',
            'e.default_report_type',
            'e.uat_id',
            'e.is_uat',
            'e.address',
            'e.last_updated',
            'e.main_creditor_1_cui',
            'e.main_creditor_2_cui',
            'u.county_code',
          ])
          .where((eb) =>
            eb.or([
              // Regular county: siruta_code = county_code
              eb('u.siruta_code', '=', eb.ref('u.county_code')),
              // Bucharest special case
              eb.and([eb('u.county_code', '=', 'B'), eb('u.siruta_code', '=', '179132')]),
            ])
          )
          .where('u.county_code', 'in', countyCodes)
          .execute();

        // Map county_code to entity
        const countyEntityMap = new Map<string, (typeof rows)[0]>();
        for (const row of rows) {
          countyEntityMap.set(row.county_code, row);
        }

        // Return positionally-matched results
        return queries.map((q) => {
          // Check if this UAT is itself a county
          const isCounty =
            q.obj.siruta_code === q.obj.county_code ||
            (q.obj.county_code === 'B' && q.obj.siruta_code === '179132');

          if (isCounty) {
            return null;
          }

          const countyEntity = countyEntityMap.get(q.obj.county_code);
          if (countyEntity === undefined) {
            return null;
          }

          return {
            cui: countyEntity.cui,
            name: countyEntity.name,
            entity_type: countyEntity.entity_type,
            default_report_type: countyEntity.default_report_type,
            uat_id: countyEntity.uat_id,
            is_uat: countyEntity.is_uat,
            address: countyEntity.address,
            last_updated: countyEntity.last_updated,
            main_creditor_1_cui: countyEntity.main_creditor_1_cui,
            main_creditor_2_cui: countyEntity.main_creditor_2_cui,
          };
        });
      },
    },
  };
};
