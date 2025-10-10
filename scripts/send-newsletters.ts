#!/usr/bin/env ts-node

/**
 * Newsletter Send Script
 *
 * Sends batched notifications to users based on notification type and period.
 * Must be run manually with Clerk admin token for email lookup.
 *
 * Usage:
 *   ts-node scripts/send-newsletters.ts --type newsletter_entity_monthly --clerk-token <token>
 *   ts-node scripts/send-newsletters.ts --type newsletter_entity_quarterly --clerk-token <token>
 *   ts-node scripts/send-newsletters.ts --type newsletter_entity_yearly --clerk-token <token> --user <user_id>
 *   ts-node scripts/send-newsletters.ts --type newsletter_entity_annual --clerk-token <token> --user <user_id>
 *   ts-node scripts/send-newsletters.ts --type alert_data_series --clerk-token <token>
 *
 * Options:
 *   --type: Notification type to send (required)
 *   --clerk-token: Clerk admin token for email lookup (required)
 *   --user: Send only to specific user ID (optional, for testing)
 *   --dry-run: Simulate sending without actually sending emails
 *   --date: ISO date string for period calculation (defaults to today)
 */

import { notificationService } from '../src/services/notifications/notificationService';
import { emailService } from '../src/services/notifications/emailService';
import type { NotificationType, Notification } from '../src/services/notifications/types';
import { generateDeliveryKey, generatePeriodKey } from '../src/services/notifications/types';
import { entityRepository, executionLineItemRepository } from '../src/db/repositories';
import type {
  ReportPeriodInput,
  ReportPeriodType,
  YearMonthPeriod,
  YearQuarterPeriod,
  YearPeriod,
  AnalyticsFilter,
  AnalyticsSeries,
} from '../src/types';
import { getNormalizationUnit } from '../src/db/repositories/utils';

// Clerk admin SDK for email lookup
import { createClerkClient } from '@clerk/backend';

interface CLIOptions {
  type: NotificationType;
  clerkToken: string;
  user?: string;
  dryRun?: boolean;
  date?: string;
}

interface UserEmailMap {
  [userId: string]: string;
}

interface EntityNewsletterContent {
  entityName: string;
  entityCui: string;
  periodKey: string;
  granularity: ReportPeriodType;
  summary: {
    totalSpending: number;
    totalIncome: number;
    balance: number;
    executionRate?: number;
  };
  topCreditors?: Array<{ name: string; amount: number }>;
  topDebtors?: Array<{ name: string; amount: number }>;
  entityUrl?: string;
}

interface DataSeriesAlertContent {
  title?: string;
  description?: string;
  series: {
    seriesId: string;
    xAxis: { name: string; type: string; unit: string };
    yAxis: { name: string; type: string; unit: string };
    data: Array<{ x: string; y: number }>;
  };
  metadata: {
    accountCategory: string;
    periodType: string;
    normalization?: string;
  };
}

interface NotificationData<TContent = any> {
  notification: Notification;
  data: TContent;
  metadata?: Record<string, any>;
}

function getClientBaseUrl(): string {
  const raw =
    process.env.CLIENT_BASE_URL ||
    process.env.PUBLIC_CLIENT_BASE_URL ||
    process.env.PUBLIC_URL ||
    process.env.BASE_URL ||
    'http://localhost:5173';

  return raw.replace(/\/+$/, '');
}

function parseMonthlyPeriodKey(periodKey: string): { year: number; month: number } | null {
  const [yearStr, monthStr] = periodKey.split('-');
  const year = Number(yearStr);
  const month = Number(monthStr);

  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
    return null;
  }

  return { year, month };
}

function buildMonthlyPeriodInput(year: number, month: number): ReportPeriodInput {
  const period: YearMonthPeriod = `${year}-${String(month).padStart(2, '0')}` as YearMonthPeriod;
  return {
    type: 'MONTH',
    selection: { dates: [period] },
  };
}

