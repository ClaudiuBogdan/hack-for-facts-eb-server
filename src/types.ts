// Represents the data extracted consistently, regardless of source XML structure
export interface NormalizedData {
  cui?: string;
  entityName?: string;
  sectorType?: string;
  address?: string;
  parent1?: string;
  parent2?: string;
  reportingDate?: string; // Extracted date string
  formatId: string; // Identifier for the detected format
  lineItems: LineItem[];
  // Store original file path for context
  filePath: string;
  year: string;
  month: string;
}

export interface LineItem {
  functionalCode?: string;
  functionalName?: string;
  economicCode?: string;
  accountCategory?: string;
  economicName?: string;
  fundingSource?: string;
  amount?: number; // Example: Extracting amount if present
}

// ------------------------------
// Unified Analytics Filter Types
// ------------------------------

export type NormalizationMode = "total" | "per_capita";

export type ExpenseType = "dezvoltare" | "functionare";

export interface AnalyticsFilter {
  // Required scope
  years: number[];
  account_category: "vn" | "ch";

  // Line-item dimensional filters (WHERE on ExecutionLineItems or joined dims)
  report_ids?: string[];
  report_types?: string[];
  reporting_years?: number[];
  entity_cuis?: string[];
  functional_codes?: string[];
  functional_prefixes?: string[];
  economic_codes?: string[];
  economic_prefixes?: string[];
  funding_source_ids?: number[];
  budget_sector_ids?: number[];
  expense_types?: ExpenseType[];
  program_codes?: string[];

  // Geography / entity scope (joins to Entities/UATs)
  county_codes?: string[];
  regions?: string[];
  uat_ids?: number[];
  entity_types?: string[];
  is_uat?: boolean;
  search?: string;

  // Population constraints (missing population is treated as 0)
  min_population?: number | null;
  max_population?: number | null;

  // Transform and aggregated thresholds (HAVING on aggregated measure)
  normalization?: NormalizationMode; // default 'total'
  aggregate_min_amount?: number | null;
  aggregate_max_amount?: number | null;

  // Per-item thresholds (WHERE on eli.amount)
  item_min_amount?: number | null;
  item_max_amount?: number | null;
}
