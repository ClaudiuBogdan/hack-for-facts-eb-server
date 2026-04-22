import { Section, Text, Button, Hr } from '@react-email/components';
// eslint-disable-next-line @typescript-eslint/naming-convention -- React is a third-party naming standard
import * as React from 'react';

import { EmailLayout } from './email-layout.js';
import { formatTemplateTimestamp } from './formatting.js';
import { getTranslations } from '../../core/i18n.js';

import type { WelcomeEmailProps } from '../../core/types.js';

const styles = {
  greeting: {
    fontSize: '22px',
    lineHeight: '32px',
    fontWeight: '600',
    color: '#1F2937',
    margin: '0 0 8px',
  },
  body: {
    fontSize: '15px',
    lineHeight: '26px',
    color: '#4B5563',
    margin: '0 0 16px',
  },
  ctaSection: {
    margin: '32px 0 28px',
    textAlign: 'center' as const,
  },
  button: {
    backgroundColor: '#4F46E5',
    borderRadius: '8px',
    color: '#ffffff',
    fontSize: '15px',
    fontWeight: '600',
    textDecoration: 'none',
    textAlign: 'center' as const,
    display: 'inline-block',
    padding: '14px 32px',
  },
  closing: {
    fontSize: '13px',
    lineHeight: '22px',
    color: '#9CA3AF',
    margin: '0',
  },
  closingHr: {
    borderColor: '#E5E7EB',
    margin: '24px 0 16px',
  },
};

export const WelcomeEmail = ({
  lang,
  unsubscribeUrl,
  preferencesUrl,
  platformBaseUrl,
  copyrightYear,
  registeredAt,
  ctaUrl,
}: WelcomeEmailProps): React.ReactElement => {
  const t = getTranslations(lang);
  const previewText = t.welcome.body.intro;
  const actionUrl = ctaUrl ?? platformBaseUrl;
  const registeredAtDate = new Date(registeredAt);
  const formattedRegisteredAt = Number.isNaN(registeredAtDate.getTime())
    ? registeredAt
    : formatTemplateTimestamp(registeredAt);

  return (
    <EmailLayout
      lang={lang}
      previewText={previewText}
      unsubscribeUrl={unsubscribeUrl}
      platformBaseUrl={platformBaseUrl}
      copyrightYear={copyrightYear}
      {...(preferencesUrl !== undefined ? { preferencesUrl } : {})}
    >
      <Text style={styles.greeting}>{t.welcome.body.greeting}</Text>
      <Text style={styles.body}>{t.welcome.body.intro}</Text>
      <Text style={styles.body}>
        <strong>{t.welcome.body.registeredAtLabel}:</strong> {formattedRegisteredAt}
      </Text>
      <table
        width="100%"
        cellPadding="0"
        cellSpacing="0"
        border={0}
        style={{
          backgroundColor: '#F5F3FF',
          borderLeft: '3px solid #7C3AED',
          borderRadius: '0 8px 8px 0',
          margin: '0 0 16px',
        }}
      >
        <tbody>
          {t.welcome.body.benefits.map((benefit, index) => (
            <tr key={index}>
              <td
                style={{
                  width: '28px',
                  paddingLeft: '18px',
                  paddingTop: index === 0 ? '14px' : '4px',
                  paddingBottom: index === t.welcome.body.benefits.length - 1 ? '14px' : '4px',
                  verticalAlign: 'top',
                  color: '#7C3AED',
                  fontSize: '15px',
                  lineHeight: '22px',
                }}
              >
                {'\u2713'}
              </td>
              <td
                style={{
                  paddingRight: '18px',
                  paddingTop: index === 0 ? '14px' : '4px',
                  paddingBottom: index === t.welcome.body.benefits.length - 1 ? '14px' : '4px',
                  fontSize: '15px',
                  lineHeight: '22px',
                  color: '#4B5563',
                }}
              >
                {benefit}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <Section style={styles.ctaSection}>
        <Button href={actionUrl} style={styles.button}>
          {t.welcome.body.cta}
        </Button>
      </Section>
      <Hr style={styles.closingHr} />
      <Text style={styles.closing}>{t.welcome.body.closing}</Text>
    </EmailLayout>
  );
};

export default WelcomeEmail;
