/**
 * Mercurius loaders for Report nested fields.
 *
 * Mercurius loaders automatically batch queries to avoid N+1 problems.
 * Each loader receives an array of queries and must return a
 * positionally-matched array of results.
 *
 * @see https://github.com/mercurius-js/mercurius/blob/master/docs/loaders.md
 */

import type { Report } from '../../core/types.js';
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
 * Creates Mercurius loaders for Report nested fields.
 *
 * @param db - Database client for queries
 * @returns Mercurius loaders object
 */
export const createReportLoaders = (db: BudgetDbClient): MercuriusLoaders => {
  return {
    Report: {
      /**
       * Batch load entities for reports.
       */
      entity: async (queries: LoaderQuery<Report>[], _context: MercuriusContext) => {
        const cuis = [...new Set(queries.map((q) => q.obj.entity_cui))];

        if (cuis.length === 0) {
          return queries.map(() => null);
        }

        const rows = await db
          .selectFrom('entities')
          .select([
            'cui',
            'name',
            'entity_type',
            'default_report_type',
            'uat_id',
            'is_uat',
            'address',
            'last_updated',
            'main_creditor_1_cui',
            'main_creditor_2_cui',
          ])
          .where('cui', 'in', cuis)
          .execute();

        const map = new Map(rows.map((e) => [e.cui, e]));
        return queries.map((q) => map.get(q.obj.entity_cui) ?? null);
      },

      /**
       * Batch load main creditor entities for reports.
       */
      // eslint-disable-next-line @typescript-eslint/naming-convention -- GraphQL field name
      main_creditor: async (queries: LoaderQuery<Report>[], _context: MercuriusContext) => {
        // Filter out nulls and get unique CUIs
        const cuis = [
          ...new Set(
            queries.map((q) => q.obj.main_creditor_cui).filter((cui): cui is string => cui !== null)
          ),
        ];

        if (cuis.length === 0) {
          return queries.map(() => null);
        }

        const rows = await db
          .selectFrom('entities')
          .select([
            'cui',
            'name',
            'entity_type',
            'default_report_type',
            'uat_id',
            'is_uat',
            'address',
            'last_updated',
            'main_creditor_1_cui',
            'main_creditor_2_cui',
          ])
          .where('cui', 'in', cuis)
          .execute();

        const map = new Map(rows.map((e) => [e.cui, e]));
        return queries.map((q) => {
          if (q.obj.main_creditor_cui === null) {
            return null;
          }
          return map.get(q.obj.main_creditor_cui) ?? null;
        });
      },

      /**
       * Batch load budget sectors for reports.
       */
      budgetSector: async (queries: LoaderQuery<Report>[], _context: MercuriusContext) => {
        const ids = [...new Set(queries.map((q) => q.obj.budget_sector_id))];

        if (ids.length === 0) {
          return queries.map(() => null);
        }

        const rows = await db
          .selectFrom('budgetsectors')
          .select(['sector_id', 'sector_description'])
          .where('sector_id', 'in', ids)
          .execute();

        const map = new Map(rows.map((b) => [b.sector_id, b]));
        return queries.map((q) => {
          const data = map.get(q.obj.budget_sector_id);
          if (data === undefined) return null;
          return {
            sector_id: String(data.sector_id),
            sector_description: data.sector_description,
          };
        });
      },
    },
  };
};
