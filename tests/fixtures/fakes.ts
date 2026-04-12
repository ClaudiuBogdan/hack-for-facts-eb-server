/**
 * Test fakes and mocks
 */

import { Decimal } from 'decimal.js';
import { ok, err, type Result } from 'neverthrow';

import { FUNKY_NOTIFICATION_ENTITY_UPDATES_TYPE } from '@/common/campaign-keys.js';
import { makeUnsubscribeTokenSigner } from '@/infra/unsubscribe/token.js';
import { jsonValuesAreEqual } from '@/modules/learning-progress/core/json-equality.js';
import {
  USER_VISIBLE_NOTIFICATION_TYPES,
  generateNotificationHash,
  type Notification,
  type NotificationDelivery,
  type NotificationDeliveryHistory,
  type NotificationType,
} from '@/modules/notifications/core/types.js';
import { sha256Hasher } from '@/modules/notifications/shell/crypto/hasher.js';

import type { CachePort, CacheError, CacheSetOptions, CacheStats } from '@/infra/cache/index.js';
import type { BudgetDbClient, InsDbClient } from '@/infra/database/client.js';
import type {
  BudgetSectorRepository,
  BudgetSector,
  BudgetSectorFilter,
  BudgetSectorConnection,
} from '@/modules/budget-sector/index.js';
import type {
  DatasetRepo,
  Dataset,
  DatasetRepoError,
  DatasetFileEntry,
} from '@/modules/datasets/index.js';
import type {
  ExecutionLineItemRepository,
  ExecutionLineItem,
  ExecutionLineItemFilter,
  ExecutionLineItemConnection,
  SortInput,
} from '@/modules/execution-line-items/index.js';
import type {
  FundingSourceRepository,
  ExecutionLineItemRepository as FundingSourceLineItemRepository,
  FundingSource,
  FundingSourceFilter,
  FundingSourceConnection,
  ExecutionLineItem as FundingSourceLineItem,
  ExecutionLineItemFilter as FundingSourceLineItemFilter,
  ExecutionLineItemConnection as FundingSourceLineItemConnection,
} from '@/modules/funding-sources/index.js';
import type { LearningProgressError } from '@/modules/learning-progress/core/errors.js';
import type { LearningProgressRepository } from '@/modules/learning-progress/core/ports.js';
import type {
  CampaignAdminPhaseCounts,
  CampaignAdminInteractionRow,
  CampaignAdminReviewStatusCounts,
  CampaignAdminRiskFlagCandidate,
  CampaignAdminSortOrder,
  CampaignAdminStatsBase,
  CampaignAdminThreadPhaseCounts,
  CampaignAdminUserListCursor,
  CampaignAdminUserRow,
  CampaignAdminUserSortBy,
  CampaignAdminUsersMetaCounts,
  GetCampaignAdminStatsInput,
  GetCampaignAdminStatsOutput,
  GetCampaignAdminUsersMetaCountsInput,
  GetRecordsOptions,
  InteractiveAuditEvent,
  InteractiveStateRecord,
  ListCampaignAdminInteractionRowsInput,
  ListCampaignAdminInteractionRowsOutput,
  ListCampaignAdminUsersInput,
  ListCampaignAdminUsersOutput,
  LearningInteractiveUpdatedEvent,
  LearningProgressEvent,
  LearningProgressRecordRow,
  StoredInteractiveAuditEvent,
  UpsertInteractiveRecordInput,
} from '@/modules/learning-progress/core/types.js';
import type { DeliveryError } from '@/modules/notification-delivery/core/errors.js';
import type {
  DeliveryRepository,
  CreateDeliveryInput,
  UpdateRenderedContentInput,
  UpdateDeliveryStatusInput,
  ExtendedNotificationsRepository,
} from '@/modules/notification-delivery/core/ports.js';
import type { DeliveryRecord, DeliveryStatus } from '@/modules/notification-delivery/core/types.js';
import type { NotificationError } from '@/modules/notifications/core/errors.js';
import type {
  NotificationsRepository,
  DeliveriesRepository,
  UnsubscribeTokenSigner,
  CreateNotificationInput,
  UpdateNotificationRepoInput,
} from '@/modules/notifications/core/ports.js';
import type { ShareError } from '@/modules/share/core/errors.js';
import type { ShortLinkRepository, ShortLinkCache, Hasher } from '@/modules/share/core/ports.js';
import type { ShortLink, CreateShortLinkInput, UrlMetadata } from '@/modules/share/core/types.js';
import type { Kysely } from 'kysely';

/**
 * Creates minimal fake datasets for normalization.
 * These are required for the NormalizationService to initialize.
 */
const createMinimalNormalizationDatasets = (): Record<string, Dataset> => {
  // Sample years for testing
  const years = [2020, 2021, 2022, 2023, 2024];

  const createYearlyDataset = (id: string, unit: string, values: number[]): Dataset => ({
    id,
    metadata: {
      id,
      source: 'test',
      lastUpdated: '2024-01-01',
      units: unit,
      frequency: 'yearly',
    },
    i18n: {
      ro: {
        title: `Test ${id}`,
        xAxisLabel: 'An',
        yAxisLabel: unit,
      },
    },
    axes: {
      x: { label: 'Year', type: 'date', frequency: 'yearly' },
      y: { label: 'Value', type: 'number', unit },
    },
    points: years.map((year, i) => ({
      x: String(year),
      y: new Decimal(values[i] ?? values[0] ?? 100),
    })),
  });

  return {
    // CPI dataset - values represent a year-over-year index (base 100 each year)
    'ro.economics.cpi.yearly': createYearlyDataset(
      'ro.economics.cpi.yearly',
      'index',
      [100, 105, 118, 125, 130]
    ),
    // EUR exchange rate - RON per EUR
    'ro.economics.exchange.ron_eur.yearly': createYearlyDataset(
      'ro.economics.exchange.ron_eur.yearly',
      'RON/EUR',
      [4.87, 4.92, 4.93, 4.95, 4.97]
    ),
    // USD exchange rate - RON per USD
    'ro.economics.exchange.ron_usd.yearly': createYearlyDataset(
      'ro.economics.exchange.ron_usd.yearly',
      'RON/USD',
      [4.24, 4.16, 4.69, 4.57, 4.58]
    ),
    // GDP in RON
    'ro.economics.gdp.yearly': createYearlyDataset(
      'ro.economics.gdp.yearly',
      'RON',
      [
        1_058_000_000_000, 1_182_000_000_000, 1_409_000_000_000, 1_580_000_000_000,
        1_700_000_000_000,
      ]
    ),
    // Population
    'ro.demographics.population.yearly': createYearlyDataset(
      'ro.demographics.population.yearly',
      'persons',
      [19328000, 19201000, 19053000, 18968000, 18900000]
    ),
  };
};

interface FakeDatasetRepoOptions {
  /** Custom datasets to include */
  datasets?: Record<string, Dataset>;
  /** If true, includes minimal normalization datasets (default: true) */
  includeNormalizationDatasets?: boolean;
}

/**
 * Creates a fake dataset repository for testing.
 *
 * By default, includes minimal normalization datasets required for the
 * NormalizationService to initialize. Pass `includeNormalizationDatasets: false`
 * to create an empty repo for testing validation errors.
 */
export const makeFakeDatasetRepo = (options: FakeDatasetRepoOptions = {}): DatasetRepo => {
  const { datasets: customDatasets = {}, includeNormalizationDatasets = true } = options;

  // Merge datasets based on options
  const datasets = includeNormalizationDatasets
    ? { ...createMinimalNormalizationDatasets(), ...customDatasets }
    : customDatasets;

  return {
    getById: async (id: string): Promise<Result<Dataset, DatasetRepoError>> => {
      const dataset = datasets[id];
      if (dataset != null) {
        return ok(dataset);
      }
      return err({ type: 'NotFound', message: `Dataset ${id} not found` });
    },
    listAvailable: async (): Promise<Result<DatasetFileEntry[], DatasetRepoError>> => {
      const entries: DatasetFileEntry[] = Object.keys(datasets).map((id) => ({
        id,
        absolutePath: `/fake/${id}.yaml`,
        relativePath: `${id}.yaml`,
      }));
      return ok(entries);
    },
    getByIds: async (ids: string[]): Promise<Result<Dataset[], DatasetRepoError>> => {
      const uniqueIds = [...new Set(ids)];
      const results: Dataset[] = [];
      for (const id of uniqueIds) {
        const dataset = datasets[id];
        if (dataset != null) {
          results.push(dataset);
        }
      }
      return ok(results);
    },
    getAllWithMetadata: async (): Promise<Result<Dataset[], DatasetRepoError>> => {
      return ok(Object.values(datasets));
    },
  };
};

/**
 * Creates a fake budget database client for testing.
 *
 * This fake implements just enough to pass dependency injection checks
 * and work with health checkers (which use sql`SELECT 1`.execute(db)).
 */
export const makeFakeBudgetDb = (): BudgetDbClient => {
  // Use the Kysely fake that supports health check queries
  return makeFakeKyselyDb() as unknown as BudgetDbClient;
};

/**
 * Creates a fake INS database client for testing.
 */
export const makeFakeInsDb = (): InsDbClient => {
  return makeFakeKyselyDb() as unknown as InsDbClient;
};

// =============================================================================
// Health Check Fakes
// =============================================================================

interface FakeKyselyDbOptions {
  /** If provided, the health check query will fail with this error */
  failWithError?: Error;
  /** If provided, the health check query will delay by this many ms */
  delayMs?: number;
}

/**
 * Creates a fake Kysely client for testing health checkers.
 *
 * The fake implements just enough to support the `sql\`SELECT 1\`.execute(db)` pattern
 * used by the db health checker.
 *
 * Kysely's internals require:
 * - db.getExecutor() -> executor
 * - executor.executeQuery() -> query result
 * - executor.compileQuery() -> compiled query (for raw SQL)
 */
