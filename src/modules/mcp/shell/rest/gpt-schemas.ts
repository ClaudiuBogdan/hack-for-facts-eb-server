/**
 * GPT REST API Schemas
 *
 * TypeBox schemas for request/response validation.
 * Wraps MCP core schemas with REST-style response format.
 */

import { Type, type Static, type TObject } from '@sinclair/typebox';

// ─────────────────────────────────────────────────────────────────────────────
// Re-export Input Schemas (unchanged from MCP core)
// ─────────────────────────────────────────────────────────────────────────────

export {
  GetEntitySnapshotInputSchema,
  type GetEntitySnapshotInput,
  DiscoverFiltersInputSchema,
  type DiscoverFiltersInput,
  QueryTimeseriesInputSchema,
  type QueryTimeseriesInput,
  AnalyzeEntityBudgetInputSchema,
  type AnalyzeEntityBudgetInput,
  ExploreBudgetBreakdownInputSchema,
  type ExploreBudgetBreakdownInput,
  RankEntitiesInputSchema,
  type RankEntitiesInput,
} from '../../core/schemas/index.js';

// ─────────────────────────────────────────────────────────────────────────────
// Response Wrapper Schemas
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Creates a success response schema wrapping a data schema.
 * Format: { ok: true, data: T }
 */
export const SuccessResponseSchema = <T extends TObject>(dataSchema: T) =>
  Type.Object({
    ok: Type.Literal(true),
    data: dataSchema,
  });

/**
 * Error response schema.
 * Format: { ok: false, error: string, message: string }
 */
export const GptErrorResponseSchema = Type.Object({
  ok: Type.Literal(false),
  error: Type.String({ description: 'Error code (e.g., ENTITY_NOT_FOUND)' }),
  message: Type.String({ description: 'Human-readable error message' }),
});

export type GptErrorResponse = Static<typeof GptErrorResponseSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Data Schemas (inner content of successful responses)
// ─────────────────────────────────────────────────────────────────────────────

// Entity Snapshot Data (without ok field)
export const EntitySnapshotDataSchema = Type.Object({
  kind: Type.Literal('entities.details'),
  query: Type.Object({
    cui: Type.String(),
    year: Type.Number(),
  }),
  link: Type.String({ description: 'Shareable URL' }),
  item: Type.Object({
    cui: Type.String(),
    name: Type.String(),
    address: Type.Union([Type.String(), Type.Null()]),
    totalIncome: Type.Number(),
    totalExpenses: Type.Number(),
    totalIncomeFormatted: Type.String(),
    totalExpensesFormatted: Type.String(),
    summary: Type.String(),
  }),
});

// Discover Filters Data
export const DiscoverFiltersDataSchema = Type.Object({
  results: Type.Array(
    Type.Object({
      name: Type.String(),
      category: Type.String(),
      context: Type.Optional(Type.String()),
      score: Type.Number(),
      filterKey: Type.String(),
      filterValue: Type.String(),
      metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    })
  ),
  bestMatch: Type.Optional(
    Type.Object({
      name: Type.String(),
      category: Type.String(),
      context: Type.Optional(Type.String()),
      score: Type.Number(),
      filterKey: Type.String(),
      filterValue: Type.String(),
      metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    })
  ),
});

// Timeseries Data
export const TimeseriesDataSchema = Type.Object({
  title: Type.String(),
  dataLink: Type.String(),
  dataSeries: Type.Array(
    Type.Object({
      label: Type.String(),
      seriesId: Type.String(),
      xAxis: Type.Object({ name: Type.String(), unit: Type.String() }),
      yAxis: Type.Object({ name: Type.String(), unit: Type.String() }),
      dataPoints: Type.Array(Type.Object({ x: Type.String(), y: Type.Number() })),
      statistics: Type.Object({
        min: Type.Number(),
        max: Type.Number(),
        avg: Type.Number(),
        sum: Type.Number(),
        count: Type.Number(),
      }),
    })
  ),
});

// Entity Budget Data
export const EntityBudgetDataSchema = Type.Object({
  kind: Type.String(),
  query: Type.Object({
    cui: Type.String(),
    year: Type.Number(),
  }),
  link: Type.String(),
  item: Type.Object({
    cui: Type.String(),
    name: Type.String(),
    expenseGroups: Type.Array(
      Type.Object({
        code: Type.String(),
        name: Type.String(),
        amount: Type.Number(),
        percentage: Type.Number(),
        link: Type.Optional(Type.String()),
      })
    ),
    incomeGroups: Type.Array(
      Type.Object({
        code: Type.String(),
        name: Type.String(),
        amount: Type.Number(),
        percentage: Type.Number(),
        link: Type.Optional(Type.String()),
      })
    ),
    expenseGroupSummary: Type.Optional(Type.String()),
    incomeGroupSummary: Type.Optional(Type.String()),
  }),
});

// Budget Breakdown Data
export const BudgetBreakdownDataSchema = Type.Object({
  link: Type.String(),
  item: Type.Object({
    expenseGroups: Type.Optional(
      Type.Array(
        Type.Object({
          code: Type.String(),
          name: Type.String(),
          value: Type.Number(),
          count: Type.Number(),
          isLeaf: Type.Boolean(),
          percentage: Type.Number(),
          humanSummary: Type.Optional(Type.String()),
          link: Type.Optional(Type.String()),
        })
      )
    ),
    incomeGroups: Type.Optional(
      Type.Array(
        Type.Object({
          code: Type.String(),
          name: Type.String(),
          value: Type.Number(),
          count: Type.Number(),
          isLeaf: Type.Boolean(),
          percentage: Type.Number(),
          humanSummary: Type.Optional(Type.String()),
          link: Type.Optional(Type.String()),
        })
      )
    ),
    expenseGroupSummary: Type.Optional(Type.String()),
    incomeGroupSummary: Type.Optional(Type.String()),
  }),
});

// Rank Entities Data
export const RankEntitiesDataSchema = Type.Object({
  link: Type.String(),
  entities: Type.Array(
    Type.Object({
      entity_cui: Type.String(),
      entity_name: Type.String(),
      entity_type: Type.Union([Type.String(), Type.Null()]),
      uat_id: Type.Union([Type.Number(), Type.Null()]),
      county_code: Type.Union([Type.String(), Type.Null()]),
      county_name: Type.Union([Type.String(), Type.Null()]),
      population: Type.Union([Type.Number(), Type.Null()]),
      amount: Type.Number(),
      total_amount: Type.Number(),
      per_capita_amount: Type.Number(),
    })
  ),
  pageInfo: Type.Object({
    totalCount: Type.Number(),
    hasNextPage: Type.Boolean(),
    hasPreviousPage: Type.Boolean(),
  }),
});

// ─────────────────────────────────────────────────────────────────────────────
// Complete Response Schemas (for Fastify schema validation)
// ─────────────────────────────────────────────────────────────────────────────

export const EntitySnapshotResponseSchema = SuccessResponseSchema(EntitySnapshotDataSchema);
export const DiscoverFiltersResponseSchema = SuccessResponseSchema(DiscoverFiltersDataSchema);
export const TimeseriesResponseSchema = SuccessResponseSchema(TimeseriesDataSchema);
export const EntityBudgetResponseSchema = SuccessResponseSchema(EntityBudgetDataSchema);
export const BudgetBreakdownResponseSchema = SuccessResponseSchema(BudgetBreakdownDataSchema);
export const RankEntitiesResponseSchema = SuccessResponseSchema(RankEntitiesDataSchema);
