/**
 * MCP Module - Ports (Dependency Interfaces)
 *
 * Defines the interfaces for external dependencies.
 * These are implemented by adapters in the shell layer.
 */

import type { McpError } from './errors.js';
import type { McpSession, McpConfig } from './types.js';
import type { Decimal } from 'decimal.js';
import type { Result } from 'neverthrow';

// ─────────────────────────────────────────────────────────────────────────────
// Re-export repository types from existing modules
// ─────────────────────────────────────────────────────────────────────────────

// Entity module
export type { EntityRepository } from '@/modules/entity/index.js';
export type { Entity, EntityFilter, EntityConnection } from '@/modules/entity/index.js';

// UAT module
export type { UATRepository } from '@/modules/uat/index.js';
export type { UAT, UATFilter, UATConnection } from '@/modules/uat/index.js';

// Classification module
export type {
  FunctionalClassificationRepository,
  EconomicClassificationRepository,
  FunctionalClassification,
  EconomicClassification,
  FunctionalClassificationFilter,
  EconomicClassificationFilter,
} from '@/modules/classification/index.js';

// Entity analytics module
export type { EntityAnalyticsRepository } from '@/modules/entity-analytics/index.js';

// Aggregated line items module
export type { AggregatedLineItemsRepository } from '@/modules/aggregated-line-items/index.js';

// Share module
export type { ShortLinkRepository, Hasher } from '@/modules/share/index.js';

// ─────────────────────────────────────────────────────────────────────────────
// MCP-Specific Ports
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Session store interface for MCP sessions.
 * Implemented by Redis in production, in-memory for tests.
 */
export interface McpSessionStore {
  /**
   * Get a session by ID.
   * Returns null if session doesn't exist or is expired.
   */
  get(sessionId: string): Promise<McpSession | null>;

  /**
   * Create or update a session.
   */
  set(session: McpSession): Promise<void>;

  /**
   * Delete a session.
   */
  delete(sessionId: string): Promise<void>;

  /**
   * Update last accessed time (touch).
   * Used to extend session TTL on activity.
   */
  touch(sessionId: string): Promise<void>;
}

/**
 * Rate limiter interface for MCP endpoints.
 */
export interface McpRateLimiter {
  /**
   * Check if a request is allowed.
   * @param key - Identifier (session ID or IP)
   * @returns true if allowed, false if rate limited
   */
  isAllowed(key: string): Promise<boolean>;

  /**
   * Record a request.
   * @param key - Identifier (session ID or IP)
   */
  recordRequest(key: string): Promise<void>;

  /**
   * Get remaining requests in current window.
   * @param key - Identifier (session ID or IP)
   */
  getRemainingRequests(key: string): Promise<number>;
}

/**
 * Link builder interface for creating shareable URLs.
 */
export interface McpLinkBuilder {
  /**
   * Build entity details link.
   */
  buildEntityDetailsLink(cui: string, options: { year: number }): string;

  /**
   * Build functional classification view link.
   */
  buildFunctionalLink(
    cui: string,
    functionalCode: string,
    type: 'income' | 'expense',
    year: number
  ): string;

  /**
   * Build economic classification view link.
   */
  buildEconomicLink(
    cui: string,
    economicCode: string,
    type: 'income' | 'expense',
    year: number
  ): string;

  /**
   * Build entity analytics link.
   */
  buildEntityAnalyticsLink(options: {
    view: 'table' | 'line-items';
    filter: Record<string, unknown>;
    page?: number;
    pageSize?: number;
    treemapPrimary?: string;
    treemapDepth?: string;
  }): string;

  /**
   * Build chart link with embedded schema.
   */
  buildChartLink(chartId: string, chartSchema: Record<string, unknown>): string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Aggregated Dependencies
// ─────────────────────────────────────────────────────────────────────────────

/**
 * All repository dependencies needed by MCP tools.
 * This is injected into the MCP server factory.
 */
export interface McpToolDeps {
  // From entity module
  entityRepo: import('@/modules/entity/index.js').EntityRepository;

  // From UAT module
  uatRepo: import('@/modules/uat/index.js').UATRepository;

  // From classification module
  functionalClassificationRepo: import('@/modules/classification/index.js').FunctionalClassificationRepository;
  economicClassificationRepo: import('@/modules/classification/index.js').EconomicClassificationRepository;

  // From entity analytics module
  entityAnalyticsRepo: import('@/modules/entity-analytics/index.js').EntityAnalyticsRepository;

  // From aggregated line items module
  aggregatedLineItemsRepo: import('@/modules/aggregated-line-items/index.js').AggregatedLineItemsRepository;

  // From share module
  shortLinkRepo: import('@/modules/share/index.js').ShortLinkRepository;
  hasher: import('@/modules/share/index.js').Hasher;

  // MCP-specific
  linkBuilder: McpLinkBuilder;
}

/**
 * Infrastructure dependencies for MCP module.
 */
export interface McpInfraDeps {
  sessionStore: McpSessionStore;
  rateLimiter: McpRateLimiter;
  config: McpConfig;
}

/**
 * Logger interface for MCP operations.
 */
export interface McpLogger {
  debug(msg: string, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
}

// ─────────────────────────────────────────────────────────────────────────────
// Execution Line Items Port (for entity snapshot)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Yearly snapshot totals for an entity.
 * Uses Decimal for precise financial calculations.
 */
export interface YearlySnapshotTotals {
  totalIncome: Decimal;
  totalExpenses: Decimal;
}

/**
 * Repository for execution line item queries specific to MCP.
 * This extends what's available from existing modules.
 */
export interface McpExecutionRepo {
  /**
   * Get yearly income/expense totals for an entity.
   */
  getYearlySnapshotTotals(
    entityCui: string,
    year: number,
    reportType?: string
  ): Promise<Result<YearlySnapshotTotals, McpError>>;
}
