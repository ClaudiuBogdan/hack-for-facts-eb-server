import { Button, Link, Section, Text } from '@react-email/components';
// eslint-disable-next-line @typescript-eslint/naming-convention -- React is a third-party naming standard
import * as React from 'react';

import { CampaignHeader } from './components/campaign-header.js';
import { EmailLayout } from './email-layout.js';

import type {
  WeeklyProgressDigestCta,
  WeeklyProgressDigestItem,
  WeeklyProgressDigestProps,
  SupportedLanguage,
} from '../../core/types.js';

interface Copy {
  preview: string;
  heading: string;
  intro: string;
  summaryLine: (input: { periodLabel: string; totalItemCount: number }) => string;
  actionNowLine: (actionNowCount: number) => string;
  changesHeading: string;
  nextStepsHeading: string;
  feedbackLabel: string;
  moreUpdatesLine: (hiddenItemCount: number) => string;
  allUpdatesLabel: string;
  closing: string;
  signature: string;
}

const COPY_BY_LANG: Record<SupportedLanguage, Copy> = {
  ro: {
    preview: 'Vezi ce s-a schimbat si care este cel mai util pas urmator.',
    heading: 'Actualizarea ta saptamanala',
    intro:
      'Am adunat cele mai importante schimbari din aceasta saptamana si ti-am pregatit urmatorii pasi utili.',
    summaryLine: ({ periodLabel, totalItemCount }) =>
      `In perioada ${periodLabel} ai ${String(totalItemCount)} actualizari noi.`,
    actionNowLine: (actionNowCount) =>
      actionNowCount === 1
        ? '1 actualizare are nevoie de atentia ta acum.'
        : `${String(actionNowCount)} actualizari au nevoie de atentia ta acum.`,
    changesHeading: 'Ce s-a schimbat',
    nextStepsHeading: 'Ce poti face mai departe',
    feedbackLabel: 'Observatie',
    moreUpdatesLine: (hiddenItemCount) =>
      `Si inca ${String(hiddenItemCount)} actualizari in contul tau.`,
    allUpdatesLabel: 'Vezi toate actualizarile',
    closing: 'Multumim ca urmaresti bugetul local.',
    signature: 'Echipa Funky x transparenta.eu',
  },
  en: {
    preview: 'See what changed and the most useful next step for you.',
    heading: 'Your weekly update',
    intro:
      'We gathered the most important changes from this week and prepared the most useful next steps for you.',
    summaryLine: ({ periodLabel, totalItemCount }) =>
      `During ${periodLabel} you had ${String(totalItemCount)} new updates.`,
    actionNowLine: (actionNowCount) =>
      actionNowCount === 1
        ? '1 update needs your attention now.'
        : `${String(actionNowCount)} updates need your attention now.`,
    changesHeading: 'What changed',
    nextStepsHeading: 'What you can do next',
    feedbackLabel: 'Note',
    moreUpdatesLine: (hiddenItemCount) =>
      `And ${String(hiddenItemCount)} more updates are available in your account.`,
    allUpdatesLabel: 'See all updates',
    closing: 'Thank you for following your local budget.',
    signature: 'Funky x transparenta.eu team',
  },
};

const styles = {
  heading: {
    fontSize: '24px',
    lineHeight: '32px',
    fontWeight: '700',
    color: '#111827',
    margin: '0 0 12px',
  },
  intro: {
    fontSize: '15px',
    lineHeight: '24px',
    color: '#4B5563',
    margin: '0 0 20px',
  },
  summaryPanel: {
    border: '1px solid #DBEAFE',
    borderRadius: '12px',
    backgroundColor: '#EFF6FF',
    padding: '16px 18px',
    margin: '0 0 24px',
  },
  summaryText: {
    fontSize: '14px',
    lineHeight: '22px',
    color: '#1F2937',
    margin: '0 0 6px',
  },
  sectionHeading: {
    fontSize: '16px',
    lineHeight: '24px',
    fontWeight: '700',
    color: '#111827',
    margin: '0 0 16px',
  },
  itemPanel: {
    border: '1px solid #E5E7EB',
    borderRadius: '12px',
    backgroundColor: '#FFFFFF',
    padding: '16px 18px',
    margin: '0 0 14px',
  },
  itemHeader: {
    fontSize: '16px',
    lineHeight: '24px',
    fontWeight: '700',
    color: '#111827',
    margin: '0 0 6px',
  },
  itemMeta: {
    fontSize: '13px',
    lineHeight: '20px',
    color: '#6B7280',
    margin: '0 0 8px',
  },
  itemDescription: {
    fontSize: '14px',
    lineHeight: '22px',
    color: '#374151',
    margin: '0 0 10px',
  },
  feedbackLabel: {
    fontSize: '12px',
    lineHeight: '18px',
    fontWeight: '700',
    color: '#6B7280',
    margin: '0 0 4px',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.04em',
  },
  feedbackText: {
    fontSize: '13px',
    lineHeight: '20px',
    color: '#374151',
    margin: '0 0 10px',
  },
  itemLink: {
    color: '#2456B7',
    fontSize: '14px',
    lineHeight: '22px',
    textDecoration: 'underline',
  },
  primaryButton: {
    backgroundColor: '#2456B7',
    color: '#FFFFFF',
    borderRadius: '10px',
    fontSize: '14px',
    fontWeight: '700',
    textDecoration: 'none',
    padding: '12px 18px',
    display: 'inline-block',
    margin: '0 0 14px',
  },
  secondaryLinkRow: {
    margin: '0 0 8px',
  },
  secondaryLink: {
    color: '#2456B7',
    fontSize: '14px',
    lineHeight: '22px',
    textDecoration: 'underline',
  },
  mutedText: {
    fontSize: '13px',
    lineHeight: '21px',
    color: '#6B7280',
    margin: '0 0 12px',
  },
  closing: {
    fontSize: '15px',
    lineHeight: '24px',
    color: '#4B5563',
    margin: '24px 0 12px',
  },
  signature: {
    fontSize: '15px',
    lineHeight: '24px',
    color: '#111827',
    fontWeight: '700',
    margin: '0',
  },
};

