import { notificationsRepository } from '../../db/repositories/notificationsRepository';
import { notificationDeliveriesRepository } from '../../db/repositories/notificationDeliveriesRepository';
import type { Notification, NotificationType, UUID, NotificationConfig } from './types';
import { generateNotificationHash, generateDeliveryKey, generatePeriodKey, NOTIFICATION_TYPE_CONFIGS } from './types';
import { ValidationError } from '../../utils/errors';

function ensureAnalyticsAlertConfig(config: any): asserts config is any {
  if (!config) {
    throw new ValidationError('Alert configuration is required', [
      { path: 'config', message: 'Provide alert config for analytics alert', code: 'missing_config' },
    ]);
  }
  if (!config.filter) {
    throw new ValidationError('Analytics filter is required', [
      { path: 'config.filter', message: 'Analytics filter must be provided', code: 'missing_analytics_input' },
    ]);
  }
  const conditions = Array.isArray(config.conditions) ? config.conditions : [];
  for (let i = 0; i < conditions.length; i++) {
    const condition = conditions[i];
    if (!condition.unit) {
      throw new ValidationError('Condition unit is required', [
        { path: `config.conditions[${i}].unit`, message: 'Provide a unit for the condition', code: 'missing_unit' },
      ]);
    }
    if (!Number.isFinite(condition.threshold)) {
      throw new ValidationError('Condition threshold must be a finite number', [
        { path: `config.conditions[${i}].threshold`, message: 'Threshold must be a finite number', code: 'invalid_threshold' },
      ]);
    }
  }
}

function ensureStaticAlertConfig(config: any): asserts config is any {
  if (!config) {
    throw new ValidationError('Alert configuration is required', [
      { path: 'config', message: 'Provide alert config for static alert', code: 'missing_config' },
    ]);
  }
  if (!config.datasetId) {
    throw new ValidationError('Dataset id is required', [
      { path: 'config.datasetId', message: 'Provide datasetId for static alert', code: 'missing_dataset_id' },
    ]);
  }
  const conditions = Array.isArray(config.conditions) ? config.conditions : [];
  for (let i = 0; i < conditions.length; i++) {
    const condition = conditions[i];
    if (!condition.unit) {
      throw new ValidationError('Condition unit is required', [
        { path: `config.conditions[${i}].unit`, message: 'Provide a unit for the condition', code: 'missing_unit' },
      ]);
    }
    if (!Number.isFinite(condition.threshold)) {
      throw new ValidationError('Condition threshold must be a finite number', [
        { path: `config.conditions[${i}].threshold`, message: 'Threshold must be a finite number', code: 'invalid_threshold' },
      ]);
    }
  }
}

export class NotificationService {
  /**
   * Subscribe a user to a notification type
   * Creates or reactivates a notification subscription
   */
  async subscribe(
    userId: string,
    notificationType: NotificationType,
    entityCui?: string | null,
    configArg?: NotificationConfig | null
  ): Promise<Notification> {
    const typeConfig = NOTIFICATION_TYPE_CONFIGS[notificationType];

    // Validate entity requirement
    if (typeConfig.requiresEntity && !entityCui) {
      throw new ValidationError('Notification type requires entityCui', [
        {
          path: 'entityCui',
          message: `Notification type ${notificationType} requires an entityCui value`,
          code: 'missing_entity_cui',
        },
      ]);
    }

    const normalizedEntity = entityCui ?? null;
    const defaultedConfig = (configArg ?? typeConfig.defaultConfig ?? null) as NotificationConfig;

    if (notificationType === 'alert_series_analytics') {
      ensureAnalyticsAlertConfig(defaultedConfig);
    } else if (notificationType === 'alert_series_static') {
      ensureStaticAlertConfig(defaultedConfig);
    }

    const existing = await notificationsRepository.findByUserTypeAndEntity(
      userId,
      notificationType,
      normalizedEntity
    );

    if (existing && ['newsletter_entity_monthly', 'newsletter_entity_quarterly', 'newsletter_entity_yearly'].includes(notificationType)) {
      const resolvedConfig = configArg !== undefined ? configArg : existing.config;
      const resolvedConfigOrNull = resolvedConfig ?? null;
      const nextHash = generateNotificationHash(
        userId,
        notificationType,
        normalizedEntity,
        resolvedConfigOrNull
      );

      const updates: { isActive: boolean; config?: NotificationConfig | null; hash?: string } = {
        isActive: true,
      };

      if (configArg !== undefined) {
        updates.config = resolvedConfigOrNull;
      }

      if (nextHash !== existing.hash) {
        updates.hash = nextHash;
      }

      return notificationsRepository.update(existing.id, updates);
    }

    const hash = generateNotificationHash(
      userId,
      notificationType,
      normalizedEntity,
      defaultedConfig
    );

    const notificationExists = await notificationsRepository.findByHash(hash);

    if (notificationExists) {
      return notificationExists;
    }

    return notificationsRepository.create({
      userId,
      notificationType,
      entityCui: normalizedEntity,
      config: defaultedConfig,
    });
  }

