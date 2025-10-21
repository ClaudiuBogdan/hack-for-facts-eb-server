import { z } from 'zod';

export const periodSelectionSchema = z.object({
  interval: z
    .object({
      start: z.string(),
      end: z.string(),
    })
    .optional(),
  dates: z.array(z.string()).optional(),
});

export const analyticsFilterSchema = z.object({
  account_category: z.enum(['vn', 'ch']),
  report_period: z
    .object({
      type: z.enum(['MONTH', 'QUARTER', 'YEAR']),
      selection: periodSelectionSchema,
    })
    .optional(),
  report_type: z.string().optional(),
  main_creditor_cui: z.string().optional(),
  report_ids: z.array(z.string()).optional(),
  entity_cuis: z.array(z.string()).optional(),
  functional_codes: z.array(z.string()).optional(),
  functional_prefixes: z.array(z.string()).optional(),
  economic_codes: z.array(z.string()).optional(),
  economic_prefixes: z.array(z.string()).optional(),
  funding_source_ids: z.array(z.number()).optional(),
  budget_sector_ids: z.array(z.number()).optional(),
  expense_types: z.array(z.enum(['dezvoltare', 'functionare'])).optional(),
  program_codes: z.array(z.string()).optional(),
  county_codes: z.array(z.string()).optional(),
  regions: z.array(z.string()).optional(),
  uat_ids: z.array(z.number()).optional(),
  entity_types: z.array(z.string()).optional(),
  is_uat: z.boolean().optional(),
  search: z.string().optional(),
  min_population: z.number().nullable().optional(),
  max_population: z.number().nullable().optional(),
  normalization: z.enum(['total', 'per_capita', 'total_euro', 'per_capita_euro']).optional(),
  aggregate_min_amount: z.number().nullable().optional(),
  aggregate_max_amount: z.number().nullable().optional(),
  item_min_amount: z.number().nullable().optional(),
  item_max_amount: z.number().nullable().optional(),
  exclude: z
    .object({
      report_ids: z.array(z.string()).optional(),
      entity_cuis: z.array(z.string()).optional(),
      main_creditor_cui: z.string().optional(),
      functional_codes: z.array(z.string()).optional(),
      functional_prefixes: z.array(z.string()).optional(),
      economic_codes: z.array(z.string()).optional(),
      economic_prefixes: z.array(z.string()).optional(),
      funding_source_ids: z.array(z.number()).optional(),
      budget_sector_ids: z.array(z.number()).optional(),
      expense_types: z.array(z.enum(['dezvoltare', 'functionare'])).optional(),
      program_codes: z.array(z.string()).optional(),
      county_codes: z.array(z.string()).optional(),
      regions: z.array(z.string()).optional(),
      uat_ids: z.array(z.number()).optional(),
      entity_types: z.array(z.string()).optional(),
    })
    .optional(),
});

export type AnalyticsFilterInput = z.infer<typeof analyticsFilterSchema>;
