import { Button, Link, Section, Text } from '@react-email/components';
// eslint-disable-next-line @typescript-eslint/naming-convention -- React is a third-party naming standard
import * as React from 'react';

import { CampaignHeader } from './components/campaign-header.js';
import { EmailLayout } from './email-layout.js';

import type { BucharestBudgetAnalysisProps } from '../../core/types.js';

const TEMPLATE_DATA = {
  entityName: 'Primăria Municipiului București',
  analysisUrl: 'https://funky.ong/analiza-buget-local-primaria-municipiului-bucuresti-2026/',
  platformUrl: 'https://transparenta.eu/primarie/4267117',
  budgetTotalLabel: '12,88 miliarde lei',
  localBudgetLabel: '8,49 miliarde lei',
  localBudgetGrowthLabel: '+45,2%',
  transportHeatingShareLabel: '56,7%',
  transportHeatingAmountLabel: '4,82 miliarde lei',
  debateDateLabel: '30 aprilie 2026',
  debateTime: '10:00',
  debateLocation: 'Sala de Consiliu a Primăriei Generale a Municipiului București',
  highlights: [
    {
      title: 'Bani în plus, dar nu din merit propriu',
      body:
        'Creșterea vine în principal din cotele și sumele defalcate din impozitul pe venit, ca efect al aplicării parțiale a referendumului local din 2024.',
    },
    {
      title: 'Transportul și termoficarea domină bugetul',
      body:
        'Transportul rutier și energia termică absorb 4,82 miliarde lei, peste jumătate din bugetul local, în mare parte prin subvenții operaționale.',
    },
    {
      title: 'Bugetul a fost publicat ca PDF scanat',
      body:
        'Formatul face analiza automată mult mai dificilă. Pentru un buget de peste 12 miliarde lei, accesul real la date ar trebui să fie mai bun.',
    },
  ],
} as const;

