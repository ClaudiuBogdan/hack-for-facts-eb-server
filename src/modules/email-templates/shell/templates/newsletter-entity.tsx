/**
 * Newsletter Entity Email Template
 *
 * Email template for entity budget newsletters (monthly, quarterly, yearly).
 * Features a beautiful, information-rich design matching the transparenta.eu client.
 */

import { Section, Text, Button, Row, Column } from '@react-email/components';
// eslint-disable-next-line @typescript-eslint/naming-convention -- React is a third-party naming standard
import * as React from 'react';

import { CategoryList } from './components/category-list.js';
import { EntityHeader } from './components/entity-header.js';
import { FundingBreakdown } from './components/funding-breakdown.js';
import { MetricCard } from './components/metric-card.js';
import { EmailLayout } from './email-layout.js';
import { formatCompactCurrency, formatCurrency } from './formatting.js';
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
    backgroundColor: '#4F46E5',
    borderRadius: '8px',
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
    borderRadius: '8px',
    color: '#4F46E5',
    fontSize: '14px',
    fontWeight: '600',
    textDecoration: 'none',
    textAlign: 'center' as const,
    display: 'inline-block',
    padding: '12px 24px',
    border: '1px solid #4F46E5',
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

export const NewsletterEntityEmail = ({
  lang,
  unsubscribeUrl,
  preferencesUrl,
  platformBaseUrl,
  copyrightYear,
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
    copyrightYear,
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
              value={formatCompactCurrency(summary.totalIncome, summary.currency, lang)}
              changePercent={previousPeriodComparison?.incomeChangePercent}
              lang={lang}
            />
          </Column>

          {/* Expenses Card */}
          <Column style={{ width: '33%', padding: '0 3px' }}>
            <MetricCard
              type="expenses"
              label={t.newsletter.body.expenses}
              value={formatCompactCurrency(summary.totalExpenses, summary.currency, lang)}
              changePercent={previousPeriodComparison?.expensesChangePercent}
              lang={lang}
            />
          </Column>

          {/* Balance Card */}
          <Column style={{ width: '33%', padding: '0 0 0 6px' }}>
            <MetricCard
              type="balance"
              label={t.newsletter.body.balance}
              value={formatCompactCurrency(summary.budgetBalance, summary.currency, lang)}
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
          <table width="100%" cellPadding="0" cellSpacing="0" border={0}>
            <tbody>
              <tr>
                {/* Income per capita */}
                <td style={{ width: '50%', verticalAlign: 'top' }}>
                  <table cellPadding="0" cellSpacing="0" border={0}>
                    <tbody>
                      <tr>
                        <td style={{ verticalAlign: 'middle', paddingRight: '12px' }}>
                          <table
                            width="36"
                            cellPadding="0"
                            cellSpacing="0"
                            border={0}
                            style={{ borderRadius: '50%', backgroundColor: '#10b98115' }}
                          >
                            <tbody>
                              <tr>
                                <td
                                  align="center"
                                  valign="middle"
                                  height="36"
                                  style={{ fontSize: '16px', color: '#10b981' }}
                                >
                                  {'\u2197'}
                                </td>
                              </tr>
                            </tbody>
                          </table>
                        </td>
                        <td style={{ verticalAlign: 'middle' }}>
                          <Text style={styles.perCapitaLabel}>{t.newsletter.perCapita.income}</Text>
                          <Text style={{ ...styles.perCapitaValue, color: '#10b981' }}>
                            {formatCurrency(perCapita.income, summary.currency, lang)}
                          </Text>
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </td>
                {/* Expenses per capita */}
                <td style={{ width: '50%', verticalAlign: 'top' }}>
                  <table cellPadding="0" cellSpacing="0" border={0}>
                    <tbody>
                      <tr>
                        <td style={{ verticalAlign: 'middle', paddingRight: '12px' }}>
                          <table
                            width="36"
                            cellPadding="0"
                            cellSpacing="0"
                            border={0}
                            style={{ borderRadius: '50%', backgroundColor: '#f43f5e15' }}
                          >
                            <tbody>
                              <tr>
                                <td
                                  align="center"
                                  valign="middle"
                                  height="36"
                                  style={{ fontSize: '16px', color: '#f43f5e' }}
                                >
                                  {'\u2198'}
                                </td>
                              </tr>
                            </tbody>
                          </table>
                        </td>
                        <td style={{ verticalAlign: 'middle' }}>
                          <Text style={styles.perCapitaLabel}>{t.newsletter.perCapita.expenses}</Text>
                          <Text style={{ ...styles.perCapitaValue, color: '#f43f5e' }}>
                            {formatCurrency(perCapita.expenses, summary.currency, lang)}
                          </Text>
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </td>
              </tr>
            </tbody>
          </table>
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
  preferencesUrl: 'https://transparenta.eu/settings/notifications',
  platformBaseUrl: 'https://transparenta.eu',
  copyrightYear: 2025,
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
    totalIncome: '280050000',
    totalExpenses: '182370000',
    budgetBalance: '97680000',
    currency: 'RON',
  },

  // Period Comparison
  previousPeriodComparison: {
    incomeChangePercent: '12.3',
    expensesChangePercent: '8.7',
    balanceChangePercent: '23.1',
  },

  // Top Spending Categories
  topExpenseCategories: [
    { name: 'Învățământ', amount: '45200000', percentage: '24.8' },
    { name: 'Sănătate', amount: '32100000', percentage: '17.6' },
    { name: 'Administrație publică', amount: '25800000', percentage: '14.1' },
    { name: 'Cultură și recreere', amount: '18300000', percentage: '10.0' },
    { name: 'Transport public', amount: '15200000', percentage: '8.3' },
  ],

  // Funding Sources
  fundingSources: [
    { name: 'Buget local', percentage: '65' },
    { name: 'Buget de stat', percentage: '25' },
    { name: 'Fonduri UE', percentage: '10' },
  ],

  // Per Capita
  perCapita: {
    income: '1902',
    expenses: '1238',
  },

  // Links
  detailsUrl: 'https://transparenta.eu/entities/4240600?period=2025-01',
  mapUrl: 'https://transparenta.eu/map?entity=4240600',
} as NewsletterEntityProps;

export default NewsletterEntityEmail;
