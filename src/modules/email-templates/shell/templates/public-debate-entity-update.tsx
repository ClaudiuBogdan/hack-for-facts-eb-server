import { Section, Text } from '@react-email/components';
// eslint-disable-next-line @typescript-eslint/naming-convention -- React is a third-party naming standard
import * as React from 'react';

import { CampaignHeader } from './components/campaign-header.js';
import { EmailLayout } from './email-layout.js';

import type { PublicDebateEntityUpdateProps, SupportedLanguage } from '../../core/types.js';

interface Copy {
  preview: string;
  updateHeading: string;
  updateLead: string;
  subjectLabel: string;
  institutionLabel: string;
  entityLabel: string;
  occurredAtLabel: string;
  resolutionLabel: string;
  notesLabel: string;
  replyPreviewLabel: string;
}

const COPY_BY_LANG: Record<SupportedLanguage, Record<PublicDebateEntityUpdateProps['eventType'], Copy>> =
  {
    ro: {
      thread_started: {
        preview: 'Solicitarea ta pentru dezbatere publică a fost trimisă către Primărie.',
        updateHeading: 'Cererea a fost trimisă',
        updateLead:
          'Cererea pentru organizarea dezbaterii publice a fost trimisă către Primărie.',
        subjectLabel: 'Subiect',
        institutionLabel: 'Adresa de email a Primăriei',
        entityLabel: 'Localitate',
        occurredAtLabel: 'Trimis la',
        resolutionLabel: 'Rezoluție',
        notesLabel: 'Note',
        replyPreviewLabel: 'Extras răspuns',
      },
      thread_failed: {
        preview: 'Noutăți despre dezbaterea bugetului local.',
        updateHeading: 'Trimiterea a eșuat',
        updateLead:
          'A apărut o problemă la trimiterea cererii către Primărie. Vom păstra firul pentru următoarele actualizări.',
        subjectLabel: 'Subiect',
        institutionLabel: 'Email Primărie',
        entityLabel: 'Localitate',
        occurredAtLabel: 'Moment',
        resolutionLabel: 'Rezoluție',
        notesLabel: 'Note',
        replyPreviewLabel: 'Extras răspuns',
      },
      reply_received: {
        preview: 'Noutăți despre dezbaterea bugetului local.',
        updateHeading: 'A sosit un răspuns',
        updateLead:
          'Primăria a trimis un răspuns, iar acesta este disponibil mai jos.',
        subjectLabel: 'Subiect',
        institutionLabel: 'Email Primărie',
        entityLabel: 'Localitate',
        occurredAtLabel: 'Moment',
        resolutionLabel: 'Rezoluție',
        notesLabel: 'Note',
        replyPreviewLabel: 'Extras răspuns',
      },
      reply_reviewed: {
        preview: 'Noutăți despre dezbaterea bugetului local.',
        updateHeading: 'Răspunsul a fost revizuit',
        updateLead:
          'Răspunsul Primăriei a fost revizuit și starea firului a fost actualizată.',
        subjectLabel: 'Subiect',
        institutionLabel: 'Email Primărie',
        entityLabel: 'Localitate',
        occurredAtLabel: 'Moment',
        resolutionLabel: 'Rezoluție',
        notesLabel: 'Note',
        replyPreviewLabel: 'Extras răspuns',
      },
    },
    en: {
      thread_started: {
        preview: 'Your public debate request was sent to the city hall.',
        updateHeading: 'Request sent',
        updateLead:
          'The public debate request was sent to the city hall.',
        subjectLabel: 'Subject',
        institutionLabel: 'City hall email address',
        entityLabel: 'Locality',
        occurredAtLabel: 'Sent at',
        resolutionLabel: 'Resolution',
        notesLabel: 'Notes',
        replyPreviewLabel: 'Reply excerpt',
      },
      thread_failed: {
        preview: 'Updates about the local budget debate.',
        updateHeading: 'Send failed',
        updateLead:
          'There was a problem sending the request to the city hall. We will keep the thread for the next updates.',
        subjectLabel: 'Subject',
        institutionLabel: 'City hall email',
        entityLabel: 'Locality',
        occurredAtLabel: 'Time',
        resolutionLabel: 'Resolution',
        notesLabel: 'Notes',
        replyPreviewLabel: 'Reply excerpt',
      },
      reply_received: {
        preview: 'Updates about the local budget debate.',
        updateHeading: 'Reply received',
        updateLead:
          'The city hall sent a reply, and you can see it below.',
        subjectLabel: 'Subject',
        institutionLabel: 'City hall email',
        entityLabel: 'Locality',
        occurredAtLabel: 'Time',
        resolutionLabel: 'Resolution',
        notesLabel: 'Notes',
        replyPreviewLabel: 'Reply excerpt',
      },
      reply_reviewed: {
        preview: 'Updates about the local budget debate.',
        updateHeading: 'Reply reviewed',
        updateLead:
          'The city hall reply was reviewed and the thread status was updated.',
        subjectLabel: 'Subject',
        institutionLabel: 'City hall email',
        entityLabel: 'Locality',
        occurredAtLabel: 'Time',
        resolutionLabel: 'Resolution',
        notesLabel: 'Notes',
        replyPreviewLabel: 'Reply excerpt',
      },
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
  intro: {
    fontSize: '15px',
    lineHeight: '26px',
    color: '#4B5563',
    margin: '0 0 16px',
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
  thanks: {
    fontSize: '15px',
    lineHeight: '26px',
    color: '#4B5563',
    margin: '0 0 16px',
  },
  signature: {
    fontSize: '15px',
    lineHeight: '26px',
    fontWeight: '700',
    color: '#111827',
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
  entityName,
}: Pick<
  PublicDebateEntityUpdateProps,
  'lang' | 'eventType' | 'entityCui' | 'entityName'
>): string => {
  const prefixByLang: Record<
    SupportedLanguage,
    Record<PublicDebateEntityUpdateProps['eventType'], string>
  > = {
    ro: {
      thread_started: 'Cererea a fost trimisă',
      thread_failed: 'Trimiterea a eșuat',
      reply_received: 'A sosit un răspuns',
      reply_reviewed: 'Răspunsul a fost revizuit',
    },
    en: {
      thread_started: 'Request sent',
      thread_failed: 'Send failed',
      reply_received: 'Reply received',
      reply_reviewed: 'Reply reviewed',
    },
  };
  const locality = entityName !== undefined && entityName.trim() !== '' ? entityName : entityCui;

  return `${prefixByLang[lang][eventType]}: ${locality} - ${
    lang === 'ro'
      ? '„Cu ochii pe bugetele locale 2026”'
      : '"Cu ochii pe bugetele locale 2026"'
  }`;
};

export const PublicDebateEntityUpdateEmail = (
  props: PublicDebateEntityUpdateProps
): React.ReactElement => {
  const copy = COPY_BY_LANG[props.lang][props.eventType];
  const formattedOccurredAt = formatTimestamp(props.lang, props.occurredAt);
  const entityName = props.entityName ?? props.entityCui;
  const introByLang: Record<
    SupportedLanguage,
    Record<PublicDebateEntityUpdateProps['eventType'], string>
  > = {
    ro: {
      thread_started: `Cererea ta pentru organizarea unei dezbateri publice în ${entityName} a fost trimisă către Primărie. Mai jos găsești detaliile trimiterii. Vei primi în continuare pe email actualizările despre această solicitare.`,
      thread_failed: `A apărut o problemă la trimiterea cererii pentru organizarea unei dezbateri publice în ${entityName}. Mai jos poți vedea detaliile și următoarele actualizări.`,
      reply_received: `Primăria din ${entityName} a trimis un răspuns. Mai jos poți vedea toate actualizările.`,
      reply_reviewed: `Răspunsul primit de la Primăria din ${entityName} a fost revizuit. Mai jos poți vedea toate actualizările.`,
    },
    en: {
      thread_started: `Your request to organize a public debate in ${entityName} was sent to the city hall. Below you can find the send details. You will continue receiving updates about this request by email.`,
      thread_failed: `There was a problem sending the public debate request for ${entityName}. You can see the details and the next updates below.`,
      reply_received: `The city hall in ${entityName} sent a reply. You can see all updates below.`,
      reply_reviewed: `The reply received from the city hall in ${entityName} was reviewed. You can see all updates below.`,
    },
  };
  const recommendationByLang: Record<SupportedLanguage, string> = {
    ro: 'Pentru participarea la dezbatere, îți recomandăm să parcurgi atât proiectul de buget, cât și execuția anilor precedenți.',
    en: 'To prepare for the debate, we recommend reviewing both the draft budget and the execution data from previous years.',
  };
  const thanksByLang: Record<SupportedLanguage, string> = {
    ro: 'Mulțumim că ești parte din această provocare civică!',
    en: 'Thank you for being part of this civic challenge!',
  };
  const signatureByLang: Record<SupportedLanguage, string> = {
    ro: 'Echipa Funky x transparenta.eu',
    en: 'The Funky x transparenta.eu team',
  };

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
      <Text style={styles.intro}>{introByLang[props.lang][props.eventType]}</Text>

      <Section style={styles.panel}>
        <Text style={styles.panelHeading}>{copy.updateHeading}</Text>
        <Text style={styles.panelLead}>{copy.updateLead}</Text>

        <Text style={styles.label}>{copy.entityLabel}</Text>
        <Text style={styles.value}>{entityName}</Text>

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

      <Text style={styles.intro}>{recommendationByLang[props.lang]}</Text>
      <Text style={styles.thanks}>{thanksByLang[props.lang]}</Text>
      <Text style={styles.signature}>{signatureByLang[props.lang]}</Text>
    </EmailLayout>
  );
};

export default PublicDebateEntityUpdateEmail;