function formatMonthLabel(year: number, month: number): string {
  const date = new Date(Date.UTC(year, month - 1, 1));
  return date.toLocaleDateString('ro-RO', { year: 'numeric', month: 'long' });
}

function parseQuarterPeriodKey(periodKey: string): { year: number; quarter: number } | null {
  const match = periodKey.match(/^(\d{4})-Q([1-4])$/);
  if (!match) {
    return null;
  }

  const year = Number(match[1]);
  const quarter = Number(match[2]);
  if (!Number.isInteger(year) || !Number.isInteger(quarter) || quarter < 1 || quarter > 4) {
    return null;
  }

  return { year, quarter };
}

function buildQuarterPeriodInput(year: number, quarter: number): ReportPeriodInput {
  const period: YearQuarterPeriod = `${year}-Q${quarter}` as YearQuarterPeriod;
  return {
    type: 'QUARTER',
    selection: { dates: [period] },
  };
}

function formatQuarterLabel(year: number, quarter: number): string {
  return `Trimestrul ${quarter}, ${year}`;
}

function parseAnnualPeriodKey(periodKey: string): { year: number } | null {
  const year = Number(periodKey);
  if (!Number.isInteger(year) || periodKey.length !== 4) {
    return null;
  }
  return { year };
}

function buildAnnualPeriodInput(year: number): ReportPeriodInput {
  const period: YearPeriod = `${year}` as YearPeriod;
  return {
    type: 'YEAR',
    selection: { dates: [period] },
  };
}

function formatYearLabel(year: number): string {
  return `Anul ${year}`;
}

function buildEntityUrl(entityCui: string, period: string): string {
  const baseUrl = getClientBaseUrl();
  const normalizedBase = baseUrl.replace(/\/+$/, '');
  return `${normalizedBase}/entities/${encodeURIComponent(entityCui)}?period=${encodeURIComponent(period)}`;
}

function calculateExecutionRate(totalIncome: number, totalExpenses: number): number | undefined {
  if (!totalIncome || !isFinite(totalIncome)) {
    return undefined;
  }

  const rate = (totalExpenses / totalIncome) * 100;
  return Number.isFinite(rate) ? Number(rate.toFixed(2)) : undefined;
}

/**
 * Parse command line arguments
 */
function parseArgs(): CLIOptions {
  const args = process.argv.slice(2);
  const options: Partial<CLIOptions> = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const nextArg = args[i + 1];

    switch (arg) {
      case '--type':
        options.type = nextArg as NotificationType;
        i++;
        break;
      case '--clerk-token':
        options.clerkToken = nextArg;
        i++;
        break;
      case '--user':
        options.user = nextArg;
        i++;
        break;
      case '--dry-run':
        options.dryRun = true;
        break;
      case '--date':
        options.date = nextArg;
        i++;
        break;
    }
  }

  if (!options.type) {
    throw new Error('--type is required');
  }

  if (!options.clerkToken) {
    throw new Error('--clerk-token is required');
  }

  return options as CLIOptions;
}

/**
 * Fetch user emails from Clerk in batch
 */
async function fetchUserEmails(userIds: string[], clerkToken: string): Promise<UserEmailMap> {
  const clerk = createClerkClient({ secretKey: clerkToken });
  const emailMap: UserEmailMap = {};

  console.log(`Fetching emails for ${userIds.length} users from Clerk...`);

  // Fetch users in parallel (with reasonable concurrency limit)
  const batchSize = 10;
  for (let i = 0; i < userIds.length; i += batchSize) {
    const batch = userIds.slice(i, i + batchSize);
    const results = await Promise.allSettled(
      batch.map(async (userId) => {
        const user = await clerk.users.getUser(userId);
        const email = user.emailAddresses.find((e) => e.id === user.primaryEmailAddressId)?.emailAddress;
        return { userId, email };
      })
    );

    for (const result of results) {
      if (result.status === 'fulfilled' && result.value.email) {
        emailMap[result.value.userId] = result.value.email;
      } else {
        console.warn(`Failed to fetch email for user: ${result.status === 'fulfilled' ? result.value.userId : 'unknown'}`);
      }
    }
  }

  console.log(`Successfully fetched ${Object.keys(emailMap).length} emails`);
  return emailMap;
}

