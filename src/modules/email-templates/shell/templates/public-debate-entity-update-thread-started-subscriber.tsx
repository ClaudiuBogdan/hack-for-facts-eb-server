import { Button, Section, Text } from '@react-email/components';
// eslint-disable-next-line @typescript-eslint/naming-convention -- React is a third-party naming standard
import * as React from 'react';

import { CampaignHeader } from './components/campaign-header.js';
import { EmailLayout } from './email-layout.js';
import { formatTemplateTimestamp } from './formatting.js';

import type {
  PublicDebateEntityUpdateThreadStartedSubscriberProps,
  SupportedLanguage,
} from '../../core/types.js';

interface Copy {
  preview: string;
  heading: string;
  lead: string;
  whyReceived: string;
  ctaLead: string;
  ctaSafety: string;
  entityLabel: string;
  occurredAtLabel: string;
  ctaLabel: string;
  thanks: string;
  signature: string;
}

const COPY_BY_LANG: Record<SupportedLanguage, Copy> = {
  ro: {
    preview:
      'Urmărești această localitate: o cerere pentru organizarea dezbaterii publice a fost deja trimisă către Primărie.',
    heading: 'Există deja o cerere în curs pentru această localitate',
    lead:
      'Pentru această localitate, o cerere de organizare a dezbaterii publice a fost deja trimisă către Primărie și este în așteptarea unui răspuns.',
    whyReceived:
      'Primești această informare pentru că urmărești actualizările despre această localitate în provocarea civică. Mesajul nu confirmă o cerere trimisă de tine.',
    ctaLead:
      'Pe pagina localității poți urmări stadiul solicitării și, dacă vrei, poți continua pașii tăi din provocare.',
    ctaSafety:
      'Nu trimite o altă cerere către Primărie pentru aceeași localitate. Butonul de mai jos deschide pagina localității, unde vezi actualizările și pașii opționali disponibili.',
    entityLabel: 'Localitate',
    occurredAtLabel: 'Trimis la',
    ctaLabel: 'Vezi stadiul solicitării',
    thanks: 'Mulțumim că urmărești această provocare civică!',
    signature: 'Echipa Funky x transparenta.eu',
  },
  en: {
    preview:
      'You follow this locality: a request to organize the public debate has already been sent to the city hall.',
    heading: 'There is already a request in progress for this locality',
    lead:
      'For this locality, a request to organize the public debate has already been sent to the city hall and is awaiting a reply.',
    whyReceived:
      'You are receiving this update because you follow this locality in the civic challenge. This message does not confirm a request sent by you.',
    ctaLead:
      'On the locality page, you can follow the request status and, if you want, continue your own challenge steps.',
    ctaSafety:
      'Do not send another request to the city hall for the same locality. The button below opens the locality page, where you can see updates and available optional steps.',
    entityLabel: 'Locality',
    occurredAtLabel: 'Sent at',
    ctaLabel: 'View request status',
    thanks: 'Thank you for following this civic challenge!',
    signature: 'The Funky x transparenta.eu team',
  },
};

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
  panelHeading: {
    fontSize: '18px',
    lineHeight: '28px',
    fontWeight: '700',
    color: '#111827',
    margin: '0 0 8px',
  },
  panelLead: {
    fontSize: '14px',
    lineHeight: '24px',
    color: '#4B5563',
    margin: '0 0 16px',
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
  signature: {
    fontSize: '15px',
    lineHeight: '26px',
    fontWeight: '700',
    color: '#111827',
    margin: '0',
  },
};

export const getPublicDebateEntityUpdateThreadStartedSubscriberSubject = ({
  lang,
  entityCui,
  entityName,
}: Pick<
  PublicDebateEntityUpdateThreadStartedSubscriberProps,
  'lang' | 'entityCui' | 'entityName'
>): string => {
  const locality = entityName !== undefined && entityName.trim() !== '' ? entityName : entityCui;
  const prefix =
    lang === 'ro'
      ? 'Există deja o cerere trimisă către Primărie'
      : 'There is already a request sent to the city hall';

  return `${prefix}: ${locality} - ${
    lang === 'ro'
      ? '„Cu ochii pe bugetele locale 2026”'
      : '"Cu ochii pe bugetele locale 2026"'
  }`;
};

export const PublicDebateEntityUpdateThreadStartedSubscriberEmail = (
  props: PublicDebateEntityUpdateThreadStartedSubscriberProps
): React.ReactElement => {
  const copy = COPY_BY_LANG[props.lang];
  const entityName = props.entityName ?? props.entityCui;

  return (
    <EmailLayout
      lang={props.lang}
      previewText={copy.preview}
      unsubscribeUrl={props.unsubscribeUrl}
      platformBaseUrl={props.platformBaseUrl}
      copyrightYear={props.copyrightYear}
      header={<CampaignHeader />}
      {...(props.preferencesUrl !== undefined ? { preferencesUrl: props.preferencesUrl } : {})}
    >
      <Text style={styles.greeting}>{props.lang === 'ro' ? 'Salutare,' : 'Hello,'}</Text>
      <Text style={styles.body}>{copy.lead}</Text>
      <Text style={styles.body}>{copy.whyReceived}</Text>

      <Section style={styles.panel}>
        <Text style={styles.panelHeading}>{copy.heading}</Text>
        <Text style={styles.panelLead}>{copy.ctaLead}</Text>

        <Text style={styles.label}>{copy.entityLabel}</Text>
        <Text style={styles.value}>{entityName}</Text>

        <Text style={styles.label}>{copy.occurredAtLabel}</Text>
        <Text style={styles.value}>{formatTemplateTimestamp(props.occurredAt)}</Text>
      </Section>

      <Text style={styles.body}>{copy.ctaSafety}</Text>

      <Section style={styles.ctaSection}>
        <Button href={props.ctaUrl} style={styles.button}>
          {copy.ctaLabel}
        </Button>
      </Section>

      <Text style={styles.body}>{copy.thanks}</Text>
      <Text style={styles.signature}>{copy.signature}</Text>
    </EmailLayout>
  );
};

export default PublicDebateEntityUpdateThreadStartedSubscriberEmail;
