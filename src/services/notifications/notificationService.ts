import { notificationsRepository } from '../../db/repositories/notificationsRepository';
import { notificationDeliveriesRepository } from '../../db/repositories/notificationDeliveriesRepository';
import { unsubscribeTokensRepository } from '../../db/repositories/unsubscribeTokensRepository';
import type {
  Notification,
  NotificationConfig,
  NotificationType,
} from './types';
import {
  generateNotificationHash,
  generateDeliveryKey,
  generatePeriodKey,
  NOTIFICATION_TYPE_CONFIGS,
} from './types';

export class NotificationService {
  /**
   * Subscribe a user to a notification type
   * Creates or reactivates a notification subscription
   */
  async subscribe(
    userId: string,
    notificationType: NotificationType,
    entityCui?: string | null,
    config?: NotificationConfig | null
  ): Promise<Notification> {
    const typeConfig = NOTIFICATION_TYPE_CONFIGS[notificationType];

    // Validate entity requirement
    if (typeConfig.requiresEntity && !entityCui) {
      throw new Error(`Notification type ${notificationType} requires an entity_cui`);
    }

    const normalizedEntity = entityCui ?? null;
    const defaultedConfig = config ?? typeConfig.defaultConfig ?? null;

    const existing = await notificationsRepository.findByUserTypeAndEntity(
      userId,
      notificationType,
      normalizedEntity
    );

    if (existing) {
      const resolvedConfig = config !== undefined ? config : existing.config;
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

      if (config !== undefined) {
        updates.config = resolvedConfigOrNull;
      }

      if (nextHash !== existing.hash) {
        updates.hash = nextHash;
      }

      return notificationsRepository.update(existing.id, updates);
    }

    // Create new notification
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
  async unsubscribe(notificationId: number): Promise<Notification> {
    return notificationsRepository.deactivate(notificationId);
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
   * Update notification configuration
   */
  async updateConfig(notificationId: number, config: NotificationConfig): Promise<Notification> {
    return notificationsRepository.update(notificationId, { config });
  }

  /**
   * Check if a notification has already been delivered for a period
   */
  async hasBeenDelivered(
    userId: string,
    notificationId: number,
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
  async deleteNotification(notificationId: number): Promise<Notification | null> {
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
