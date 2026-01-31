/**
 * Notifications Module - Validation Logic
 *
 * Pure validation functions for notification configurations.
 * These functions are used by both subscribe and update use cases.
 */

import { ok, err, type Result } from 'neverthrow';

import {
  createEntityRequiredError,
  createConfigRequiredError,
  createInvalidConfigError,
  type NotificationError,
} from './errors.js';

import type {
  NotificationType,
  NotificationConfig,
  AnalyticsSeriesAlertConfig,
  StaticSeriesAlertConfig,
} from './types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Type Guards
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Type guard for AnalyticsSeriesAlertConfig.
 */
export function isAnalyticsAlertConfig(
  config: NotificationConfig
): config is AnalyticsSeriesAlertConfig {
  if (config === null) {
    return false;
  }

  if (typeof config !== 'object') {
    return false;
  }

  const candidate = config as unknown as { filter?: unknown; conditions?: unknown };
  return (
    typeof candidate.filter === 'object' &&
    candidate.filter !== null &&
    Array.isArray(candidate.conditions)
  );
}

/**
 * Type guard for StaticSeriesAlertConfig.
 */
export function isStaticAlertConfig(config: NotificationConfig): config is StaticSeriesAlertConfig {
  if (config === null) {
    return false;
  }

  if (typeof config !== 'object') {
    return false;
  }

  const candidate = config as unknown as { datasetId?: unknown; conditions?: unknown };
  return typeof candidate.datasetId === 'string' && Array.isArray(candidate.conditions);
}

// ─────────────────────────────────────────────────────────────────────────────
// Condition Validation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Validates an array of alert conditions.
 *
 * Each condition must have:
 * - A non-empty unit string
 * - A finite threshold number
 */
export function validateConditions(
  conditions: unknown[],
  notificationType: NotificationType
): Result<void, NotificationError> {
  for (const [i, condition] of conditions.entries()) {
    if (
      condition === null ||
      typeof condition !== 'object' ||
      typeof (condition as Record<string, unknown>)['unit'] !== 'string' ||
      ((condition as Record<string, unknown>)['unit'] as string).trim() === ''
    ) {
      return err(
        createInvalidConfigError(
          notificationType,
          `Condition at index ${String(i)} requires a unit`
        )
      );
    }

    const threshold = (condition as Record<string, unknown>)['threshold'];
    if (typeof threshold !== 'number' || !Number.isFinite(threshold)) {
      return err(
        createInvalidConfigError(
          notificationType,
          `Condition at index ${String(i)} requires a finite threshold`
        )
      );
    }

    const operator = (condition as Record<string, unknown>)['operator'];
    if (
      operator !== 'gt' &&
      operator !== 'gte' &&
      operator !== 'lt' &&
      operator !== 'lte' &&
      operator !== 'eq'
    ) {
      return err(
        createInvalidConfigError(
          notificationType,
          `Condition at index ${String(i)} requires a valid operator`
        )
      );
    }
  }

  return ok(undefined);
}

// ─────────────────────────────────────────────────────────────────────────────
// Newsletter Validation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Validates that a newsletter subscription has a valid entity CUI.
 *
 * Newsletter subscriptions require a non-empty entity CUI because
 * they provide periodic reports for a specific public institution.
 */
export function validateNewsletterEntity(
  notificationType: NotificationType,
  entityCui: string | null
): Result<void, NotificationError> {
  if (entityCui === null || entityCui.trim() === '') {
    return err(createEntityRequiredError(notificationType));
  }
  return ok(undefined);
}

// ─────────────────────────────────────────────────────────────────────────────
// Analytics Alert Validation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Validates analytics alert configuration.
 *
 * Analytics alerts require:
 * - A non-null config with a filter property
 * - Valid conditions (if any)
 */
export function validateAnalyticsAlertConfig(
  config: NotificationConfig,
  notificationType: NotificationType
): Result<AnalyticsSeriesAlertConfig, NotificationError> {
  if (config === null) {
    return err(createConfigRequiredError(notificationType));
  }

  if (!isAnalyticsAlertConfig(config)) {
    return err(createInvalidConfigError(notificationType, 'Analytics alert requires a filter'));
  }

  const conditionsResult = validateConditions(config.conditions, notificationType);
  if (conditionsResult.isErr()) {
    return err(conditionsResult.error);
  }

  return ok(config);
}

// ─────────────────────────────────────────────────────────────────────────────
// Static Alert Validation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Validates static alert configuration.
 *
 * Static alerts require:
 * - A non-null config with a datasetId property
 * - A non-empty datasetId
 * - Valid conditions (if any)
 */
export function validateStaticAlertConfig(
  config: NotificationConfig,
  notificationType: NotificationType
): Result<StaticSeriesAlertConfig, NotificationError> {
  if (config === null) {
    return err(createConfigRequiredError(notificationType));
  }

  if (!isStaticAlertConfig(config)) {
    return err(createInvalidConfigError(notificationType, 'Static alert requires a datasetId'));
  }

  if (config.datasetId.trim() === '') {
    return err(createInvalidConfigError(notificationType, 'datasetId cannot be empty'));
  }

  const conditionsResult = validateConditions(config.conditions, notificationType);
  if (conditionsResult.isErr()) {
    return err(conditionsResult.error);
  }

  return ok(config);
}

// ─────────────────────────────────────────────────────────────────────────────
// Generic Config Validation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Validates config for a specific notification type.
 *
 * - Newsletter types: config should be null (ignored)
 * - Analytics alerts: validates filter and conditions
 * - Static alerts: validates datasetId and conditions
 */
export function validateConfigForNotificationType(
  notificationType: NotificationType,
  config: NotificationConfig
): Result<void, NotificationError> {
  // Newsletter types don't use config
  if (
    notificationType === 'newsletter_entity_monthly' ||
    notificationType === 'newsletter_entity_quarterly' ||
    notificationType === 'newsletter_entity_yearly'
  ) {
    return ok(undefined);
  }

  // Analytics alert
  if (notificationType === 'alert_series_analytics') {
    if (config !== null && !isAnalyticsAlertConfig(config)) {
      return err(
        createInvalidConfigError(notificationType, 'Analytics alert config must have a filter')
      );
    }

    if (config !== null) {
      const conditionsResult = validateConditions(config.conditions, notificationType);
      if (conditionsResult.isErr()) {
        return err(conditionsResult.error);
      }
    }
  }

  // Static alert
  if (notificationType === 'alert_series_static') {
    if (config !== null && !isStaticAlertConfig(config)) {
      return err(
        createInvalidConfigError(notificationType, 'Static alert config must have a datasetId')
      );
    }

    if (config !== null && config.datasetId.trim() === '') {
      return err(createInvalidConfigError(notificationType, 'datasetId cannot be empty'));
    }

    if (config !== null) {
      const conditionsResult = validateConditions(config.conditions, notificationType);
      if (conditionsResult.isErr()) {
        return err(conditionsResult.error);
      }
    }
  }

  return ok(undefined);
}
