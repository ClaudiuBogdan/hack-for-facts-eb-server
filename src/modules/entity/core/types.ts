/**
 * Domain types for Entity module.
 *
 * Entities represent public institutions, administrative units, and other
 * organizations that report budget execution data.
 */

import type {
  ReportPeriodInput,
  NormalizationMode,
  AnalyticsSeries,
} from '@/common/types/analytics.js';
import type { DataSeries } from '@/common/types/temporal.js';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** Default page size for entity listing */
export const DEFAULT_LIMIT = 20;

/** Maximum allowed page size */
export const MAX_LIMIT = 500;

/** Similarity threshold for pg_trgm search */
export const SIMILARITY_THRESHOLD = 0.1;

/** Cache configuration for single entities */
export const ENTITY_CACHE_CONFIG = {
  maxItems: 50_000,
  maxSizeBytes: 20 * 1024 * 1024, // 20MB
  ttlMs: 5 * 60 * 1000, // 5 minutes
} as const;

/** Cache configuration for entity lists */
export const ENTITIES_CACHE_CONFIG = {
  maxItems: 20_000,
  maxSizeBytes: 50 * 1024 * 1024, // 50MB
  ttlMs: 2 * 60 * 1000, // 2 minutes
} as const;

/** Cache configuration for entity counts */
export const COUNT_CACHE_CONFIG = {
  maxItems: 20_000,
  maxSizeBytes: 10 * 1024 * 1024, // 10MB
  ttlMs: 2 * 60 * 1000, // 2 minutes
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Report Type Mapping
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Database report type enum values.
 */
export type DbReportType =
  | 'Executie bugetara agregata la nivel de ordonator principal'
  | 'Executie bugetara agregata la nivel de ordonator secundar'
  | 'Executie bugetara detaliata';

/**
 * GraphQL report type enum values.
 */
export type GqlReportType = 'PRINCIPAL_AGGREGATED' | 'SECONDARY_AGGREGATED' | 'DETAILED';

/**
 * Maps GraphQL ReportType to database value.
 */
export const GQL_TO_DB_REPORT_TYPE: Record<GqlReportType, DbReportType> = {
  PRINCIPAL_AGGREGATED: 'Executie bugetara agregata la nivel de ordonator principal',
  SECONDARY_AGGREGATED: 'Executie bugetara agregata la nivel de ordonator secundar',
  DETAILED: 'Executie bugetara detaliata',
};

/**
 * Maps database ReportType to GraphQL value.
 */
export const DB_TO_GQL_REPORT_TYPE: Record<DbReportType, GqlReportType> = {
  'Executie bugetara agregata la nivel de ordonator principal': 'PRINCIPAL_AGGREGATED',
  'Executie bugetara agregata la nivel de ordonator secundar': 'SECONDARY_AGGREGATED',
  'Executie bugetara detaliata': 'DETAILED',
};

// ─────────────────────────────────────────────────────────────────────────────
// Entity Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Entity domain type.
 * Represents a public institution or administrative unit.
 */
export interface Entity {
  /** Unique fiscal identification code (CUI) */
  cui: string;
  /** Entity name */
  name: string;
  /** Entity type classification */
  entity_type: string | null;
  /** Default report type for this entity (DB enum value) */
  default_report_type: DbReportType;
  /** Reference to UAT (Administrative Territorial Unit) */
  uat_id: number | null;
  /** Whether this entity is a UAT */
  is_uat: boolean;
  /** Physical address */
  address: string | null;
  /** Last update timestamp */
  last_updated: Date | null;
  /** First main creditor CUI (parent entity) */
  main_creditor_1_cui: string | null;
  /** Second main creditor CUI (parent entity) */
  main_creditor_2_cui: string | null;
}

/**
 * Filter options for entity queries.
 */
export interface EntityFilter {
  /** Exact CUI match */
  cui?: string;
  /** Match any of these CUIs */
  cuis?: string[];
  /** Partial name match (ILIKE) when no search */
  name?: string;
  /** Entity type filter */
  entity_type?: string;
  /** UAT ID filter */
  uat_id?: number;
  /** Partial address match (ILIKE) when no search */
  address?: string;
  /** Full-text search using pg_trgm similarity */
  search?: string;
  /** Filter by is_uat flag */
  is_uat?: boolean;
  /** Filter by parent entities (matches main_creditor_1 OR main_creditor_2) */
  parents?: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Pagination Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Pagination metadata for entity listing.
 */
export interface EntityPageInfo {
  /** Total number of entities matching the filter */
  totalCount: number;
  /** Whether there are more pages after current */
  hasNextPage: boolean;
  /** Whether there are pages before current */
  hasPreviousPage: boolean;
}

/**
 * Paginated connection of entities.
 */
export interface EntityConnection {
  /** List of entities in current page */
  nodes: Entity[];
  /** Pagination metadata */
  pageInfo: EntityPageInfo;
}

// ─────────────────────────────────────────────────────────────────────────────
// UAT Types (Stub)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Administrative Territorial Unit (UAT).
 * Stub type for now - full implementation in separate module.
 */
export interface UAT {
  /** UAT ID */
  id: number;
  /** UAT key */
  uat_key: string;
  /** UAT code */
  uat_code: string;
  /** SIRUTA code */
  siruta_code: string;
  /** UAT name */
  name: string;
  /** County code */
  county_code: string;
  /** County name */
  county_name: string;
  /** Region name */
  region: string;
  /** Population count */
  population: number | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Report Types (Stub)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Budget execution report.
 * Stub type for now - full implementation in separate module.
 */
export interface Report {
  /** Report ID */
  report_id: string;
  /** Entity CUI */
  entity_cui: string;
  /** Report type */
  report_type: DbReportType;
  /** Main creditor CUI */
  main_creditor_cui: string | null;
  /** Report date */
  report_date: Date;
  /** Reporting year */
  reporting_year: number;
  /** Reporting period */
  reporting_period: string;
  /** Budget sector ID */
  budget_sector_id: number;
  /** File source path */
  file_source: string | null;
}

/**
 * Filter options for report queries.
 */
export interface ReportFilter {
  /** Entity CUI */
  entity_cui: string;
  /** Filter by year */
  year?: number;
  /** Filter by period */
  period?: string;
  /** Filter by report type */
  type?: GqlReportType;
  /** Filter by main creditor CUI */
  main_creditor_cui?: string;
}

/**
 * Report sort options.
 */
export interface ReportSort {
  by: string;
  order: 'ASC' | 'DESC';
}

/**
 * Pagination metadata for reports.
 */
export interface ReportPageInfo {
  totalCount: number;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
}

/**
 * Paginated connection of reports.
 */
export interface ReportConnection {
  nodes: Report[];
  pageInfo: ReportPageInfo;
}

// ─────────────────────────────────────────────────────────────────────────────
// Analytics Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Entity financial totals.
 */
export interface EntityTotals {
  /** Total income for the period */
  totalIncome: number;
  /** Total expenses for the period */
  totalExpenses: number;
  /** Budget balance (income - expenses) */
  budgetBalance: number;
}

/**
 * Re-export analytics types for convenience.
 */
export type { ReportPeriodInput, NormalizationMode, AnalyticsSeries, DataSeries };