/**
 * Fetch data series alert data from analytics
 */
async function fetchDataSeriesAlertData(
  notification: Notification,
  periodKey: string
): Promise<NotificationData<DataSeriesAlertContent> | null> {
  const config = notification.config;

  if (!config?.filter) {
    console.warn(`  Notification ${notification.id} missing analyticsInput config – skipping`);
    return null;
  }

  if (!config.title) {
    console.warn(`  Notification ${notification.id} missing title – skipping`);
    return null;
  }

  try {
    const filter = config.filter as any;
    const unit = getNormalizationUnit(filter?.normalization);
    const type = filter?.report_period?.type;

    let series: AnalyticsSeries;

    if (type === 'MONTH') {
      const monthly = await executionLineItemRepository.getMonthlyTrend(filter);
      series = {
        seriesId: 'alert-series',
        xAxis: { name: 'Month', type: 'STRING', unit: 'month' },
        yAxis: { name: 'Amount', type: 'FLOAT', unit },
        data: monthly.map(p => ({ x: `${p.year}-${String(p.month).padStart(2, '0')}`, y: p.value })),
      };
    } else if (type === 'QUARTER') {
      const quarterly = await executionLineItemRepository.getQuarterlyTrend(filter);
      series = {
        seriesId: 'alert-series',
        xAxis: { name: 'Quarter', type: 'STRING', unit: 'quarter' },
        yAxis: { name: 'Amount', type: 'FLOAT', unit },
        data: quarterly.map(p => ({ x: `${p.year}-Q${p.quarter}`, y: p.value })),
      };
    } else {
      // Default: yearly
      const yearly = await executionLineItemRepository.getYearlyTrend(filter);
      series = {
        seriesId: 'alert-series',
        xAxis: { name: 'Year', type: 'INTEGER', unit: 'year' },
        yAxis: { name: 'Amount', type: 'FLOAT', unit },
        data: yearly.map(p => ({ x: String(p.year), y: p.value })),
      };
    }

    // Check if there's any data
    if (!series.data || series.data.length === 0) {
      console.log(`  No data found for alert ${notification.id} – skipping`);
      return null;
    }

    const content: DataSeriesAlertContent = {
      title: config.title,
      description: config.description,
      series,
      metadata: {
        accountCategory: filter?.account_category === 'vn' ? 'Income' : 'Expenses',
        periodType: type ?? 'YEAR',
        normalization: filter?.normalization,
      },
    };

    return {
      notification,
      data: content,
      metadata: {
        generatedAt: new Date().toISOString(),
        periodKey,
        seriesDataPointCount: series.data.length,
        filterSummary: {
          accountCategory: filter?.account_category,
          periodType: type,
          entityCuis: filter?.entity_cuis,
          functionalCodes: filter?.functional_codes,
          economicCodes: filter?.economic_codes,
        },
      },
    };
  } catch (error: any) {
    console.error(`  Failed to fetch data series alert data: ${error.message}`);
    return null;
  }
}

/**
 * Fetch notification data based on type
 * This is where you'd call your analytics/data repositories
 */
