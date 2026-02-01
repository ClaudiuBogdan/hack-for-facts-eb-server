/**
 * Test fakes and mocks
 */

import { Decimal } from 'decimal.js';
import { ok, err, type Result } from 'neverthrow';

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
import type {
  LearningProgressRepository,
  LearningProgressData,
  UpsertEventsResult,
} from '@/modules/learning-progress/core/ports.js';
import type { LearningProgressEvent } from '@/modules/learning-progress/core/types.js';
import type { DeliveryError } from '@/modules/notification-delivery/core/errors.js';
import type {
  DeliveryRepository,
  CreateDeliveryInput,
  UpdateDeliveryStatusInput,
  WebhookEventRepository,
  InsertWebhookEventInput,
} from '@/modules/notification-delivery/core/ports.js';
import type {
  DeliveryRecord,
  DeliveryStatus,
  StoredWebhookEvent,
} from '@/modules/notification-delivery/core/types.js';
import type { NotificationError } from '@/modules/notifications/core/errors.js';
import type {
  NotificationsRepository,
  DeliveriesRepository,
  UnsubscribeTokensRepository,
  CreateNotificationInput,
  UpdateNotificationRepoInput,
} from '@/modules/notifications/core/ports.js';
import type {
  Notification,
  NotificationDelivery,
  UnsubscribeToken,
  NotificationType,
} from '@/modules/notifications/core/types.js';
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

    deleteCascade: async (id: string): Promise<Result<Notification | null, NotificationError>> => {
      if (simulateDbError) return createDbError();
      const notification = store.get(id);
      if (notification === undefined) {
        return ok(null);
      }
      store.delete(id);
      return ok(notification);
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

  return {
    findByUserId: async (
      userId: string,
      limit: number,
      offset: number
    ): Promise<Result<NotificationDelivery[], NotificationError>> => {
      if (simulateDbError) {
        return err({ type: 'DatabaseError', message: 'Simulated database error', retryable: true });
      }

      const userDeliveries = deliveries
        .filter((d) => d.userId === userId)
        .sort((a, b) => {
          // Sort by sentAt descending, with nulls at the end
          const aTime = a.sentAt?.getTime() ?? 0;
          const bTime = b.sentAt?.getTime() ?? 0;
          return bTime - aTime;
        });

      return ok(userDeliveries.slice(offset, offset + limit));
    },
  };
};

interface FakeUnsubscribeTokensRepoOptions {
  /** Initial tokens to seed the store with */
  tokens?: UnsubscribeToken[];
  /** Enable database error simulation */
  simulateDbError?: boolean;
}

/**
 * Creates a fake unsubscribe tokens repository for testing.
 */
