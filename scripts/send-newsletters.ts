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
 *   ts-node scripts/send-newsletters.ts --type alert_data_series --clerk-token <token>
 *
 * Options:
 *   --type: Notification type to send (optional; if omitted, sends all types in one email per user)
 *   --clerk-token: Clerk admin token for email lookup (required)
 *   --user: Send only to specific user ID (optional, for testing)
 *   --dry-run: Simulate sending without actually sending emails
 *   --date: ISO date string for period calculation (defaults to today)
 */

import { notificationService } from '../src/services/notifications/notificationService';
import { emailService } from '../src/services/notifications/emailService';
import type { EntityNewsletterContent as EntityNewsletterEmailContent, SeriesAlertEmailContent } from '../src/services/notifications/emailTypes';
import type { NotificationType, Notification } from '../src/services/notifications/types';
import { generateDeliveryKey, generatePeriodKey } from '../src/services/notifications/types';
import { entityRepository, executionLineItemRepository } from '../src/db/repositories';
import { aggregatedLineItemsRepository } from '../src/db/repositories/aggregatedLineItemsRepository';
import type {
  ReportPeriodInput,
  ReportPeriodType,
  YearMonthPeriod,
  YearQuarterPeriod,
  YearPeriod,
  AnalyticsFilter,
} from '../src/types';

// Clerk admin SDK for email lookup
import { createClerkClient } from '@clerk/backend';

interface CLIOptions {
  type?: NotificationType;
  clerkToken: string;
  user?: string;
  dryRun?: boolean;
  date?: string;
}

interface UserEmailMap {
  [userId: string]: string;
}

// Use shared email content payload types
type EntityNewsletterContent = EntityNewsletterEmailContent;
type DataSeriesAlertContent = SeriesAlertEmailContent;

interface NotificationData<TContent = unknown> {
  notification: Notification;
  data: TContent;
  metadata?: Record<string, unknown>;
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

function prevMonth(year: number, month: number): { year: number; month: number } {
  const d = new Date(Date.UTC(year, month - 1, 1));
  d.setUTCMonth(d.getUTCMonth() - 1);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 };
}

function prevQuarter(year: number, quarter: number): { year: number; quarter: number } {
  const prev = quarter === 1 ? { year: year - 1, quarter: 4 } : { year, quarter: quarter - 1 };
  return prev;
}

function getLastNMonths(endYear: number, endMonth: number, n: number): string[] {
  const months: string[] = [];
  let y = endYear;
  let m = endMonth;
  for (let i = 0; i < n; i++) {
    months.unshift(`${y}-${String(m).padStart(2, '0')}`);
    const prev = prevMonth(y, m);
    y = prev.year; m = prev.month;
  }
  return months;
}

function getLastNQuarters(endYear: number, endQuarter: number, n: number): string[] {
  const quarters: string[] = [];
  let y = endYear;
  let q = endQuarter;
  for (let i = 0; i < n; i++) {
    quarters.unshift(`${y}-Q${q}`);
    const prev = prevQuarter(y, q);
    y = prev.year; q = prev.quarter;
  }
  return quarters;
}

