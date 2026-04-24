import { CAMPAIGN_ADMIN_REVIEW_CAMPAIGN_KEYS } from '../modules/learning-progress/index.js';

import type { CacheClient } from '../infra/cache/index.js';
import type { AppConfig } from '../infra/config/env.js';
import type { BudgetDbClient, InsDbClient, UserDbClient } from '../infra/database/client.js';
import type { AdminEventRuntimeFactory } from '../modules/admin-events/index.js';
import type { AuthProvider } from '../modules/auth/index.js';
import type { BudgetSectorRepository } from '../modules/budget-sector/index.js';
import type { DatasetRepo } from '../modules/datasets/index.js';
import type { ExecutionLineItemRepository as ExecutionLineItemsModuleRepository } from '../modules/execution-line-items/index.js';
import type {
  ExecutionLineItemRepository,
  FundingSourceRepository,
} from '../modules/funding-sources/index.js';
import type { HealthChecker } from '../modules/health/index.js';
import type { CorrespondenceRecoveryRuntimeFactory } from '../modules/institution-correspondence/index.js';
import type { NotificationDeliveryRuntimeFactory } from '../modules/notification-delivery/index.js';
import type { UserEventRuntimeFactory } from '../modules/user-events/index.js';
import type { FastifyServerOptions } from 'fastify';

/**
 * Application dependencies that can be injected.
 */
export interface AppDeps {
  healthCheckers?: HealthChecker[];
  budgetDb: BudgetDbClient;
  insDb: InsDbClient;
  /** User database for notifications and other user-related data */
  userDb?: UserDbClient;
  datasetRepo: DatasetRepo;
  budgetSectorRepo?: BudgetSectorRepository;
  fundingSourceRepo?: FundingSourceRepository;
  /** Repository for funding source nested resolver (funding-sources module) */
  executionLineItemRepo?: ExecutionLineItemRepository;
  /** Repository for execution line items module (standalone queries) */
  executionLineItemsModuleRepo?: ExecutionLineItemsModuleRepository;
  config: AppConfig;
  /** Optional cache client for testing (auto-initialized if not provided) */
  cacheClient?: CacheClient;
  /**
   * Optional auth provider for token verification.
   * When provided, GraphQL context will include auth information.
   * Resolvers can use `requireAuthOrThrow` or `withAuth` to require authentication.
   */
  authProvider?: AuthProvider;
  /** Optional notification delivery runtime factory for tests */
  notificationDeliveryRuntimeFactory?: NotificationDeliveryRuntimeFactory;
  /** Optional user event runtime factory for tests */
  userEventRuntimeFactory?: UserEventRuntimeFactory;
  /** Optional admin event runtime factory for tests */
  adminEventRuntimeFactory?: AdminEventRuntimeFactory;
  /** Optional correspondence recovery runtime factory for tests */
  correspondenceRecoveryRuntimeFactory?: CorrespondenceRecoveryRuntimeFactory;
}

/**
 * Application options combining Fastify options with our custom deps.
 */
export interface AppOptions {
  fastifyOptions?: FastifyServerOptions;
  deps?: Partial<AppDeps>;
  version?: string | undefined;
}

export interface AppFeatureFlags {
  hasBullmqRedisConfig: boolean;
  shouldRegisterNotificationAdminRoutes: boolean;
  shouldPublishLearningProgressUserEvents: boolean;
  shouldEnqueueClerkWelcomeNotifications: boolean;
  shouldStartNotificationWorkers: boolean;
  shouldInitializeNotificationDeliveryRuntime: boolean;
  shouldInitializeUserEventRuntime: boolean;
  enabledCampaignAdminKeys: readonly string[];
  shouldEnablePublicDebateCorrespondence: boolean;
  emailFromAddress: string | undefined;
  funkyEmailFromAddress: string | undefined;
  campaignAuditCcRecipients: string[];
  campaignReplyToAddress: string | undefined;
}

export interface BuildPlan {
  deps: AppDeps;
  features: AppFeatureFlags;
}

