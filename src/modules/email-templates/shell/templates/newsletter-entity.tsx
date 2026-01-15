/**
 * Newsletter Entity Email Template
 *
 * Email template for entity budget newsletters (monthly, quarterly, yearly).
 * Features a beautiful, information-rich design matching the transparenta.eu client.
 */

import { Section, Text, Button, Row, Column } from '@react-email/components';
// eslint-disable-next-line @typescript-eslint/naming-convention -- React is a third-party naming standard
import * as React from 'react';

import { EmailLayout } from './email-layout.js';
import { EntityHeader } from './components/entity-header.js';
import { MetricCard } from './components/metric-card.js';
import { CategoryList } from './components/category-list.js';
import { FundingBreakdown } from './components/funding-breakdown.js';
import { getTranslations, getNewsletterIntro } from '../../core/i18n.js';

import type { NewsletterEntityProps } from '../../core/types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Styles
// ─────────────────────────────────────────────────────────────────────────────

const styles = {
  greeting: {
    fontSize: '16px',
    lineHeight: '24px',
    color: '#1a1a2e',
    margin: '0 0 16px',
  },
  intro: {
    fontSize: '16px',
    lineHeight: '24px',
    color: '#525f7f',
    margin: '0 0 24px',
  },
  metricsContainer: {
    margin: '0 0 24px',
  },
  button: {
    backgroundColor: '#1a1a2e',
    borderRadius: '4px',
    color: '#ffffff',
    fontSize: '14px',
    fontWeight: '600',
    textDecoration: 'none',
    textAlign: 'center' as const,
    display: 'inline-block',
    padding: '12px 24px',
  },
  secondaryButton: {
    backgroundColor: '#ffffff',
    borderRadius: '4px',
    color: '#1a1a2e',
    fontSize: '14px',
    fontWeight: '600',
    textDecoration: 'none',
    textAlign: 'center' as const,
    display: 'inline-block',
    padding: '12px 24px',
    border: '1px solid #e5e7eb',
  },
  ctaSection: {
    textAlign: 'center' as const,
    margin: '32px 0',
  },
  perCapitaContainer: {
    backgroundColor: '#ffffff',
    borderRadius: '8px',
    padding: '24px',
    border: '1px solid #e5e7eb',
    margin: '0 0 24px',
  },
  perCapitaTitle: {
    fontSize: '14px',
    fontWeight: '600',
    color: '#8898aa',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.5px',
    margin: '0 0 16px',
  },
  perCapitaLabel: {
    fontSize: '12px',
    color: '#8898aa',
    margin: '0 0 4px',
  },
  perCapitaValue: {
    fontSize: '18px',
    fontWeight: '600',
    color: '#1a1a2e',
    margin: '0',
  },
  closing: {
    fontSize: '14px',
    lineHeight: '20px',
    color: '#8898aa',
    margin: '24px 0 0',
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Formats a number as compact currency (e.g., "280,05 mil. RON").
 */
const formatCompactCurrency = (value: number, currency: string): string => {
  if (value >= 1_000_000_000) {
    return `${(value / 1_000_000_000).toFixed(2).replace('.', ',')} mld. ${currency}`;
  }
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(2).replace('.', ',')} mil. ${currency}`;
  }
  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(2).replace('.', ',')} mii ${currency}`;
  }
  return new Intl.NumberFormat('ro-RO', {
    style: 'currency',
    currency,
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(value);
};

/**
 * Formats per capita values.
 */
const formatPerCapita = (value: number, currency: string): string => {
  return new Intl.NumberFormat('ro-RO', {
    style: 'currency',
    currency,
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(value);
};

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

export const NewsletterEntityEmail = ({
  lang,
  unsubscribeUrl,
  preferencesUrl,
  platformBaseUrl,
  entityName,
  entityCui,
  entityType,
  countyName,
  population,
  periodType,
  periodLabel,
  summary,
  previousPeriodComparison,
  topExpenseCategories,
  fundingSources,
  perCapita,
  detailsUrl,
  mapUrl,
}: NewsletterEntityProps): React.ReactElement => {
  const t = getTranslations(lang);
  const previewText = getNewsletterIntro(lang, periodType, entityName, periodLabel);

  const layoutProps = {
    lang,
    previewText,
    unsubscribeUrl,
    platformBaseUrl,
    ...(preferencesUrl !== undefined ? { preferencesUrl } : {}),
  };

  return (
    <EmailLayout {...layoutProps}>
      {/* Greeting */}
      <Text style={styles.greeting}>{t.newsletter.body.greeting}</Text>

      {/* Intro */}
      <Text style={styles.intro}>
        {getNewsletterIntro(lang, periodType, entityName, periodLabel)}
      </Text>

      {/* Entity Header */}
      <EntityHeader
        entityName={entityName}
        entityCui={entityCui}
        entityType={entityType}
        countyName={countyName}
        population={population}
        periodLabel={periodLabel}
        lang={lang}
      />

      {/* Financial Summary - 3 Metric Cards */}
      <Section style={styles.metricsContainer}>
        <Row>
          {/* Income Card */}
          <Column style={{ width: '33%', padding: '0 6px 0 0' }}>
            <MetricCard
              type="income"
              label={t.newsletter.body.income}
              value={formatCompactCurrency(summary.totalIncome, summary.currency)}
              changePercent={previousPeriodComparison?.incomeChangePercent}
              lang={lang}
            />
          </Column>

          {/* Expenses Card */}
          <Column style={{ width: '33%', padding: '0 3px' }}>
            <MetricCard
              type="expenses"
              label={t.newsletter.body.expenses}
              value={formatCompactCurrency(summary.totalExpenses, summary.currency)}
              changePercent={previousPeriodComparison?.expensesChangePercent}
              lang={lang}
            />
          </Column>

          {/* Balance Card */}
          <Column style={{ width: '33%', padding: '0 0 0 6px' }}>
            <MetricCard
              type="balance"
              label={t.newsletter.body.balance}
              value={formatCompactCurrency(summary.budgetBalance, summary.currency)}
              changePercent={previousPeriodComparison?.balanceChangePercent}
              lang={lang}
            />
          </Column>
        </Row>
      </Section>

      {/* Top Spending Categories */}
      {topExpenseCategories !== undefined && topExpenseCategories.length > 0 && (
        <CategoryList categories={topExpenseCategories} currency={summary.currency} lang={lang} />
      )}

      {/* Funding Sources */}
      {fundingSources !== undefined && fundingSources.length > 0 && (
        <FundingBreakdown sources={fundingSources} lang={lang} />
      )}

      {/* Per Capita Metrics */}
      {perCapita !== undefined && (
        <Section style={styles.perCapitaContainer}>
          <Text style={styles.perCapitaTitle}>{t.newsletter.perCapita.title}</Text>
          <Row>
            <Column style={{ width: '50%' }}>
              <Text style={styles.perCapitaLabel}>{t.newsletter.perCapita.income}</Text>
              <Text style={{ ...styles.perCapitaValue, color: '#10b981' }}>
                {formatPerCapita(perCapita.income, summary.currency)}
              </Text>
            </Column>
            <Column style={{ width: '50%' }}>
              <Text style={styles.perCapitaLabel}>{t.newsletter.perCapita.expenses}</Text>
              <Text style={{ ...styles.perCapitaValue, color: '#f43f5e' }}>
                {formatPerCapita(perCapita.expenses, summary.currency)}
              </Text>
            </Column>
          </Row>
        </Section>
      )}

      {/* CTA Buttons */}
      <Section style={styles.ctaSection}>
        {detailsUrl !== undefined && (
          <Button href={detailsUrl} style={styles.button}>
            {t.newsletter.body.viewFullReport}
          </Button>
        )}
        {mapUrl !== undefined && (
          <>
            {'  '}
            <Button href={mapUrl} style={styles.secondaryButton}>
              {t.newsletter.cta.viewOnMap}
            </Button>
          </>
        )}
      </Section>

      {/* Closing */}
      <Text style={styles.closing}>{t.newsletter.body.closing}</Text>
    </EmailLayout>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// Preview Props (for React Email dev server)
// ─────────────────────────────────────────────────────────────────────────────

NewsletterEntityEmail.PreviewProps = {
  lang: 'ro',
  unsubscribeUrl: 'https://transparenta.eu/api/v1/notifications/unsubscribe/abc123',
  preferencesUrl: 'https://transparenta.eu/notifications/preferences',
  platformBaseUrl: 'https://transparenta.eu',
  templateType: 'newsletter_entity',

  // Entity Info
  entityName: 'Municipiul Sibiu',
  entityCui: '4240600',
  entityType: 'Primărie Municipiu',
  countyName: 'Sibiu',
  population: 147245,

  // Period
  periodType: 'monthly',
  periodLabel: 'Ianuarie 2025',

  // Financial Summary
  summary: {
    totalIncome: 280050000,
    totalExpenses: 182370000,
    budgetBalance: 97680000,
    currency: 'RON',
  },

  // Period Comparison
  previousPeriodComparison: {
    incomeChangePercent: 12.3,
    expensesChangePercent: 8.7,
    balanceChangePercent: 23.1,
  },

  // Top Spending Categories
  topExpenseCategories: [
    { name: 'Învățământ', amount: 45200000, percentage: 24.8 },
    { name: 'Sănătate', amount: 32100000, percentage: 17.6 },
    { name: 'Administrație publică', amount: 25800000, percentage: 14.1 },
    { name: 'Cultură și recreere', amount: 18300000, percentage: 10.0 },
    { name: 'Transport public', amount: 15200000, percentage: 8.3 },
  ],

  // Funding Sources
  fundingSources: [
    { name: 'Buget local', percentage: 65 },
    { name: 'Buget de stat', percentage: 25 },
    { name: 'Fonduri UE', percentage: 10 },
  ],

  // Per Capita
  perCapita: {
    income: 1902,
    expenses: 1238,
  },

  // Links
  detailsUrl: 'https://transparenta.eu/entities/4240600?period=2025-01',
  mapUrl: 'https://transparenta.eu/map?entity=4240600',
} as NewsletterEntityProps;

export default NewsletterEntityEmail;
