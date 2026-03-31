/**
 * Metric Card Component
 *
 * A reusable card for displaying financial metrics with icon, value, and change indicator.
 */

import { Section, Text, Row, Column } from '@react-email/components';
// eslint-disable-next-line @typescript-eslint/naming-convention -- React is a third-party naming standard
import * as React from 'react';

import { getTranslations } from '../../../core/i18n.js';
import { formatAbsolutePercentage } from '../formatting.js';
import {
  getMetricChangeArrow,
  getMetricChangeBackgroundColor,
  getMetricChangeColor,
} from './metric-change.js';

import type { DecimalString, SupportedLanguage } from '../../../core/types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type MetricType = 'income' | 'expenses' | 'balance';

export interface MetricCardProps {
  /** Metric type determines color and icon */
  type: MetricType;
  /** Label text */
  label: string;
  /** Formatted value (e.g., "280,05 mil. RON") */
  value: string;
  /** Change percentage vs previous period */
  changePercent?: DecimalString | undefined;
  /** Language for translations */
  lang: SupportedLanguage;
}

// ─────────────────────────────────────────────────────────────────────────────
// Styles
// ─────────────────────────────────────────────────────────────────────────────

const colors = {
  income: '#10b981', // Teal-500 (green)
  expenses: '#f43f5e', // Rose-500 (red)
  balance: '#6366f1', // Indigo-500 (blue)
};

const styles = {
  card: {
    backgroundColor: '#ffffff',
    borderRadius: '8px',
    padding: '20px',
    textAlign: 'center' as const,
    border: '1px solid #e5e7eb',
  },
  iconContainer: {
    width: '48px',
    height: '48px',
    borderRadius: '50%',
    margin: '0 auto 12px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  label: {
    fontSize: '12px',
    fontWeight: '600',
    color: '#8898aa',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.5px',
    margin: '0 0 8px',
  },
  value: {
    fontSize: '24px',
    fontWeight: '700',
    color: '#1a1a2e',
    margin: '0 0 8px',
    lineHeight: '1.2',
  },
  changeContainer: {
    display: 'inline-block',
    padding: '4px 8px',
    borderRadius: '4px',
    fontSize: '12px',
    fontWeight: '600',
  },
};

export const MetricCard = ({
  type,
  label,
  value,
  changePercent,
  lang,
}: MetricCardProps): React.ReactElement => {
  const t = getTranslations(lang);
  const color = colors[type];
  const hasChange = changePercent !== undefined;

  return (
    <Section style={styles.card}>
      {/* Icon Circle */}
      <table
        width="48"
        cellPadding="0"
        cellSpacing="0"
        border={0}
        style={{
          margin: '0 auto 12px',
          borderRadius: '50%',
          backgroundColor: `${color}15`,
        }}
      >
        <tbody>
          <tr>
            <td
              align="center"
              valign="middle"
              height="48"
              style={{
                fontSize: '20px',
                color: color,
              }}
            >
              {type === 'income' && '↗'}
              {type === 'expenses' && '↘'}
              {type === 'balance' && '⚖'}
            </td>
          </tr>
        </tbody>
      </table>

      {/* Label */}
      <Text style={styles.label}>{label}</Text>

      {/* Value */}
      <Text style={{ ...styles.value, color: color }}>{value}</Text>

      {/* Change Indicator */}
      {hasChange && (
        <Row>
          <Column>
            <Text
              style={{
                ...styles.changeContainer,
                color: getMetricChangeColor(type, changePercent),
                backgroundColor: getMetricChangeBackgroundColor(type, changePercent),
                margin: '0',
              }}
            >
              {getMetricChangeArrow(changePercent)} {formatAbsolutePercentage(changePercent, lang)}{' '}
              {t.newsletter.change.vsLastPeriod}
            </Text>
          </Column>
        </Row>
      )}
    </Section>
  );
};

export default MetricCard;
