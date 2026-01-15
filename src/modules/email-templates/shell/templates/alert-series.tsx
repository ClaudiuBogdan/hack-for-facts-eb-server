/**
 * Alert Series Email Template
 *
 * Email template for alert notifications when conditions are triggered.
 */

import { Section, Text, Button, Row, Column } from '@react-email/components';
// eslint-disable-next-line @typescript-eslint/naming-convention -- React is a third-party naming standard
import * as React from 'react';

import { EmailLayout } from './email-layout.js';
import { getTranslations, getOperatorLabel } from '../../core/i18n.js';

import type { AlertSeriesProps, TriggeredCondition } from '../../core/types.js';

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
  title: {
    fontSize: '20px',
    fontWeight: '600',
    color: '#1a1a2e',
    margin: '0 0 8px',
  },
  description: {
    fontSize: '16px',
    lineHeight: '24px',
    color: '#525f7f',
    margin: '0 0 24px',
  },
  intro: {
    fontSize: '16px',
    lineHeight: '24px',
    color: '#525f7f',
    margin: '0 0 24px',
  },
  conditionsBox: {
    backgroundColor: '#fff8e6',
    borderRadius: '8px',
    borderLeft: '4px solid #f5a623',
    padding: '16px 24px',
    margin: '0 0 24px',
  },
  conditionsTitle: {
    fontSize: '14px',
    fontWeight: '600',
    color: '#8898aa',
    textTransform: 'uppercase' as const,
    letterSpacing: '1px',
    margin: '0 0 16px',
  },
  conditionRow: {
    marginBottom: '12px',
  },
  conditionText: {
    fontSize: '14px',
    color: '#525f7f',
    margin: '0',
    lineHeight: '20px',
  },
  conditionValue: {
    fontWeight: '600',
    color: '#1a1a2e',
  },
  conditionActual: {
    fontSize: '12px',
    color: '#8898aa',
    margin: '4px 0 0',
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
 * Formats a number with locale-specific formatting.
 */
const formatNumber = (value: number, unit: string): string => {
  const formatted = new Intl.NumberFormat('ro-RO', {
    maximumFractionDigits: 2,
  }).format(value);
  return `${formatted} ${unit}`;
};

/**
 * Renders a single condition.
 */
const renderCondition = (
  condition: TriggeredCondition,
  lang: AlertSeriesProps['lang'],
  index: number
): React.ReactNode => {
  const operatorLabel = getOperatorLabel(lang, condition.operator);

  return (
    <Row key={index} style={styles.conditionRow}>
      <Column>
        <Text style={styles.conditionText}>
          Valoare{' '}
          <span style={styles.conditionValue}>
            {operatorLabel} {formatNumber(condition.threshold, condition.unit)}
          </span>
        </Text>
        <Text style={styles.conditionActual}>
          Valoare reală: {formatNumber(condition.actualValue, condition.unit)}
        </Text>
      </Column>
    </Row>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

export const AlertSeriesEmail = ({
  lang,
  unsubscribeUrl,
  preferencesUrl,
  platformBaseUrl,
  title,
  description,
  triggeredConditions,
  dataSourceUrl,
}: AlertSeriesProps): React.ReactElement => {
  const t = getTranslations(lang);
  const previewText = `${t.alert.body.greeting} ${title}`;

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
      <Text style={styles.greeting}>{t.alert.body.greeting}</Text>

      {/* Title */}
      <Text style={styles.title}>{title}</Text>

      {/* Description (if provided) */}
      {description !== undefined && <Text style={styles.description}>{description}</Text>}

      {/* Intro */}
      <Text style={styles.intro}>{t.alert.body.intro}</Text>

      {/* Conditions Box */}
      <Section style={styles.conditionsBox}>
        <Text style={styles.conditionsTitle}>{t.alert.body.conditionsTitle}</Text>
        {triggeredConditions.map((condition, index) =>
          renderCondition(condition, lang, index)
        )}
      </Section>

      {/* CTA Button */}
      {dataSourceUrl !== undefined && (
        <Section style={{ textAlign: 'center', margin: '24px 0' }}>
          <Button href={dataSourceUrl} style={styles.button}>
            {t.alert.body.viewData}
          </Button>
        </Section>
      )}

      {/* Closing */}
      <Text style={styles.closing}>{t.alert.body.closing}</Text>
    </EmailLayout>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// Preview Props (for React Email dev server)
// ─────────────────────────────────────────────────────────────────────────────

AlertSeriesEmail.PreviewProps = {
  lang: 'ro',
  unsubscribeUrl: 'https://transparenta.eu/api/v1/notifications/unsubscribe/abc123',
  preferencesUrl: 'https://transparenta.eu/notifications/preferences',
  platformBaseUrl: 'https://transparenta.eu',
  templateType: 'alert_series',
  title: 'Alertă: Cheltuieli neobișnuite detectate',
  description: 'Au fost detectate cheltuieli care depășesc pragurile normale pentru această entitate.',
  triggeredConditions: [
    {
      operator: 'gt',
      threshold: 1000000,
      actualValue: 1500000,
      unit: 'RON',
    },
    {
      operator: 'gte',
      threshold: 50,
      actualValue: 75,
      unit: '%',
    },
  ],
  dataSourceUrl: 'https://transparenta.eu/entities/4267117/analytics',
} as AlertSeriesProps;

export default AlertSeriesEmail;
