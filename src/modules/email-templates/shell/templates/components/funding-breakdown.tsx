/**
 * Funding Breakdown Component
 *
 * Displays funding sources as a horizontal stacked bar with legend.
 */

import { Section, Text, Row, Column } from '@react-email/components';
// eslint-disable-next-line @typescript-eslint/naming-convention -- React is a third-party naming standard
import * as React from 'react';

import { getTranslations } from '../../../core/i18n.js';

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
  barContainer: {
    display: 'flex',
    borderRadius: '6px',
    overflow: 'hidden',
    height: '24px',
    marginBottom: '16px',
  },
  legendItem: {
    display: 'inline-flex',
    alignItems: 'center',
    marginRight: '16px',
    marginBottom: '8px',
  },
  legendDot: {
    width: '12px',
    height: '12px',
    borderRadius: '50%',
    marginRight: '8px',
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
        <tr>
          {sources.map((source, index) => (
            <td
              key={index}
              width={`${source.percentage}%`}
              height="24"
              style={{
                backgroundColor: fundingColors[index % fundingColors.length],
              }}
            />
          ))}
        </tr>
      </table>

      {/* Legend */}
      <Row>
        <Column>
          {sources.map((source, index) => (
            <div
              key={index}
              style={{
                display: 'inline-block',
                marginRight: '20px',
                marginBottom: '8px',
              }}
            >
              <table cellPadding="0" cellSpacing="0" border={0}>
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
                      <span style={styles.percentText}>{source.percentage.toFixed(0)}%</span>
                    </Text>
                  </td>
                </tr>
              </table>
            </div>
          ))}
        </Column>
      </Row>
    </Section>
  );
};

export default FundingBreakdown;
