import { Hr, Section, Text, Button } from '@react-email/components';
// eslint-disable-next-line @typescript-eslint/naming-convention -- React is a third-party naming standard
import * as React from 'react';

import { CampaignHeader } from './components/campaign-header.js';
import { EmailLayout } from './email-layout.js';
import { getTranslations } from '../../core/i18n.js';

import type { PublicDebateEntitySubscriptionProps } from '../../core/types.js';

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
  checklistHeading: {
    fontSize: '14px',
    lineHeight: '22px',
    fontWeight: '700',
    color: '#111827',
    margin: '0 0 12px',
  },
  checklistItem: {
    fontSize: '14px',
    lineHeight: '24px',
    color: '#374151',
    margin: '0 0 8px',
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

const formatTimestamp = (
  lang: PublicDebateEntitySubscriptionProps['lang'],
  value: string
): string => {
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

export const PublicDebateEntitySubscriptionEmail = (
  props: PublicDebateEntitySubscriptionProps
): React.ReactElement => {
  const t = getTranslations(props.lang).publicDebateEntitySubscription;
  const acceptedTermsAt = formatTimestamp(props.lang, props.acceptedTermsAt);
  const actionUrl = props.ctaUrl ?? `${props.platformBaseUrl}/entities/${props.entityCui}`;

  return (
    <EmailLayout
      lang={props.lang}
      previewText={t.body.intro}
      unsubscribeUrl={props.unsubscribeUrl}
      platformBaseUrl={props.platformBaseUrl}
      copyrightYear={props.copyrightYear}
      header={<CampaignHeader />}
      {...(props.preferencesUrl !== undefined ? { preferencesUrl: props.preferencesUrl } : {})}
    >
      <Text style={styles.heading}>{t.body.greeting}</Text>
      <Text style={styles.body}>{t.body.intro}</Text>

      <Section style={styles.panel}>
        <Text style={styles.label}>{t.body.entityLabel}</Text>
        <Text style={styles.value}>
          {props.entityName} ({props.entityCui})
        </Text>

        <Text style={styles.label}>{t.body.acceptedTermsAtLabel}</Text>
        <Text style={styles.value}>{acceptedTermsAt}</Text>

        <Text style={styles.checklistHeading}>{t.body.whatHappensNextTitle}</Text>
        {t.body.whatHappensNext.map((item, index) => (
          <Text key={index} style={styles.checklistItem}>
            {'\u2022'} {item}
          </Text>
        ))}
      </Section>

      <Section style={styles.ctaSection}>
        <Button href={actionUrl} style={styles.button}>
          {t.body.cta}
        </Button>
      </Section>

      <Hr style={styles.divider} />
      <Text style={styles.closing}>{t.body.closing}</Text>
    </EmailLayout>
  );
};

export default PublicDebateEntitySubscriptionEmail;