const normalizeSecondaryCtas = (
  primaryCta: WeeklyProgressDigestCta,
  secondaryCtas: readonly WeeklyProgressDigestCta[]
): WeeklyProgressDigestCta[] => {
  const seen = new Set<string>([primaryCta.url]);
  const unique: WeeklyProgressDigestCta[] = [];

  for (const cta of secondaryCtas) {
    if (seen.has(cta.url)) {
      continue;
    }

    seen.add(cta.url);
    unique.push(cta);

    if (unique.length >= 2) {
      break;
    }
  }

  return unique;
};

const getVisibleItems = (items: readonly WeeklyProgressDigestItem[]): WeeklyProgressDigestItem[] => {
  return items.slice(0, 5);
};

const formatStatusTone = (tone: WeeklyProgressDigestItem['statusTone']): string => {
  switch (tone) {
    case 'danger':
      return '#B42318';
    case 'warning':
      return '#B54708';
    case 'success':
      return '#027A48';
  }
};

export const getWeeklyProgressDigestSubject = ({
  lang,
  summary,
}: Pick<WeeklyProgressDigestProps, 'lang' | 'summary'>): string => {
  if (summary.actionNowCount >= 2) {
    return lang === 'ro'
      ? `Ai ${String(summary.actionNowCount)} pasi care merita atentie`
      : `You have ${String(summary.actionNowCount)} steps worth your attention`;
  }

  if (summary.actionNowCount === 1) {
    return lang === 'ro'
      ? 'Ai un pas important de facut saptamana asta'
      : 'You have one important step this week';
  }

  return lang === 'ro'
    ? 'Actualizarea ta saptamanala din campania Funky'
    : 'Your weekly update from the Funky campaign';
};

export const WeeklyProgressDigestEmail = (
  props: WeeklyProgressDigestProps
): React.ReactElement => {
  const copy = COPY_BY_LANG[props.lang];
  const visibleItems = getVisibleItems(props.items);
  const secondaryCtas = normalizeSecondaryCtas(props.primaryCta, props.secondaryCtas);
  const hiddenItemCount =
    props.summary.hiddenItemCount > 0
      ? props.summary.hiddenItemCount
      : Math.max(props.items.length - visibleItems.length, 0);

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
      <Text style={styles.heading}>{copy.heading}</Text>
      <Text style={styles.intro}>{copy.intro}</Text>

      <Section style={styles.summaryPanel}>
        <Text style={styles.summaryText}>
          {copy.summaryLine({
            periodLabel: props.periodLabel,
            totalItemCount: props.summary.totalItemCount,
          })}
        </Text>
        <Text style={{ ...styles.summaryText, margin: '0' }}>
          {copy.actionNowLine(props.summary.actionNowCount)}
        </Text>
      </Section>

      <Text style={styles.sectionHeading}>{copy.changesHeading}</Text>
      {visibleItems.map((item) => {
        const showInlineAction = item.actionUrl !== props.primaryCta.url;

        return (
          <Section key={item.itemKey} style={styles.itemPanel}>
            <Text style={styles.itemHeader}>{item.title}</Text>
            <Text style={styles.itemMeta}>
              <span>{item.entityName}</span>
              <span>{' • '}</span>
              <span style={{ color: formatStatusTone(item.statusTone) }}>{item.statusLabel}</span>
            </Text>
            <Text style={styles.itemDescription}>{item.description}</Text>
            {item.feedbackSnippet !== undefined && item.feedbackSnippet.trim() !== '' ? (
              <>
                <Text style={styles.feedbackLabel}>{copy.feedbackLabel}</Text>
                <Text style={styles.feedbackText}>{item.feedbackSnippet}</Text>
              </>
            ) : null}
            {showInlineAction ? (
              <Link href={item.actionUrl} style={styles.itemLink}>
                {item.actionLabel}
              </Link>
            ) : null}
          </Section>
        );
      })}

      {hiddenItemCount > 0 ? (
        <Text style={styles.mutedText}>{copy.moreUpdatesLine(hiddenItemCount)}</Text>
      ) : null}

      {props.allUpdatesUrl !== undefined && props.allUpdatesUrl !== null ? (
        <Text style={styles.mutedText}>
          <Link href={props.allUpdatesUrl} style={styles.secondaryLink}>
            {copy.allUpdatesLabel}
          </Link>
        </Text>
      ) : null}

      <Text style={styles.sectionHeading}>{copy.nextStepsHeading}</Text>
      <Section>
        <Button href={props.primaryCta.url} style={styles.primaryButton}>
          {props.primaryCta.label}
        </Button>
        {secondaryCtas.map((cta) => (
          <Text key={`${cta.url}:${cta.label}`} style={styles.secondaryLinkRow}>
            <Link href={cta.url} style={styles.secondaryLink}>
              {cta.label}
            </Link>
          </Text>
        ))}
      </Section>

      <Text style={styles.closing}>{copy.closing}</Text>
      <Text style={styles.signature}>{copy.signature}</Text>
    </EmailLayout>
  );
};