export const makeFakeKyselyDb = <T>(options: FakeKyselyDbOptions = {}): Kysely<T> => {
  const { failWithError, delayMs = 0 } = options;

  // Minimal compiled query object
  const fakeCompiledQuery = {
    sql: 'SELECT 1',
    parameters: [],
    query: { kind: 'RawNode' },
  };

  // The executor that actually runs queries
  const fakeExecutor = {
    executeQuery: async () => {
      if (delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
      if (failWithError !== undefined) {
        throw failWithError;
      }
      // Return a minimal query result
      return { rows: [{ '?column?': 1 }] };
    },
    compileQuery: () => fakeCompiledQuery,
    // Additional methods that Kysely might call
    transformQuery: (node: unknown) => node,
    provideConnection: async <R>(fn: (conn: unknown) => Promise<R>) => {
      return fn({
        executeQuery: async () => {
          if (delayMs > 0) {
            await new Promise((resolve) => setTimeout(resolve, delayMs));
          }
          if (failWithError !== undefined) {
            throw failWithError;
          }
          return { rows: [{ '?column?': 1 }] };
        },
      });
    },
  };

  // The db object with getExecutor method
  const fakeDb = {
    getExecutor: () => fakeExecutor,
  };

  return fakeDb as unknown as Kysely<T>;
};

interface FakeCachePortOptions {
  /** If provided, all operations will fail with this error */
  failWithError?: CacheError;
  /** If provided, operations will delay by this many ms */
  delayMs?: number;
}

/**
 * Creates a fake CachePort for testing cache health checker.
 *
 * Implements the CachePort interface with controllable behavior.
 */
export const makeFakeCachePort = <T = unknown>(
  options: FakeCachePortOptions = {}
): CachePort<T> => {
  const { failWithError, delayMs = 0 } = options;
  const store = new Map<string, T>();
  let hits = 0;
  let misses = 0;

  const maybeDelay = async (): Promise<void> => {
    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  };

  return {
    get: async (key: string) => {
      await maybeDelay();
      if (failWithError !== undefined) return err(failWithError);
      const value = store.get(key);
      if (value === undefined) {
        misses++;
        return ok(undefined);
      }
      hits++;
      return ok(value);
    },
    set: async (key: string, value: T, _options?: CacheSetOptions) => {
      await maybeDelay();
      if (failWithError !== undefined) return err(failWithError);
      store.set(key, value);
      return ok(undefined);
    },
    delete: async (key: string) => {
      await maybeDelay();
      if (failWithError !== undefined) return err(failWithError);
      const existed = store.has(key);
      store.delete(key);
      return ok(existed);
    },
    has: async (key: string) => {
      await maybeDelay();
      if (failWithError !== undefined) return err(failWithError);
      return ok(store.has(key));
    },
    clearByPrefix: async (prefix: string) => {
      await maybeDelay();
      if (failWithError !== undefined) return err(failWithError);
      let deleted = 0;
      for (const key of store.keys()) {
        if (key.startsWith(prefix)) {
          store.delete(key);
          deleted++;
        }
      }
      return ok(deleted);
    },
    clear: async () => {
      await maybeDelay();
      if (failWithError !== undefined) return err(failWithError);
      store.clear();
      hits = 0;
      misses = 0;
      return ok(undefined);
    },
    stats: async (): Promise<CacheStats> => {
      return { hits, misses, size: store.size };
    },
  };
};

// =============================================================================
// Budget Sector Fakes
// =============================================================================

/** Default budget sectors for testing */
const defaultBudgetSectors: BudgetSector[] = [
  { sector_id: 1, sector_description: 'Buget local' },
  { sector_id: 2, sector_description: 'Buget de stat' },
  { sector_id: 3, sector_description: 'Buget asigurari sociale' },
  { sector_id: 4, sector_description: 'Fonduri externe nerambursabile' },
];

interface FakeBudgetSectorRepoOptions {
  /** Custom sectors to use instead of defaults */
  sectors?: BudgetSector[];
}

/**
 * Creates a fake budget sector repository for testing.
 *
 * Uses simple substring matching for search filter (instead of pg_trgm).
 * Sectors are sorted by sector_id for deterministic pagination.
 */
export const makeFakeBudgetSectorRepo = (
  options: FakeBudgetSectorRepoOptions = {}
): BudgetSectorRepository => {
  const sectors = options.sectors ?? defaultBudgetSectors;

  return {
    findById: async (id: number) => {
      const sector = sectors.find((s) => s.sector_id === id);
      return ok(sector ?? null);
    },

    list: async (filter: BudgetSectorFilter | undefined, limit: number, offset: number) => {
      let filtered = [...sectors];

      // Apply search filter (simple substring match for fake)
      if (filter?.search !== undefined && filter.search.trim() !== '') {
        const searchLower = filter.search.toLowerCase();
        filtered = filtered.filter((s) => s.sector_description.toLowerCase().includes(searchLower));
      }

      // Apply sector_ids filter
      if (filter?.sector_ids !== undefined && filter.sector_ids.length > 0) {
        const idsSet = new Set(filter.sector_ids);
        filtered = filtered.filter((s) => idsSet.has(s.sector_id));
      }

      // Sort by ID for consistency
      filtered.sort((a, b) => a.sector_id - b.sector_id);

      const totalCount = filtered.length;
      const nodes = filtered.slice(offset, offset + limit);

      const connection: BudgetSectorConnection = {
        nodes,
        pageInfo: {
          totalCount,
          hasNextPage: offset + limit < totalCount,
          hasPreviousPage: offset > 0,
        },
      };

      return ok(connection);
    },
  };
};

// =============================================================================
// Funding Source Fakes
// =============================================================================

/** Default funding sources for testing */
const defaultFundingSources: FundingSource[] = [
  { source_id: 1, source_description: 'Buget de stat' },
  { source_id: 2, source_description: 'Fonduri externe nerambursabile' },
  { source_id: 3, source_description: 'Venituri proprii' },
  { source_id: 4, source_description: 'Credite externe' },
];

/** Default execution line items for funding source nested resolver testing */
const defaultFundingSourceLineItems: FundingSourceLineItem[] = [
  {
    line_item_id: '1',
    report_id: 'report-1',
    year: 2024,
    month: 6,
    entity_cui: '1234567',
    account_category: 'ch',
    functional_code: '51.01',
    economic_code: '10.01',
    ytd_amount: '1000000.00',
    monthly_amount: '100000.00',
  },
  {
    line_item_id: '2',
    report_id: 'report-1',
    year: 2024,
    month: 6,
    entity_cui: '1234567',
    account_category: 'vn',
    functional_code: '00.01',
    economic_code: null,
    ytd_amount: '2000000.00',
    monthly_amount: '200000.00',
  },
];

interface FakeFundingSourceRepoOptions {
  /** Custom funding sources to use instead of defaults */
  sources?: FundingSource[];
}

/**
 * Creates a fake funding source repository for testing.
 *
 * Uses simple substring matching for search filter (instead of pg_trgm).
 * Sources are sorted by source_id for deterministic pagination.
 */
export const makeFakeFundingSourceRepo = (
  options: FakeFundingSourceRepoOptions = {}
): FundingSourceRepository => {
  const sources = options.sources ?? defaultFundingSources;

  return {
    findById: async (id: number) => {
      const source = sources.find((s) => s.source_id === id);
      return ok(source ?? null);
    },

    list: async (filter: FundingSourceFilter | undefined, limit: number, offset: number) => {
      let filtered = [...sources];

      // Apply search filter (simple substring match for fake)
      if (filter?.search !== undefined && filter.search.trim() !== '') {
        const searchLower = filter.search.toLowerCase();
        filtered = filtered.filter((s) => s.source_description.toLowerCase().includes(searchLower));
      }

      // Apply source_ids filter
      if (filter?.source_ids !== undefined && filter.source_ids.length > 0) {
        const idsSet = new Set(filter.source_ids);
        filtered = filtered.filter((s) => idsSet.has(s.source_id));
      }

      // Sort by ID for consistency
      filtered.sort((a, b) => a.source_id - b.source_id);

      const totalCount = filtered.length;
      const nodes = filtered.slice(offset, offset + limit);

      const connection: FundingSourceConnection = {
        nodes,
        pageInfo: {
          totalCount,
          hasNextPage: offset + limit < totalCount,
          hasPreviousPage: offset > 0,
        },
      };

      return ok(connection);
    },
  };
};

interface FakeFundingSourceLineItemRepoOptions {
  /** Custom line items to use instead of defaults */
  lineItems?: FundingSourceLineItem[];
}

/**
 * Creates a fake execution line item repository for funding source nested resolvers.
 *
 * Line items are filtered by funding_source_id from the parent.
 * Additional filters (report_id, account_category) are applied if provided.
 */
export const makeFakeFundingSourceLineItemRepo = (
  options: FakeFundingSourceLineItemRepoOptions = {}
): FundingSourceLineItemRepository => {
  const lineItems = options.lineItems ?? defaultFundingSourceLineItems;

  return {
    listByFundingSource: async (
      filter: FundingSourceLineItemFilter,
      limit: number,
      offset: number
    ) => {
      // In real implementation, items would be filtered by funding_source_id
      // For fake, we just return all items or empty based on funding_source_id
      let filtered =
        filter.funding_source_id === 1 || filter.funding_source_id === 2 ? [...lineItems] : [];

      // Apply report_id filter
      if (filter.report_id !== undefined) {
        filtered = filtered.filter((item) => item.report_id === filter.report_id);
      }

      // Apply account_category filter
      if (filter.account_category !== undefined) {
        filtered = filtered.filter((item) => item.account_category === filter.account_category);
      }

      const totalCount = filtered.length;
      const nodes = filtered.slice(offset, offset + limit);

      const connection: FundingSourceLineItemConnection = {
        nodes,
        pageInfo: {
          totalCount,
          hasNextPage: offset + limit < totalCount,
          hasPreviousPage: offset > 0,
        },
      };

      return ok(connection);
    },
  };
};

// =============================================================================
// Execution Line Items Module Fakes
// =============================================================================

/** Default execution line items for comprehensive testing */
const defaultExecutionLineItems: ExecutionLineItem[] = [
  {
    line_item_id: 'eli-1',
    report_id: 'report-1',
    entity_cui: '1234567',
    funding_source_id: 1,
    budget_sector_id: 1,
    functional_code: '51.01',
    economic_code: '10.01',
    account_category: 'ch',
    expense_type: 'functionare',
    program_code: null,
    year: 2024,
    month: 6,
    quarter: 2,
    ytd_amount: new Decimal('1000000.00'),
    monthly_amount: new Decimal('100000.00'),
    quarterly_amount: new Decimal('300000.00'),
    anomaly: null,
  },
  {
    line_item_id: 'eli-2',
    report_id: 'report-1',
    entity_cui: '1234567',
    funding_source_id: 1,
    budget_sector_id: 1,
    functional_code: '00.01',
    economic_code: null,
    account_category: 'vn',
    expense_type: null,
    program_code: null,
    year: 2024,
    month: 6,
    quarter: 2,
    ytd_amount: new Decimal('2000000.00'),
    monthly_amount: new Decimal('200000.00'),
    quarterly_amount: new Decimal('600000.00'),
    anomaly: null,
  },
  {
    line_item_id: 'eli-3',
    report_id: 'report-2',
    entity_cui: '7654321',
    funding_source_id: 2,
    budget_sector_id: 2,
    functional_code: '54.02',
    economic_code: '20.01',
    account_category: 'ch',
    expense_type: 'dezvoltare',
    program_code: 'P001',
    year: 2023,
    month: 12,
    quarter: 4,
    ytd_amount: new Decimal('5000000.00'),
    monthly_amount: new Decimal('500000.00'),
    quarterly_amount: new Decimal('1500000.00'),
    anomaly: null,
  },
];

interface FakeExecutionLineItemRepoOptions {
  /** Custom line items to use instead of defaults */
  lineItems?: ExecutionLineItem[];
}

/**
 * Creates a fake execution line item repository for testing.
 *
 * Supports findById and list operations with basic filtering.
 * Filtering is simplified - doesn't implement all filter options.
 */
export const makeFakeExecutionLineItemRepo = (
  options: FakeExecutionLineItemRepoOptions = {}
): ExecutionLineItemRepository => {
  const lineItems = options.lineItems ?? defaultExecutionLineItems;

  return {
    findById: async (id: string) => {
      const item = lineItems.find((i) => i.line_item_id === id);
      return ok(item ?? null);
    },

    list: async (
      filter: ExecutionLineItemFilter,
      _sort: SortInput,
      limit: number,
      offset: number
    ) => {
      let filtered = [...lineItems];

      // Apply account_category filter (required)
      if (filter.account_category !== undefined) {
        filtered = filtered.filter((item) => item.account_category === filter.account_category);
      }

      // Apply entity_cuis filter
      if (filter.entity_cuis !== undefined && filter.entity_cuis.length > 0) {
        const cuisSet = new Set(filter.entity_cuis);
        filtered = filtered.filter((item) => cuisSet.has(item.entity_cui));
      }

      // Apply functional_codes filter
      if (filter.functional_codes !== undefined && filter.functional_codes.length > 0) {
        const codesSet = new Set(filter.functional_codes);
        filtered = filtered.filter((item) => codesSet.has(item.functional_code));
      }

      // Apply funding_source_ids filter (strings in filter, numbers in items)
      if (filter.funding_source_ids !== undefined && filter.funding_source_ids.length > 0) {
        const idsSet = new Set(filter.funding_source_ids.map(Number));
        filtered = filtered.filter((item) => idsSet.has(item.funding_source_id));
      }

      // Sort by year desc, ytd_amount desc (default)
      filtered.sort((a, b) => {
        if (a.year !== b.year) {
          return b.year - a.year;
        }
        return b.ytd_amount.comparedTo(a.ytd_amount);
      });

      const totalCount = filtered.length;
      const nodes = filtered.slice(offset, offset + limit);

      const connection: ExecutionLineItemConnection = {
        nodes,
        pageInfo: {
          totalCount,
          hasNextPage: offset + limit < totalCount,
          hasPreviousPage: offset > 0,
        },
      };

      return ok(connection);
    },
  };
};

// =============================================================================
// Notifications Module Fakes
// =============================================================================

interface FakeNotificationsRepoOptions {
  /** Initial notifications to seed the store with */
  notifications?: Notification[];
  /** Enable database error simulation */
  simulateDbError?: boolean;
}

/**
 * Creates a fake notifications repository for testing.
 *
 * Implements all NotificationsRepository methods using an in-memory Map.
 * Supports basic CRUD operations with proper uniqueness by hash.
 */
export const makeFakeNotificationsRepo = (
  options: FakeNotificationsRepoOptions = {}
): NotificationsRepository => {
  const store = new Map<string, Notification>();
  const simulateDbError = options.simulateDbError ?? false;

  // Seed initial notifications
  if (options.notifications !== undefined) {
    for (const n of options.notifications) {
      store.set(n.id, { ...n });
    }
  }

  const createDbError = (): Result<never, NotificationError> =>
    err({ type: 'DatabaseError', message: 'Simulated database error', retryable: true });

  return {
    create: async (
      input: CreateNotificationInput
    ): Promise<Result<Notification, NotificationError>> => {
      if (simulateDbError) return createDbError();

      const id = crypto.randomUUID();
      const now = new Date();
      const notification: Notification = {
        id,
        userId: input.userId,
        entityCui: input.entityCui,
        notificationType: input.notificationType,
        isActive: true,
        config: input.config,
        hash: input.hash,
        createdAt: now,
        updatedAt: now,
      };
      store.set(id, notification);
      return ok(notification);
    },

    findById: async (id: string): Promise<Result<Notification | null, NotificationError>> => {
      if (simulateDbError) return createDbError();
      const notification = store.get(id);
      return ok(notification ?? null);
    },

    findByHash: async (hash: string): Promise<Result<Notification | null, NotificationError>> => {
      if (simulateDbError) return createDbError();
      for (const notification of store.values()) {
        if (notification.hash === hash) {
          return ok(notification);
        }
      }
      return ok(null);
    },

    findByUserId: async (
      userId: string,
      activeOnly: boolean
    ): Promise<Result<Notification[], NotificationError>> => {
      if (simulateDbError) return createDbError();
      const notifications: Notification[] = [];
      for (const n of store.values()) {
        if (n.userId === userId) {
          if (activeOnly && !n.isActive) continue;
          notifications.push(n);
        }
      }
      return ok(notifications);
    },

    findByUserAndEntity: async (
      userId: string,
      entityCui: string | null,
      activeOnly: boolean
    ): Promise<Result<Notification[], NotificationError>> => {
      if (simulateDbError) return createDbError();
      const notifications: Notification[] = [];
      for (const n of store.values()) {
        if (n.userId === userId && n.entityCui === entityCui) {
          if (activeOnly && !n.isActive) continue;
          notifications.push(n);
        }
      }
      return ok(notifications);
    },

    findByUserTypeAndEntity: async (
      userId: string,
      notificationType: NotificationType,
      entityCui: string | null
    ): Promise<Result<Notification | null, NotificationError>> => {
      if (simulateDbError) return createDbError();
      for (const n of store.values()) {
        if (
          n.userId === userId &&
          n.notificationType === notificationType &&
          n.entityCui === entityCui
        ) {
          return ok(n);
        }
      }
      return ok(null);
    },

    update: async (
      id: string,
      input: UpdateNotificationRepoInput
    ): Promise<Result<Notification, NotificationError>> => {
      if (simulateDbError) return createDbError();
      const notification = store.get(id);
      if (notification === undefined) {
        return err({
          type: 'NotificationNotFoundError',
          message: `Notification with ID '${id}' not found`,
          id,
        });
      }

      const updated: Notification = {
        ...notification,
        ...(input.isActive !== undefined && { isActive: input.isActive }),
        ...(input.config !== undefined && { config: input.config }),
        ...(input.hash !== undefined && { hash: input.hash }),
        updatedAt: new Date(),
      };
      store.set(id, updated);
      return ok(updated);
    },

    updateCampaignGlobalPreference: async (
      id,
      input
    ): Promise<Result<Notification, NotificationError>> => {
      if (simulateDbError) return createDbError();
      const notification = store.get(id);
      if (notification === undefined) {
        return err({
          type: 'NotificationNotFoundError',
          message: `Notification with ID '${id}' not found`,
          id,
        });
      }

      const updatedAt = new Date();
      const updatedGlobal: Notification = {
        ...notification,
        isActive: input.isActive,
        ...(input.config !== undefined && { config: input.config }),
        ...(input.hash !== undefined && { hash: input.hash }),
        updatedAt,
      };
      store.set(id, updatedGlobal);

      for (const current of store.values()) {
        if (
          current.userId !== updatedGlobal.userId ||
          current.notificationType !== FUNKY_NOTIFICATION_ENTITY_UPDATES_TYPE
        ) {
          continue;
        }

        store.set(current.id, {
          ...current,
          isActive: input.isActive,
          updatedAt,
        });
      }

      return ok(updatedGlobal);
    },

    deleteCascade: async (id: string): Promise<Result<Notification | null, NotificationError>> => {
      if (simulateDbError) return createDbError();
      const notification = store.get(id);
      if (notification === undefined) {
        return ok(null);
      }
      store.delete(id);
      return ok(notification);
    },

    deactivateGlobalUnsubscribe: async (
      userId: string
    ): Promise<Result<void, NotificationError>> => {
      if (simulateDbError) return createDbError();
      let found = false;
      for (const n of store.values()) {
        if (
          n.userId === userId &&
          n.notificationType === ('global_unsubscribe' as NotificationType)
        ) {
          store.set(n.id, { ...n, isActive: false, updatedAt: new Date() });
          found = true;
          break;
        }
      }
      if (!found) {
        const id = crypto.randomUUID();
        const now = new Date();
        const config = { channels: { email: false } };
        store.set(id, {
          id,
          userId,
          entityCui: null,
          notificationType: 'global_unsubscribe' as NotificationType,
          isActive: false,
          config,
          hash: generateNotificationHash(sha256Hasher, userId, 'global_unsubscribe', null, config),
          createdAt: now,
          updatedAt: now,
        });
      }
      return ok(undefined);
    },
  };
};

interface FakeDeliveriesRepoOptions {
  /** Initial deliveries to seed the store with */
  deliveries?: NotificationDelivery[];
  /** Enable database error simulation */
  simulateDbError?: boolean;
}

/**
 * Creates a fake deliveries repository for testing.
 */
export const makeFakeDeliveriesRepo = (
  options: FakeDeliveriesRepoOptions = {}
): DeliveriesRepository => {
  const deliveries = [...(options.deliveries ?? [])];
  const simulateDbError = options.simulateDbError ?? false;
  const hasSentAt = (
    delivery: NotificationDelivery
  ): delivery is NotificationDeliveryHistory & { notificationType?: NotificationType } => {
    return delivery.sentAt !== null;
  };

  return {
    findByUserId: async (
      userId: string,
      limit: number,
      offset: number
    ): Promise<Result<NotificationDeliveryHistory[], NotificationError>> => {
      if (simulateDbError) {
        return err({ type: 'DatabaseError', message: 'Simulated database error', retryable: true });
      }

      const userDeliveries = deliveries
        .filter((d): d is NotificationDeliveryHistory & { notificationType?: NotificationType } => {
          const notificationType = (
            d as NotificationDelivery & { notificationType?: NotificationType }
          ).notificationType;

          return (
            d.userId === userId &&
            hasSentAt(d) &&
            notificationType !== undefined &&
            [...USER_VISIBLE_NOTIFICATION_TYPES].includes(notificationType)
          );
        })
        .sort((a, b) => {
          const aTime = a.sentAt.getTime();
          const bTime = b.sentAt.getTime();
          return bTime - aTime;
        });

      return ok(userDeliveries.slice(offset, offset + limit) as NotificationDeliveryHistory[]);
    },
  };
};

// =============================================================================
// Notification Test Builders
// =============================================================================

let notificationIdCounter = 0;

/**
 * Creates a test notification with sensible defaults.
 */
export const createTestNotification = (overrides: Partial<Notification> = {}): Notification => {
  notificationIdCounter++;
  const now = new Date();
  return {
    id: overrides.id ?? `notification-${String(notificationIdCounter)}`,
    userId: overrides.userId ?? 'user-1',
    entityCui: overrides.entityCui ?? null,
    notificationType: overrides.notificationType ?? 'newsletter_entity_monthly',
    isActive: overrides.isActive ?? true,
    config: overrides.config ?? null,
    hash: overrides.hash ?? `hash-${String(notificationIdCounter)}`,
    createdAt: overrides.createdAt ?? now,
    updatedAt: overrides.updatedAt ?? now,
  };
};

let deliveryIdCounter = 0;

/**
 * Creates a test delivery with sensible defaults.
 */
export const createTestDelivery = (
  overrides: Partial<NotificationDelivery> & { notificationType?: NotificationType } = {}
): NotificationDelivery => {
  deliveryIdCounter++;
  const now = new Date();
  const userId = overrides.userId ?? 'user-1';
  const notificationId =
    'notificationId' in overrides ? (overrides.notificationId ?? null) : 'notification-1';
  const scopeKey = overrides.scopeKey ?? '2024-01';
  const deliveryKey =
    overrides.deliveryKey ??
    (notificationId === null
      ? `${userId}:no-reference:${scopeKey}`
      : `${userId}:${notificationId}:${scopeKey}`);

  return {
    id: overrides.id ?? `delivery-${String(deliveryIdCounter)}`,
    userId,
    notificationId,
    scopeKey,
    deliveryKey,
    status: overrides.status ?? 'sent',
    renderedSubject: overrides.renderedSubject ?? null,
    renderedHtml: overrides.renderedHtml ?? null,
    renderedText: overrides.renderedText ?? null,
    contentHash: overrides.contentHash ?? null,
    templateName: overrides.templateName ?? null,
    templateVersion: overrides.templateVersion ?? null,
    toEmail: overrides.toEmail ?? null,
    resendEmailId: overrides.resendEmailId ?? null,
    lastError: overrides.lastError ?? null,
    attemptCount: overrides.attemptCount ?? 1,
    lastAttemptAt: overrides.lastAttemptAt ?? now,
    sentAt: overrides.sentAt ?? now,
    metadata: overrides.metadata ?? {},
    createdAt: overrides.createdAt ?? now,
    notificationType: overrides.notificationType ?? 'newsletter_entity_monthly',
  } as NotificationDelivery;
};

// =============================================================================
// Share Module Fakes
// =============================================================================

interface FakeShortLinkRepoOptions {
  /** Initial short links to seed the store with */
  shortLinks?: ShortLink[];
  /** Enable database error simulation */
  simulateDbError?: boolean;
}

/**
 * Creates a fake short link repository for testing.
 *
 * Implements all ShortLinkRepository methods using an in-memory Map.
 * Supports basic CRUD operations.
 */
export const makeFakeShortLinkRepo = (
  options: FakeShortLinkRepoOptions = {}
): ShortLinkRepository => {
  const store = new Map<string, ShortLink>();
  const simulateDbError = options.simulateDbError ?? false;

  // Seed initial short links (keyed by code)
  if (options.shortLinks !== undefined) {
    for (const link of options.shortLinks) {
      store.set(link.code, { ...link });
    }
  }

  const createDbError = (): Result<never, ShareError> =>
    err({ type: 'DatabaseError', message: 'Simulated database error', retryable: true });

  return {
    getByCode: async (code: string): Promise<Result<ShortLink | null, ShareError>> => {
      if (simulateDbError) return createDbError();
      const link = store.get(code);
      return ok(link ?? null);
    },

    getByOriginalUrl: async (url: string): Promise<Result<ShortLink | null, ShareError>> => {
      if (simulateDbError) return createDbError();
      for (const link of store.values()) {
        if (link.originalUrl === url) {
          return ok(link);
        }
      }
      return ok(null);
    },

    createOrAssociateUser: async (
      input: CreateShortLinkInput
    ): Promise<Result<ShortLink, ShareError>> => {
      if (simulateDbError) return createDbError();

      // Check if link exists by URL
      for (const existing of store.values()) {
        if (existing.originalUrl === input.originalUrl) {
          // Associate user if not already
          if (!existing.userIds.includes(input.userId)) {
            const updated: ShortLink = {
              ...existing,
              userIds: [...existing.userIds, input.userId],
            };
            store.set(existing.code, updated);
            return ok(updated);
          }
          return ok(existing);
        }
      }

      // Check for collision (same code, different URL)
      const existingByCode = store.get(input.code);
      if (existingByCode !== undefined) {
        return err({
          type: 'HashCollisionError',
          message: 'Hash collision detected',
          code: input.code,
        });
      }

      // Create new link
      const id = crypto.randomUUID();
      const now = new Date();
      const newLink: ShortLink = {
        id,
        code: input.code,
        userIds: [input.userId],
        originalUrl: input.originalUrl,
        createdAt: now,
        accessCount: 0,
        lastAccessAt: null,
        metadata: input.metadata,
      };
      store.set(input.code, newLink);
      return ok(newLink);
    },

    countRecentForUser: async (
      userId: string,
      since: Date
    ): Promise<Result<number, ShareError>> => {
      if (simulateDbError) return createDbError();
      let count = 0;
      for (const link of store.values()) {
        if (link.userIds.includes(userId) && link.createdAt >= since) {
          count++;
        }
      }
      return ok(count);
    },

    incrementAccessStats: async (code: string): Promise<Result<void, ShareError>> => {
      if (simulateDbError) return createDbError();
      const link = store.get(code);
      if (link !== undefined) {
        const updated: ShortLink = {
          ...link,
          accessCount: link.accessCount + 1,
          lastAccessAt: new Date(),
        };
        store.set(code, updated);
      }
      return ok(undefined);
    },
  };
};

interface FakeShortLinkCacheOptions {
  /** Initial cache entries */
  entries?: Map<string, string>;
}

/**
 * Creates a fake short link cache for testing.
 */
export const makeFakeShortLinkCache = (options: FakeShortLinkCacheOptions = {}): ShortLinkCache => {
  const cache = new Map<string, string>(options.entries ?? []);

  return {
    get: async (code: string): Promise<string | null> => {
      return cache.get(code) ?? null;
    },

    set: async (code: string, originalUrl: string): Promise<void> => {
      cache.set(code, originalUrl);
    },
  };
};

/**
 * Deterministic test hasher that produces predictable output.
 * Uses simple string manipulation instead of real cryptography.
 */
export const testHasher: Hasher = {
  sha256: (data: string): string => {
    // Create a simple deterministic hash based on input
    let hash = 0;
    for (let i = 0; i < data.length; i++) {
      const char = data.codePointAt(i) ?? 0;
      hash = Math.trunc((hash << 5) - hash + char);
    }
    // Convert to hex and pad to 64 chars
    const hexHash = Math.abs(hash).toString(16).padStart(8, '0');
    return hexHash.repeat(8).substring(0, 64);
  },
  sha512: (data: string): string => {
    // Create a longer deterministic hash
    let hash = 0;
    for (let i = 0; i < data.length; i++) {
      const char = data.codePointAt(i) ?? 0;
      hash = Math.trunc((hash << 5) - hash + char);
    }
    const hexHash = Math.abs(hash).toString(16).padStart(8, '0');
    return hexHash.repeat(16).substring(0, 128);
  },
};

// =============================================================================
// Short Link Test Builders
// =============================================================================

let shortLinkIdCounter = 0;

/**
 * Creates a test short link with sensible defaults.
 */
export const createTestShortLink = (overrides: Partial<ShortLink> = {}): ShortLink => {
  shortLinkIdCounter++;
  const now = new Date();
  return {
    id: overrides.id ?? `shortlink-${String(shortLinkIdCounter)}`,
    code: overrides.code ?? `code${String(shortLinkIdCounter).padStart(12, '0')}`,
    userIds: overrides.userIds ?? ['user-1'],
    originalUrl: overrides.originalUrl ?? 'https://transparenta.eu/page',
    createdAt: overrides.createdAt ?? now,
    accessCount: overrides.accessCount ?? 0,
    lastAccessAt: overrides.lastAccessAt ?? null,
    metadata: overrides.metadata ?? { path: '/page', query: {} },
  };
};

/**
 * Creates test URL metadata with sensible defaults.
 */
export const createTestUrlMetadata = (overrides: Partial<UrlMetadata> = {}): UrlMetadata => {
  return {
    path: overrides.path ?? '/page',
    query: overrides.query ?? {},
  };
};

// =============================================================================
// Learning Progress Module Fakes
// =============================================================================

interface FakeLearningProgressRepoOptions {
  /** Initial records per user (Map<userId, records>) */
  initialRecords?: Map<string, LearningProgressRecordRow[]>;
  /** Optional minimal campaign-admin thread summaries keyed by campaign/entity */
  campaignAdminThreadSummaries?: Map<string, CampaignAdminInteractionRow['threadSummary']>;
  /** Enable database error simulation */
  simulateDbError?: boolean;
  /** Fail when a specific upsert attempt is reached (1-based) */
  failOnUpsertAttempt?: number;
  /** Fail when a specific reset attempt is reached (1-based) */
  failOnResetAttempt?: number;
}

/**
 * Creates a fake learning progress repository for testing.
 *
 * Implements the generic record store using an in-memory Map.
 */
export const makeFakeLearningProgressRepo = (
  options: FakeLearningProgressRepoOptions = {}
): LearningProgressRepository => {
  const store = new Map<string, Map<string, LearningProgressRecordRow>>();
  const campaignAdminThreadSummaries = options.campaignAdminThreadSummaries ?? new Map();
  const simulateDbError = options.simulateDbError ?? false;
  const failOnUpsertAttempt = options.failOnUpsertAttempt;
  const failOnResetAttempt = options.failOnResetAttempt;
  let nextSeq = 1n;
  let upsertAttempts = 0;
  let resetAttempts = 0;

  if (options.initialRecords !== undefined) {
    for (const [userId, records] of options.initialRecords.entries()) {
      const userStore = new Map<string, LearningProgressRecordRow>();
      for (const record of records) {
        userStore.set(record.recordKey, {
          ...record,
          auditEvents: [...record.auditEvents],
        });
        const recordSeq = BigInt(record.updatedSeq);
        if (recordSeq >= nextSeq) {
          nextSeq = recordSeq + 1n;
        }
      }
      store.set(userId, userStore);
    }
  }

  const createDbError = (): Result<never, LearningProgressError> =>
    err({ type: 'DatabaseError', message: 'Simulated database error', retryable: true });

  const compareTimestamps = (leftTimestamp: string, rightTimestamp: string): number => {
    const leftValue = Date.parse(leftTimestamp);
    const rightValue = Date.parse(rightTimestamp);

    if (Number.isNaN(leftValue) || Number.isNaN(rightValue)) {
      return leftTimestamp.localeCompare(rightTimestamp);
    }

    if (leftValue < rightValue) return -1;
    if (leftValue > rightValue) return 1;
    return 0;
  };

  const compareReviewRows = (
    leftRow: LearningProgressRecordRow,
    rightRow: LearningProgressRecordRow
  ): number => {
    const updatedAtComparison = compareTimestamps(rightRow.updatedAt, leftRow.updatedAt);
    if (updatedAtComparison !== 0) {
      return updatedAtComparison;
    }

    const userComparison = leftRow.userId.localeCompare(rightRow.userId);
    if (userComparison !== 0) {
      return userComparison;
    }

    return leftRow.recordKey.localeCompare(rightRow.recordKey);
  };

  const getSubmissionPath = (record: InteractiveStateRecord): string | null => {
    const payloadValue =
      record.value?.kind === 'json' ? (record.value.json.value as Record<string, unknown>) : null;

    return typeof payloadValue?.['submissionPath'] === 'string'
      ? payloadValue['submissionPath']
      : null;
  };

  const matchesCampaignAdminInteractionFilter = (
    row: LearningProgressRecordRow,
    interaction: { interactionId: string; submissionPath?: string }
  ): boolean => {
    if (interaction.interactionId !== row.record.interactionId) {
      return false;
    }

    if (interaction.submissionPath === undefined) {
      return true;
    }

    return getSubmissionPath(row.record) === interaction.submissionPath;
  };

  const getCampaignThreadSummary = (
    row: LearningProgressRecordRow,
    campaignKey: string
  ): CampaignAdminInteractionRow['threadSummary'] => {
    if (row.record.scope.type !== 'entity') {
      return null;
    }

    const threadSummary = campaignAdminThreadSummaries.get(
      `${campaignKey}::${row.record.scope.entityCui}`
    ) as CampaignAdminInteractionRow['threadSummary'] | undefined;
    return threadSummary ?? null;
  };

  const getCampaignAdminReviewStatus = (
    row: LearningProgressRecordRow,
    reviewable: boolean
  ): 'pending' | 'approved' | 'rejected' | null => {
    if (!reviewable) {
      return null;
    }

    if (row.record.review?.status !== undefined) {
      return row.record.review.status;
    }

    return row.record.phase === 'pending' ? 'pending' : null;
  };

  const getCampaignAdminUserCursorValue = (
    row: CampaignAdminUserRow,
    sortBy: CampaignAdminUserSortBy
  ): CampaignAdminUserListCursor['value'] => {
    switch (sortBy) {
      case 'userId':
        return row.userId;
      case 'latestUpdatedAt':
        return row.latestUpdatedAt;
      case 'interactionCount':
        return row.interactionCount;
      case 'pendingReviewCount':
        return row.pendingReviewCount;
      default:
        return row.latestUpdatedAt;
    }
  };

  const compareCampaignAdminUserPrimaryValue = (
    leftRow: CampaignAdminUserRow,
    rightRow: CampaignAdminUserRow,
    sortBy: CampaignAdminUserSortBy,
    sortOrder: CampaignAdminSortOrder
  ): number => {
    switch (sortBy) {
      case 'userId':
        return sortOrder === 'asc'
          ? leftRow.userId.localeCompare(rightRow.userId)
          : rightRow.userId.localeCompare(leftRow.userId);
      case 'latestUpdatedAt': {
        const comparison = compareTimestamps(leftRow.latestUpdatedAt, rightRow.latestUpdatedAt);
        return sortOrder === 'asc' ? comparison : -comparison;
      }
      case 'interactionCount': {
        const comparison = leftRow.interactionCount - rightRow.interactionCount;
        return sortOrder === 'asc' ? comparison : -comparison;
      }
      case 'pendingReviewCount': {
        const comparison = leftRow.pendingReviewCount - rightRow.pendingReviewCount;
        return sortOrder === 'asc' ? comparison : -comparison;
      }
      default:
        return 0;
    }
  };

  const compareCampaignAdminUsers = (
    leftRow: CampaignAdminUserRow,
    rightRow: CampaignAdminUserRow,
    sortBy: CampaignAdminUserSortBy,
    sortOrder: CampaignAdminSortOrder
  ): number => {
    const primaryComparison = compareCampaignAdminUserPrimaryValue(
      leftRow,
      rightRow,
      sortBy,
      sortOrder
    );
    if (primaryComparison !== 0) {
      return primaryComparison;
    }

    if (sortBy === 'userId') {
      return 0;
    }

    return leftRow.userId.localeCompare(rightRow.userId);
  };

  const isCampaignAdminUserAfterCursor = (
    row: CampaignAdminUserRow,
    cursor: CampaignAdminUserListCursor,
    sortBy: CampaignAdminUserSortBy,
    sortOrder: CampaignAdminSortOrder
  ): boolean => {
    if (sortBy === 'userId') {
      return sortOrder === 'asc' ? row.userId > cursor.userId : row.userId < cursor.userId;
    }

    const cursorRow: CampaignAdminUserRow =
      sortBy === 'interactionCount'
        ? {
            ...row,
            userId: cursor.userId,
            interactionCount: Number(cursor.value),
          }
        : sortBy === 'pendingReviewCount'
          ? {
              ...row,
              userId: cursor.userId,
              pendingReviewCount: Number(cursor.value),
            }
          : {
              ...row,
              userId: cursor.userId,
              latestUpdatedAt: String(cursor.value),
            };

    return compareCampaignAdminUsers(row, cursorRow, sortBy, sortOrder) > 0;
  };

  const getInstitutionEmail = (record: InteractiveStateRecord): string | null => {
    if (record.value?.kind !== 'json') {
      return null;
    }

    const value = record.value.json.value as Record<string, unknown>;
    return typeof value['primariaEmail'] === 'string' && value['primariaEmail'].trim() !== ''
      ? value['primariaEmail'].trim()
      : null;
  };

  const createEmptyCampaignAdminReviewStatusCounts = (): CampaignAdminReviewStatusCounts => ({
    pending: 0,
    approved: 0,
    rejected: 0,
    notReviewed: 0,
  });

  const createEmptyCampaignAdminPhaseCounts = (): CampaignAdminPhaseCounts => ({
    idle: 0,
    draft: 0,
    pending: 0,
    resolved: 0,
    failed: 0,
  });

  const createEmptyCampaignAdminThreadPhaseCounts = (): CampaignAdminThreadPhaseCounts => ({
    sending: 0,
    awaiting_reply: 0,
    reply_received_unreviewed: 0,
    manual_follow_up_needed: 0,
    resolved_positive: 0,
    resolved_negative: 0,
    closed_no_response: 0,
    failed: 0,
    none: 0,
  });

  const createEmptyCampaignAdminStatsBase = (): CampaignAdminStatsBase => ({
    total: 0,
    withInstitutionThread: 0,
    reviewStatusCounts: createEmptyCampaignAdminReviewStatusCounts(),
    phaseCounts: createEmptyCampaignAdminPhaseCounts(),
    threadPhaseCounts: createEmptyCampaignAdminThreadPhaseCounts(),
  });

  const createEmptyCampaignAdminUsersMetaCounts = (): CampaignAdminUsersMetaCounts => ({
    totalUsers: 0,
    usersWithPendingReviews: 0,
  });

  interface MutableCampaignAdminReviewStatusCounts {
    pending: number;
    approved: number;
    rejected: number;
    notReviewed: number;
  }

  interface MutableCampaignAdminPhaseCounts {
    idle: number;
    draft: number;
    pending: number;
    resolved: number;
    failed: number;
  }

  interface MutableCampaignAdminThreadPhaseCounts {
    sending: number;
    awaiting_reply: number;
    reply_received_unreviewed: number;
    manual_follow_up_needed: number;
    resolved_positive: number;
    resolved_negative: number;
    closed_no_response: number;
    failed: number;
    none: number;
  }

  interface MutableCampaignAdminStatsBase {
    total: number;
    withInstitutionThread: number;
    reviewStatusCounts: MutableCampaignAdminReviewStatusCounts;
    phaseCounts: MutableCampaignAdminPhaseCounts;
    threadPhaseCounts: MutableCampaignAdminThreadPhaseCounts;
  }

  const cloneStore = (source: Map<string, Map<string, LearningProgressRecordRow>>) => {
    const clonedStore = new Map<string, Map<string, LearningProgressRecordRow>>();

    for (const [userId, userStore] of source.entries()) {
      const clonedUserStore = new Map<string, LearningProgressRecordRow>();

      for (const [recordKey, row] of userStore.entries()) {
        clonedUserStore.set(recordKey, {
          ...row,
          record: row.record,
          auditEvents: [...row.auditEvents],
        });
      }

      clonedStore.set(userId, clonedUserStore);
    }

    return clonedStore;
  };

  const noopCommitStore = (
    _nextStore: Map<string, Map<string, LearningProgressRecordRow>>
  ): undefined => {
    return undefined;
  };

  const buildRepo = (
    currentStore: Map<string, Map<string, LearningProgressRecordRow>>,
    commitStore: (nextStore: Map<string, Map<string, LearningProgressRecordRow>>) => void,
    transactionScoped = false
  ): LearningProgressRepository => {
    const repo: LearningProgressRepository = {
      getRecords: async (
        userId: string,
        options?: GetRecordsOptions
      ): Promise<Result<readonly LearningProgressRecordRow[], LearningProgressError>> => {
        if (simulateDbError) return createDbError();

        const userStore = currentStore.get(userId);
        if (userStore === undefined) {
          return ok([]);
        }

        return ok(
          [...userStore.values()]
            .filter((row) => {
              if (options?.recordKeyPrefix === undefined) {
                return true;
              }

              return row.recordKey.startsWith(options.recordKeyPrefix);
            })
            .sort((leftRecord, rightRecord) => {
              const leftSeq = BigInt(leftRecord.updatedSeq);
              const rightSeq = BigInt(rightRecord.updatedSeq);
              if (leftSeq < rightSeq) return -1;
              if (leftSeq > rightSeq) return 1;
              return leftRecord.recordKey.localeCompare(rightRecord.recordKey);
            })
        );
      },

      getRecord: async (
        userId: string,
        recordKey: string
      ): Promise<Result<LearningProgressRecordRow | null, LearningProgressError>> => {
        if (simulateDbError) return createDbError();

        const userStore = currentStore.get(userId);
        return ok(userStore?.get(recordKey) ?? null);
      },

      getRecordForUpdate: async (
        userId: string,
        recordKey: string
      ): Promise<Result<LearningProgressRecordRow | null, LearningProgressError>> => {
        if (simulateDbError) return createDbError();

        const userStore = currentStore.get(userId);
        return ok(userStore?.get(recordKey) ?? null);
      },

      listCampaignAdminInteractionRows: async (
        input: ListCampaignAdminInteractionRowsInput
      ): Promise<Result<ListCampaignAdminInteractionRowsOutput, LearningProgressError>> => {
        if (simulateDbError) return createDbError();

        const filteredRows = [...currentStore.values()]
          .flatMap((userStore) => [...userStore.values()])
          .filter((row) => {
            const matchingInteraction = input.interactions.find((interaction) =>
              matchesCampaignAdminInteractionFilter(row, interaction)
            );
            if (matchingInteraction === undefined) {
              return false;
            }

            if (input.phase !== undefined && row.record.phase !== input.phase) {
              return false;
            }

            if (input.reviewStatus !== undefined) {
              const reviewStatus =
                row.record.review?.status ?? (row.record.phase === 'pending' ? 'pending' : null);
              if (reviewStatus !== input.reviewStatus) {
                return false;
              }
            }

            if (input.lessonId !== undefined && row.record.lessonId !== input.lessonId) {
              return false;
            }

            if (
              input.entityCui !== undefined &&
              (row.record.scope.type !== 'entity' || row.record.scope.entityCui !== input.entityCui)
            ) {
              return false;
            }

            if (input.scopeType !== undefined && row.record.scope.type !== input.scopeType) {
              return false;
            }

            if (input.payloadKind !== undefined && row.record.value?.kind !== input.payloadKind) {
              return false;
            }

            if (input.submissionPath !== undefined) {
              if (getSubmissionPath(row.record) !== input.submissionPath) {
                return false;
              }
            }

            if (input.userId !== undefined && row.userId !== input.userId) {
              return false;
            }

            if (input.recordKey !== undefined && row.recordKey !== input.recordKey) {
              return false;
            }

            if (
              input.recordKeyPrefix !== undefined &&
              !row.recordKey.startsWith(input.recordKeyPrefix)
            ) {
              return false;
            }

            if (
              input.submittedAtFrom !== undefined &&
              (row.record.submittedAt === undefined ||
                row.record.submittedAt === null ||
                compareTimestamps(row.record.submittedAt, input.submittedAtFrom) < 0)
            ) {
              return false;
            }

            if (
              input.submittedAtTo !== undefined &&
              (row.record.submittedAt === undefined ||
                row.record.submittedAt === null ||
                compareTimestamps(row.record.submittedAt, input.submittedAtTo) > 0)
            ) {
              return false;
            }

            if (
              input.updatedAtFrom !== undefined &&
              compareTimestamps(row.updatedAt, input.updatedAtFrom) < 0
            ) {
              return false;
            }

            if (
              input.updatedAtTo !== undefined &&
              compareTimestamps(row.updatedAt, input.updatedAtTo) > 0
            ) {
              return false;
            }

            const threadSummary = getCampaignThreadSummary(row, input.campaignKey);
            if (input.hasInstitutionThread === true && threadSummary === null) {
              return false;
            }

            if (input.hasInstitutionThread === false && threadSummary !== null) {
              return false;
            }

            if (
              input.threadPhase !== undefined &&
              threadSummary?.threadPhase !== input.threadPhase
            ) {
              return false;
            }

            if (input.cursor === undefined) {
              return true;
            }

            return (
              compareTimestamps(row.updatedAt, input.cursor.updatedAt) < 0 ||
              (compareTimestamps(row.updatedAt, input.cursor.updatedAt) === 0 &&
                (row.userId > input.cursor.userId ||
                  (row.userId === input.cursor.userId && row.recordKey > input.cursor.recordKey)))
            );
          })
          .sort(compareReviewRows);

        const pageRows = filteredRows.slice(0, input.limit + 1);
        const rows = pageRows.slice(0, input.limit).map(
          (row): CampaignAdminInteractionRow => ({
            userId: row.userId,
            recordKey: row.recordKey,
            campaignKey: input.campaignKey,
            record: row.record,
            auditEvents: row.auditEvents,
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
            threadSummary: getCampaignThreadSummary(row, input.campaignKey),
          })
        );

        return ok({
          rows,
          hasMore: pageRows.length > input.limit,
          nextCursor:
            pageRows.length > input.limit && rows.length > 0
              ? {
                  updatedAt: rows.at(-1)?.updatedAt ?? '',
                  userId: rows.at(-1)?.userId ?? '',
                  recordKey: rows.at(-1)?.recordKey ?? '',
                }
              : null,
        });
      },

      listCampaignAdminUsers: async (
        input: ListCampaignAdminUsersInput
      ): Promise<Result<ListCampaignAdminUsersOutput, LearningProgressError>> => {
        if (simulateDbError) return createDbError();

        const normalizedQuery = input.query?.trim().toLowerCase();
        const aggregatedRows = [...currentStore.values()]
          .flatMap((userStore) => [...userStore.values()])
          .filter((row) => {
            if (
              !input.interactions.some((interaction) =>
                matchesCampaignAdminInteractionFilter(row, interaction)
              )
            ) {
              return false;
            }

            if (normalizedQuery !== undefined && normalizedQuery !== '') {
              return row.userId.toLowerCase().includes(normalizedQuery);
            }

            return true;
          })
          .reduce<Map<string, LearningProgressRecordRow[]>>((groups, row) => {
            const existingRows = groups.get(row.userId) ?? [];
            existingRows.push(row);
            groups.set(row.userId, existingRows);
            return groups;
          }, new Map());

        const users = [...aggregatedRows.entries()].map(([userId, rows]): CampaignAdminUserRow => {
          const latestRow = [...rows].sort((leftRow, rightRow) => {
            const updatedAtComparison = compareTimestamps(rightRow.updatedAt, leftRow.updatedAt);
            if (updatedAtComparison !== 0) {
              return updatedAtComparison;
            }

            return leftRow.recordKey.localeCompare(rightRow.recordKey);
          })[0];

          return {
            userId,
            interactionCount: rows.length,
            pendingReviewCount: rows.filter((row) => {
              const isReviewable = input.reviewableInteractions.some((interaction) =>
                matchesCampaignAdminInteractionFilter(row, interaction)
              );
              return getCampaignAdminReviewStatus(row, isReviewable) === 'pending';
            }).length,
            latestUpdatedAt: latestRow?.updatedAt ?? '',
            latestInteractionId: latestRow?.record.interactionId ?? '',
            latestEntityCui:
              latestRow?.record.scope.type === 'entity' ? latestRow.record.scope.entityCui : null,
          };
        });

        const cursor = input.cursor;
        const filteredUsers =
          cursor === undefined
            ? users
            : users.filter((row) =>
                isCampaignAdminUserAfterCursor(row, cursor, input.sortBy, input.sortOrder)
              );
        const sortedUsers = [...filteredUsers].sort((leftRow, rightRow) =>
          compareCampaignAdminUsers(leftRow, rightRow, input.sortBy, input.sortOrder)
        );
        const pageRows = sortedUsers.slice(0, input.limit + 1);
        const items = pageRows.slice(0, input.limit);
        const lastItem = items.at(-1);

        return ok({
          items,
          hasMore: pageRows.length > input.limit,
          nextCursor:
            pageRows.length > input.limit && lastItem !== undefined
              ? {
                  sortBy: input.sortBy,
                  sortOrder: input.sortOrder,
                  userId: lastItem.userId,
                  value: getCampaignAdminUserCursorValue(lastItem, input.sortBy),
                }
              : null,
        });
      },

      getCampaignAdminUsersMetaCounts: async (
        input: GetCampaignAdminUsersMetaCountsInput
      ): Promise<Result<CampaignAdminUsersMetaCounts, LearningProgressError>> => {
        if (simulateDbError) return createDbError();

        if (input.interactions.length === 0) {
          return ok(createEmptyCampaignAdminUsersMetaCounts());
        }

        const rowsByUserId = [...currentStore.values()]
          .flatMap((userStore) => [...userStore.values()])
          .filter((row) =>
            input.interactions.some((interaction) =>
              matchesCampaignAdminInteractionFilter(row, interaction)
            )
          )
          .reduce<Map<string, LearningProgressRecordRow[]>>((groups, row) => {
            const existingRows = groups.get(row.userId) ?? [];
            existingRows.push(row);
            groups.set(row.userId, existingRows);
            return groups;
          }, new Map());

        let usersWithPendingReviews = 0;
        for (const rows of rowsByUserId.values()) {
          const hasPendingReview = rows.some((row) => {
            const isReviewable = input.reviewableInteractions.some((interaction) =>
              matchesCampaignAdminInteractionFilter(row, interaction)
            );
            return getCampaignAdminReviewStatus(row, isReviewable) === 'pending';
          });

          if (hasPendingReview) {
            usersWithPendingReviews += 1;
          }
        }

        return ok({
          totalUsers: rowsByUserId.size,
          usersWithPendingReviews,
        });
      },

      getCampaignAdminStats: async (
        input: GetCampaignAdminStatsInput
      ): Promise<Result<GetCampaignAdminStatsOutput, LearningProgressError>> => {
        if (simulateDbError) return createDbError();

        if (input.interactions.length === 0) {
          return ok({
            stats: createEmptyCampaignAdminStatsBase(),
            riskFlagCandidates: [],
          });
        }

        const matchingRows = [...currentStore.values()]
          .flatMap((userStore) => [...userStore.values()])
          .filter((row) => {
            return input.interactions.some((interaction) =>
              matchesCampaignAdminInteractionFilter(row, interaction)
            );
          });

        const stats: MutableCampaignAdminStatsBase = {
          total: 0,
          withInstitutionThread: 0,
          reviewStatusCounts: {
            pending: 0,
            approved: 0,
            rejected: 0,
            notReviewed: 0,
          },
          phaseCounts: {
            idle: 0,
            draft: 0,
            pending: 0,
            resolved: 0,
            failed: 0,
          },
          threadPhaseCounts: {
            sending: 0,
            awaiting_reply: 0,
            reply_received_unreviewed: 0,
            manual_follow_up_needed: 0,
            resolved_positive: 0,
            resolved_negative: 0,
            closed_no_response: 0,
            failed: 0,
            none: 0,
          },
        };
        const riskCandidateMap = new Map<string, CampaignAdminRiskFlagCandidate>();

        for (const row of matchingRows) {
          stats.total += 1;

          const reviewStatus = getCampaignAdminReviewStatus(
            row,
            input.reviewableInteractions.some((interaction) =>
              matchesCampaignAdminInteractionFilter(row, interaction)
            )
          );
          if (reviewStatus === 'pending') {
            stats.reviewStatusCounts.pending += 1;
          } else if (reviewStatus === 'approved') {
            stats.reviewStatusCounts.approved += 1;
          } else if (reviewStatus === 'rejected') {
            stats.reviewStatusCounts.rejected += 1;
          } else {
            stats.reviewStatusCounts.notReviewed += 1;
          }

          if (row.record.phase === 'idle') {
            stats.phaseCounts.idle += 1;
          } else if (row.record.phase === 'draft') {
            stats.phaseCounts.draft += 1;
          } else if (row.record.phase === 'pending') {
            stats.phaseCounts.pending += 1;
          } else if (row.record.phase === 'resolved') {
            stats.phaseCounts.resolved += 1;
          } else {
            stats.phaseCounts.failed += 1;
          }

          const threadSummary = input.threadSummaryInteractions.some((interaction) =>
            matchesCampaignAdminInteractionFilter(row, interaction)
          )
            ? getCampaignThreadSummary(row, input.campaignKey)
            : null;
          if (threadSummary !== null) {
            stats.withInstitutionThread += 1;
          }

          if (threadSummary?.threadPhase === 'sending') {
            stats.threadPhaseCounts.sending += 1;
          } else if (threadSummary?.threadPhase === 'awaiting_reply') {
            stats.threadPhaseCounts.awaiting_reply += 1;
          } else if (threadSummary?.threadPhase === 'reply_received_unreviewed') {
            stats.threadPhaseCounts.reply_received_unreviewed += 1;
          } else if (threadSummary?.threadPhase === 'manual_follow_up_needed') {
            stats.threadPhaseCounts.manual_follow_up_needed += 1;
          } else if (threadSummary?.threadPhase === 'resolved_positive') {
            stats.threadPhaseCounts.resolved_positive += 1;
          } else if (threadSummary?.threadPhase === 'resolved_negative') {
            stats.threadPhaseCounts.resolved_negative += 1;
          } else if (threadSummary?.threadPhase === 'closed_no_response') {
            stats.threadPhaseCounts.closed_no_response += 1;
          } else if (threadSummary?.threadPhase === 'failed') {
            stats.threadPhaseCounts.failed += 1;
          } else {
            stats.threadPhaseCounts.none += 1;
          }

          const candidate: CampaignAdminRiskFlagCandidate = {
            interactionId: row.record.interactionId,
            entityCui: row.record.scope.type === 'entity' ? row.record.scope.entityCui : null,
            institutionEmail: getInstitutionEmail(row.record),
            threadPhase: threadSummary?.threadPhase ?? null,
            count: 0,
          };
          const candidateKey = JSON.stringify([
            candidate.interactionId,
            candidate.entityCui,
            candidate.institutionEmail,
            candidate.threadPhase,
          ]);
          const existingCandidate = riskCandidateMap.get(candidateKey);

          if (existingCandidate === undefined) {
            riskCandidateMap.set(candidateKey, {
              ...candidate,
              count: 1,
            });
          } else {
            riskCandidateMap.set(candidateKey, {
              ...existingCandidate,
              count: existingCandidate.count + 1,
            });
          }
        }

        return ok({
          stats,
          riskFlagCandidates: [...riskCandidateMap.values()],
        });
      },

      upsertInteractiveRecord: async (
        input: UpsertInteractiveRecordInput
      ): Promise<
        Result<{ applied: boolean; row: LearningProgressRecordRow }, LearningProgressError>
      > => {
        if (simulateDbError) return createDbError();

        upsertAttempts += 1;
        if (failOnUpsertAttempt !== undefined && upsertAttempts === failOnUpsertAttempt) {
          return createDbError();
        }

        const userStore =
          currentStore.get(input.userId) ?? new Map<string, LearningProgressRecordRow>();
        const existing = userStore.get(input.record.key) ?? null;

        const isDuplicateAuditUpdate =
          input.auditEvents.length > 0 &&
          existing?.auditEvents.some(
            (auditEvent) => auditEvent.sourceClientEventId === input.eventId
          ) === true;

        const isDuplicateRecordOnlyUpdate =
          input.auditEvents.length === 0 &&
          existing !== null &&
          jsonValuesAreEqual(existing.record, input.record);

        const isIncomingRecordStale =
          existing !== null &&
          compareTimestamps(input.record.updatedAt, existing.record.updatedAt) < 0;

        const hasNewAuditEvents = input.auditEvents.length > 0 && !isDuplicateAuditUpdate;
        const shouldReplaceRecord = !isDuplicateRecordOnlyUpdate && !isIncomingRecordStale;

        if (isDuplicateAuditUpdate || (!shouldReplaceRecord && !hasNewAuditEvents)) {
          if (existing === null) throw new Error('Invariant: expected existing row');
          return ok({
            applied: false,
            row: existing,
          });
        }

        const seq = String(nextSeq);
        nextSeq += 1n;
        const rowUpdatedAt = new Date().toISOString();

        const storedAuditEvents: StoredInteractiveAuditEvent[] = [
          ...(existing?.auditEvents ?? []),
          ...input.auditEvents.map((auditEvent) => ({
            ...auditEvent,
            seq,
            sourceClientEventId: input.eventId,
            sourceClientId: input.clientId,
          })),
        ];

        const nextRow: LearningProgressRecordRow = {
          userId: input.userId,
          recordKey: input.record.key,
          record: shouldReplaceRecord ? input.record : existing.record,
          auditEvents: storedAuditEvents,
          updatedSeq: seq,
          createdAt: existing?.createdAt ?? rowUpdatedAt,
          updatedAt: rowUpdatedAt,
        };

        userStore.set(input.record.key, nextRow);
        currentStore.set(input.userId, userStore);

        return ok({
          applied: true,
          row: nextRow,
        });
      },

      resetProgress: async (userId: string): Promise<Result<void, LearningProgressError>> => {
        if (simulateDbError) return createDbError();

        resetAttempts += 1;
        if (failOnResetAttempt !== undefined && resetAttempts === failOnResetAttempt) {
          return createDbError();
        }

        currentStore.delete(userId);
        return ok(undefined);
      },

      withTransaction: async <T>(
        callback: (repo: LearningProgressRepository) => Promise<Result<T, LearningProgressError>>
      ): Promise<Result<T, LearningProgressError>> => {
        if (simulateDbError) return createDbError();

        if (transactionScoped) {
          return callback(repo);
        }

        const transactionalStore = cloneStore(currentStore);
        const startingNextSeq = nextSeq;
        const result = await callback(buildRepo(transactionalStore, noopCommitStore, true));

        if (result.isErr()) {
          nextSeq = startingNextSeq;
          return result;
        }

        commitStore(transactionalStore);
        return result;
      },
    };

    return repo;
  };

  return buildRepo(store, (nextStore) => {
    store.clear();
    for (const [userId, userStore] of nextStore.entries()) {
      store.set(userId, userStore);
    }
  });
};

// =============================================================================
// Learning Progress Test Builders
// =============================================================================

let learningEventIdCounter = 0;

function parseLegacyRecordKey(
  recordKey: string
): Partial<Pick<InteractiveStateRecord, 'interactionId' | 'scope'>> {
  if (recordKey.endsWith('::global')) {
    return {
      interactionId: recordKey.slice(0, -'::global'.length),
      scope: { type: 'global' },
    };
  }

  const entityMatch = /^(.*)::entity:([^:]+)$/.exec(recordKey);
  if (entityMatch?.[1] !== undefined && entityMatch[2] !== undefined) {
    return {
      interactionId: entityMatch[1],
      scope: { type: 'entity', entityCui: entityMatch[2] },
    };
  }

  return {};
}

function buildTestRecordKey(interactionId: string, scope: InteractiveStateRecord['scope']): string {
  return scope.type === 'global'
    ? `${interactionId}::global`
    : `${interactionId}::entity:${scope.entityCui}`;
}

export const createTestInteractiveRecord = (
  overrides: Partial<InteractiveStateRecord> = {}
): InteractiveStateRecord => {
  learningEventIdCounter++;

  const legacyRecordKeyDetails =
    overrides.key !== undefined ? parseLegacyRecordKey(overrides.key) : {};
  const lessonId = overrides.lessonId ?? `lesson-${String(learningEventIdCounter)}`;
  const interactionId =
    overrides.interactionId ??
    legacyRecordKeyDetails.interactionId ??
    `quiz-${String(learningEventIdCounter)}`;
  const scope = overrides.scope ?? legacyRecordKeyDetails.scope ?? { type: 'global' };

  return {
    key: overrides.key ?? buildTestRecordKey(interactionId, scope),
    interactionId,
    lessonId,
    kind: overrides.kind ?? 'quiz',
    scope,
    completionRule: overrides.completionRule ?? { type: 'outcome', outcome: 'correct' },
    phase: overrides.phase ?? 'draft',
    value: overrides.value ?? {
      kind: 'choice',
      choice: { selectedId: null },
    },
    result: overrides.result ?? null,
    ...(overrides.review !== undefined ? { review: overrides.review } : {}),
    updatedAt: overrides.updatedAt ?? new Date().toISOString(),
    ...(overrides.submittedAt !== undefined ? { submittedAt: overrides.submittedAt } : {}),
  };
};

export const createTestSubmittedAuditEvent = (
  overrides: Partial<Extract<InteractiveAuditEvent, { type: 'submitted' }>> = {}
): Extract<InteractiveAuditEvent, { type: 'submitted' }> => {
  learningEventIdCounter++;

  const legacyRecordKeyDetails =
    overrides.recordKey !== undefined ? parseLegacyRecordKey(overrides.recordKey) : {};
  const lessonId = overrides.lessonId ?? 'lesson-1';
  const interactionId = overrides.interactionId ?? legacyRecordKeyDetails.interactionId ?? 'quiz-1';

  return {
    id: overrides.id ?? `submitted-${String(learningEventIdCounter)}`,
    recordKey: overrides.recordKey ?? buildTestRecordKey(interactionId, { type: 'global' }),
    lessonId,
    interactionId,
    type: 'submitted',
    at: overrides.at ?? new Date().toISOString(),
    actor: 'user',
    value: overrides.value ?? {
      kind: 'choice',
      choice: { selectedId: 'option-a' },
    },
  };
};

export const createTestEvaluatedAuditEvent = (
  overrides: Partial<Extract<InteractiveAuditEvent, { type: 'evaluated' }>> = {}
): Extract<InteractiveAuditEvent, { type: 'evaluated' }> => {
  learningEventIdCounter++;

  const legacyRecordKeyDetails =
    overrides.recordKey !== undefined ? parseLegacyRecordKey(overrides.recordKey) : {};
  const lessonId = overrides.lessonId ?? 'lesson-1';
  const interactionId = overrides.interactionId ?? legacyRecordKeyDetails.interactionId ?? 'quiz-1';

  return {
    id: overrides.id ?? `evaluated-${String(learningEventIdCounter)}`,
    recordKey: overrides.recordKey ?? buildTestRecordKey(interactionId, { type: 'global' }),
    lessonId,
    interactionId,
    type: 'evaluated',
    at: overrides.at ?? new Date().toISOString(),
    actor: 'system',
    phase: overrides.phase ?? 'resolved',
    result: overrides.result ?? {
      outcome: 'correct',
      evaluatedAt: new Date().toISOString(),
    },
  };
};

export const createTestInteractiveUpdatedEvent = (
  overrides: {
    eventId?: string;
    occurredAt?: string;
    clientId?: string;
    payload?: Partial<LearningInteractiveUpdatedEvent['payload']>;
  } = {}
): LearningInteractiveUpdatedEvent => {
  learningEventIdCounter++;
  const record = overrides.payload?.record ?? createTestInteractiveRecord();

  return {
    eventId: overrides.eventId ?? `interactive-${String(learningEventIdCounter)}`,
    occurredAt: overrides.occurredAt ?? record.updatedAt,
    clientId: overrides.clientId ?? 'test-client',
    type: 'interactive.updated',
    payload: {
      record,
      ...(overrides.payload?.auditEvents !== undefined
        ? { auditEvents: overrides.payload.auditEvents }
        : {}),
    },
  };
};

export const createTestProgressResetEvent = (
  overrides: Partial<LearningProgressEvent> = {}
): LearningProgressEvent => {
  learningEventIdCounter++;

  return {
    eventId: overrides.eventId ?? `reset-${String(learningEventIdCounter)}`,
    occurredAt: overrides.occurredAt ?? new Date().toISOString(),
    clientId: overrides.clientId ?? 'test-client',
    type: 'progress.reset',
  } as LearningProgressEvent;
};

// =============================================================================
// Notification Delivery Module Fakes
// =============================================================================

interface FakeDeliveryRepoOptions {
  /** Initial deliveries to seed the store with */
  deliveries?: DeliveryRecord[];
  /** Enable database error simulation */
  simulateDbError?: boolean;
}

/**
 * Creates a fake delivery repository for testing.
 *
 * Implements all DeliveryRepository methods using an in-memory Map.
 * Supports atomic claim pattern for testing worker behavior.
 */
export const makeFakeDeliveryRepo = (options: FakeDeliveryRepoOptions = {}): DeliveryRepository => {
  const store = new Map<string, DeliveryRecord>();
  const keyIndex = new Map<string, string>(); // deliveryKey -> id
  const simulateDbError = options.simulateDbError ?? false;

  // Seed initial deliveries
  if (options.deliveries !== undefined) {
    for (const d of options.deliveries) {
      store.set(d.id, { ...d });
      keyIndex.set(d.deliveryKey, d.id);
    }
  }

  const createDbError = (): Result<never, DeliveryError> =>
    err({
      type: 'DatabaseError',
      message: 'Simulated database error',
      retryable: true,
    } as DeliveryError);

  return {
    create: async (input: CreateDeliveryInput): Promise<Result<DeliveryRecord, DeliveryError>> => {
      if (simulateDbError) return createDbError();

      // Check for duplicate delivery key
      if (keyIndex.has(input.deliveryKey)) {
        return err({
          type: 'DuplicateDelivery',
          deliveryKey: input.deliveryKey,
        } as DeliveryError);
      }

      const id = crypto.randomUUID();
      const now = new Date();
      const delivery: DeliveryRecord = {
        id,
        userId: input.userId,
        toEmail: input.toEmail ?? null,
        notificationType: input.notificationType,
        referenceId: input.referenceId,
        scopeKey: input.scopeKey,
        deliveryKey: input.deliveryKey,
        status: 'pending',
        renderedSubject: input.renderedSubject ?? null,
        renderedHtml: input.renderedHtml ?? null,
        renderedText: input.renderedText ?? null,
        contentHash: input.contentHash ?? null,
        templateName: input.templateName ?? null,
        templateVersion: input.templateVersion ?? null,
        resendEmailId: null,
        lastError: null,
        attemptCount: 0,
        lastAttemptAt: null,
        sentAt: null,
        metadata: input.metadata ?? {},
        createdAt: now,
      };
      store.set(id, delivery);
      keyIndex.set(input.deliveryKey, id);
      return ok(delivery);
    },

    updateRenderedContent: async (
      outboxId: string,
      input: UpdateRenderedContentInput
    ): Promise<Result<void, DeliveryError>> => {
      if (simulateDbError) return createDbError();

      const delivery = store.get(outboxId);
      if (delivery === undefined) {
        return ok(undefined);
      }

      const updated: DeliveryRecord = {
        ...delivery,
        renderedSubject: input.renderedSubject,
        renderedHtml: input.renderedHtml,
        renderedText: input.renderedText,
        contentHash: input.contentHash,
        templateName: input.templateName,
        templateVersion: input.templateVersion,
        ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
      };
      store.set(outboxId, updated);
      return ok(undefined);
    },

    claimForCompose: async (
      deliveryId: string
    ): Promise<Result<DeliveryRecord | null, DeliveryError>> => {
      if (simulateDbError) return createDbError();

      const delivery = store.get(deliveryId);
      if (delivery === undefined) return ok(null);

      if (delivery.status !== 'pending') {
        return ok(null);
      }

      if (
        delivery.renderedSubject !== null &&
        delivery.renderedHtml !== null &&
        delivery.renderedText !== null
      ) {
        return ok(null);
      }

      const updated: DeliveryRecord = {
        ...delivery,
        status: 'composing',
        lastAttemptAt: new Date(),
      };
      store.set(deliveryId, updated);
      return ok(updated);
    },

    findById: async (deliveryId: string): Promise<Result<DeliveryRecord | null, DeliveryError>> => {
      if (simulateDbError) return createDbError();
      const delivery = store.get(deliveryId);
      return ok(delivery ?? null);
    },

    findByDeliveryKey: async (
      deliveryKey: string
    ): Promise<Result<DeliveryRecord | null, DeliveryError>> => {
      if (simulateDbError) return createDbError();
      const id = keyIndex.get(deliveryKey);
      if (id === undefined) return ok(null);
      const delivery = store.get(id);
      return ok(delivery ?? null);
    },

    claimForSending: async (
      deliveryId: string
    ): Promise<Result<DeliveryRecord | null, DeliveryError>> => {
      if (simulateDbError) return createDbError();

      const delivery = store.get(deliveryId);
      if (delivery === undefined) return ok(null);

      // Only claim if in claimable status
      if (delivery.status !== 'pending' && delivery.status !== 'failed_transient') {
        return ok(null);
      }

      if (
        delivery.renderedSubject === null ||
        delivery.renderedHtml === null ||
        delivery.renderedText === null
      ) {
        return ok(null);
      }

      const updated: DeliveryRecord = {
        ...delivery,
        status: 'sending',
        attemptCount: delivery.attemptCount + 1,
        lastAttemptAt: new Date(),
      };
      store.set(deliveryId, updated);
      return ok(updated);
    },

    updateStatus: async (
      deliveryId: string,
      input: UpdateDeliveryStatusInput
    ): Promise<Result<void, DeliveryError>> => {
      if (simulateDbError) return createDbError();

      const delivery = store.get(deliveryId);
      if (delivery === undefined) {
        return ok(undefined); // Silently succeed like real repo
      }

      const updated: DeliveryRecord = {
        ...delivery,
        status: input.status,
        ...(input.toEmail !== undefined ? { toEmail: input.toEmail } : {}),
        ...(input.resendEmailId !== undefined ? { resendEmailId: input.resendEmailId } : {}),
        ...(input.lastError !== undefined ? { lastError: input.lastError } : {}),
        ...(input.sentAt !== undefined ? { sentAt: input.sentAt } : {}),
      };
      store.set(deliveryId, updated);
      return ok(undefined);
    },

    updateStatusIfCurrentIn: async (
      deliveryId: string,
      allowedStatuses: readonly DeliveryStatus[],
      nextStatus: DeliveryStatus,
      input?: Partial<UpdateDeliveryStatusInput>
    ): Promise<Result<boolean, DeliveryError>> => {
      if (simulateDbError) return createDbError();

      const delivery = store.get(deliveryId);
      if (delivery === undefined || !allowedStatuses.includes(delivery.status)) {
        return ok(false);
      }

      const updated: DeliveryRecord = {
        ...delivery,
        status: nextStatus,
        ...(input?.toEmail !== undefined ? { toEmail: input.toEmail } : {}),
        ...(input?.resendEmailId !== undefined ? { resendEmailId: input.resendEmailId } : {}),
        ...(input?.lastError !== undefined ? { lastError: input.lastError } : {}),
        ...(input?.sentAt !== undefined ? { sentAt: input.sentAt } : {}),
      };
      store.set(deliveryId, updated);
      return ok(true);
    },

    updateStatusIfStillSending: async (
      deliveryId: string,
      status: DeliveryStatus,
      input?: Partial<UpdateDeliveryStatusInput>
    ): Promise<Result<boolean, DeliveryError>> => {
      if (simulateDbError) return createDbError();

      const delivery = store.get(deliveryId);
      if (delivery?.status !== 'sending') {
        return ok(false);
      }

      const updated: DeliveryRecord = {
        ...delivery,
        status,
        ...(input?.toEmail !== undefined ? { toEmail: input.toEmail } : {}),
        ...(input?.resendEmailId !== undefined ? { resendEmailId: input.resendEmailId } : {}),
        ...(input?.lastError !== undefined ? { lastError: input.lastError } : {}),
        ...(input?.sentAt !== undefined ? { sentAt: input.sentAt } : {}),
      };
      store.set(deliveryId, updated);
      return ok(true);
    },

    findStuckSending: async (
      olderThanMinutes: number
    ): Promise<Result<DeliveryRecord[], DeliveryError>> => {
      if (simulateDbError) return createDbError();

      const threshold = new Date(Date.now() - olderThanMinutes * 60 * 1000);
      const stuck: DeliveryRecord[] = [];

      for (const delivery of store.values()) {
        if (
          delivery.status === 'sending' &&
          (delivery.lastAttemptAt === null || delivery.lastAttemptAt < threshold)
        ) {
          stuck.push(delivery);
        }
      }

      return ok(stuck);
    },

    findPendingComposeOrphans: async (
      olderThanMinutes: number
    ): Promise<Result<DeliveryRecord[], DeliveryError>> => {
      if (simulateDbError) return createDbError();

      const threshold = new Date(Date.now() - olderThanMinutes * 60 * 1000);
      return ok(
        [...store.values()].filter((delivery) => {
          const lastActivity = delivery.lastAttemptAt ?? delivery.createdAt;

          return (
            (delivery.status === 'pending' || delivery.status === 'composing') &&
            (delivery.renderedSubject === null ||
              delivery.renderedHtml === null ||
              delivery.renderedText === null) &&
            lastActivity < threshold
          );
        })
      );
    },

    findReadyToSendOrphans: async (
      olderThanMinutes: number
    ): Promise<Result<DeliveryRecord[], DeliveryError>> => {
      if (simulateDbError) return createDbError();

      const threshold = new Date(Date.now() - olderThanMinutes * 60 * 1000);
      return ok(
        [...store.values()].filter((delivery) => {
          const lastActivity = delivery.lastAttemptAt ?? delivery.createdAt;

          return (
            (delivery.status === 'pending' || delivery.status === 'failed_transient') &&
            delivery.renderedSubject !== null &&
            delivery.renderedHtml !== null &&
            delivery.renderedText !== null &&
            lastActivity < threshold
          );
        })
      );
    },

    findSentAwaitingWebhook: async (
      olderThanMinutes: number
    ): Promise<Result<DeliveryRecord[], DeliveryError>> => {
      if (simulateDbError) return createDbError();

      const threshold = new Date(Date.now() - olderThanMinutes * 60 * 1000);
      return ok(
        [...store.values()].filter(
          (delivery) =>
            delivery.status === 'sent' && delivery.sentAt !== null && delivery.sentAt < threshold
        )
      );
    },

    existsByDeliveryKey: async (deliveryKey: string): Promise<Result<boolean, DeliveryError>> => {
      if (simulateDbError) return createDbError();
      return ok(keyIndex.has(deliveryKey));
    },
  };
};

// =============================================================================
// Extended Notifications Repository Fake (Delivery Pipeline)
// =============================================================================

interface FakeExtendedNotificationsRepoOptions {
  /** Initial notifications to seed the store with */
  notifications?: Notification[];
  /** Notifications already materialized for a given period */
  deliveredNotificationIdsByPeriod?: Record<string, string[]>;
  /** Simulate a globally unsubscribed user (by userId) */
  globallyUnsubscribedUsers?: Set<string>;
  /** Enable database error simulation */
  simulateDbError?: boolean;
}

/**
 * Creates a fake ExtendedNotificationsRepository for testing delivery pipeline.
 */
export const makeFakeExtendedNotificationsRepo = (
  options: FakeExtendedNotificationsRepoOptions = {}
): ExtendedNotificationsRepository => {
  const store = new Map<string, Notification>();
  const simulateDbError = options.simulateDbError ?? false;
  const deliveredNotificationIdsByPeriod = options.deliveredNotificationIdsByPeriod ?? {};
  const globallyUnsubscribedUsers = options.globallyUnsubscribedUsers ?? new Set<string>();

  if (options.notifications !== undefined) {
    for (const n of options.notifications) {
      store.set(n.id, { ...n });
    }
  }

  const createDbError = (): Result<never, DeliveryError> =>
    err({
      type: 'DatabaseError',
      message: 'Simulated database error',
      retryable: true,
    } as DeliveryError);

  return {
    findById: async (notificationId: string) => {
      if (simulateDbError) return createDbError();
      const n = store.get(notificationId);
      return ok(n ?? null);
    },

    findEligibleForDelivery: async (
      notificationType: NotificationType,
      periodKey: string,
      limit = 100,
      ignoreMaterialized = false
    ) => {
      if (simulateDbError) return createDbError();
      const deliveredNotificationIds = ignoreMaterialized
        ? new Set<string>()
        : new Set(deliveredNotificationIdsByPeriod[periodKey] ?? []);
      const eligible: Notification[] = [];
      for (const n of store.values()) {
        const isGloballyUnsubscribed =
          globallyUnsubscribedUsers.has(n.userId) ||
          [...store.values()].some((candidate) => {
            if (
              candidate.userId !== n.userId ||
              candidate.notificationType !== 'global_unsubscribe'
            ) {
              return false;
            }

            if (!candidate.isActive) {
              return true;
            }

            const config = candidate.config as Record<string, unknown> | null;
            if (config !== null && typeof config === 'object') {
              const channels = config['channels'] as Record<string, unknown> | undefined;
              return channels?.['email'] === false;
            }

            return false;
          });

        if (
          n.notificationType === notificationType &&
          n.isActive &&
          !isGloballyUnsubscribed &&
          !deliveredNotificationIds.has(n.id)
        ) {
          eligible.push(n);
          if (eligible.length >= limit) break;
        }
      }
      return ok(eligible);
    },

    findActiveByTypeAndEntity: async (notificationType: NotificationType, entityCui: string) => {
      if (simulateDbError) return createDbError();

      return ok(
        [...store.values()].filter(
          (notification) =>
            notification.notificationType === notificationType &&
            notification.entityCui === entityCui &&
            notification.isActive &&
            !globallyUnsubscribedUsers.has(notification.userId) &&
            !(
              notificationType === 'funky:notification:entity_updates' &&
              [...store.values()].some(
                (candidate) =>
                  candidate.userId === notification.userId &&
                  candidate.notificationType === 'funky:notification:global' &&
                  !candidate.isActive
              )
            ) &&
            ![...store.values()].some((candidate) => {
              if (
                candidate.userId !== notification.userId ||
                candidate.notificationType !== 'global_unsubscribe'
              ) {
                return false;
              }

              if (!candidate.isActive) {
                return true;
              }

              const config = candidate.config as Record<string, unknown> | null;
              if (config !== null && typeof config === 'object') {
                const channels = config['channels'] as Record<string, unknown> | undefined;
                return channels?.['email'] === false;
              }

              return false;
            })
        )
      );
    },

    findActiveByType: async (notificationType: NotificationType) => {
      if (simulateDbError) return createDbError();

      return ok(
        [...store.values()].filter(
          (notification) =>
            notification.notificationType === notificationType &&
            notification.isActive &&
            !globallyUnsubscribedUsers.has(notification.userId) &&
            !(
              notificationType === 'funky:notification:entity_updates' &&
              [...store.values()].some(
                (candidate) =>
                  candidate.userId === notification.userId &&
                  candidate.notificationType === 'funky:notification:global' &&
                  !candidate.isActive
              )
            ) &&
            ![...store.values()].some((candidate) => {
              if (
                candidate.userId !== notification.userId ||
                candidate.notificationType !== 'global_unsubscribe'
              ) {
                return false;
              }

              if (!candidate.isActive) {
                return true;
              }

              const config = candidate.config as Record<string, unknown> | null;
              if (config !== null && typeof config === 'object') {
                const channels = config['channels'] as Record<string, unknown> | undefined;
                return channels?.['email'] === false;
              }

              return false;
            })
        )
      );
    },

    deactivate: async (notificationId: string) => {
      if (simulateDbError) return createDbError();
      const n = store.get(notificationId);
      if (n !== undefined) {
        store.set(notificationId, { ...n, isActive: false, updatedAt: new Date() });
      }
      return ok(undefined);
    },

    isUserGloballyUnsubscribed: async (userId: string) => {
      if (simulateDbError) return createDbError();

      // Check override set first
      if (globallyUnsubscribedUsers.has(userId)) {
        return ok(true);
      }

      // Check store
      for (const n of store.values()) {
        if (n.userId === userId && n.notificationType === 'global_unsubscribe') {
          if (!n.isActive) return ok(true);
          const config = n.config as Record<string, unknown> | null;
          if (config !== null && typeof config === 'object') {
            const channels = config['channels'] as Record<string, unknown> | undefined;
            if (channels?.['email'] === false) {
              return ok(true);
            }
          }
        }
      }

      return ok(false);
    },
  };
};

// =============================================================================
// Fake Token Signer (HMAC-based)
// =============================================================================

/**
 * Creates a real UnsubscribeTokenSigner backed by the HMAC implementation.
 * Uses a deterministic test secret by default.
 */
export const makeFakeTokenSigner = (
  secret = 'test-secret-for-unit-tests-min-32chars!'
): UnsubscribeTokenSigner => {
  return makeUnsubscribeTokenSigner(secret);
};

// =============================================================================
// Notification Delivery Test Builders
// =============================================================================

let deliveryRecordIdCounter = 0;

/**
 * Creates a test delivery record with sensible defaults.
 */
export const createTestDeliveryRecord = (
  overrides: Partial<DeliveryRecord> = {}
): DeliveryRecord => {
  deliveryRecordIdCounter++;
  const now = new Date();
  const id = overrides.id ?? `delivery-record-${String(deliveryRecordIdCounter)}`;
  const userId = overrides.userId ?? 'user-1';
  const notificationType = overrides.notificationType ?? 'newsletter_entity_monthly';
  const referenceId =
    'referenceId' in overrides ? (overrides.referenceId ?? null) : 'notification-1';
  const scopeKey = overrides.scopeKey ?? '2025-01';
  const deliveryKeyReference =
    referenceId ?? (notificationType === 'transactional_welcome' ? 'welcome' : 'notification-1');
  const deliveryKey = overrides.deliveryKey ?? `${userId}:${deliveryKeyReference}:${scopeKey}`;

  return {
    id,
    userId,
    toEmail: overrides.toEmail ?? null,
    notificationType,
    referenceId,
    scopeKey,
    deliveryKey,
    status: overrides.status ?? 'pending',
    renderedSubject: overrides.renderedSubject ?? null,
    renderedHtml: overrides.renderedHtml ?? null,
    renderedText: overrides.renderedText ?? null,
    contentHash: overrides.contentHash ?? null,
    templateName: overrides.templateName ?? null,
    templateVersion: overrides.templateVersion ?? null,
    resendEmailId: overrides.resendEmailId ?? null,
    lastError: overrides.lastError ?? null,
    attemptCount: overrides.attemptCount ?? 0,
    lastAttemptAt: overrides.lastAttemptAt ?? null,
    sentAt: overrides.sentAt ?? null,
    metadata: overrides.metadata ?? {},
    createdAt: overrides.createdAt ?? now,
  };
};