function requireAppDeps(deps: Partial<AppDeps>): AppDeps {
  if (
    deps.budgetDb === undefined ||
    deps.insDb === undefined ||
    deps.datasetRepo === undefined ||
    deps.config === undefined
  ) {
    throw new Error('Missing required dependencies: budgetDb, insDb, datasetRepo, config');
  }

  return {
    ...deps,
    budgetDb: deps.budgetDb,
    insDb: deps.insDb,
    datasetRepo: deps.datasetRepo,
    config: deps.config,
  };
}

function buildFeatureFlags(deps: AppDeps): AppFeatureFlags {
  const config = deps.config;
  const hasBullmqRedisConfig = config.jobs.redisUrl !== undefined && config.jobs.redisUrl !== '';
  const shouldRegisterNotificationAdminRoutes =
    config.notifications.triggerApiKey !== undefined && config.notifications.triggerApiKey !== '';
  const shouldPublishLearningProgressUserEvents = hasBullmqRedisConfig;
  const shouldEnqueueClerkWelcomeNotifications =
    hasBullmqRedisConfig && config.auth.clerkWebhookSigningSecret !== undefined;
  const shouldStartNotificationWorkers = hasBullmqRedisConfig;
  const shouldInitializeNotificationDeliveryRuntime =
    shouldRegisterNotificationAdminRoutes ||
    shouldEnqueueClerkWelcomeNotifications ||
    shouldStartNotificationWorkers;
  const shouldInitializeUserEventRuntime = shouldPublishLearningProgressUserEvents;
  const shouldEnablePublicDebateCorrespondence = deps.userDb !== undefined && config.email.enabled;

  return {
    hasBullmqRedisConfig,
    shouldRegisterNotificationAdminRoutes,
    shouldPublishLearningProgressUserEvents,
    shouldEnqueueClerkWelcomeNotifications,
    shouldStartNotificationWorkers,
    shouldInitializeNotificationDeliveryRuntime,
    shouldInitializeUserEventRuntime,
    enabledCampaignAdminKeys: config.learningProgress.campaignAdminEnabledCampaigns,
    shouldEnablePublicDebateCorrespondence,
    emailFromAddress: config.email.fromAddress?.trim(),
    funkyEmailFromAddress: config.email.funkyFromAddress?.trim(),
    campaignAuditCcRecipients: config.email.funkyFromAddressCcRecipients,
    campaignReplyToAddress: config.email.funkyReplyToAddress?.trim(),
  };
}

