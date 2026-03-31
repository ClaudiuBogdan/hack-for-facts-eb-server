/**
 * Funding Breakdown Component
 *
 * Displays funding sources as a horizontal stacked bar with legend.
 */

import { Section, Text } from '@react-email/components';
// eslint-disable-next-line @typescript-eslint/naming-convention -- React is a third-party naming standard
import * as React from 'react';

import { getTranslations } from '../../../core/i18n.js';
import { clampPercentage, formatPercentage } from '../formatting.js';

import type { FundingSourceBreakdown, SupportedLanguage } from '../../../core/types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface FundingBreakdownProps {
  /** List of funding sources to display */
  sources: FundingSourceBreakdown[];
  /** Language for translations */
  lang: SupportedLanguage;
}

// ─────────────────────────────────────────────────────────────────────────────
// Styles
// ─────────────────────────────────────────────────────────────────────────────

const fundingColors = [
  '#10b981', // Teal (Buget local)
  '#6366f1', // Indigo (Buget de stat)
  '#f59e0b', // Amber (Fonduri UE)
  '#ec4899', // Pink (Alte surse)
  '#8b5cf6', // Purple (Extra)
];

const styles = {
  container: {
    backgroundColor: '#ffffff',
    borderRadius: '8px',
    padding: '24px',
    border: '1px solid #e5e7eb',
    margin: '0 0 24px',
  },
  title: {
    fontSize: '14px',
    fontWeight: '600',
    color: '#8898aa',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.5px',
    margin: '0 0 20px',
  },
  legendText: {
    fontSize: '13px',
    color: '#525f7f',
    margin: '0',
  },
  percentText: {
    fontWeight: '600',
    color: '#1a1a2e',
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

export const FundingBreakdown = ({
  sources,
  lang,
}: FundingBreakdownProps): React.ReactElement => {
  const t = getTranslations(lang);

  return (
    <Section style={styles.container}>
      <Text style={styles.title}>{t.newsletter.funding.title}</Text>

      {/* Stacked Bar - Using table for email compatibility */}
      <table
        width="100%"
        cellPadding="0"
        cellSpacing="0"
        border={0}
        style={{
          borderRadius: '6px',
          overflow: 'hidden',
          marginBottom: '16px',
        }}
      >
        <tbody>
          <tr>
            {sources.map((source, index) => (
              <td
                key={index}
                width={`${String(clampPercentage(source.percentage))}%`}
                height="24"
                style={{
                  backgroundColor: fundingColors[index % fundingColors.length],
                }}
              />
            ))}
          </tr>
        </tbody>
      </table>

      {/* Legend */}
      <table width="100%" cellPadding="0" cellSpacing="0" border={0}>
        <tbody>
          <tr>
            {sources.map((source, index) => (
              <td key={index} style={{ paddingRight: '20px', paddingBottom: '8px' }}>
                <table cellPadding="0" cellSpacing="0" border={0}>
                  <tbody>
                    <tr>
                      <td
                        width="12"
                        height="12"
                        style={{
                          backgroundColor: fundingColors[index % fundingColors.length],
                          borderRadius: '50%',
                        }}
                      />
                      <td style={{ paddingLeft: '8px' }}>
                        <Text style={styles.legendText}>
                          {source.name}{' '}
                          <span style={styles.percentText}>
                            {formatPercentage(source.percentage, lang, 0)}
                          </span>
                        </Text>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </td>
            ))}
          </tr>
        </tbody>
      </table>
    </Section>
  );
};

export default FundingBreakdown;
