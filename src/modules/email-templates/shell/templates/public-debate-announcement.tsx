import { Button, Link, Section, Text } from '@react-email/components';
// eslint-disable-next-line @typescript-eslint/naming-convention -- React is a third-party naming standard
import * as React from 'react';

import { CampaignHeader } from './components/campaign-header.js';
import { EmailLayout } from './email-layout.js';
import { formatTemplateDate } from './formatting.js';

import type { PublicDebateAnnouncementProps } from '../../core/types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Styles
// ─────────────────────────────────────────────────────────────────────────────

const styles = {
  greeting: {
    fontSize: '16px',
    lineHeight: '26px',
    fontWeight: '700',
    color: '#111827',
    margin: '0 0 16px',
  },
  body: {
    fontSize: '15px',
    lineHeight: '26px',
    color: '#4B5563',
    margin: '0 0 16px',
  },
  panel: {
    border: '1px solid #E5E7EB',
    borderLeft: '3px solid #4F46E5',
    borderRadius: '10px',
    backgroundColor: '#ffffff',
    padding: '20px',
    margin: '24px 0',
  },
  infoRowTable: {
    width: '100%',
    borderCollapse: 'collapse' as const,
  },
  infoIconCell: {
    width: '36px',
    verticalAlign: 'top' as const,
    paddingRight: '12px',
  },
  infoIconCircle: {
    width: '28px',
    height: '28px',
    borderRadius: '50%',
    backgroundColor: '#EEF2FF',
  },
  infoIconText: {
    fontSize: '14px',
    lineHeight: '28px',
    textAlign: 'center' as const,
  },
  infoContentCell: {
    verticalAlign: 'top' as const,
  },
  infoLabel: {
    fontSize: '11px',
    lineHeight: '16px',
    fontWeight: '700',
    color: '#6B7280',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.06em',
    margin: '0 0 4px',
  },
  infoValue: {
    fontSize: '15px',
    lineHeight: '22px',
    color: '#111827',
    margin: '0',
  },
  infoDivider: {
    borderTop: '1px solid #F3F4F6',
    margin: '12px 0',
  },
  description: {
    fontSize: '14px',
    lineHeight: '24px',
    color: '#374151',
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

// ─────────────────────────────────────────────────────────────────────────────
// Components
// ─────────────────────────────────────────────────────────────────────────────

interface InfoRowProps {
  icon: string;
  label: string;
  value: React.ReactNode;
  isLast?: boolean;
}

const renderMultilineText = (value: string): React.ReactNode => {
  const lines = value.replaceAll('\r\n', '\n').split('\n');

  return lines.map((line, index) => (
    <React.Fragment key={`announcement-line-${index.toString()}`}>
      {line}
      {index < lines.length - 1 ? <br /> : null}
    </React.Fragment>
  ));
};

const InfoRow = ({ icon, label, value, isLast = false }: InfoRowProps): React.ReactElement => (
  <>
    <table cellPadding="0" cellSpacing="0" border={0} style={styles.infoRowTable}>
      <tbody>
        <tr>
          <td style={styles.infoIconCell}>
            <table cellPadding="0" cellSpacing="0" border={0} style={styles.infoIconCircle}>
              <tbody>
                <tr>
                  <td style={styles.infoIconText}>{icon}</td>
                </tr>
              </tbody>
            </table>
          </td>
          <td style={styles.infoContentCell}>
            <Text style={styles.infoLabel}>{label}</Text>
            <Text style={styles.infoValue}>{value}</Text>
          </td>
        </tr>
      </tbody>
    </table>
    {!isLast && <div style={styles.infoDivider} />}
  </>
);

// ─────────────────────────────────────────────────────────────────────────────
// Template
// ─────────────────────────────────────────────────────────────────────────────

export const getPublicDebateAnnouncementSubject = (
  props: Pick<PublicDebateAnnouncementProps, 'entityName' | 'date' | 'time'>
): string => {
  return `Anunț de dezbatere publică: ${props.entityName} pe ${formatTemplateDate(props.date)} la ${props.time}`;
};

export const PublicDebateAnnouncementEmail = (
  props: PublicDebateAnnouncementProps
): React.ReactElement => {
  const trimmedDescription = props.description?.trim();
  const formattedDate = formatTemplateDate(props.date);

  return (
    <EmailLayout
      lang={props.lang}
      previewText={`Anunț de dezbatere publică pentru ${props.entityName}`}
      unsubscribeUrl={props.unsubscribeUrl}
      platformBaseUrl={props.platformBaseUrl}
      copyrightYear={props.copyrightYear}
      header={<CampaignHeader />}
      {...(props.preferencesUrl !== undefined ? { preferencesUrl: props.preferencesUrl } : {})}
    >
      <Text style={styles.greeting}>A fost publicat un anunț de dezbatere publică.</Text>
      <Text style={styles.body}>
        {props.entityName} a publicat un anunț de dezbatere publică. Mai jos găsești detaliile
        principale.
      </Text>

      <Section style={styles.panel}>
        <InfoRow icon="📍" label="Localitate" value={props.entityName} />
        <InfoRow icon="📅" label="Data" value={formattedDate} />
        <InfoRow icon="🕐" label="Ora" value={props.time} />
        <InfoRow icon="📍" label="Locație" value={props.location} />
        {props.onlineParticipationLink !== undefined ? (
          <InfoRow
            icon="💻"
            label="Participare online"
            value={
              <Link href={props.onlineParticipationLink} style={styles.link}>
                Participă online
              </Link>
            }
          />
        ) : null}
        <InfoRow
          icon="🔗"
          label="Anunț"
          value={
            <Link href={props.announcementLink} style={styles.link}>
              {props.announcementLink}
            </Link>
          }
        />
        {trimmedDescription !== undefined && trimmedDescription.length > 0 ? (
          <InfoRow
            icon="📝"
            label="Descriere"
            value={<span style={styles.description}>{renderMultilineText(trimmedDescription)}</span>}
            isLast
          />
        ) : (
          <InfoRow icon="📝" label="Descriere" value="—" isLast />
        )}
      </Section>

      <Section style={styles.ctaSection}>
        <Button href={props.announcementLink} style={styles.button}>
          Vezi anunțul
        </Button>
      </Section>

      {props.ctaUrl !== undefined ? (
        <Text style={styles.body}>
          Poți urmări și actualizările pentru această localitate{' '}
          <Link href={props.ctaUrl} style={styles.link}>
            aici
          </Link>
          .
        </Text>
      ) : null}

      <Text style={styles.body}>
        Primești acest email pentru că urmărești actualizările pentru această localitate.
      </Text>
      <Text style={styles.signature}>Echipa Funky & Transparenta.eu</Text>
    </EmailLayout>
  );
};

export default PublicDebateAnnouncementEmail;
