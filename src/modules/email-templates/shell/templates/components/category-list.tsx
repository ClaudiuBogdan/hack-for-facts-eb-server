/**
 * Category List Component
 *
 * Displays top spending categories with progress bars and amounts.
 */

import { Section, Text, Row, Column } from '@react-email/components';
// eslint-disable-next-line @typescript-eslint/naming-convention -- React is a third-party naming standard
import * as React from 'react';

import { ProgressBar } from './progress-bar.js';
import { getTranslations } from '../../../core/i18n.js';
import { formatCompactCurrency, formatPercentage } from '../formatting.js';

import type { TopExpenseCategory, SupportedLanguage } from '../../../core/types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface CategoryListProps {
  /** List of expense categories to display */
  categories: TopExpenseCategory[];
  /** Currency code for formatting */
  currency: string;
  /** Language for translations */
  lang: SupportedLanguage;
}

// ─────────────────────────────────────────────────────────────────────────────
// Styles
// ─────────────────────────────────────────────────────────────────────────────

const categoryColors = [
  '#6366f1', // Indigo
  '#8b5cf6', // Purple
  '#a855f7', // Violet
  '#d946ef', // Fuchsia
  '#ec4899', // Pink
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
  categoryRow: {
    marginBottom: '16px',
  },
  categoryName: {
    fontSize: '14px',
    fontWeight: '500',
    color: '#1a1a2e',
    margin: '0 0 4px',
  },
  categoryDetails: {
    fontSize: '12px',
    color: '#8898aa',
    margin: '4px 0 0',
  },
  amountText: {
    fontWeight: '600',
    color: '#525f7f',
  },
  percentText: {
    color: '#8898aa',
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

export const CategoryList = ({
  categories,
  currency,
  lang,
}: CategoryListProps): React.ReactElement => {
  const t = getTranslations(lang);

  return (
    <Section style={styles.container}>
      <Text style={styles.title}>{t.newsletter.categories.title}</Text>

      {categories.map((category, index) => (
        <Row key={index} style={styles.categoryRow}>
          <Column>
            {/* Category Name */}
            <Text style={styles.categoryName}>
              {index + 1}. {category.name}
            </Text>

            {/* Progress Bar */}
            <table width="100%" cellPadding="0" cellSpacing="0" border={0}>
              <tbody>
                <tr>
                  <td style={{ padding: '8px 0' }}>
                    <ProgressBar
                      percentage={category.percentage}
                      color={categoryColors[index % categoryColors.length] ?? '#6366f1'}
                    />
                  </td>
                </tr>
              </tbody>
            </table>

            {/* Amount and Percentage */}
            <Text style={styles.categoryDetails}>
              <span style={styles.amountText}>
                {formatCompactCurrency(category.amount, currency, lang)}
              </span>
              {' · '}
              <span style={styles.percentText}>
                {formatPercentage(category.percentage, lang)} {t.newsletter.categories.ofTotal}
              </span>
            </Text>
          </Column>
        </Row>
      ))}
    </Section>
  );
};

export default CategoryList;
