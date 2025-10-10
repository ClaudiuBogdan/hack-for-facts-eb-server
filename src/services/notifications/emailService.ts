import crypto from 'crypto';
import { withTransaction } from '../../db/dataAccess';
import { notificationDeliveriesRepository } from '../../db/repositories/notificationDeliveriesRepository';
import { unsubscribeTokensRepository } from '../../db/repositories/unsubscribeTokensRepository';
import type { Notification, UUID } from './types';
import { generateDeliveryKey } from './types';

export interface PendingNotification {
  notification: Notification;
  periodKey: string;
  deliveryKey: string;
  data: any;
  metadata?: Record<string, any>;
}

export interface EmailSection {
  type: 'entity_newsletter' | 'alert';
  title: string;
  content: any;
  unsubscribeUrl: string;
}

export interface ConsolidatedEmailData {
  userEmail: string;
  sections: EmailSection[];
  baseUrl: string;
}

/**
 * Email service for sending notifications
 * NOTE: This is a placeholder implementation. In production, integrate with your email provider
 * (e.g., SendGrid, AWS SES, Mailgun, etc.)
 */
export class EmailService {
  private baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl;
  }

  /**
   * Send a batch of notifications to a single user in one consolidated email
   * Uses transaction to ensure atomicity: either all deliveries are recorded + email sent, or rollback
   */
  async sendBatchedNotifications(
    userId: string,
    userEmail: string,
    pendingNotifications: PendingNotification[]
  ): Promise<string> {
    const emailBatchId = crypto.randomUUID();

    await withTransaction('userdata', async (client) => {
      // 1. Create unsubscribe tokens for all notifications
      const sections: EmailSection[] = [];

      for (const { notification, periodKey, deliveryKey, data, metadata } of pendingNotifications) {
        // Create unsubscribe token
        const token = await unsubscribeTokensRepository.create(
          {
            userId,
            notificationId: notification.id,
          },
          client
        );

        const unsubscribeUrl = `${this.baseUrl}/api/notifications/unsubscribe/${token.token}`;

        // Build section data
        sections.push({
          type: notification.notificationType.startsWith('newsletter') ? 'entity_newsletter' : 'alert',
          title: this.getSectionTitle(notification),
          content: data,
          unsubscribeUrl,
        });

        // 2. Insert delivery record
        await notificationDeliveriesRepository.create(
          {
            userId,
            notificationId: notification.id,
            periodKey,
            deliveryKey,
            emailBatchId,
            metadata: metadata ?? {},
          },
          client
        );
      }

      // 3. Send consolidated email
      const emailData: ConsolidatedEmailData = {
        userEmail,
        sections,
        baseUrl: this.baseUrl,
      };

      await this.sendConsolidatedEmail(emailData);

      // Transaction commits automatically if no error thrown
      // If sendConsolidatedEmail throws, transaction rolls back
    });

    return emailBatchId;
  }

  /**
   * Send the actual consolidated email
   * TODO: Integrate with your email provider (SendGrid, AWS SES, etc.)
   */
  private async sendConsolidatedEmail(data: ConsolidatedEmailData): Promise<void> {
    // Placeholder implementation
    // In production, this would:
    // 1. Render email template with Handlebars
    // 2. Send via email provider API
    // 3. Handle errors appropriately

    console.log('Sending consolidated email to:', data.userEmail);
    console.log('Number of sections:', data.sections.length);
    console.log('Sections:', data.sections.map(s => s.type));

    // Example structure for email provider integration:
    /*
    const html = await renderEmailTemplate('consolidated-notification', data);

    await emailProvider.send({
      to: data.userEmail,
      from: 'notifications@yourdomain.com',
      subject: this.generateEmailSubject(data.sections),
      html,
    });
    */

    // For now, just log (in production, this would actually send)
    // Simulate potential email send error for testing
    if (process.env.NODE_ENV === 'test' && data.userEmail === 'fail@test.com') {
      throw new Error('Email send failed (test simulation)');
    }
  }

  /**
   * Generate email subject based on sections
   */
  private generateEmailSubject(sections: EmailSection[]): string {
    const hasNewsletters = sections.some(s => s.type === 'entity_newsletter');
    const hasAlerts = sections.some(s => s.type === 'alert');

    if (hasNewsletters && hasAlerts) {
      return 'Your Budget Execution Updates & Alerts';
    } else if (hasNewsletters) {
      return 'Your Budget Execution Updates';
    } else {
      return 'Budget Execution Alerts';
    }
  }

  /**
   * Generate section title based on notification type
   */
  private getSectionTitle(notification: Notification): string {
    // For data series alerts, use the custom title from config
    if (notification.notificationType === 'alert_data_series' && notification.config?.title) {
      return notification.config.title;
    }

    switch (notification.notificationType) {
      case 'newsletter_entity_monthly':
        return 'Monthly Budget Execution Report';
      case 'newsletter_entity_quarterly':
        return 'Quarterly Budget Execution Report';
      case 'newsletter_entity_yearly':
        return 'Yearly Budget Execution Summary';
      case 'newsletter_entity_annual':
        return 'Annual Budget Execution Summary';
      case 'alert_data_series':
        return 'Budget Alert Notification';
      default:
        return 'Notification';
    }
  }

  /**
   * Check if a notification has already been delivered
   * Used before attempting to send
   */
  async hasBeenDelivered(deliveryKey: string): Promise<boolean> {
    return notificationDeliveriesRepository.checkDeliveryExists(deliveryKey);
  }

  /**
   * Get delivery key for checking
   */
  getDeliveryKey(userId: string, notificationId: UUID, periodKey: string): string {
    return generateDeliveryKey(userId, notificationId, periodKey);
  }
}

/**
 * Factory function to create email service with environment-based configuration
 */
export function createEmailService(): EmailService {
  const baseUrl = process.env.BASE_URL || 'http://localhost:3000';
  return new EmailService(baseUrl);
}

export const emailService = createEmailService();
