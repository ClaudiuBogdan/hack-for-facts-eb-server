/**
 * MCP Module - Common Schemas
 *
 * Shared TypeBox schemas used across multiple MCP tools.
 */

import { Type, type Static } from '@sinclair/typebox';

// ─────────────────────────────────────────────────────────────────────────────
// Language Schema
// ─────────────────────────────────────────────────────────────────────────────

export const LanguageSchema = Type.Union([Type.Literal('ro'), Type.Literal('en')], {
  description: 'Language for response content. Defaults to Romanian.',
  default: 'ro',
});

export type Language = Static<typeof LanguageSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Period Schemas
// ─────────────────────────────────────────────────────────────────────────────

export const GranularitySchema = Type.Union(
  [Type.Literal('YEAR'), Type.Literal('MONTH'), Type.Literal('QUARTER')],
  {
    description: 'Time granularity for the data series.',
  }
);

export type Granularity = Static<typeof GranularitySchema>;

export const PeriodIntervalSchema = Type.Object(
  {
    start: Type.String({
      description: 'Start period (YYYY for YEAR, YYYY-MM for MONTH, YYYY-QN for QUARTER)',
      examples: ['2020', '2020-01', '2020-Q1'],
    }),
    end: Type.String({
      description: 'End period (YYYY for YEAR, YYYY-MM for MONTH, YYYY-QN for QUARTER)',
      examples: ['2024', '2024-12', '2024-Q4'],
    }),
  },
  { description: 'Period interval with start and end dates.' }
);

export type PeriodInterval = Static<typeof PeriodIntervalSchema>;

export const PeriodSelectionSchema = Type.Union(
  [
    Type.Object({
      interval: PeriodIntervalSchema,
    }),
    Type.Object({
      dates: Type.Array(Type.String(), {
        description: 'Explicit list of periods',
        minItems: 1,
      }),
    }),
  ],
  { description: 'Period selection: either an interval or explicit dates.' }
);

export type PeriodSelection = Static<typeof PeriodSelectionSchema>;

export const PeriodInputSchema = Type.Object(
  {
    type: GranularitySchema,
    selection: PeriodSelectionSchema,
  },
  {
    description: 'Time period specification with granularity and selection.',
  }
);

export type PeriodInput = Static<typeof PeriodInputSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Account Category Schema
// ─────────────────────────────────────────────────────────────────────────────

export const AccountCategorySchema = Type.Union([Type.Literal('ch'), Type.Literal('vn')], {
  description: 'Account category: ch (cheltuieli/expenses) or vn (venituri/income)',
});

export type AccountCategory = Static<typeof AccountCategorySchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Normalization Schema
// ─────────────────────────────────────────────────────────────────────────────

export const NormalizationModeSchema = Type.Union(
  [
    Type.Literal('total'),
    Type.Literal('per_capita'),
    Type.Literal('total_euro'),
    Type.Literal('per_capita_euro'),
  ],
  {
    description:
      'Normalization mode: total (raw RON), per_capita (RON/capita), total_euro (EUR), per_capita_euro (EUR/capita)',
    default: 'total',
  }
);

export type NormalizationMode = Static<typeof NormalizationModeSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Expense Type Schema
// ─────────────────────────────────────────────────────────────────────────────

export const ExpenseTypeSchema = Type.Union(
  [Type.Literal('dezvoltare'), Type.Literal('functionare')],
  {
    description: 'Expense type: dezvoltare (development) or functionare (operating)',
  }
);

export type ExpenseType = Static<typeof ExpenseTypeSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Exclude Filter Schema
// ─────────────────────────────────────────────────────────────────────────────

export const ExcludeFilterSchema = Type.Object(
  {
    entity_cuis: Type.Optional(Type.Array(Type.String())),
    uat_ids: Type.Optional(Type.Array(Type.String())),
    county_codes: Type.Optional(Type.Array(Type.String())),
    functional_codes: Type.Optional(Type.Array(Type.String())),
    functional_prefixes: Type.Optional(Type.Array(Type.String())),
    economic_codes: Type.Optional(Type.Array(Type.String())),
    economic_prefixes: Type.Optional(Type.Array(Type.String())),
  },
  { description: 'Exclusion filters to exclude specific entities or classifications.' }
);

export type ExcludeFilter = Static<typeof ExcludeFilterSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Analytics Filter Schema
// ─────────────────────────────────────────────────────────────────────────────