const styles = {
  eyebrow: {
    fontSize: '12px',
    lineHeight: '18px',
    fontWeight: '700',
    color: '#B45309',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.08em',
    margin: '0 0 8px',
  },
  title: {
    fontSize: '24px',
    lineHeight: '32px',
    fontWeight: '800',
    color: '#111827',
    margin: '0 0 12px',
  },
  intro: {
    fontSize: '16px',
    lineHeight: '26px',
    color: '#374151',
    margin: '0',
  },
  body: {
    fontSize: '15px',
    lineHeight: '26px',
    color: '#4B5563',
    margin: '0 0 16px',
  },
  metaTable: {
    width: '100%',
    borderCollapse: 'collapse' as const,
    margin: '18px 0 0',
  },
  metaCell: {
    verticalAlign: 'top' as const,
    padding: '0 10px 0 0',
  },
  metaLabel: {
    fontSize: '11px',
    lineHeight: '16px',
    fontWeight: '700',
    color: '#6B7280',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.06em',
    margin: '0 0 2px',
  },
  metaValue: {
    fontSize: '14px',
    lineHeight: '22px',
    fontWeight: '700',
    color: '#111827',
    margin: '0',
  },
  heroPanel: {
    border: '1px solid #FED7AA',
    borderTop: '5px solid #D97706',
    borderRadius: '8px',
    backgroundColor: '#FFFBEB',
    padding: '24px',
    margin: '24px 0',
  },
  sectionTitle: {
    fontSize: '17px',
    lineHeight: '26px',
    fontWeight: '700',
    color: '#111827',
    margin: '0 0 12px',
  },
  statGrid: {
    width: '100%',
    borderCollapse: 'collapse' as const,
    margin: '10px 0 0',
  },
  statCellLeft: {
    width: '50%',
    verticalAlign: 'top' as const,
    padding: '0 8px 14px 0',
  },
  statCellRight: {
    width: '50%',
    verticalAlign: 'top' as const,
    padding: '0 0 14px 8px',
  },
  statBox: {
    border: '1px solid #E5E7EB',
    borderRadius: '8px',
    backgroundColor: '#FFFFFF',
    padding: '14px',
  },
  statLabel: {
    fontSize: '11px',
    lineHeight: '16px',
    fontWeight: '700',
    color: '#92400E',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.06em',
    margin: '0 0 4px',
  },
  statValue: {
    fontSize: '20px',
    lineHeight: '28px',
    fontWeight: '800',
    color: '#111827',
    margin: '0 0 4px',
  },
  statValueCompact: {
    fontSize: '18px',
    lineHeight: '26px',
    fontWeight: '800',
    color: '#111827',
    margin: '0 0 4px',
  },
  statDetail: {
    fontSize: '12px',
    lineHeight: '18px',
    color: '#6B7280',
    margin: '0',
  },
  highlightSection: {
    margin: '24px 0',
  },
  highlightTable: {
    width: '100%',
    borderCollapse: 'collapse' as const,
  },
  highlightNumberCell: {
    width: '34px',
    verticalAlign: 'top' as const,
    padding: '2px 12px 16px 0',
  },
  highlightNumber: {
    width: '28px',
    height: '28px',
    borderRadius: '14px',
    backgroundColor: '#111827',
  },
  highlightNumberText: {
    fontSize: '13px',
    lineHeight: '28px',
    fontWeight: '700',
    color: '#FFFFFF',
    textAlign: 'center' as const,
  },
  highlightContentCell: {
    verticalAlign: 'top' as const,
    padding: '0 0 16px',
  },
  highlightTitle: {
    fontSize: '15px',
    lineHeight: '24px',
    fontWeight: '700',
    color: '#111827',
    margin: '0 0 4px',
  },
  highlightBody: {
    fontSize: '14px',
    lineHeight: '24px',
    color: '#4B5563',
    margin: '0 0 16px',
  },
  debatePanel: {
    border: '1px solid #BFDBFE',
    borderRadius: '8px',
    backgroundColor: '#EFF6FF',
    padding: '18px',
    margin: '24px 0',
  },
  debateTitle: {
    fontSize: '15px',
    lineHeight: '24px',
    fontWeight: '700',
    color: '#111827',
    margin: '0 0 8px',
  },
  smallNote: {
    fontSize: '13px',
    lineHeight: '22px',
    color: '#4B5563',
    margin: '0',
  },
  ctaSection: {
    margin: '28px 0 24px',
    textAlign: 'center' as const,
  },
  button: {
    backgroundColor: '#3565c4',
    borderRadius: '8px',
    color: '#ffffff',
    fontSize: '15px',
    fontWeight: '600',
    textDecoration: 'none',
    textAlign: 'center' as const,
    display: 'inline-block',
    padding: '14px 32px',
  },
  link: {
    color: '#3565c4',
    textDecoration: 'underline',
  },
  signature: {
    fontSize: '15px',
    lineHeight: '26px',
    fontWeight: '700',
    color: '#111827',
    margin: '0',
  },
};

const StatBox = ({
  label,
  value,
  detail,
  compactValue = false,
}: {
  label: string;
  value: string;
  detail: string;
  compactValue?: boolean;
}): React.ReactElement => (
  <div style={styles.statBox}>
    <Text style={styles.statLabel}>{label}</Text>
    <Text style={compactValue ? styles.statValueCompact : styles.statValue}>{value}</Text>
    <Text style={styles.statDetail}>{detail}</Text>
  </div>
);

export const getBucharestBudgetAnalysisSubject = (
  _props: BucharestBudgetAnalysisProps
): string => {
  return 'Analiza Funky: bugetul 2026 pentru Primăria Municipiului București';
};

