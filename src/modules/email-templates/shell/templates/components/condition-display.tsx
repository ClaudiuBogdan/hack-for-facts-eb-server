/**
 * Condition Display Component
 *
 * Renders triggered alert conditions in an email-safe table layout.
 * Shared by both alert-series and digest templates.
 */

import { Text } from '@react-email/components';
// eslint-disable-next-line @typescript-eslint/naming-convention -- React is a third-party naming standard
import * as React from 'react';

import { getOperatorLabel, getTranslations } from '../../../core/i18n.js';
import { formatNumberWithUnit } from '../formatting.js';

import type { TriggeredCondition, SupportedLanguage } from '../../../core/types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface ConditionDisplayProps {
  /** Alert conditions to display */
  conditions: TriggeredCondition[];
  /** Language for translations */
  lang: SupportedLanguage;
  /** Whether to use compact styling (for digest) */
  compact?: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Styles
// ─────────────────────────────────────────────────────────────────────────────

const styles = {
  conditionText: {
    fontSize: '14px',
    color: '#525f7f',
    margin: '0',
    lineHeight: '20px',
  },
  conditionValue: {
    fontWeight: '600' as const,
    color: '#1a1a2e',
  },
  conditionActual: {
    fontSize: '12px',
    color: '#8898aa',
    margin: '4px 0 0',
    lineHeight: '16px',
  },
  compactText: {
    fontSize: '13px',
    color: '#525f7f',
    margin: '0',
    lineHeight: '18px',
  },
  compactActual: {
    fontSize: '11px',
    color: '#8898aa',
    margin: '2px 0 0',
    lineHeight: '14px',
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

export const ConditionDisplay = ({
  conditions,
  lang,
  compact = false,
}: ConditionDisplayProps): React.ReactElement => {
  const t = getTranslations(lang);
  const thresholdLabel = t.alert.condition.threshold;
  const actualLabel = t.alert.condition.actualValue;

  const textStyle = compact ? styles.compactText : styles.conditionText;
  const actualStyle = compact ? styles.compactActual : styles.conditionActual;

  return (
    <table width="100%" cellPadding="0" cellSpacing="0" border={0}>
      <tbody>
        {conditions.map((condition, index) => (
          <tr key={index}>
            <td style={{ paddingBottom: index < conditions.length - 1 ? '12px' : '0' }}>
              <Text style={textStyle}>
                {thresholdLabel}{' '}
                <span style={styles.conditionValue}>
                  {getOperatorLabel(lang, condition.operator)}{' '}
                  {formatNumberWithUnit(condition.threshold, condition.unit, lang)}
                </span>
              </Text>
              <Text style={actualStyle}>
                {actualLabel}: {formatNumberWithUnit(condition.actualValue, condition.unit, lang)}
              </Text>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
};

export default ConditionDisplay;