export const AnalyticsFilterSchema = Type.Object(
  {
    // Required
    accountCategory: AccountCategorySchema,

    // Entity scope
    entityCuis: Type.Optional(
      Type.Array(Type.String(), {
        description: 'Filter by entity CUI codes',
      })
    ),
    uatIds: Type.Optional(
      Type.Array(Type.String(), {
        description: 'Filter by UAT (Administrative Territorial Unit) IDs',
      })
    ),
    countyCodes: Type.Optional(
      Type.Array(Type.String(), {
        description: 'Filter by county codes (e.g., "CJ", "B")',
      })
    ),
    regions: Type.Optional(
      Type.Array(Type.String(), {
        description: 'Filter by development regions',
      })
    ),
    isUat: Type.Optional(
      Type.Boolean({
        description: 'Filter to only UAT entities (true) or non-UAT (false)',
      })
    ),

    // Population constraints
    minPopulation: Type.Optional(
      Type.Number({
        description: 'Minimum population threshold',
      })
    ),
    maxPopulation: Type.Optional(
      Type.Number({
        description: 'Maximum population threshold',
      })
    ),

    // Classification filters
    functionalCodes: Type.Optional(
      Type.Array(Type.String(), {
        description: 'Filter by exact functional classification codes (COFOG)',
      })
    ),
    functionalPrefixes: Type.Optional(
      Type.Array(Type.String(), {
        description: 'Filter by functional classification prefixes (e.g., "65." for health)',
      })
    ),
    economicCodes: Type.Optional(
      Type.Array(Type.String(), {
        description: 'Filter by exact economic classification codes',
      })
    ),
    economicPrefixes: Type.Optional(
      Type.Array(Type.String(), {
        description: 'Filter by economic classification prefixes',
      })
    ),

    // Other filters
    fundingSourceIds: Type.Optional(Type.Array(Type.Number())),
    budgetSectorIds: Type.Optional(Type.Array(Type.Number())),
    expenseTypes: Type.Optional(Type.Array(ExpenseTypeSchema)),
    programCodes: Type.Optional(Type.Array(Type.String())),

    // Normalization
    normalization: Type.Optional(NormalizationModeSchema),

    // Report type
    reportType: Type.Optional(
      Type.String({
        description:
          'Report type: PRINCIPAL_AGGREGATED (default), SECONDARY_AGGREGATED, or DETAILED',
        default: 'PRINCIPAL_AGGREGATED',
      })
    ),

    // Exclusions
    exclude: Type.Optional(ExcludeFilterSchema),
  },
  {
    description: 'Analytics filter for querying budget data.',
  }
);

export type AnalyticsFilter = Static<typeof AnalyticsFilterSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Series Definition Schema
// ─────────────────────────────────────────────────────────────────────────────

export const SeriesDefinitionSchema = Type.Object(
  {
    label: Type.Optional(
      Type.String({
        description: 'Custom label for the series. Auto-generated if not provided.',
      })
    ),
    filter: AnalyticsFilterSchema,
  },
  { description: 'Definition of a single data series.' }
);

export type SeriesDefinition = Static<typeof SeriesDefinitionSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Sort Schema
// ─────────────────────────────────────────────────────────────────────────────

export const SortDirectionSchema = Type.Union([Type.Literal('ASC'), Type.Literal('DESC')], {
  description: 'Sort direction: ASC (ascending) or DESC (descending)',
  default: 'DESC',
});

export type SortDirection = Static<typeof SortDirectionSchema>;

export const SortSchema = Type.Object(
  {
    by: Type.String({
      description: 'Field to sort by (e.g., amount, per_capita_amount, entity_name)',
    }),
    order: Type.Optional(SortDirectionSchema),
  },
  { description: 'Sort configuration.' }
);

export type Sort = Static<typeof SortSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Pagination Schema
// ─────────────────────────────────────────────────────────────────────────────

export const PaginationSchema = Type.Object(
  {
    limit: Type.Optional(
      Type.Number({
        description: 'Maximum number of results to return',
        minimum: 1,
        maximum: 500,
        default: 50,
      })
    ),
    offset: Type.Optional(
      Type.Number({
        description: 'Number of results to skip',
        minimum: 0,
        default: 0,
      })
    ),
  },
  { description: 'Pagination options.' }
);

export type Pagination = Static<typeof PaginationSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Page Info Schema (Output)
// ─────────────────────────────────────────────────────────────────────────────

export const PageInfoSchema = Type.Object(
  {
    totalCount: Type.Number({ description: 'Total number of results' }),
    hasNextPage: Type.Boolean({ description: 'Whether there are more results after this page' }),
    hasPreviousPage: Type.Boolean({
      description: 'Whether there are results before this page',
    }),
  },
  { description: 'Pagination information.' }
);

export type PageInfoOutput = Static<typeof PageInfoSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Classification Dimension Schema
// ─────────────────────────────────────────────────────────────────────────────

export const ClassificationDimensionSchema = Type.Union([Type.Literal('fn'), Type.Literal('ec')], {
  description: 'Classification dimension: fn (functional/COFOG) or ec (economic)',
  default: 'fn',
});

export type ClassificationDimension = Static<typeof ClassificationDimensionSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Hierarchy Root Depth Schema
// ─────────────────────────────────────────────────────────────────────────────

export const HierarchyRootDepthSchema = Type.Union(
  [Type.Literal('chapter'), Type.Literal('subchapter'), Type.Literal('paragraph')],
  {
    description: 'Starting depth for hierarchy exploration',
    default: 'chapter',
  }
);

export type HierarchyRootDepth = Static<typeof HierarchyRootDepthSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Filter Category Schema
// ─────────────────────────────────────────────────────────────────────────────

export const FilterCategorySchema = Type.Union(
  [
    Type.Literal('entity'),
    Type.Literal('uat'),
    Type.Literal('functional_classification'),
    Type.Literal('economic_classification'),
  ],
  {
    description: 'Category to search for filter values',
  }
);

export type FilterCategory = Static<typeof FilterCategorySchema>;
