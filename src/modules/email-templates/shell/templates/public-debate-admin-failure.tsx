import { Section, Text } from '@react-email/components';
// eslint-disable-next-line @typescript-eslint/naming-convention -- React is a third-party naming standard
import * as React from 'react';

import { EmailLayout } from './email-layout.js';

import type { PublicDebateAdminFailureProps, SupportedLanguage } from '../../core/types.js';

interface Copy {
  preview: string;
  heading: string;
  lead: string;
  entityLabel: string;
  entityCuiLabel: string;
  institutionLabel: string;
  subjectLabel: string;
  occurredAtLabel: string;
  failureLabel: string;
  threadIdLabel: string;
}

const COPY_BY_LANG: Record<SupportedLanguage, Copy> = {
  ro: {
    preview: 'Alertă internă pentru trimiterea cererii de dezbatere publică.',
    heading: 'Trimiterea către Primărie a eșuat',
    lead: 'Cererea de dezbatere publică nu a putut fi trimisă către instituție.',
    entityLabel: 'Localitate',
    entityCuiLabel: 'CUI',
    institutionLabel: 'Email Primărie',
    subjectLabel: 'Subiect',
    occurredAtLabel: 'Moment',
    failureLabel: 'Mesaj eroare',
    threadIdLabel: 'Thread ID',
  },
  en: {
    preview: 'Internal alert for a failed public debate request send.',
    heading: 'Send to city hall failed',
    lead: 'The public debate request could not be sent to the institution.',
    entityLabel: 'Locality',
    entityCuiLabel: 'CUI',
    institutionLabel: 'City hall email',
    subjectLabel: 'Subject',
    occurredAtLabel: 'Time',
    failureLabel: 'Error message',
    threadIdLabel: 'Thread ID',
  },
};

const styles = {
  heading: {
    fontSize: '24px',
    lineHeight: '32px',
    fontWeight: '800',
    color: '#111827',
    margin: '0 0 10px',
  },
  lead: {
    fontSize: '15px',
    lineHeight: '24px',
    color: '#4B5563',
    margin: '0 0 18px',
  },
  panel: {
    border: '1px solid #E5E7EB',
    borderRadius: '10px',
    backgroundColor: '#F9FAFB',
    padding: '16px 18px',
    margin: '20px 0',
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
    fontSize: '14px',
    lineHeight: '22px',
    color: '#111827',
    margin: '0 0 12px',
  },
  failureBox: {
    borderLeft: '3px solid #DC2626',
    paddingLeft: '14px',
    margin: '4px 0 0',
    color: '#7F1D1D',
    fontSize: '14px',
    lineHeight: '22px',
    whiteSpace: 'pre-wrap' as const,
  },
};

const formatTimestamp = (lang: SupportedLanguage, occurredAt: string): string => {
  const date = new Date(occurredAt);
  if (Number.isNaN(date.getTime())) {
    return occurredAt;
  }

  return new Intl.DateTimeFormat(lang === 'ro' ? 'ro-RO' : 'en-US', {
    dateStyle: 'long',
    timeStyle: 'short',
    timeZone: 'UTC',
  }).format(date);
};

export const getPublicDebateAdminFailureSubject = ({
  lang,
  entityCui,
  entityName,
}: Pick<PublicDebateAdminFailureProps, 'lang' | 'entityCui' | 'entityName'>): string => {
  const locality = entityName !== undefined && entityName.trim() !== '' ? entityName : entityCui;
  return lang === 'ro'
    ? `Eșec trimitere cerere dezbatere: ${locality}`
    : `Public debate send failure: ${locality}`;
};

export const PublicDebateAdminFailureEmail = (
  props: PublicDebateAdminFailureProps
): React.ReactElement => {
  const copy = COPY_BY_LANG[props.lang];
  const entityName =
    props.entityName !== undefined && props.entityName.trim() !== '' ? props.entityName : props.entityCui;

  return (
    <EmailLayout
      lang={props.lang}
      previewText={copy.preview}
      unsubscribeUrl={props.unsubscribeUrl}
      platformBaseUrl={props.platformBaseUrl}
      copyrightYear={props.copyrightYear}
    >
      <Text style={styles.heading}>{copy.heading}</Text>
      <Text style={styles.lead}>{copy.lead}</Text>

      <Section style={styles.panel}>
        <Text style={styles.label}>{copy.entityLabel}</Text>
        <Text style={styles.value}>{entityName}</Text>

        <Text style={styles.label}>{copy.entityCuiLabel}</Text>
        <Text style={styles.value}>{props.entityCui}</Text>

        <Text style={styles.label}>{copy.institutionLabel}</Text>
        <Text style={styles.value}>{props.institutionEmail}</Text>

        <Text style={styles.label}>{copy.subjectLabel}</Text>
        <Text style={styles.value}>{props.subjectLine}</Text>

        <Text style={styles.label}>{copy.occurredAtLabel}</Text>
        <Text style={styles.value}>{formatTimestamp(props.lang, props.occurredAt)}</Text>

        <Text style={styles.label}>{copy.threadIdLabel}</Text>
        <Text style={styles.value}>{props.threadId}</Text>

        <Text style={styles.label}>{copy.failureLabel}</Text>
        <Text style={styles.failureBox}>{props.failureMessage}</Text>
      </Section>
    </EmailLayout>
  );
};