export const makeFakeUnsubscribeTokensRepo = (
  options: FakeUnsubscribeTokensRepoOptions = {}
): UnsubscribeTokensRepository => {
  const store = new Map<string, UnsubscribeToken>();
  const simulateDbError = options.simulateDbError ?? false;

  // Seed initial tokens
  if (options.tokens !== undefined) {
    for (const t of options.tokens) {
      store.set(t.token, { ...t });
    }
  }

  const createDbError = (): Result<never, NotificationError> =>
    err({ type: 'DatabaseError', message: 'Simulated database error', retryable: true });

  return {
    findByToken: async (
      token: string
    ): Promise<Result<UnsubscribeToken | null, NotificationError>> => {
      if (simulateDbError) return createDbError();
      const tokenRecord = store.get(token);
      return ok(tokenRecord ?? null);
    },

    isTokenValid: async (token: string): Promise<Result<boolean, NotificationError>> => {
      if (simulateDbError) return createDbError();
      const tokenRecord = store.get(token);
      if (tokenRecord === undefined) return ok(false);
      const now = new Date();
      if (tokenRecord.expiresAt < now) return ok(false);
      if (tokenRecord.usedAt !== null) return ok(false);
      return ok(true);
    },

    markAsUsed: async (token: string): Promise<Result<UnsubscribeToken, NotificationError>> => {
      if (simulateDbError) return createDbError();
      const tokenRecord = store.get(token);
      if (tokenRecord === undefined) {
        return err({
          type: 'TokenNotFoundError',
          message: 'Unsubscribe token not found',
          token,
        });
      }
      const updated: UnsubscribeToken = {
        ...tokenRecord,
        usedAt: new Date(),
      };
      store.set(token, updated);
      return ok(updated);
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
  overrides: Partial<NotificationDelivery> = {}
): NotificationDelivery => {
  deliveryIdCounter++;
  const now = new Date();
  return {
    id: overrides.id ?? `delivery-${String(deliveryIdCounter)}`,
    userId: overrides.userId ?? 'user-1',
    notificationId: overrides.notificationId ?? 'notification-1',
    periodKey: overrides.periodKey ?? '2024-01',
    deliveryKey: overrides.deliveryKey ?? `user-1:notification-1:2024-01`,
    status: overrides.status ?? 'sent',
    unsubscribeToken: overrides.unsubscribeToken ?? null,
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
  };
};

/**
 * Creates a test unsubscribe token with sensible defaults.
 */
export const createTestUnsubscribeToken = (
  overrides: Partial<UnsubscribeToken> = {}
): UnsubscribeToken => {
  const now = new Date();
  const oneYearFromNow = new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000);
  return {
    token:
      overrides.token ??
      crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', ''),
    userId: overrides.userId ?? 'user-1',
    notificationId: overrides.notificationId ?? 'notification-1',
    createdAt: overrides.createdAt ?? now,
    expiresAt: overrides.expiresAt ?? oneYearFromNow,
    usedAt: overrides.usedAt ?? null,
  };
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
  /** Initial events per user (Map<userId, events>) */
  initialEvents?: Map<string, LearningProgressEvent[]>;
  /** Enable database error simulation */
  simulateDbError?: boolean;
}

/**
 * Creates a fake learning progress repository for testing.
 *
 * Implements all LearningProgressRepository methods using an in-memory Map.
 * Events are stored per user and deduplicated by eventId on upsert.
 */
export const makeFakeLearningProgressRepo = (
  options: FakeLearningProgressRepoOptions = {}
): LearningProgressRepository => {
  const store = new Map<string, LearningProgressEvent[]>();
  const simulateDbError = options.simulateDbError ?? false;

  // Seed initial events
  if (options.initialEvents !== undefined) {
    for (const [userId, events] of options.initialEvents.entries()) {
      store.set(userId, [...events]);
    }
  }

  const createDbError = (): Result<never, LearningProgressError> =>
    err({ type: 'DatabaseError', message: 'Simulated database error', retryable: true });

  return {
    getProgress: async (
      userId: string
    ): Promise<Result<LearningProgressData | null, LearningProgressError>> => {
      if (simulateDbError) return createDbError();

      const events = store.get(userId);
      if (events === undefined || events.length === 0) {
        return ok(null);
      }

      // Find latest event timestamp
      const lastEventAt = events.reduce<string | null>((latest, event) => {
        if (latest === null || event.occurredAt > latest) {
          return event.occurredAt;
        }
        return latest;
      }, null);

      return ok({
        events: [...events],
        lastEventAt,
        eventCount: events.length,
      });
    },

    upsertEvents: async (
      userId: string,
      newEvents: LearningProgressEvent[]
    ): Promise<Result<UpsertEventsResult, LearningProgressError>> => {
      if (simulateDbError) return createDbError();

      const existingEvents = store.get(userId) ?? [];
      const existingIds = new Set(existingEvents.map((e) => e.eventId));

      // Filter to only new events
      const actuallyNew = newEvents.filter((e) => !existingIds.has(e.eventId));

      // Merge
      const merged = [...existingEvents, ...actuallyNew];
      store.set(userId, merged);

      return ok({
        newEventsCount: actuallyNew.length,
        totalEventCount: merged.length,
      });
    },

    getEventCount: async (userId: string): Promise<Result<number, LearningProgressError>> => {
      if (simulateDbError) return createDbError();
      const events = store.get(userId);
      return ok(events?.length ?? 0);
    },
  };
};

// =============================================================================
// Learning Progress Test Builders
// =============================================================================

let learningEventIdCounter = 0;

interface TestContentProgressedPayload {
  contentId?: string;
  status?: 'not_started' | 'in_progress' | 'completed' | 'passed' | 'failed';
  score?: number;
  interaction?: {
    interactionId: string;
    state: Record<string, unknown> | null;
  };
}

/**
 * Creates a test content progressed event with sensible defaults.
 */
export const createTestContentProgressedEvent = (
  overrides: {
    eventId?: string;
    occurredAt?: string;
    clientId?: string;
    payload?: TestContentProgressedPayload;
  } = {}
): LearningProgressEvent => {
  learningEventIdCounter++;
  const payload = overrides.payload ?? {};
  return {
    eventId: overrides.eventId ?? `event-${String(learningEventIdCounter)}`,
    occurredAt: overrides.occurredAt ?? new Date().toISOString(),
    clientId: overrides.clientId ?? 'test-client',
    type: 'content.progressed',
    payload: {
      contentId: payload.contentId ?? `content-${String(learningEventIdCounter)}`,
      status: payload.status ?? 'in_progress',
      ...(payload.score !== undefined && { score: payload.score }),
      ...(payload.interaction !== undefined && { interaction: payload.interaction }),
    },
  } as LearningProgressEvent;
};

/**
 * Creates a test onboarding completed event.
 */
export const createTestOnboardingCompletedEvent = (
  pathId: string,
  overrides: Partial<LearningProgressEvent> = {}
): LearningProgressEvent => {
  learningEventIdCounter++;
  return {
    eventId: overrides.eventId ?? `onboarding-${String(learningEventIdCounter)}`,
    occurredAt: overrides.occurredAt ?? new Date().toISOString(),
    clientId: overrides.clientId ?? 'test-client',
    type: 'onboarding.completed',
    payload: { pathId },
  } as LearningProgressEvent;
};

/**
 * Creates a test active path set event.
 */
export const createTestActivePathSetEvent = (
  pathId: string | null,
  overrides: Partial<LearningProgressEvent> = {}
): LearningProgressEvent => {
  learningEventIdCounter++;
  return {
    eventId: overrides.eventId ?? `path-${String(learningEventIdCounter)}`,
    occurredAt: overrides.occurredAt ?? new Date().toISOString(),
    clientId: overrides.clientId ?? 'test-client',
    type: 'activePath.set',
    payload: { pathId },
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
        toEmail: null,
        notificationId: input.notificationId,
        periodKey: input.periodKey,
        deliveryKey: input.deliveryKey,
        status: 'pending',
        unsubscribeToken: input.unsubscribeToken ?? null,
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
          delivery.lastAttemptAt !== null &&
          delivery.lastAttemptAt < threshold
        ) {
          stuck.push(delivery);
        }
      }

      return ok(stuck);
    },

    existsByDeliveryKey: async (deliveryKey: string): Promise<Result<boolean, DeliveryError>> => {
      if (simulateDbError) return createDbError();
      return ok(keyIndex.has(deliveryKey));
    },
  };
};

