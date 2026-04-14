import { Link, Section, Text } from '@react-email/components';
// eslint-disable-next-line @typescript-eslint/naming-convention -- React is a third-party naming standard
import * as React from 'react';

import { CampaignHeader } from './components/campaign-header.js';
import { EmailLayout } from './email-layout.js';

import type {
  AdminReviewedInteractionProps,
  SupportedLanguage,
} from '../../core/types.js';

interface Copy {
  preview: string;
  approvedHeading: string;
  approvedLead: string;
  rejectedHeading: string;
  rejectedLead: string;
  interactionLabel: string;
  entityLabel: string;
  reviewedAtLabel: string;
  feedbackLabel: string;
  nextStepsLabel: string;
  closing: string;
  signature: string;
}

const COPY_BY_LANG: Record<SupportedLanguage, Copy> = {
  ro: {
    preview: 'Actualizare despre o interactiune revizuita de echipa campaniei.',
    approvedHeading: 'Interactiunea ta a fost aprobata',
    approvedLead:
      'O interactiune trimisa in cadrul campaniei a fost revizuita de echipa si a fost aprobata.',
    rejectedHeading: 'Interactiunea ta are nevoie de o noua incercare',
    rejectedLead:
      'O interactiune trimisa in cadrul campaniei a fost revizuita de echipa si a fost respinsa. Poti folosi informatiile de mai jos pentru a reveni asupra pasului.',
    interactionLabel: 'Interactiune',
    entityLabel: 'Localitate',
    reviewedAtLabel: 'Revizuita la',
    feedbackLabel: 'Feedback',
    nextStepsLabel: 'Pasi recomandati',
    closing: 'Iti multumim ca participi la campanie.',
    signature: 'Echipa Transparenta',
  },
  en: {
    preview: 'Update about an interaction reviewed by the campaign team.',
    approvedHeading: 'Your interaction was approved',
    approvedLead:
      'An interaction you submitted in the campaign was reviewed by the team and approved.',
    rejectedHeading: 'Your interaction needs another attempt',
    rejectedLead:
      'An interaction you submitted in the campaign was reviewed by the team and rejected. You can use the information below to revisit the step.',
    interactionLabel: 'Interaction',
    entityLabel: 'Locality',
    reviewedAtLabel: 'Reviewed at',
    feedbackLabel: 'Feedback',
    nextStepsLabel: 'Recommended next steps',
    closing: 'Thank you for taking part in the campaign.',
    signature: 'Transparenta Team',
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
  linkList: {
    margin: '16px 0 0',
  },
  linkRow: {
    margin: '0 0 12px',
  },
  link: {
    color: '#2456B7',
    fontSize: '14px',
    lineHeight: '22px',
    textDecoration: 'underline',
  },
  linkDescription: {
    color: '#4B5563',
    fontSize: '13px',
    lineHeight: '21px',
    margin: '4px 0 0',
  },
  closing: {
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

const formatTimestamp = (lang: SupportedLanguage, reviewedAt: string): string => {
  const date = new Date(reviewedAt);
  if (Number.isNaN(date.getTime())) {
    return reviewedAt;
  }

  return new Intl.DateTimeFormat(lang === 'ro' ? 'ro-RO' : 'en-US', {
    dateStyle: 'long',
    timeStyle: 'short',
    timeZone: 'UTC',
  }).format(date);
};

export const getAdminReviewedInteractionSubject = ({
  lang,
  entityCui,
  entityName,
  interactionLabel,
  reviewStatus,
}: Pick<
  AdminReviewedInteractionProps,
  'lang' | 'entityCui' | 'entityName' | 'interactionLabel' | 'reviewStatus'
>): string => {
  const locality = entityName.trim() !== '' ? entityName : entityCui;
  const prefix =
    lang === 'ro'
      ? reviewStatus === 'approved'
        ? 'Interactiune aprobata'
        : 'Interactiune respinsa'
      : reviewStatus === 'approved'
        ? 'Interaction approved'
        : 'Interaction rejected';

  return `${prefix}: ${interactionLabel} - ${locality}`;
};

export const AdminReviewedInteractionEmail = (
  props: AdminReviewedInteractionProps
): React.ReactElement => {
  const copy = COPY_BY_LANG[props.lang];
  const reviewedAt = formatTimestamp(props.lang, props.reviewedAt);
  const heading =
    props.reviewStatus === 'approved' ? copy.approvedHeading : copy.rejectedHeading;
  const lead = props.reviewStatus === 'approved' ? copy.approvedLead : copy.rejectedLead;

  return (
    <EmailLayout
      lang={props.lang}
      previewText={copy.preview}
      unsubscribeUrl={props.unsubscribeUrl}
      {...(props.preferencesUrl !== undefined ? { preferencesUrl: props.preferencesUrl } : {})}
      platformBaseUrl={props.platformBaseUrl}
      copyrightYear={props.copyrightYear}
      header={<CampaignHeader />}
    >
      <Text style={styles.greeting}>{heading}</Text>
      <Text style={styles.intro}>{lead}</Text>

      <Section style={styles.panel}>
        <Text style={styles.label}>{copy.interactionLabel}</Text>
        <Text style={styles.value}>{props.interactionLabel}</Text>

        <Text style={styles.label}>{copy.entityLabel}</Text>
        <Text style={styles.value}>{props.entityName}</Text>

        <Text style={styles.label}>{copy.reviewedAtLabel}</Text>
        <Text style={styles.value}>{reviewedAt}</Text>

        {props.feedbackText !== undefined && props.feedbackText.trim() !== '' ? (
          <>
            <Text style={styles.label}>{copy.feedbackLabel}</Text>
            <Text style={styles.value}>{props.feedbackText}</Text>
          </>
        ) : null}

        {props.nextStepLinks !== undefined && props.nextStepLinks.length > 0 ? (
          <>
            <Text style={styles.label}>{copy.nextStepsLabel}</Text>
            <Section style={styles.linkList}>
              {props.nextStepLinks.map((link, index) => (
                <Section key={`${link.kind}:${link.url}:${String(index)}`} style={styles.linkRow}>
                  <Link href={link.url} style={styles.link}>
                    {link.label}
                  </Link>
                  {link.description !== undefined && link.description.trim() !== '' ? (
                    <Text style={styles.linkDescription}>{link.description}</Text>
                  ) : null}
                </Section>
              ))}
            </Section>
          </>
        ) : null}
      </Section>

      <Text style={styles.closing}>{copy.closing}</Text>
      <Text style={styles.signature}>{copy.signature}</Text>
    </EmailLayout>
  );
};
