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
import type { DbReportType } from '@/modules/report/index.js';

// Re-export types from report module for backward compatibility
export type { DbReportType, GqlReportType } from '@/modules/report/index.js';
export { GQL_TO_DB_REPORT_TYPE, DB_TO_GQL_REPORT_TYPE } from '@/modules/report/index.js';

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
