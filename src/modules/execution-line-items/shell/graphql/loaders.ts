/**
 * Mercurius loaders for ExecutionLineItem nested fields.
 *
 * Mercurius loaders automatically batch queries to avoid N+1 problems.
 * Each loader receives an array of queries and must return a
 * positionally-matched array of results.
 *
 * @see https://github.com/mercurius-js/mercurius/blob/master/docs/loaders.md
 */

import type { ExecutionLineItemOutput } from '../../core/types.js';
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
 * Creates Mercurius loaders for ExecutionLineItem nested fields.
 *
 * @param db - Database client for queries
 * @returns Mercurius loaders object
 */
export const createExecutionLineItemLoaders = (db: BudgetDbClient): MercuriusLoaders => {
  return {
    ExecutionLineItem: {
      /**
       * Batch load reports for line items.
       */
      report: async (
        queries: LoaderQuery<ExecutionLineItemOutput>[],
        _context: MercuriusContext
      ) => {
        const reportIds = [...new Set(queries.map((q) => q.obj.report_id))];

        if (reportIds.length === 0) {
          return queries.map(() => null);
        }

        const rows = await db
          .selectFrom('reports')
          .select([
            'report_id',
            'entity_cui',
            'report_type',
            'main_creditor_cui',
            'report_date',
            'reporting_year',
            'reporting_period',
            'budget_sector_id',
            'file_source',
          ])
          .where('report_id', 'in', reportIds)
          .execute();

        const map = new Map(rows.map((r) => [r.report_id, r]));
        return queries.map((q) => map.get(q.obj.report_id) ?? null);
      },

      /**
       * Batch load entities for line items.
       */
      entity: async (
        queries: LoaderQuery<ExecutionLineItemOutput>[],
        _context: MercuriusContext
      ) => {
        const cuis = [...new Set(queries.map((q) => q.obj.entity_cui))];

        if (cuis.length === 0) {
          return queries.map(() => null);
        }

        const rows = await db
          .selectFrom('entities')
          .select(['cui', 'name', 'uat_id', 'address', 'entity_type', 'is_uat'])
          .where('cui', 'in', cuis)
          .execute();

        const map = new Map(rows.map((e) => [e.cui, e]));
        return queries.map((q) => map.get(q.obj.entity_cui) ?? null);
      },

      /**
       * Batch load funding sources for line items.
       */
      fundingSource: async (
        queries: LoaderQuery<ExecutionLineItemOutput>[],
        _context: MercuriusContext
      ) => {
        const ids = [...new Set(queries.map((q) => q.obj.funding_source_id))];

        if (ids.length === 0) {
          return queries.map(() => null);
        }

        const rows = await db
          .selectFrom('fundingsources')
          .select(['source_id', 'source_description'])
          .where('source_id', 'in', ids)
          .execute();

        const map = new Map(rows.map((f) => [f.source_id, f]));
        return queries.map((q) => {
          const data = map.get(q.obj.funding_source_id);
          if (data === undefined) return null;
          return {
            source_id: String(data.source_id),
            source_description: data.source_description,
          };
        });
      },

      /**
       * Batch load budget sectors for line items.
       */
      budgetSector: async (
        queries: LoaderQuery<ExecutionLineItemOutput>[],
        _context: MercuriusContext
      ) => {
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

      /**
       * Batch load functional classifications for line items.
       */
      functionalClassification: async (
        queries: LoaderQuery<ExecutionLineItemOutput>[],
        _context: MercuriusContext
      ) => {
        const codes = [...new Set(queries.map((q) => q.obj.functional_code))];

        if (codes.length === 0) {
          return queries.map(() => null);
        }

        const rows = await db
          .selectFrom('functionalclassifications')
          .select(['functional_code', 'functional_name'])
          .where('functional_code', 'in', codes)
          .execute();

        const map = new Map(rows.map((f) => [f.functional_code, f]));
        return queries.map((q) => map.get(q.obj.functional_code) ?? null);
      },

      /**
       * Batch load economic classifications for line items.
       */
      economicClassification: async (
        queries: LoaderQuery<ExecutionLineItemOutput>[],
        _context: MercuriusContext
      ) => {
        const codes = queries
          .map((q) => q.obj.economic_code)
          .filter((code): code is string => code !== null);
        const uniqueCodes = [...new Set(codes)];

        if (uniqueCodes.length === 0) {
          return queries.map(() => null);
        }

        const rows = await db
          .selectFrom('economicclassifications')
          .select(['economic_code', 'economic_name'])
          .where('economic_code', 'in', uniqueCodes)
          .execute();

        const map = new Map(rows.map((e) => [e.economic_code, e]));
        return queries.map((q) => {
          if (q.obj.economic_code === null) return null;
          return map.get(q.obj.economic_code) ?? null;
        });
      },
    },
  };
};
