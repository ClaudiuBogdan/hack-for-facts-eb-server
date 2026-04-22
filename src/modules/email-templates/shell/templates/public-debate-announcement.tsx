import { Button, Link, Section, Text } from '@react-email/components';
// eslint-disable-next-line @typescript-eslint/naming-convention -- React is a third-party naming standard
import * as React from 'react';

import { CampaignHeader } from './components/campaign-header.js';
import { EmailLayout } from './email-layout.js';

import type { PublicDebateAnnouncementProps } from '../../core/types.js';

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
    borderRadius: '10px',
    backgroundColor: '#F9FAFB',
    padding: '16px 18px',
    margin: '24px 0',
  },
  label: {
    fontSize: '12px',
    lineHeight: '18px',
    fontWeight: '700',
    color: '#6B7280',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.04em',
    margin: '0 0 4px',
  },
  value: {
    fontSize: '15px',
    lineHeight: '24px',
    color: '#111827',
    margin: '0 0 12px',
  },
  description: {
    fontSize: '14px',
    lineHeight: '24px',
    color: '#374151',
    whiteSpace: 'pre-wrap' as const,
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

export const getPublicDebateAnnouncementSubject = (
  props: Pick<PublicDebateAnnouncementProps, 'entityName' | 'date' | 'time'>
): string => {
  return `Anunt de dezbatere publica: ${props.entityName} pe ${props.date} la ${props.time}`;
};

export const PublicDebateAnnouncementEmail = (
  props: PublicDebateAnnouncementProps
): React.ReactElement => {
  return (
    <EmailLayout
      lang={props.lang}
      previewText={`Anunt de dezbatere publica pentru ${props.entityName}`}
      unsubscribeUrl={props.unsubscribeUrl}
      platformBaseUrl={props.platformBaseUrl}
      copyrightYear={props.copyrightYear}
      header={<CampaignHeader />}
      {...(props.preferencesUrl !== undefined ? { preferencesUrl: props.preferencesUrl } : {})}
    >
      <Text style={styles.greeting}>A fost publicat un anunt de dezbatere publica.</Text>
      <Text style={styles.body}>
        {props.entityName} a publicat un anunt de dezbatere publica. Mai jos gasesti
        detaliile principale.
      </Text>

      <Section style={styles.panel}>
        <Text style={styles.label}>Localitate</Text>
        <Text style={styles.value}>{props.entityName}</Text>
        <Text style={styles.label}>Data</Text>
        <Text style={styles.value}>{props.date}</Text>
        <Text style={styles.label}>Ora</Text>
        <Text style={styles.value}>{props.time}</Text>
        <Text style={styles.label}>Locatie</Text>
        <Text style={styles.value}>{props.location}</Text>
        {props.onlineParticipationLink !== undefined ? (
          <>
            <Text style={styles.label}>Participare online</Text>
            <Text style={styles.value}>
              <Link href={props.onlineParticipationLink} style={styles.link}>
                Participa online
              </Link>
            </Text>
          </>
        ) : null}
        {props.description !== undefined ? (
          <>
            <Text style={styles.label}>Descriere</Text>
            <Text style={styles.description}>{props.description}</Text>
          </>
        ) : null}
      </Section>

      <Section style={styles.ctaSection}>
        <Button href={props.announcementLink} style={styles.button}>
          Vezi anuntul
        </Button>
      </Section>

      {props.ctaUrl !== undefined ? (
        <Text style={styles.body}>
          Poti urmari si actualizarile pentru aceasta localitate{' '}
          <Link href={props.ctaUrl} style={styles.link}>
            aici
          </Link>
          .
        </Text>
      ) : null}

      <Text style={styles.body}>
        Primesti acest email pentru ca urmaresti actualizarile pentru aceasta localitate.
      </Text>
      <Text style={styles.signature}>Funky</Text>
    </EmailLayout>
  );
};

export default PublicDebateAnnouncementEmail;