function validateBuildPlan(deps: AppDeps, features: AppFeatureFlags): void {
  const config = deps.config;
  const supportedCampaignAdminKeys = new Set<string>(CAMPAIGN_ADMIN_REVIEW_CAMPAIGN_KEYS);
  const unsupportedCampaignAdminKeys = features.enabledCampaignAdminKeys.filter(
    (campaignKey) => !supportedCampaignAdminKeys.has(campaignKey)
  );
  const unsubscribeSecret = config.notifications.unsubscribeHmacSecret?.trim();
  const campaignAdminClerkSecret = config.auth.clerkSecretKey?.trim();
  const emailApiKey = config.email.apiKey;

  if (
    config.email.enabled &&
    (features.emailFromAddress === undefined || features.emailFromAddress === '')
  ) {
    throw new Error('Email is enabled but EMAIL_FROM_ADDRESS is missing.');
  }

  if (
    features.shouldEnablePublicDebateCorrespondence &&
    (features.funkyEmailFromAddress === undefined || features.funkyEmailFromAddress === '')
  ) {
    throw new Error(
      'Public debate campaign email requires FUNKY_EMAIL_FROM_ADDRESS when email is enabled.'
    );
  }

  if (
    features.shouldEnablePublicDebateCorrespondence &&
    (features.campaignReplyToAddress === undefined || features.campaignReplyToAddress === '')
  ) {
    throw new Error(
      'Public debate correspondence requires FUNKY_EMAIL_REPLY_TO_ADDRESS when email is enabled.'
    );
  }

  if (features.shouldEnablePublicDebateCorrespondence && !features.hasBullmqRedisConfig) {
    throw new Error(
      'Public debate correspondence requires BULLMQ_REDIS_URL so learning progress requests can dispatch institution email.'
    );
  }

  if (features.shouldInitializeNotificationDeliveryRuntime && deps.userDb === undefined) {
    throw new Error(
      'Notification delivery runtime requires userDb when notification admin routes or workers are enabled.'
    );
  }

  if (
    features.shouldInitializeNotificationDeliveryRuntime &&
    (config.jobs.redisUrl === undefined || config.jobs.redisUrl === '')
  ) {
    throw new Error(
      'Notification delivery runtime requires BULLMQ_REDIS_URL when notification admin routes or workers are enabled.'
    );
  }

  if (features.shouldInitializeUserEventRuntime && deps.userDb === undefined) {
    throw new Error(
      'User event runtime requires userDb when BullMQ background processing is enabled.'
    );
  }

  if (unsupportedCampaignAdminKeys.length > 0) {
    throw new Error(
      `Campaign admin routes configured for unsupported campaigns: ${unsupportedCampaignAdminKeys.join(', ')}.`
    );
  }

  if (features.enabledCampaignAdminKeys.length > 0 && deps.userDb === undefined) {
    throw new Error('Campaign admin routes require userDb when the campaign admin API is enabled.');
  }

  if (features.enabledCampaignAdminKeys.length > 0 && deps.authProvider === undefined) {
    throw new Error(
      'Campaign admin routes require authProvider when the campaign admin API is enabled.'
    );
  }

  if (deps.userDb !== undefined && (unsubscribeSecret === undefined || unsubscribeSecret === '')) {
    throw new Error(
      'Notification routes require UNSUBSCRIBE_HMAC_SECRET (min 32 chars) when userDb is enabled.'
    );
  }

  if (features.shouldStartNotificationWorkers && config.auth.clerkSecretKey === undefined) {
    throw new Error(
      'Notification delivery requires CLERK_SECRET_KEY when BullMQ workers are enabled.'
    );
  }

  if (
    features.shouldStartNotificationWorkers &&
    (emailApiKey === undefined || emailApiKey === '')
  ) {
    throw new Error(
      'Notification delivery requires RESEND_API_KEY when BullMQ workers are enabled.'
    );
  }

  if (
    features.shouldStartNotificationWorkers &&
    (features.emailFromAddress === undefined || features.emailFromAddress === '')
  ) {
    throw new Error(
      'Notification delivery requires EMAIL_FROM_ADDRESS when BullMQ workers are enabled.'
    );
  }

  if (features.shouldStartNotificationWorkers && config.notifications.platformBaseUrl === '') {
    throw new Error(
      'Notification delivery requires PUBLIC_CLIENT_BASE_URL when BullMQ workers are enabled.'
    );
  }

  if (
    deps.userDb !== undefined &&
    config.email.enabled &&
    (emailApiKey === undefined || emailApiKey === '')
  ) {
    throw new Error('Email is enabled but RESEND_API_KEY is missing.');
  }

  if (
    features.enabledCampaignAdminKeys.length > 0 &&
    (campaignAdminClerkSecret === undefined || campaignAdminClerkSecret === '')
  ) {
    throw new Error(
      'Campaign admin routes require CLERK_SECRET_KEY when the campaign admin API is enabled.'
    );
  }

  if (features.enabledCampaignAdminKeys.length > 0 && !config.email.enabled) {
    throw new Error(
      'Campaign admin routes require public debate correspondence wiring when the campaign admin API is enabled.'
    );
  }
}

export function resolveBuildPlan(deps: Partial<AppDeps>): BuildPlan {
  const requiredDeps = requireAppDeps(deps);
  const features = buildFeatureFlags(requiredDeps);

  validateBuildPlan(requiredDeps, features);

  return {
    deps: requiredDeps,
    features,
  };
}
