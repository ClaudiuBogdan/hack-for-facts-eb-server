import { Button, Link, Section, Text } from '@react-email/components';
// eslint-disable-next-line @typescript-eslint/naming-convention -- React is a third-party naming standard
import * as React from 'react';

import { buildCampaignEntityUrl } from '@/common/utils/build-campaign-entity-url.js';

import { CampaignHeader } from './components/campaign-header.js';
import { EmailLayout } from './email-layout.js';
import { getTranslations, interpolate } from '../../core/i18n.js';

import type { PublicDebateEntitySubscriptionProps } from '../../core/types.js';

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
    margin: '0 0 8px',
  },
  value: {
    fontSize: '20px',
    lineHeight: '30px',
    fontWeight: '700',
    color: '#111827',
    margin: '0 0 24px',
  },
  localityItem: {
    fontSize: '14px',
    lineHeight: '24px',
    color: '#374151',
    margin: '0 0 8px',
  },
  benefitItem: {
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
  closing: {
    fontSize: '15px',
    lineHeight: '26px',
    color: '#6B7280',
    margin: '0 0 16px',
  },
};

export const PublicDebateEntitySubscriptionEmail = (
  props: PublicDebateEntitySubscriptionProps
): React.ReactElement => {
  const t = getTranslations(props.lang).publicDebateEntitySubscription;
  const actionUrl = props.ctaUrl ?? buildCampaignEntityUrl(props.platformBaseUrl, props.entityCui);
  const selectedEntities = props.selectedEntities ?? [];
  const updatesIntro = interpolate(t.body.updatesIntro, { entity: props.entityName });

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
      <Text style={styles.greeting}>{t.body.greeting}</Text>
      <Text style={styles.body}>{t.body.intro}</Text>
      <Text style={styles.body}>{updatesIntro}</Text>

      <Section style={styles.panel}>
        <Text style={styles.label}>{t.body.newLocalityLabel}</Text>
        <Text style={styles.value}>{props.entityName}</Text>

        {selectedEntities.length > 0 && (
          <>
            <Text style={styles.label}>{t.body.selectedLocalitiesLabel}</Text>
            {selectedEntities.map((entityName, index) => (
              <Text key={index} style={styles.localityItem}>
                {'\u2022'} {entityName}
              </Text>
            ))}
          </>
        )}
      </Section>

      <Text style={styles.body}>
        {t.body.continuationIntro}
      </Text>
      {t.body.benefits.map((benefit, index) => (
        <Text key={index} style={styles.benefitItem}>
          {'\u2022'} {benefit}
        </Text>
      ))}
      <Text style={styles.benefitItem}>
        {'\u2022'}{' '}
        {props.preferencesUrl !== undefined ? (
          <>
            {t.body.preferencesBulletPrefix}
            <Link href={props.preferencesUrl} style={styles.link}>
              {t.body.preferencesBulletLinkLabel}
            </Link>
            {t.body.preferencesBulletSuffix}
          </>
        ) : (
          t.body.preferencesBulletFallback
        )}
      </Text>

      <Section style={styles.ctaSection}>
        <Button href={actionUrl} style={styles.button}>
          {t.body.cta}
        </Button>
      </Section>

      <Text style={styles.closing}>{t.body.closing}</Text>
      <Text style={styles.signature}>{t.body.signature}</Text>
    </EmailLayout>
  );
};

export default PublicDebateEntitySubscriptionEmail;
