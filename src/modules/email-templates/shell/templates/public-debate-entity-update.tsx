import { Section, Text } from '@react-email/components';
// eslint-disable-next-line @typescript-eslint/naming-convention -- React is a third-party naming standard
import * as React from 'react';

import { CampaignHeader } from './components/campaign-header.js';
import { EmailLayout } from './email-layout.js';
import { formatTemplateTimestamp } from './formatting.js';

import type { PublicDebateEntityUpdateProps, SupportedLanguage } from '../../core/types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────────────────────────
// Copy
// ─────────────────────────────────────────────────────────────────────────────

const COPY_BY_LANG: Record<
  SupportedLanguage,
  Record<PublicDebateEntityUpdateProps['eventType'], Copy>
> = {
  ro: {
    thread_started: {
      preview: 'Solicitarea ta pentru dezbatere publică a fost trimisă către Primărie.',
      updateHeading: 'Cererea a fost trimisă',
      updateLead: 'Cererea pentru organizarea dezbaterii publice a fost trimisă către Primărie.',
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
      updateLead: 'Primăria a trimis un răspuns, iar acesta este disponibil mai jos.',
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
      updateLead: 'Răspunsul Primăriei a fost revizuit și starea firului a fost actualizată.',
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
      updateLead: 'The public debate request was sent to the city hall.',
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
      updateLead: 'The city hall sent a reply, and you can see it below.',
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
      updateLead: 'The city hall reply was reviewed and the thread status was updated.',
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

// ─────────────────────────────────────────────────────────────────────────────
// Status theming
// ─────────────────────────────────────────────────────────────────────────────

const STATUS_THEME: Record<
  PublicDebateEntityUpdateProps['eventType'],
  { color: string; icon: string; bg: string }
> = {
  thread_started: { color: '#10b981', icon: '✅', bg: '#ECFDF5' },
  reply_received: { color: '#3565c4', icon: '📩', bg: '#EFF6FF' },
  reply_reviewed: { color: '#7C3AED', icon: '👁', bg: '#F5F3FF' },
  thread_failed: { color: '#f43f5e', icon: '⚠️', bg: '#FFF1F2' },
};

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
  intro: {
    fontSize: '15px',
    lineHeight: '26px',
    color: '#4B5563',
    margin: '0 0 16px',
  },
  panel: {
    border: '1px solid #E5E7EB',
    borderRadius: '10px',
    backgroundColor: '#ffffff',
    padding: '20px',
    margin: '24px 0',
  },
  statusHeader: {
    margin: '0 0 16px',
  },
  statusRow: {
    display: 'flex' as const,
    alignItems: 'center' as const,
    gap: '10px',
  },
  statusIconCircle: {
    width: '32px',
    height: '32px',
    borderRadius: '50%',
  },
  statusIconText: {
    fontSize: '16px',
    lineHeight: '32px',
    textAlign: 'center' as const,
  },
  statusHeading: {
    fontSize: '18px',
    lineHeight: '28px',
    fontWeight: '700',
    margin: '0',
  },
  statusLead: {
    fontSize: '14px',
    lineHeight: '22px',
    color: '#4B5563',
    margin: '4px 0 0',
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
    backgroundColor: '#F3F4F6',
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
  previewPanel: {
    borderRadius: '8px',
    backgroundColor: '#F9FAFB',
    border: '1px solid #E5E7EB',
    padding: '16px',
    margin: '12px 0 0',
  },
  previewLabel: {
    fontSize: '11px',
    lineHeight: '16px',
    fontWeight: '700',
    color: '#6B7280',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.06em',
    margin: '0 0 8px',
  },
  previewText: {
    fontSize: '14px',
    lineHeight: '24px',
    color: '#374151',
    margin: '0',
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
    <React.Fragment key={`entity-update-line-${index.toString()}`}>
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
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// Subject
// ─────────────────────────────────────────────────────────────────────────────

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
    lang === 'ro' ? '„Cu ochii pe bugetele locale 2026”' : '"Cu ochii pe bugetele locale 2026"'
  }`;
};

// ─────────────────────────────────────────────────────────────────────────────
// Template
// ─────────────────────────────────────────────────────────────────────────────

export const PublicDebateEntityUpdateEmail = (
  props: PublicDebateEntityUpdateProps
): React.ReactElement => {
  const copy = COPY_BY_LANG[props.lang][props.eventType];
  const theme = STATUS_THEME[props.eventType];
  const formattedOccurredAt = formatTemplateTimestamp(props.occurredAt);
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
    ro: 'Echipa Funky & Transparenta.eu',
    en: 'Funky & Transparenta.eu Team',
  };

  const hasResolution = props.resolutionCode !== undefined && props.resolutionCode !== null;
  const hasNotes =
    props.reviewNotes !== undefined &&
    props.reviewNotes !== null &&
    props.reviewNotes.trim() !== '';
  const replyTextPreview = props.replyTextPreview ?? null;
  const hasReplyPreview = replyTextPreview !== null && replyTextPreview.trim() !== '';

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
        {/* Status header */}
        <div style={styles.statusHeader}>
          <table cellPadding="0" cellSpacing="0" border={0} style={{ width: '100%' }}>
            <tbody>
              <tr>
                <td style={{ width: '40px', verticalAlign: 'top', paddingRight: '12px' }}>
                  <table
                    cellPadding="0"
                    cellSpacing="0"
                    border={0}
                    style={{
                      ...styles.statusIconCircle,
                      backgroundColor: theme.bg,
                    }}
                  >
                    <tbody>
                      <tr>
                        <td style={{ ...styles.statusIconText, color: theme.color }}>
                          {theme.icon}
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </td>
                <td style={{ verticalAlign: 'top' }}>
                  <Text style={{ ...styles.statusHeading, color: theme.color }}>
                    {copy.updateHeading}
                  </Text>
                  <Text style={styles.statusLead}>{copy.updateLead}</Text>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <div style={styles.infoDivider} />

        {/* Info rows */}
        <InfoRow icon="📍" label={copy.entityLabel} value={entityName} />
        <InfoRow icon="🏛" label={copy.institutionLabel} value={props.institutionEmail} />
        <InfoRow icon="📧" label={copy.subjectLabel} value={props.subjectLine} />
        <InfoRow icon="🕐" label={copy.occurredAtLabel} value={formattedOccurredAt} />

        {hasResolution && (
          <InfoRow icon="🏁" label={copy.resolutionLabel} value={props.resolutionCode} />
        )}

        {hasNotes && <InfoRow icon="📝" label={copy.notesLabel} value={props.reviewNotes} />}

        {hasReplyPreview && (
          <>
            <div style={styles.infoDivider} />
            <Text style={styles.previewLabel}>{copy.replyPreviewLabel}</Text>
            <Section style={styles.previewPanel}>
              <Text style={styles.previewText}>{renderMultilineText(replyTextPreview)}</Text>
            </Section>
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