async function fetchNotificationData(
  notification: Notification,
  periodKey: string
): Promise<NotificationData<EntityNewsletterContent | DataSeriesAlertContent> | null> {
  console.log(`  Fetching data for notification ${notification.id} (${notification.notificationType})`);

  // Handle data series alerts separately
  if (notification.notificationType === 'alert_data_series') {
    return fetchDataSeriesAlertData(notification, periodKey);
  }

  if (
    notification.notificationType !== 'newsletter_entity_monthly' &&
    notification.notificationType !== 'newsletter_entity_quarterly' &&
    notification.notificationType !== 'newsletter_entity_yearly' &&
    notification.notificationType !== 'newsletter_entity_annual'
  ) {
    console.warn(`  Unsupported notification type "${notification.notificationType}" for data fetch – skipping`);
    return null;
  }

  if (!notification.entityCui) {
    console.warn(`  Notification ${notification.id} is missing entityCui – skipping`);
    return null;
  }

  let reportPeriod: ReportPeriodInput | null = null;
  let displayPeriod: string | null = null;
  let entityPeriodParam: string | null = null;
  let granularity: ReportPeriodType | null = null;

  switch (notification.notificationType) {
    case 'newsletter_entity_monthly': {
      const parsed = parseMonthlyPeriodKey(periodKey);
      if (!parsed) {
        console.warn(`  Period key "${periodKey}" is invalid – skipping notification ${notification.id}`);
        return null;
      }
      granularity = 'MONTH';
      reportPeriod = buildMonthlyPeriodInput(parsed.year, parsed.month);
      displayPeriod = formatMonthLabel(parsed.year, parsed.month);
      entityPeriodParam = `${parsed.year}-${String(parsed.month).padStart(2, '0')}`;
      break;
    }
    case 'newsletter_entity_quarterly': {
      const parsed = parseQuarterPeriodKey(periodKey);
      if (!parsed) {
        console.warn(`  Period key "${periodKey}" is invalid – skipping notification ${notification.id}`);
        return null;
      }
      granularity = 'QUARTER';
      reportPeriod = buildQuarterPeriodInput(parsed.year, parsed.quarter);
      displayPeriod = formatQuarterLabel(parsed.year, parsed.quarter);
      entityPeriodParam = `${parsed.year}-Q${parsed.quarter}`;
      break;
    }
    case 'newsletter_entity_yearly':
    case 'newsletter_entity_annual': {
      const parsed = parseAnnualPeriodKey(periodKey);
      if (!parsed) {
        console.warn(`  Period key "${periodKey}" is invalid – skipping notification ${notification.id}`);
        return null;
      }
      granularity = 'YEAR';
      reportPeriod = buildAnnualPeriodInput(parsed.year);
      displayPeriod = formatYearLabel(parsed.year);
      entityPeriodParam = `${parsed.year}`;
      break;
    }
    default:
      console.warn(`  Unsupported notification type "${notification.notificationType}" for data fetch – skipping`);
      return null;
  }

  if (!reportPeriod || !displayPeriod || !entityPeriodParam || !granularity) {
    console.warn(`  Failed to resolve period data for notification ${notification.id} – skipping`);
    return null;
  }

  const entity = await entityRepository.getById(notification.entityCui);
  if (!entity) {
    console.warn(`  Entity ${notification.entityCui} not found – skipping notification ${notification.id}`);
    return null;
  }

  try {
    const reportType =
      entity.default_report_type ??
      'Executie bugetara agregata la nivel de ordonator principal';

    const totals = await executionLineItemRepository.getPeriodSnapshotTotals(
      entity.cui,
      reportPeriod,
      reportType
    );

    const executionRate = calculateExecutionRate(totals.totalIncome, totals.totalExpenses);
    const content: EntityNewsletterContent = {
      entityName: entity.name,
      entityCui: entity.cui,
      periodKey: displayPeriod,
      granularity,
      summary: {
        totalSpending: totals.totalExpenses,
        totalIncome: totals.totalIncome,
        balance: totals.budgetBalance,
        executionRate,
      },
      entityUrl: buildEntityUrl(entity.cui, entityPeriodParam),
    };

    return {
      notification,
      data: content,
      metadata: {
        generatedAt: new Date().toISOString(),
        periodKey,
        displayPeriod,
        granularity,
        reportType,
        totals,
      },
    };
  } catch (error: any) {
    console.error(`  Failed to fetch newsletter data for entity ${entity.cui}: ${error.message}`);
    return null;
  }
}

/**
 * Main execution function
 */
