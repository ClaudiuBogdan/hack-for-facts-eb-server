import { Link, Section, Text } from '@react-email/components';
// eslint-disable-next-line @typescript-eslint/naming-convention -- React is a third-party naming standard
import * as React from 'react';

import { CampaignHeader } from './components/campaign-header.js';
import { EmailLayout } from './email-layout.js';

import type {
  PublicDebateAdminResponseRequesterProps,
  PublicDebateAdminResponseSubscriberProps,
  SupportedLanguage,
} from '../../core/types.js';

type PublicDebateAdminResponseProps =
  | PublicDebateAdminResponseRequesterProps
  | PublicDebateAdminResponseSubscriberProps;

const styles = {
  intro: {
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
    whiteSpace: 'pre-wrap' as const,
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

const RESPONSE_STATUS_LABELS: Record<
  SupportedLanguage,
  Record<PublicDebateAdminResponseProps['responseStatus'], string>
> = {
  ro: {
    registration_number_received: 'Număr de înregistrare primit',
    request_confirmed: 'Cerere confirmată',
    request_denied: 'Cerere respinsă',
  },
  en: {
    registration_number_received: 'Registration number received',
    request_confirmed: 'Request confirmed',
    request_denied: 'Request denied',
  },
};

const COPY = {
  ro: {
    requester: {
      preview: 'A fost adăugat un răspuns la solicitarea ta.',
      intro:
        'Un administrator a adăugat un răspuns la solicitarea ta privind dezbaterea publică.',
    },
    subscriber: {
      preview: 'A apărut o actualizare pentru localitatea pe care o urmărești.',
      intro:
        'Primești acest email pentru că urmărești această localitate și a fost adăugat un răspuns administrativ la un fir de solicitare privind dezbaterea publică.',
    },
    responseHeading: 'Detalii răspuns',
    localityLabel: 'Localitate',
    responseStatusLabel: 'Status răspuns',
    responseDateLabel: 'Data răspunsului',
    messageLabel: 'Mesaj',
    ctaLabel: 'Vezi actualizările pentru localitate',
    thanks: 'Mulțumim că urmărești procesul de transparență.',
    signature: 'Echipa Funky Citizens',
  },
  en: {
    requester: {
      preview: 'A response was added to your request.',
      intro: 'An admin added a response to your public debate request.',
    },
    subscriber: {
      preview: 'There is an update for a locality you follow.',
      intro:
        'You are receiving this email because you follow this locality and an administrative response was added to a public debate request thread.',
    },
    responseHeading: 'Response details',
    localityLabel: 'Locality',
    responseStatusLabel: 'Response status',
    responseDateLabel: 'Response date',
    messageLabel: 'Message',
    ctaLabel: 'View locality updates',
    thanks: 'Thank you for following local transparency.',
    signature: 'Funky Citizens team',
  },
} as const;

const formatTimestamp = (lang: SupportedLanguage, value: string): string => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat(lang === 'ro' ? 'ro-RO' : 'en-US', {
    dateStyle: 'long',
    timeStyle: 'short',
    timeZone: 'UTC',
  }).format(date);
};

const getVariant = (
  templateType: PublicDebateAdminResponseProps['templateType']
): 'requester' | 'subscriber' => {
  return templateType === 'public_debate_admin_response_requester'
    ? 'requester'
    : 'subscriber';
};

export const getPublicDebateAdminResponseSubject = (
  props: Pick<
    PublicDebateAdminResponseProps,
    'lang' | 'entityCui' | 'entityName' | 'responseStatus' | 'templateType'
  >
): string => {
  const locality = props.entityName.trim() !== '' ? props.entityName : props.entityCui;
  const variant = getVariant(props.templateType);
  const prefix =
    variant === 'requester'
      ? props.lang === 'ro'
        ? 'Răspuns adăugat la solicitarea ta'
        : 'Response added to your request'
      : props.lang === 'ro'
        ? 'Actualizare pentru localitatea urmărită'
        : 'Update for a locality you follow';

  return `${prefix}: ${locality}`;
};

export const PublicDebateAdminResponseEmail = (
  props: PublicDebateAdminResponseProps
): React.ReactElement => {
  const langCopy = COPY[props.lang];
  const variant = getVariant(props.templateType);
  const locality = props.entityName.trim() !== '' ? props.entityName : props.entityCui;

  return (
    <EmailLayout
      lang={props.lang}
      previewText={langCopy[variant].preview}
      unsubscribeUrl={props.unsubscribeUrl}
      platformBaseUrl={props.platformBaseUrl}
      copyrightYear={props.copyrightYear}
      {...(props.preferencesUrl !== undefined ? { preferencesUrl: props.preferencesUrl } : {})}
    >
      <CampaignHeader />

      <Text style={styles.intro}>{langCopy[variant].intro}</Text>

      <Section style={styles.panel}>
        <Text style={styles.panelHeading}>{langCopy.responseHeading}</Text>

        <Text style={styles.label}>{langCopy.localityLabel}</Text>
        <Text style={styles.value}>{locality}</Text>

        <Text style={styles.label}>{langCopy.responseStatusLabel}</Text>
        <Text style={styles.value}>{RESPONSE_STATUS_LABELS[props.lang][props.responseStatus]}</Text>

        <Text style={styles.label}>{langCopy.responseDateLabel}</Text>
        <Text style={styles.value}>{formatTimestamp(props.lang, props.responseDate)}</Text>

        <Text style={styles.label}>{langCopy.messageLabel}</Text>
        <Text style={styles.value}>{props.messageContent}</Text>

        <Link href={props.ctaUrl} style={styles.link}>
          {langCopy.ctaLabel}
        </Link>
      </Section>

      <Text style={styles.intro}>{langCopy.thanks}</Text>
      <Text style={styles.signature}>{langCopy.signature}</Text>
    </EmailLayout>
  );
};
