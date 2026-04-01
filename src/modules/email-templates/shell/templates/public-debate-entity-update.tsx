import { Hr, Section, Text } from '@react-email/components';
// eslint-disable-next-line @typescript-eslint/naming-convention -- React is a third-party naming standard
import * as React from 'react';

import { CampaignHeader } from './components/campaign-header.js';
import { EmailLayout } from './email-layout.js';

import type { PublicDebateEntityUpdateProps, SupportedLanguage } from '../../core/types.js';

interface Copy {
  preview: string;
  heading: string;
  lead: string;
  subjectLabel: string;
  institutionLabel: string;
  entityLabel: string;
  occurredAtLabel: string;
  resolutionLabel: string;
  notesLabel: string;
  replyPreviewLabel: string;
  closing: string;
}

const COPY_BY_LANG: Record<SupportedLanguage, Record<PublicDebateEntityUpdateProps['eventType'], Copy>> =
  {
    ro: {
      thread_started: {
        preview: 'Cererea de dezbatere publica a fost trimisa.',
        heading: 'Cererea a fost trimisa',
        lead:
          'Cererea de dezbatere publica pentru aceasta entitate a fost trimisa si vom urmari raspunsurile primite pe firul de corespondenta.',
        subjectLabel: 'Subiect',
        institutionLabel: 'Email institutie',
        entityLabel: 'Entitate',
        occurredAtLabel: 'Moment',
        resolutionLabel: 'Rezolutie',
        notesLabel: 'Note',
        replyPreviewLabel: 'Extras raspuns',
        closing: 'Vei primi un nou mesaj cand apare o actualizare relevanta pe acest fir.',
      },
      thread_failed: {
        preview: 'Nu am putut trimite cererea de dezbatere publica.',
        heading: 'Trimiterea a esuat',
        lead:
          'Am inregistrat o eroare la trimiterea cererii de dezbatere publica. Firul ramane in sistem pentru urmarire si reluare.',
        subjectLabel: 'Subiect',
        institutionLabel: 'Email institutie',
        entityLabel: 'Entitate',
        occurredAtLabel: 'Moment',
        resolutionLabel: 'Rezolutie',
        notesLabel: 'Note',
        replyPreviewLabel: 'Extras raspuns',
        closing: 'Daca reluam cu succes trimiterea, vei primi o actualizare noua.',
      },
      reply_received: {
        preview: 'Institutia a raspuns la cererea de dezbatere publica.',
        heading: 'A sosit un raspuns',
        lead:
          'Am primit un raspuns din partea institutiei si l-am marcat pentru revizuire administrativa.',
        subjectLabel: 'Subiect',
        institutionLabel: 'Email institutie',
        entityLabel: 'Entitate',
        occurredAtLabel: 'Moment',
        resolutionLabel: 'Rezolutie',
        notesLabel: 'Note',
        replyPreviewLabel: 'Extras raspuns',
        closing: 'Dupa revizuire, vei primi o noua actualizare cu concluzia traseului.',
      },
      reply_reviewed: {
        preview: 'A fost actualizata starea raspunsului institutiei.',
        heading: 'Raspunsul a fost revizuit',
        lead:
          'Un administrator a revizuit raspunsul institutiei si a actualizat starea firului de corespondenta.',
        subjectLabel: 'Subiect',
        institutionLabel: 'Email institutie',
        entityLabel: 'Entitate',
        occurredAtLabel: 'Moment',
        resolutionLabel: 'Rezolutie',
        notesLabel: 'Note',
        replyPreviewLabel: 'Extras raspuns',
        closing: 'Poti folosi pagina de notificari pentru a dezactiva aceste actualizari in orice moment.',
      },
    },
    en: {
      thread_started: {
        preview: 'The public debate request has been sent.',
        heading: 'Request sent',
        lead:
          'The public debate request for this entity has been sent and we will track any follow-up messages on the correspondence thread.',
        subjectLabel: 'Subject',
        institutionLabel: 'Institution email',
        entityLabel: 'Entity',
        occurredAtLabel: 'Time',
        resolutionLabel: 'Resolution',
        notesLabel: 'Notes',
        replyPreviewLabel: 'Reply excerpt',
        closing: 'You will receive another email when there is a relevant update on this thread.',
      },
      thread_failed: {
        preview: 'We could not send the public debate request.',
        heading: 'Send failed',
        lead:
          'We recorded an error while sending the public debate request. The thread remains in the system for follow-up and retry.',
        subjectLabel: 'Subject',
        institutionLabel: 'Institution email',
        entityLabel: 'Entity',
        occurredAtLabel: 'Time',
        resolutionLabel: 'Resolution',
        notesLabel: 'Notes',
        replyPreviewLabel: 'Reply excerpt',
        closing: 'If we retry successfully, you will receive another update.',
      },
      reply_received: {
        preview: 'The institution replied to the public debate request.',
        heading: 'Reply received',
        lead:
          'We received a reply from the institution and marked it for administrative review.',
        subjectLabel: 'Subject',
        institutionLabel: 'Institution email',
        entityLabel: 'Entity',
        occurredAtLabel: 'Time',
        resolutionLabel: 'Resolution',
        notesLabel: 'Notes',
        replyPreviewLabel: 'Reply excerpt',
        closing: 'After review, you will receive another update with the outcome.',
      },
      reply_reviewed: {
        preview: 'The institution reply status has been updated.',
        heading: 'Reply reviewed',
        lead:
          'An administrator reviewed the institution reply and updated the correspondence thread status.',
        subjectLabel: 'Subject',
        institutionLabel: 'Institution email',
        entityLabel: 'Entity',
        occurredAtLabel: 'Time',
        resolutionLabel: 'Resolution',
        notesLabel: 'Notes',
        replyPreviewLabel: 'Reply excerpt',
        closing: 'You can disable these updates at any time from the notification settings page.',
      },
    },
  };

