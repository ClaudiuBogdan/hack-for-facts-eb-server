/**
 * Compact Metric Row Component
 *
 * A horizontal 3-metric display (income/expenses/balance) for digest emails.
 * Uses email-safe tables for maximum client compatibility.
 */

import { Text } from '@react-email/components';
// eslint-disable-next-line @typescript-eslint/naming-convention -- React is a third-party naming standard
import * as React from 'react';

import { formatAbsolutePercentage } from '../formatting.js';
import { getMetricChangeArrow, getMetricChangeColor } from './metric-change.js';

import type { DecimalString, SupportedLanguage } from '../../../core/types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface CompactMetric {
  /** Metric label (e.g., "Venituri") */
  label: string;
  /** Pre-formatted value string (e.g., "280,05 mil. RON") */
  value: string;
  /** Change percentage vs previous period */
  changePercent?: DecimalString | undefined;
}

export interface CompactMetricRowProps {
  income: CompactMetric;
  expenses: CompactMetric;
  balance: CompactMetric;
  lang: SupportedLanguage;
}

// ─────────────────────────────────────────────────────────────────────────────
// Styles
// ─────────────────────────────────────────────────────────────────────────────

const colors = {
  income: '#10b981',
  expenses: '#f43f5e',
  balance: '#6366f1',
};

const styles = {
  label: {
    fontSize: '11px',
    fontWeight: '600' as const,
    color: '#8898aa',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.5px',
    margin: '0 0 4px',
    lineHeight: '14px',
  },
  value: {
    fontSize: '15px',
    fontWeight: '700' as const,
    margin: '0',
    lineHeight: '20px',
  },
  change: {
    fontSize: '11px',
    fontWeight: '600' as const,
    margin: '2px 0 0',
    lineHeight: '14px',
  },
};

const MetricCell = ({
  metric,
  color,
  metricType,
  lang,
}: {
  metric: CompactMetric;
  color: string;
  metricType: 'income' | 'expenses' | 'balance';
  lang: SupportedLanguage;
}): React.ReactElement => (
  <td style={{ width: '33%', padding: '0 4px', verticalAlign: 'top' }}>
    <Text style={styles.label}>{metric.label}</Text>
    <Text style={{ ...styles.value, color }}>{metric.value}</Text>
    {metric.changePercent !== undefined && (
      <Text
        style={{
          ...styles.change,
          color: getMetricChangeColor(metricType, metric.changePercent),
        }}
      >
        {getMetricChangeArrow(metric.changePercent)}{' '}
        {formatAbsolutePercentage(metric.changePercent, lang)}
      </Text>
    )}
  </td>
);

export const CompactMetricRow = ({
  income,
  expenses,
  balance,
  lang,
}: CompactMetricRowProps): React.ReactElement => (
  <table
    width="100%"
    cellPadding="0"
    cellSpacing="0"
    border={0}
    style={{ margin: '12px 0 0' }}
  >
    <tbody>
      <tr>
        <MetricCell metric={income} color={colors.income} metricType="income" lang={lang} />
        <MetricCell metric={expenses} color={colors.expenses} metricType="expenses" lang={lang} />
        <MetricCell metric={balance} color={colors.balance} metricType="balance" lang={lang} />
      </tr>
    </tbody>
  </table>
);

export default CompactMetricRow;