async function main() {
  try {
    const options = parseArgs();
    console.log('Newsletter Send Script');
    console.log('=====================');
    console.log(`Type: ${options.type}`);
    console.log(`Dry Run: ${options.dryRun ? 'YES' : 'NO'}`);
    if (options.user) {
      console.log(`User Filter: ${options.user}`);
    }
    console.log();

    // Calculate period key
    const date = options.date ? new Date(options.date) : new Date();
    const periodKey = generatePeriodKey(options.type, date);
    console.log(`Period: ${periodKey}`);
    console.log();

    // 1. Get all active notifications of specified type
    let notifications = await notificationService.getActiveNotificationsByType(options.type);

    // Filter by user if specified
    if (options.user) {
      notifications = notifications.filter((n) => n.userId === options.user);
    }

    console.log(`Found ${notifications.length} active notifications`);
    if (notifications.length === 0) {
      console.log('Nothing to send. Exiting.');
      return;
    }

    // 2. Group by user
    const notificationsByUser = new Map<string, Notification[]>();
    for (const notification of notifications) {
      const existing = notificationsByUser.get(notification.userId) || [];
      existing.push(notification);
      notificationsByUser.set(notification.userId, existing);
    }

    console.log(`Notifications grouped into ${notificationsByUser.size} users`);
    console.log();

    // 3. Fetch user emails from Clerk
    const userIds = Array.from(notificationsByUser.keys());
    const userEmails = await fetchUserEmails(userIds, options.clerkToken);
    console.log();

    // 4. Process each user
    let successCount = 0;
    let skipCount = 0;
    let errorCount = 0;

    for (const [userId, userNotifications] of notificationsByUser.entries()) {
      const userEmail = userEmails[userId];
      if (!userEmail) {
        console.log(`❌ User ${userId}: No email found, skipping`);
        skipCount++;
        continue;
      }

      console.log(`\nProcessing user ${userId} (${userEmail})`);
      console.log(`  ${userNotifications.length} notification(s)`);

      // 5. Check which notifications need to be sent
      const pendingNotifications = [];

      for (const notification of userNotifications) {
        const deliveryKey = generateDeliveryKey(userId, notification.id, periodKey);

        // Check if already delivered
        const alreadySent = await emailService.hasBeenDelivered(deliveryKey);
        if (alreadySent) {
          console.log(`  ⏭️  Notification ${notification.id}: Already sent, skipping`);
          continue;
        }

        // Fetch notification data
        const notificationData = await fetchNotificationData(notification, periodKey);
        if (!notificationData) {
          console.log(`  ⏭️  Notification ${notification.id}: No data or alert not triggered, skipping`);
          continue;
        }

        pendingNotifications.push({
          notification,
          periodKey,
          deliveryKey,
          data: notificationData.data,
          metadata: notificationData.metadata,
        });
      }

      if (pendingNotifications.length === 0) {
        console.log(`  ⏭️  No pending notifications for this user`);
        skipCount++;
        continue;
      }

      // 6. Send batched email
      if (options.dryRun) {
        console.log(`  🔍 DRY RUN: Would send ${pendingNotifications.length} notification(s) in one email`);
        successCount++;
      } else {
        try {
          const emailBatchId = await emailService.sendBatchedNotifications(
            userId,
            userEmail,
            pendingNotifications
          );
          console.log(`  ✅ Sent ${pendingNotifications.length} notification(s) in batch ${emailBatchId}`);
          successCount++;
        } catch (error: any) {
          console.error(`  ❌ Failed to send: ${error.message}`);
          errorCount++;
        }
      }
    }

    // 7. Summary
    console.log();
    console.log('Summary');
    console.log('=======');
    console.log(`✅ Success: ${successCount}`);
    console.log(`⏭️  Skipped: ${skipCount}`);
    console.log(`❌ Errors: ${errorCount}`);
    console.log();

    process.exit(errorCount > 0 ? 1 : 0);
  } catch (error: any) {
    console.error('Fatal error:', error.message);
    process.exit(1);
  }
}

// Run the script
main();