const styles = {
  heading: {
    fontSize: '22px',
    lineHeight: '32px',
    fontWeight: '700',
    color: '#111827',
    margin: '0 0 8px',
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
    fontSize: '14px',
    lineHeight: '22px',
    color: '#111827',
    margin: '0 0 12px',
  },
  quote: {
    borderLeft: '3px solid #3565c4',
    paddingLeft: '14px',
    margin: '16px 0 0',
    color: '#374151',
    fontSize: '14px',
    lineHeight: '24px',
    whiteSpace: 'pre-wrap' as const,
  },
  divider: {
    borderColor: '#E5E7EB',
    margin: '24px 0 16px',
  },
  closing: {
    fontSize: '13px',
    lineHeight: '22px',
    color: '#6B7280',
    margin: '0',
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

export const getPublicDebateEntityUpdateSubject = ({
  lang,
  eventType,
  entityCui,
}: Pick<PublicDebateEntityUpdateProps, 'lang' | 'eventType' | 'entityCui'>): string => {
  const prefixByLang: Record<
    SupportedLanguage,
    Record<PublicDebateEntityUpdateProps['eventType'], string>
  > = {
    ro: {
      thread_started: 'Cererea a fost trimisa',
      thread_failed: 'Trimiterea a esuat',
      reply_received: 'A sosit un raspuns',
      reply_reviewed: 'Raspunsul a fost revizuit',
    },
    en: {
      thread_started: 'Request sent',
      thread_failed: 'Send failed',
      reply_received: 'Reply received',
      reply_reviewed: 'Reply reviewed',
    },
  };

  return `${prefixByLang[lang][eventType]}: ${entityCui}`;
};

export const PublicDebateEntityUpdateEmail = (
  props: PublicDebateEntityUpdateProps
): React.ReactElement => {
  const copy = COPY_BY_LANG[props.lang][props.eventType];
  const formattedOccurredAt = formatTimestamp(props.lang, props.occurredAt);

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
      <Text style={styles.heading}>{copy.heading}</Text>
      <Text style={styles.body}>{copy.lead}</Text>

      <Section style={styles.panel}>
        <Text style={styles.label}>{copy.entityLabel}</Text>
        <Text style={styles.value}>{props.entityCui}</Text>

        <Text style={styles.label}>{copy.institutionLabel}</Text>
        <Text style={styles.value}>{props.institutionEmail}</Text>

        <Text style={styles.label}>{copy.subjectLabel}</Text>
        <Text style={styles.value}>{props.subjectLine}</Text>

        <Text style={styles.label}>{copy.occurredAtLabel}</Text>
        <Text style={styles.value}>{formattedOccurredAt}</Text>

        {props.resolutionCode !== undefined && props.resolutionCode !== null && (
          <>
            <Text style={styles.label}>{copy.resolutionLabel}</Text>
            <Text style={styles.value}>{props.resolutionCode}</Text>
          </>
        )}

        {props.reviewNotes !== undefined && props.reviewNotes !== null && props.reviewNotes.trim() !== '' && (
          <>
            <Text style={styles.label}>{copy.notesLabel}</Text>
            <Text style={styles.value}>{props.reviewNotes}</Text>
          </>
        )}

        {props.replyTextPreview !== undefined &&
          props.replyTextPreview !== null &&
          props.replyTextPreview.trim() !== '' && (
            <>
              <Text style={styles.label}>{copy.replyPreviewLabel}</Text>
              <Text style={styles.quote}>{props.replyTextPreview}</Text>
            </>
          )}
      </Section>

      <Hr style={styles.divider} />
      <Text style={styles.closing}>{copy.closing}</Text>
    </EmailLayout>
  );
};

export default PublicDebateEntityUpdateEmail;