function getLastNYears(endYear: number, n: number): string[] {
  const years: string[] = [];
  for (let i = n - 1; i >= 0; i--) years.push(String(endYear - i));
  return years;
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

// (removed) legacy analytics alert data fetcher replaced by provider registry

/**
 * Fetch notification data based on type
 * This is where you'd call your analytics/data repositories
 */
async function fetchNotificationData(
  notification: Notification,
  periodKey: string
): Promise<NotificationData<EntityNewsletterContent | DataSeriesAlertContent> | null> {
  console.log(`  Fetching data for notification ${notification.id} (${notification.notificationType})`);

  // Handle series alerts via provider registry
  if (notification.notificationType === 'alert_series_analytics' || notification.notificationType === 'alert_series_static') {
    const { fetchNotificationSeries } = await import('../src/services/notifications/providers/registry');

    const result = await fetchNotificationSeries(notification, periodKey);
    if (!result) return null;

    const cfg = notification.config as { title?: string; description?: string; conditions?: Array<{ operator: 'gt' | 'gte' | 'lt' | 'lte' | 'eq'; threshold: number; unit?: string }> } | null;
    const conditions: Array<{ operator: 'gt' | 'gte' | 'lt' | 'lte' | 'eq'; threshold: number; unit?: string }> = Array.isArray(cfg?.conditions) ? cfg!.conditions : [];
    const last = result.series.data[result.series.data.length - 1];
    if (conditions.length > 0 && last) {
      const matchAll = conditions.every((c) => {
        switch (c.operator) {
          case 'gt': return last.y > c.threshold;
          case 'gte': return last.y >= c.threshold;
          case 'lt': return last.y < c.threshold;
          case 'lte': return last.y <= c.threshold;
          case 'eq': return last.y === c.threshold;
        }
      });
      if (!matchAll) return null;
    }

    const prevAbs = result.metadata?.comparisons?.prev?.abs;
    const prevPct = result.metadata?.comparisons?.prev?.pct;
    const selectedThreshold = Array.isArray(cfg?.conditions) && cfg!.conditions.length > 0 ? cfg!.conditions[0].threshold : undefined;

    const content: DataSeriesAlertContent = {
      alertTitle: cfg?.title,
      alertMessage: cfg?.description,
      details: {
        currentValue: result.metadata?.current?.y,
        threshold: selectedThreshold,
        difference: typeof prevAbs === 'number' ? prevAbs : undefined,
        percentChange: typeof prevPct === 'number' ? Number(prevPct.toFixed(2)) : undefined,
      },
      periodKey,
      // entityUrl could be a deep link to chart; omitted for now
      series: { xAxis: { unit: result.series.xAxis.unit }, yAxis: { unit: result.series.yAxis.unit } },
      comparisons: result.metadata?.comparisons,
      stats: result.metadata?.stats,
      conditions: result.metadata?.conditions,
    };

    return {
      notification,
      data: content,
      metadata: {
        generatedAt: new Date().toISOString(),
        periodKey,
        seriesDataPointCount: result.series.data.length,
        ...result.metadata,
      },
    };
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

  // Resolve entity and report type upfront for use in all branches
  const entity = await entityRepository.getById(notification.entityCui);
  if (!entity) {
    console.warn(`  Entity ${notification.entityCui} not found – skipping notification ${notification.id}`);
    return null;
  }

  const reportType =
    entity.default_report_type ??
    'Executie bugetara agregata la nivel de ordonator principal';

  let reportPeriod: ReportPeriodInput | null = null;
  let displayPeriod: string | null = null;
  let entityPeriodParam: string | null = null;
  let granularity: ReportPeriodType | null = null;

  // Values optionally computed per granularity for later use
  let prevTotals: { totalExpenses: number; totalIncome: number; budgetBalance: number } | null | undefined;
  let yoyTotals: { totalExpenses: number; totalIncome: number; budgetBalance: number } | null | undefined;
  let trend: Array<{ x: string; y: number }> | undefined;
  let topFunctional: Array<{ code: string; name?: string; amount: number }> | undefined;
  let topEconomic: Array<{ code: string; name?: string; amount: number }> | undefined;

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
      // Comparisons: previous month and YoY
      const prev = prevMonth(parsed.year, parsed.month);
      try {
        prevTotals = await executionLineItemRepository.getPeriodSnapshotTotals(
          entity.cui,
          buildMonthlyPeriodInput(prev.year, prev.month),
          reportType
        );
      } catch { }
      const yoyMonth = { year: parsed.year - 1, month: parsed.month };
      try {
        yoyTotals = await executionLineItemRepository.getPeriodSnapshotTotals(
          entity.cui,
          buildMonthlyPeriodInput(yoyMonth.year, yoyMonth.month),
          reportType
        );
      } catch { }
      // Trend: last 12 months
      const lastMonths = getLastNMonths(parsed.year, parsed.month, 12);
      const monthlyTrend = await executionLineItemRepository.getMonthlyTrend({
        account_category: 'ch',
        report_type: reportType,
        report_period: { type: 'MONTH', selection: { dates: lastMonths.map(d => d as YearMonthPeriod) } },
        entity_cuis: [entity.cui],
      });
      trend = monthlyTrend.map(p => ({ x: `${p.year}-${String(p.month).padStart(2, '0')}`, y: p.value }));
      // Top categories (expenses)
      const aggFilter: AnalyticsFilter = {
        report_period: reportPeriod!,
        account_category: 'ch',
        report_type: reportType,
        entity_cuis: [entity.cui],
      };
      const agg = await aggregatedLineItemsRepository.getAggregatedLineItems(aggFilter, 250, 0);
      const byFunctional = new Map<string, { code: string; name?: string; amount: number }>();
      const byEconomic = new Map<string, { code: string; name?: string; amount: number }>();
      for (const row of agg.rows) {
        const fKey = row.functional_code;
        const f = byFunctional.get(fKey) || { code: fKey, name: row.functional_name || undefined, amount: 0 };
        f.amount += row.amount; byFunctional.set(fKey, f);
        const eKey = row.economic_code;
        const e = byEconomic.get(eKey) || { code: eKey, name: row.economic_name || undefined, amount: 0 };
        e.amount += row.amount; byEconomic.set(eKey, e);
      }
      topFunctional = Array.from(byFunctional.values()).sort((a, b) => b.amount - a.amount).slice(0, 3);
      topEconomic = Array.from(byEconomic.values()).sort((a, b) => b.amount - a.amount).slice(0, 3);
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
      // Comparisons: previous quarter and YoY
      const prev = prevQuarter(parsed.year, parsed.quarter);
      try {
        prevTotals = await executionLineItemRepository.getPeriodSnapshotTotals(
          entity.cui,
          buildQuarterPeriodInput(prev.year, prev.quarter),
          reportType
        );
      } catch { }
      const yoyQuarter = { year: parsed.year - 1, quarter: parsed.quarter };
      try {
        yoyTotals = await executionLineItemRepository.getPeriodSnapshotTotals(
          entity.cui,
          buildQuarterPeriodInput(yoyQuarter.year, yoyQuarter.quarter),
          reportType
        );
      } catch { }
      // Trend: last 8 quarters
      const lastQuarters = getLastNQuarters(parsed.year, parsed.quarter, 8);
      const quarterlyTrend = await executionLineItemRepository.getQuarterlyTrend({
        account_category: 'ch',
        report_type: reportType,
        report_period: { type: 'QUARTER', selection: { dates: lastQuarters.map(d => d as YearQuarterPeriod) } },
        entity_cuis: [entity.cui],
      });
      trend = quarterlyTrend.map(p => ({ x: `${p.year}-Q${p.quarter}`, y: p.value }));
      // Top categories (expenses)
      const aggFilter: AnalyticsFilter = {
        report_period: reportPeriod!,
        account_category: 'ch',
        report_type: reportType,
        entity_cuis: [entity.cui],
      };
      const agg = await aggregatedLineItemsRepository.getAggregatedLineItems(aggFilter, 250, 0);
      const byFunctional = new Map<string, { code: string; name?: string; amount: number }>();
      const byEconomic = new Map<string, { code: string; name?: string; amount: number }>();
      for (const row of agg.rows) {
        const fKey = row.functional_code;
        const f = byFunctional.get(fKey) || { code: fKey, name: row.functional_name || undefined, amount: 0 };
        f.amount += row.amount; byFunctional.set(fKey, f);
        const eKey = row.economic_code;
        const e = byEconomic.get(eKey) || { code: eKey, name: row.economic_name || undefined, amount: 0 };
        e.amount += row.amount; byEconomic.set(eKey, e);
      }
      topFunctional = Array.from(byFunctional.values()).sort((a, b) => b.amount - a.amount).slice(0, 3);
      topEconomic = Array.from(byEconomic.values()).sort((a, b) => b.amount - a.amount).slice(0, 3);
      break;
    }
    case 'newsletter_entity_yearly': {
      const parsed = parseAnnualPeriodKey(periodKey);
      if (!parsed) {
        console.warn(`  Period key "${periodKey}" is invalid – skipping notification ${notification.id}`);
        return null;
      }
      granularity = 'YEAR';
      reportPeriod = buildAnnualPeriodInput(parsed.year);
      displayPeriod = formatYearLabel(parsed.year);
      entityPeriodParam = `${parsed.year}`;
      // Comparisons: previous year only
      try {
        prevTotals = await executionLineItemRepository.getPeriodSnapshotTotals(
          entity.cui,
          buildAnnualPeriodInput(parsed.year - 1),
          reportType
        );
      } catch { }
      yoyTotals = prevTotals;
      // Trend: last 5 years
      const lastYears = getLastNYears(parsed.year, 5);
      const yearlyTrend = await executionLineItemRepository.getYearlyTrend({
        account_category: 'ch',
        report_type: reportType,
        report_period: { type: 'YEAR', selection: { dates: lastYears.map(d => d as YearPeriod) } },
        entity_cuis: [entity.cui],
      });
      trend = yearlyTrend.map(p => ({ x: String(p.year), y: p.value }));
      // Top categories (expenses)
      const aggFilter: AnalyticsFilter = {
        report_period: reportPeriod!,
        account_category: 'ch',
        report_type: reportType,
        entity_cuis: [entity.cui],
      };
      const agg = await aggregatedLineItemsRepository.getAggregatedLineItems(aggFilter, 250, 0);
      const byFunctional = new Map<string, { code: string; name?: string; amount: number }>();
      const byEconomic = new Map<string, { code: string; name?: string; amount: number }>();
      for (const row of agg.rows) {
        const fKey = row.functional_code;
        const f = byFunctional.get(fKey) || { code: fKey, name: row.functional_name || undefined, amount: 0 };
        f.amount += row.amount; byFunctional.set(fKey, f);
        const eKey = row.economic_code;
        const e = byEconomic.get(eKey) || { code: eKey, name: row.economic_name || undefined, amount: 0 };
        e.amount += row.amount; byEconomic.set(eKey, e);
      }
      topFunctional = Array.from(byFunctional.values()).sort((a, b) => b.amount - a.amount).slice(0, 3);
      topEconomic = Array.from(byEconomic.values()).sort((a, b) => b.amount - a.amount).slice(0, 3);
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

  try {

    const totals = await executionLineItemRepository.getPeriodSnapshotTotals(
      entity.cui,
      reportPeriod,
      reportType
    );

    const executionRate = calculateExecutionRate(totals.totalIncome, totals.totalExpenses);

    // Build comparisons if available
    let comparisons: EntityNewsletterContent['comparisons'] | undefined = undefined;
    if (typeof prevTotals !== 'undefined' || typeof yoyTotals !== 'undefined') {
      comparisons = {};
      if (prevTotals) {
        const expAbs = totals.totalExpenses - prevTotals.totalExpenses;
        const incAbs = totals.totalIncome - prevTotals.totalIncome;
        const expPct = prevTotals.totalExpenses ? (expAbs / prevTotals.totalExpenses) * 100 : undefined;
        const incPct = prevTotals.totalIncome ? (incAbs / prevTotals.totalIncome) * 100 : undefined;
        comparisons.vsPrevious = { expensesAbs: expAbs, expensesPct: expPct, incomeAbs: incAbs, incomePct: incPct };
      }
      if (yoyTotals) {
        const expAbs = totals.totalExpenses - yoyTotals.totalExpenses;
        const incAbs = totals.totalIncome - yoyTotals.totalIncome;
        const expPct = yoyTotals.totalExpenses ? (expAbs / yoyTotals.totalExpenses) * 100 : undefined;
        const incPct = yoyTotals.totalIncome ? (incAbs / yoyTotals.totalIncome) * 100 : undefined;
        comparisons.vsYoY = { expensesAbs: expAbs, expensesPct: expPct, incomeAbs: incAbs, incomePct: incPct };
      }
    }

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
      comparisons,
      topFunctional,
      topEconomic,
      trend,
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
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`  Failed to fetch newsletter data for entity ${entity.cui}: ${msg}`);
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
    console.log(`Type: ${options.type ?? 'all'}`);
    console.log(`Dry Run: ${options.dryRun ? 'YES' : 'NO'}`);
    if (options.user) {
      console.log(`User Filter: ${options.user}`);
    }
    console.log();

    // Base date (per-notification periodKey will be computed later)
    const date = options.date ? new Date(options.date) : new Date();
    if (options.type) {
      const periodKey = generatePeriodKey(options.type, date);
      console.log(`Period: ${periodKey}`);
    } else {
      console.log(`Periods: per-notification (base date ${date.toISOString().slice(0,10)})`);
    }
    console.log();

    // 1. Get active notifications (all or by type)
    let notifications: Notification[] = [];
    if (options.type) {
      notifications = await notificationService.getActiveNotificationsByType(options.type);
    } else {
      const ALL_TYPES: NotificationType[] = [
        'newsletter_entity_monthly',
        'newsletter_entity_quarterly',
        'newsletter_entity_yearly',
        'alert_series_analytics',
        'alert_series_static',
      ];
      for (const t of ALL_TYPES) {
        const list = await notificationService.getActiveNotificationsByType(t);
        if (list.length) notifications.push(...list);
      }
    }

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

      console.log(`\nProcessing user ${userId}`);
      console.log(`  ${userNotifications.length} notification(s)`);

      // 5. Check which notifications need to be sent
      const pendingNotifications = [];

      for (const notification of userNotifications) {
        const nPeriodKey = generatePeriodKey(notification.notificationType as NotificationType, date);
        const deliveryKey = generateDeliveryKey(userId, notification.id, nPeriodKey);

        // Check if already delivered
        const alreadySent = await emailService.hasBeenDelivered(deliveryKey);
        if (alreadySent) {
          console.log(`  ⏭️  Notification ${notification.id}: Already sent, skipping`);
          continue;
        }

        // Fetch notification data
        const notificationData = await fetchNotificationData(notification, nPeriodKey);
        if (!notificationData) {
          console.log(`  ⏭️  Notification ${notification.id}: No data or alert not triggered, skipping`);
          continue;
        }

        pendingNotifications.push({
          notification,
          periodKey: nPeriodKey,
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
        } catch (error: unknown) {
          const msg = error instanceof Error ? error.message : String(error);
          console.error(`  ❌ Failed to send: ${msg}`);
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
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error('Fatal error:', msg);
    process.exit(1);
  }
}

// Run the script
main();