export const BucharestBudgetAnalysisEmail = (
  props: BucharestBudgetAnalysisProps
): React.ReactElement => {
  return (
    <EmailLayout
      lang={props.lang}
      previewText="Am publicat analiza bugetului PMB 2026 pentru abonații la București"
      unsubscribeUrl={props.unsubscribeUrl}
      platformBaseUrl={props.platformBaseUrl}
      copyrightYear={props.copyrightYear}
      header={<CampaignHeader />}
      {...(props.preferencesUrl !== undefined ? { preferencesUrl: props.preferencesUrl } : {})}
    >
      <Section style={styles.heroPanel}>
        <Text style={styles.eyebrow}>Analiza Funky Citizens pentru București</Text>
        <Text style={styles.title}>Bugetul PMB 2026, pe scurt</Text>
        <Text style={styles.intro}>
          Am publicat analiza proiectului de buget al Primăriei Municipiului București. Mai jos
          sunt cifrele care merită urmărite înainte de dezbaterea publică.
        </Text>
        <table cellPadding="0" cellSpacing="0" border={0} style={styles.metaTable}>
          <tbody>
            <tr>
              <td style={styles.metaCell}>
                <Text style={styles.metaLabel}>Instituție</Text>
                <Text style={styles.metaValue}>{TEMPLATE_DATA.entityName}</Text>
              </td>
            </tr>
          </tbody>
        </table>
      </Section>

      <Section>
        <Text style={styles.sectionTitle}>Indicatorii-cheie</Text>
        <table cellPadding="0" cellSpacing="0" border={0} style={styles.statGrid}>
          <tbody>
            <tr>
              <td style={styles.statCellLeft}>
                <StatBox
                  label="Buget general"
                  value={TEMPLATE_DATA.budgetTotalLabel}
                  detail="Venituri și cheltuieli estimate în bugetul general centralizat."
                />
              </td>
              <td style={styles.statCellRight}>
                <StatBox
                  label="Buget local PMB"
                  value={TEMPLATE_DATA.localBudgetLabel}
                  detail="Sume gestionate direct de Primăria Capitalei."
                />
              </td>
            </tr>
            <tr>
              <td style={styles.statCellLeft}>
                <StatBox
                  label="Creștere locală"
                  value={TEMPLATE_DATA.localBudgetGrowthLabel}
                  detail="Cheltuieli locale propuse față de execuția reală din 2025."
                />
              </td>
              <td style={styles.statCellRight}>
                <StatBox
                  label="Transport + termoficare"
                  value={TEMPLATE_DATA.transportHeatingShareLabel}
                  detail={`${TEMPLATE_DATA.transportHeatingAmountLabel} pentru transportul rutier și energia termică.`}
                  compactValue
                />
              </td>
            </tr>
          </tbody>
        </table>
      </Section>

      <Section style={styles.highlightSection}>
        <Text style={styles.sectionTitle}>Ce am urmărit în analiză</Text>
        <table cellPadding="0" cellSpacing="0" border={0} style={styles.highlightTable}>
          <tbody>
            {TEMPLATE_DATA.highlights.map((highlight, index) => (
              <tr key={highlight.title}>
                <td style={styles.highlightNumberCell}>
                  <table cellPadding="0" cellSpacing="0" border={0} style={styles.highlightNumber}>
                    <tbody>
                      <tr>
                        <td style={styles.highlightNumberText}>{String(index + 1)}</td>
                      </tr>
                    </tbody>
                  </table>
                </td>
                <td style={styles.highlightContentCell}>
                  <Text style={styles.highlightTitle}>{highlight.title}</Text>
                  <Text style={styles.highlightBody}>{highlight.body}</Text>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      <Section style={styles.debatePanel}>
        <Text style={styles.debateTitle}>Dezbaterea publică anunțată de PMB</Text>
        <Text style={styles.body}>
          {TEMPLATE_DATA.debateDateLabel}, ora {TEMPLATE_DATA.debateTime}, la{' '}
          {TEMPLATE_DATA.debateLocation}.
        </Text>
        <Text style={styles.smallNote}>
          Analiza completă explică de ce întrebarea importantă nu este doar cât de mare este
          bugetul, ci cât din el poate fi realizat.
        </Text>
      </Section>

      <Section style={styles.ctaSection}>
        <Button href={TEMPLATE_DATA.analysisUrl} style={styles.button}>
          Citește analiza completă
        </Button>
      </Section>

      <Text style={styles.body}>
        Poți vedea și pagina Bucureștiului în platformă{' '}
        <Link href={TEMPLATE_DATA.platformUrl} style={styles.link}>
          aici
        </Link>
        .
      </Text>

      <Text style={styles.body}>
        Ai primit această notificare pentru că urmărești actualizările despre București pe
        Transparenta.eu. Poți modifica oricând localitățile urmărite din pagina de preferințe
        pentru notificări.
      </Text>
      <Text style={styles.signature}>Echipa Funky & Transparenta.eu</Text>
    </EmailLayout>
  );
};

export default BucharestBudgetAnalysisEmail;
