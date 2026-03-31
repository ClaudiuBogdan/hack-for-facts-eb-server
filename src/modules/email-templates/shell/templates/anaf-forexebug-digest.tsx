/**
 * ANAF / Forexebug Digest Email Template
 *
 * Monthly digest that bundles entity budget reports and alerts into one email.
 * Uses compact card layout with visual distinction between report and alert sections.
 */

import { Hr, Link, Section, Text } from '@react-email/components';
// eslint-disable-next-line @typescript-eslint/naming-convention -- React is a third-party naming standard
import * as React from 'react';

import { CompactMetricRow } from './components/compact-metric-row.js';
import { ConditionDisplay } from './components/condition-display.js';
import { EmailLayout } from './email-layout.js';
import { formatCompactCurrency, formatNumberWithUnit, formatPercentage } from './formatting.js';
import {
  getTranslations,
  interpolate,
  getDigestSummaryBadge,
} from '../../core/i18n.js';

import type {
  AnafForexebugDigestProps,
  AnafForexebugDigestNewsletterSection,
  AnafForexebugDigestAlertSection,
} from '../../core/types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Styles
// ─────────────────────────────────────────────────────────────────────────────

const styles = {
  heading: {
    fontSize: '24px',
    lineHeight: '32px',
    fontWeight: '700',
    color: '#111827',
    margin: '0 0 8px',
  },
  intro: {
    fontSize: '15px',
    lineHeight: '24px',
    color: '#4B5563',
    margin: '0 0 24px',
  },
  summaryBadge: {
    backgroundColor: '#F0F0FF',
    color: '#4F46E5',
    fontSize: '12px',
    fontWeight: '700' as const,
    padding: '6px 16px',
    borderRadius: '16px',
    letterSpacing: '0.3px',
  },
  entityCard: {
    border: '1px solid #E5E7EB',
    borderLeft: '3px solid #4F46E5',
    borderRadius: '10px',
    padding: '18px 20px',
    margin: '0 0 16px',
    backgroundColor: '#FFFFFF',
  },
  alertCard: {
    border: '1px solid #E5E7EB',
    borderLeft: '3px solid #F59E0B',
    borderRadius: '10px',
    padding: '18px 20px',
    margin: '0 0 16px',
    backgroundColor: '#FFFFFF',
  },
  entityLabel: {
    fontSize: '11px',
    lineHeight: '14px',
    fontWeight: '700',
    letterSpacing: '0.08em',
    textTransform: 'uppercase' as const,
    color: '#4F46E5',
    margin: '0 0 8px',
  },
  alertLabel: {
    fontSize: '11px',
    lineHeight: '14px',
    fontWeight: '700',
    letterSpacing: '0.08em',
    textTransform: 'uppercase' as const,
    color: '#92400E',
    margin: '0 0 8px',
  },
  sectionTitle: {
    fontSize: '18px',
    lineHeight: '26px',
    fontWeight: '700',
    color: '#111827',
    margin: '0 0 4px',
  },
  periodText: {
    fontSize: '13px',
    lineHeight: '18px',
    color: '#6B7280',
    margin: '0 0 4px',
  },
  description: {
    fontSize: '14px',
    lineHeight: '22px',
    color: '#4B5563',
    margin: '0 0 12px',
  },
  sectionHr: {
    borderColor: '#E5E7EB',
    margin: '14px 0',
  },
  link: {
    color: '#4F46E5',
    fontSize: '13px',
    fontWeight: '600' as const,
    textDecoration: 'none',
  },
  alertLink: {
    color: '#B45309',
    fontSize: '13px',
    fontWeight: '600' as const,
    textDecoration: 'none',
  },
  topCategoryRow: {
    fontSize: '13px',
    lineHeight: '20px',
    color: '#4B5563',
    margin: '0',
  },
  topCategoryPercent: {
    color: '#8898aa',
    fontSize: '12px',
  },
  conditionsBox: {
    backgroundColor: '#FFFBEB',
    borderRadius: '6px',
    padding: '10px 12px',
    margin: '8px 0 0',
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Section Renderers
// ─────────────────────────────────────────────────────────────────────────────

const DigestEntitySection = ({
  section,
  lang,
  periodKey,
}: {
  section: AnafForexebugDigestNewsletterSection;
  lang: AnafForexebugDigestProps['lang'];
  periodKey: string;
}): React.ReactElement => {
  const t = getTranslations(lang);
  const { summary } = section;

  return (
    <Section
      key={`entity:${section.notificationId}:${periodKey}`}
      style={styles.entityCard}
      className="digest-card"
    >
      {/* Section Label */}
      <Text style={styles.entityLabel}>{t.digest.sections.entityReport}</Text>

      {/* Entity Name */}
      <Text style={styles.sectionTitle}>{section.entityName}</Text>

      {/* Period */}
      <Text style={styles.periodText}>{section.periodLabel}</Text>

      {/* Compact Financial Metrics */}
      <CompactMetricRow
        income={{
          label: t.digest.sections.income,
          value: formatCompactCurrency(summary.totalIncome, summary.currency, lang),
          changePercent: section.previousPeriodComparison?.incomeChangePercent,
        }}
        expenses={{
          label: t.digest.sections.expenses,
          value: formatCompactCurrency(summary.totalExpenses, summary.currency, lang),
          changePercent: section.previousPeriodComparison?.expensesChangePercent,
        }}
        balance={{
          label: t.digest.sections.balance,
          value: formatCompactCurrency(summary.budgetBalance, summary.currency, lang),
          changePercent: section.previousPeriodComparison?.balanceChangePercent,
        }}
        lang={lang}
      />

      {/* Top 3 Categories (compact) */}
      {section.topExpenseCategories !== undefined && section.topExpenseCategories.length > 0 && (
        <>
          <Hr style={styles.sectionHr} />
          <Text
            style={{
              fontSize: '11px',
              fontWeight: '600',
              color: '#8898aa',
              textTransform: 'uppercase' as const,
              letterSpacing: '0.5px',
              margin: '0 0 6px',
            }}
          >
            {t.digest.sections.topCategories}
          </Text>
          <table width="100%" cellPadding="0" cellSpacing="0" border={0}>
            <tbody>
              {section.topExpenseCategories.slice(0, 3).map((cat, i) => (
                <tr key={i}>
                  <td style={{ paddingBottom: '2px' }}>
                    <Text style={styles.topCategoryRow}>
                      {cat.name}{' '}
                      <span style={styles.topCategoryPercent}>
                        {formatPercentage(cat.percentage, lang)}
                      </span>
                    </Text>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {/* View Full Report Link */}
      {section.detailsUrl !== undefined && (
        <>
          <Hr style={styles.sectionHr} />
          <Link href={section.detailsUrl} style={styles.link}>
            {t.digest.sections.viewFullReport}
          </Link>
        </>
      )}
    </Section>
  );
};

const CURRENCY_CODES = new Set(['RON', 'EUR', 'USD']);

const formatAlertValue = (
  value: string,
  unit: string,
  lang: AnafForexebugDigestProps['lang']
): string => {
  if (CURRENCY_CODES.has(unit)) {
    return formatCompactCurrency(value, unit, lang);
  }

  return formatNumberWithUnit(value, unit, lang);
};

const DigestAlertSection = ({
  section,
  lang,
  periodKey,
}: {
  section: AnafForexebugDigestAlertSection;
  lang: AnafForexebugDigestProps['lang'];
  periodKey: string;
}): React.ReactElement => {
  const t = getTranslations(lang);
  const isTriggered = section.triggeredConditions.length > 0;
  const formattedValue = formatAlertValue(section.actualValue, section.unit, lang);

  return (
    <Section
      key={`alert:${section.notificationId}:${periodKey}`}
      style={isTriggered ? styles.alertCard : { ...styles.alertCard, borderLeftColor: '#6B7280' }}
      className="digest-card"
    >
      {/* Title row: title + inline status */}
      <table width="100%" cellPadding="0" cellSpacing="0" border={0}>
        <tbody>
          <tr>
            <td style={{ verticalAlign: 'middle' }}>
              <Text style={{ ...styles.sectionTitle, margin: '0' }}>{section.title}</Text>
            </td>
            <td style={{ verticalAlign: 'middle', textAlign: 'right' as const, whiteSpace: 'nowrap' as const }}>
              <span
                style={
                  isTriggered
                    ? {
                        backgroundColor: '#FEF3C7',
                        color: '#92400E',
                        fontSize: '10px',
                        fontWeight: '700' as const,
                        padding: '3px 8px',
                        borderRadius: '8px',
                        textTransform: 'uppercase' as const,
                        letterSpacing: '0.3px',
                      }
                    : {
                        backgroundColor: '#F0FDF4',
                        color: '#166534',
                        fontSize: '10px',
                        fontWeight: '700' as const,
                        padding: '3px 8px',
                        borderRadius: '8px',
                        textTransform: 'uppercase' as const,
                        letterSpacing: '0.3px',
                      }
                }
              >
                {isTriggered ? '\u26A0\uFE0F' : '\u2713'}{' '}
                {isTriggered ? t.digest.alertStatus.triggered : t.digest.alertStatus.monitoring}
              </span>
            </td>
          </tr>
        </tbody>
      </table>

      {/* Description (smaller, muted) */}
      {section.description !== undefined && (
        <Text style={{ fontSize: '12px', lineHeight: '18px', color: '#9CA3AF', margin: '4px 0 0' }}>
          {section.description}
        </Text>
      )}

      {/* Prominent value display */}
      <table cellPadding="0" cellSpacing="0" border={0} style={{ margin: '12px 0 0' }}>
        <tbody>
          <tr>
            <td>
              <Text style={{ fontSize: '11px', fontWeight: '600' as const, color: '#8898aa', textTransform: 'uppercase' as const, letterSpacing: '0.5px', margin: '0 0 2px', lineHeight: '14px' }}>
                {t.digest.alertStatus.currentValue}
              </Text>
              <Text style={{ fontSize: '20px', fontWeight: '700' as const, color: isTriggered ? '#B45309' : '#111827', margin: '0', lineHeight: '28px' }}>
                {formattedValue}
              </Text>
            </td>
          </tr>
        </tbody>
      </table>

      {/* Triggered conditions (only when triggered) */}
      {isTriggered && (
        <Section style={styles.conditionsBox}>
          <ConditionDisplay
            conditions={section.triggeredConditions}
            lang={lang}
            compact={true}
          />
        </Section>
      )}

      {/* View Source Data Link */}
      {section.dataSourceUrl !== undefined && (
        <>
          <Hr style={styles.sectionHr} />
          <Link href={section.dataSourceUrl} style={isTriggered ? styles.alertLink : styles.link}>
            {t.digest.sections.viewSourceData}
          </Link>
        </>
      )}
    </Section>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

export const AnafForexebugDigestEmail = ({
  lang,
  unsubscribeUrl,
  preferencesUrl,
  platformBaseUrl,
  copyrightYear,
  periodLabel,
  periodKey,
  sections,
}: AnafForexebugDigestProps): React.ReactElement => {
  const t = getTranslations(lang);
  const introText = interpolate(t.digest.body.intro, { period: periodLabel });

  const reportCount = sections.filter((s) => s.kind === 'newsletter_entity').length;
  const alertCount = sections.filter((s) => s.kind === 'alert_series').length;

  return (
    <EmailLayout
      lang={lang}
      previewText={introText}
      unsubscribeUrl={unsubscribeUrl}
      platformBaseUrl={platformBaseUrl}
      copyrightYear={copyrightYear}
      {...(preferencesUrl !== undefined ? { preferencesUrl } : {})}
    >
      {/* Heading */}
      <Text style={styles.heading}>{t.digest.body.heading}</Text>

      {/* Intro */}
      <Text style={styles.intro}>{introText}</Text>

      {/* Summary Badge */}
      <table cellPadding="0" cellSpacing="0" border={0} style={{ margin: '0 auto 24px' }}>
        <tbody>
          <tr>
            <td align="center">
              <table cellPadding="0" cellSpacing="0" border={0}>
                <tbody>
                  <tr>
                    <td style={styles.summaryBadge}>
                      {getDigestSummaryBadge(lang, reportCount, alertCount)}
                    </td>
                  </tr>
                </tbody>
              </table>
            </td>
          </tr>
        </tbody>
      </table>

      {/* Sections */}
      {sections.map((section) => {
        if (section.kind === 'newsletter_entity') {
          return (
            <DigestEntitySection
              key={`entity:${section.notificationId}:${periodKey}`}
              section={section}
              lang={lang}
              periodKey={periodKey}
            />
          );
        }

        return (
          <DigestAlertSection
            key={`alert:${section.notificationId}:${periodKey}`}
            section={section}
            lang={lang}
            periodKey={periodKey}
          />
        );
      })}
    </EmailLayout>
  );
};

export default AnafForexebugDigestEmail;
