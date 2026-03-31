/**
 * Alert Series Email Template
 *
 * Email template for alert notifications when conditions are triggered.
 */

import { Section, Text, Button } from '@react-email/components';
// eslint-disable-next-line @typescript-eslint/naming-convention -- React is a third-party naming standard
import * as React from 'react';

import { ConditionDisplay } from './components/condition-display.js';
import { EmailLayout } from './email-layout.js';
import { getTranslations } from '../../core/i18n.js';

import type { AlertSeriesProps } from '../../core/types.js';

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
  closing: {
    fontSize: '14px',
    lineHeight: '20px',
    color: '#8898aa',
    margin: '24px 0 0',
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

export const AlertSeriesEmail = ({
  lang,
  unsubscribeUrl,
  preferencesUrl,
  platformBaseUrl,
  copyrightYear,
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
    copyrightYear,
    ...(preferencesUrl !== undefined ? { preferencesUrl } : {}),
  };

  return (
    <EmailLayout {...layoutProps}>
      {/* Urgency Badge */}
      <table cellPadding="0" cellSpacing="0" border={0} style={{ margin: '0 0 16px' }}>
        <tbody>
          <tr>
            <td
              style={{
                backgroundColor: '#FEF3C7',
                color: '#92400E',
                fontSize: '11px',
                fontWeight: '700',
                padding: '5px 14px',
                borderRadius: '12px',
                textTransform: 'uppercase' as const,
                letterSpacing: '0.5px',
              }}
            >
              {'\u26A0\uFE0F'} {t.alert.body.conditionsTitle}
            </td>
          </tr>
        </tbody>
      </table>

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
        <ConditionDisplay conditions={triggeredConditions} lang={lang} />
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
  preferencesUrl: 'https://transparenta.eu/settings/notifications',
  platformBaseUrl: 'https://transparenta.eu',
  copyrightYear: 2026,
  templateType: 'alert_series',
  title: 'Alertă: Cheltuieli neobișnuite detectate',
  description: 'Au fost detectate cheltuieli care depășesc pragurile normale pentru această entitate.',
  triggeredConditions: [
    {
      operator: 'gt',
      threshold: '1000000',
      actualValue: '1500000',
      unit: 'RON',
    },
    {
      operator: 'gte',
      threshold: '50',
      actualValue: '75',
      unit: '%',
    },
  ],
  dataSourceUrl: 'https://transparenta.eu/entities/4267117/analytics',
} as AlertSeriesProps;

export default AlertSeriesEmail;