  /**
   * Unsubscribe from a notification
   */
  async unsubscribe(notificationId: UUID): Promise<Notification> {
    return notificationsRepository.deactivate(notificationId);
  }

  async update(
    notificationId: UUID,
    updates: { isActive?: boolean; config?: NotificationConfig | null }
  ): Promise<Notification> {
    const existing = await notificationsRepository.findById(notificationId);
    if (!existing) {
      throw new ValidationError('Notification not found', [
        { path: 'notificationId', message: 'Notification does not exist', code: 'not_found' },
      ]);
    }

    let resolvedConfig = existing.config;
    const payload: { isActive?: boolean; config?: NotificationConfig | null; hash?: string } = {};

    if (updates.config !== undefined) {
      if (existing.notificationType === 'alert_series_analytics') {
        ensureAnalyticsAlertConfig(updates.config);
      } else if (existing.notificationType === 'alert_series_static') {
        ensureStaticAlertConfig(updates.config);
      }
      resolvedConfig = updates.config;
      payload.config = updates.config;
    }

    if (updates.isActive !== undefined) {
      payload.isActive = updates.isActive;
    }

    const nextHash = generateNotificationHash(
      existing.userId,
      existing.notificationType,
      existing.entityCui,
      resolvedConfig
    );

    if (nextHash !== existing.hash) {
      payload.hash = nextHash;
    }

    return notificationsRepository.update(notificationId, payload);
  }

  /**
   * Get all active notifications for a user
   */
  async getUserNotifications(userId: string, activeOnly = true): Promise<Notification[]> {
    return notificationsRepository.findByUserId(userId, activeOnly);
  }

  /**
   * Get notifications for a specific entity
   */
  async getEntityNotifications(entityCui: string, activeOnly = true): Promise<Notification[]> {
    return notificationsRepository.findByEntityCui(entityCui, activeOnly);
  }

  /**
   * Get user notifications for a specific entity
   */
  async getUserEntityNotifications(
    userId: string,
    entityCui: string | null,
    activeOnly = true
  ): Promise<Notification[]> {
    return notificationsRepository.findByUserAndEntity(userId, entityCui, activeOnly);
  }

  /**
   * Check if a notification has already been delivered for a period
   */
  async hasBeenDelivered(
    userId: string,
    notificationId: UUID,
    periodKey: string
  ): Promise<boolean> {
    const deliveryKey = generateDeliveryKey(userId, notificationId, periodKey);
    return notificationDeliveriesRepository.checkDeliveryExists(deliveryKey);
  }

  /**
   * Get all active notifications of a specific type
   * Used by send script to find what to send
   */
  async getActiveNotificationsByType(notificationType: NotificationType): Promise<Notification[]> {
    return notificationsRepository.findByType(notificationType, true);
  }

  /**
   * Delete a notification and related deliveries/tokens
   */
  async deleteNotification(notificationId: UUID): Promise<Notification | null> {
    return notificationsRepository.deleteCascade(notificationId);
  }

  /**
   * Get delivery history for a user
   */
  async getUserDeliveryHistory(userId: string, limit = 50, offset = 0) {
    return notificationDeliveriesRepository.findByUserId(userId, limit, offset);
  }

  /**
   * Get all deliveries for a batch email
   */
  async getBatchDeliveries(emailBatchId: string) {
    return notificationDeliveriesRepository.findByEmailBatchId(emailBatchId);
  }

  /**
   * Generate period key for current period
   */
  getPeriodKey(notificationType: NotificationType, date?: Date): string {
    return generatePeriodKey(notificationType, date);
  }
}

export const notificationService = new NotificationService();