interface FakeWebhookEventRepoOptions {
  /** Initial events to seed the store with */
  events?: StoredWebhookEvent[];
  /** Enable database error simulation */
  simulateDbError?: boolean;
}

/**
 * Creates a fake webhook event repository for testing.
 */
export const makeFakeWebhookEventRepo = (
  options: FakeWebhookEventRepoOptions = {}
): WebhookEventRepository => {
  const store = new Map<string, StoredWebhookEvent>();
  const simulateDbError = options.simulateDbError ?? false;

  // Seed initial events (keyed by svixId)
  if (options.events !== undefined) {
    for (const e of options.events) {
      store.set(e.svixId, { ...e });
    }
  }

  const createDbError = (): Result<never, DeliveryError> =>
    err({
      type: 'DatabaseError',
      message: 'Simulated database error',
      retryable: true,
    } as DeliveryError);

  return {
    insert: async (
      input: InsertWebhookEventInput
    ): Promise<Result<StoredWebhookEvent, DeliveryError>> => {
      if (simulateDbError) return createDbError();

      // Check for duplicate svix_id
      if (store.has(input.svixId)) {
        return err({
          type: 'DuplicateWebhookEvent',
          svixId: input.svixId,
        } as DeliveryError);
      }

      const id = crypto.randomUUID();
      const now = new Date();
      const event: StoredWebhookEvent = {
        id,
        svixId: input.svixId,
        eventType: input.eventType,
        resendEmailId: input.resendEmailId,
        deliveryId: input.deliveryId ?? null,
        payload: input.payload,
        processedAt: null,
        createdAt: now,
      };
      store.set(input.svixId, event);
      return ok(event);
    },

    markProcessed: async (svixId: string): Promise<Result<void, DeliveryError>> => {
      if (simulateDbError) return createDbError();

      const event = store.get(svixId);
      if (event !== undefined) {
        const updated: StoredWebhookEvent = {
          ...event,
          processedAt: new Date(),
        };
        store.set(svixId, updated);
      }
      return ok(undefined);
    },

    findUnprocessed: async (
      olderThanMinutes: number
    ): Promise<Result<StoredWebhookEvent[], DeliveryError>> => {
      if (simulateDbError) return createDbError();

      const threshold = new Date(Date.now() - olderThanMinutes * 60 * 1000);
      const unprocessed: StoredWebhookEvent[] = [];

      for (const event of store.values()) {
        if (event.processedAt === null && event.createdAt < threshold) {
          unprocessed.push(event);
        }
      }

      return ok(unprocessed);
    },
  };
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
  const notificationId = overrides.notificationId ?? 'notification-1';
  const periodKey = overrides.periodKey ?? '2025-01';
  const deliveryKey = overrides.deliveryKey ?? `${userId}:${notificationId}:${periodKey}`;

  return {
    id,
    userId,
    toEmail: overrides.toEmail ?? null,
    notificationId,
    periodKey,
    deliveryKey,
    status: overrides.status ?? 'pending',
    unsubscribeToken: overrides.unsubscribeToken ?? null,
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

let webhookEventIdCounter = 0;

/**
 * Creates a test stored webhook event with sensible defaults.
 */
export const createTestStoredWebhookEvent = (
  overrides: Partial<StoredWebhookEvent> = {}
): StoredWebhookEvent => {
  webhookEventIdCounter++;
  const now = new Date();
  return {
    id: overrides.id ?? `event-${String(webhookEventIdCounter)}`,
    svixId: overrides.svixId ?? `svix-${String(webhookEventIdCounter)}`,
    eventType: overrides.eventType ?? 'email.sent',
    resendEmailId: overrides.resendEmailId ?? `resend-${String(webhookEventIdCounter)}`,
    deliveryId: overrides.deliveryId ?? null,
    payload: overrides.payload ?? {},
    processedAt: overrides.processedAt ?? null,
    createdAt: overrides.createdAt ?? now,
  };
};
