/**
 * Entity Header Component
 *
 * Displays entity information with name, type, CUI, location, and population.
 */

import { Section, Text, Row, Column } from '@react-email/components';
// eslint-disable-next-line @typescript-eslint/naming-convention -- React is a third-party naming standard
import * as React from 'react';

import { getTranslations } from '../../../core/i18n.js';

import type { SupportedLanguage } from '../../../core/types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface EntityHeaderProps {
  /** Entity name */
  entityName: string;
  /** Entity CUI */
  entityCui: string;
  /** Entity type (e.g., "Primărie Municipiu") */
  entityType?: string | undefined;
  /** County name */
  countyName?: string | undefined;
  /** Population count */
  population?: number | undefined;
  /** Period label (e.g., "Ianuarie 2025") */
  periodLabel: string;
  /** Language for translations */
  lang: SupportedLanguage;
}

// ─────────────────────────────────────────────────────────────────────────────
// Styles
// ─────────────────────────────────────────────────────────────────────────────

const styles = {
  container: {
    backgroundColor: '#ffffff',
    borderRadius: '8px',
    padding: '24px',
    border: '1px solid #e5e7eb',
    margin: '0 0 24px',
  },
  periodBadge: {
    display: 'inline-block',
    backgroundColor: '#6366f1',
    color: '#ffffff',
    fontSize: '11px',
    fontWeight: '600',
    padding: '4px 12px',
    borderRadius: '12px',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.5px',
    marginBottom: '12px',
  },
  entityName: {
    fontSize: '22px',
    fontWeight: '700',
    color: '#1a1a2e',
    margin: '0 0 8px',
    lineHeight: '1.3',
  },
  entityTypeBadge: {
    display: 'inline-block',
    backgroundColor: '#f6f9fc',
    color: '#525f7f',
    fontSize: '12px',
    fontWeight: '500',
    padding: '4px 10px',
    borderRadius: '4px',
    marginBottom: '16px',
  },
  infoRow: {
    borderTop: '1px solid #e5e7eb',
    paddingTop: '16px',
    marginTop: '16px',
  },
  infoLabel: {
    fontSize: '11px',
    fontWeight: '600',
    color: '#8898aa',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.5px',
    margin: '0 0 4px',
  },
  infoValue: {
    fontSize: '14px',
    fontWeight: '500',
    color: '#1a1a2e',
    margin: '0',
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Formats population with thousands separator.
 */
const formatPopulation = (population: number): string => {
  return new Intl.NumberFormat('ro-RO').format(population);
};

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

export const EntityHeader = ({
  entityName,
  entityCui,
  entityType,
  countyName,
  population,
  periodLabel,
  lang,
}: EntityHeaderProps): React.ReactElement => {
  const t = getTranslations(lang);

  return (
    <Section style={styles.container}>
      {/* Period Badge */}
      <Text style={styles.periodBadge}>{periodLabel}</Text>

      {/* Entity Name */}
      <Text style={styles.entityName}>{entityName}</Text>

      {/* Entity Type Badge */}
      {entityType !== undefined && <Text style={styles.entityTypeBadge}>{entityType}</Text>}

      {/* Info Row */}
      <Row style={styles.infoRow}>
        {/* CUI */}
        <Column style={{ width: '33%' }}>
          <Text style={styles.infoLabel}>{t.newsletter.entityInfo.cui}</Text>
          <Text style={styles.infoValue}>{entityCui}</Text>
        </Column>

        {/* County */}
        {countyName !== undefined && (
          <Column style={{ width: '33%' }}>
            <Text style={styles.infoLabel}>{t.newsletter.entityInfo.county}</Text>
            <Text style={styles.infoValue}>{countyName}</Text>
          </Column>
        )}

        {/* Population */}
        {population !== undefined && (
          <Column style={{ width: '33%' }}>
            <Text style={styles.infoLabel}>{t.newsletter.entityInfo.population}</Text>
            <Text style={styles.infoValue}>
              {formatPopulation(population)} {t.newsletter.entityInfo.populationUnit}
            </Text>
          </Column>
        )}
      </Row>
    </Section>
  );
};

export default EntityHeader;
