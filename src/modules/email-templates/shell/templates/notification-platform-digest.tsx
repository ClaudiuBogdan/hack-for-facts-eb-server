import { Button, Link, Section, Text } from '@react-email/components';
// eslint-disable-next-line @typescript-eslint/naming-convention -- React is a third-party naming standard
import * as React from 'react';

import { EmailLayout } from './email-layout.js';

import type { NotificationPlatformDigestProps } from '../../core/types.js';

const styles = {
  heading: {
    color: '#111827',
    fontSize: '24px',
    fontWeight: '700',
    lineHeight: '32px',
    margin: '0 0 12px',
  },
  intro: {
    color: '#4B5563',
    fontSize: '15px',
    lineHeight: '24px',
    margin: '0 0 22px',
  },
  item: {
    backgroundColor: '#FFFFFF',
    border: '1px solid #E5E7EB',
    borderRadius: '10px',
    margin: '0 0 12px',
    padding: '15px 17px',
  },
  itemTitle: {
    color: '#111827',
    fontSize: '16px',
    fontWeight: '700',
    lineHeight: '23px',
    margin: '0 0 6px',
  },
  itemSummary: {
    color: '#4B5563',
    fontSize: '14px',
    lineHeight: '22px',
    margin: '0 0 8px',
  },
  itemLink: {
    color: '#2456B7',
    fontSize: '14px',
    lineHeight: '22px',
    textDecoration: 'underline',
  },
  overflow: {
    color: '#4B5563',
    fontSize: '14px',
    lineHeight: '22px',
    margin: '16px 0',
  },
  overflowLink: {
    color: '#2456B7',
    fontWeight: '600',
    textDecoration: 'underline',
  },
  buttonSection: {
    margin: '24px 0 8px',
    textAlign: 'center' as const,
  },
  button: {
    backgroundColor: '#2456B7',
    borderRadius: '9px',
    color: '#FFFFFF',
    fontSize: '14px',
    fontWeight: '700',
    padding: '12px 18px',
    textDecoration: 'none',
  },
};

export const getNotificationPlatformDigestSubject = (): string => 'Rezumatul notificărilor tale';

export const NotificationPlatformDigestEmail = (
  props: NotificationPlatformDigestProps
): React.ReactElement => (
  <EmailLayout
    lang={props.lang}
    previewText="Ai noutăți în inboxul Transparenta.eu."
    unsubscribeUrl={props.unsubscribeUrl}
    {...(props.preferencesUrl === undefined ? {} : { preferencesUrl: props.preferencesUrl })}
    platformBaseUrl={props.platformBaseUrl}
    copyrightYear={props.copyrightYear}
  >
    <Text style={styles.heading}>Noutățile tale de pe Transparenta.eu</Text>
    <Text style={styles.intro}>
      Am adunat într-un singur mesaj cele mai recente notificări pentru tine.
    </Text>

    {props.items.map((item, index) => (
      <Section key={`${String(index)}-${item.title}`} style={styles.item} className="digest-card">
        <Text style={styles.itemTitle}>{item.title}</Text>
        <Text style={styles.itemSummary}>{item.summary}</Text>
        {item.actionUrl === null ? null : (
          <Link href={item.actionUrl} style={styles.itemLink}>
            Vezi detaliile
          </Link>
        )}
      </Section>
    ))}

    {props.overflowCount > 0 ? (
      <Text style={styles.overflow}>
        <Link href={props.inboxUrl} style={styles.overflowLink}>
          și încă {String(props.overflowCount)} în inbox
        </Link>
      </Text>
    ) : null}

    <Section style={styles.buttonSection}>
      <Button href={props.inboxUrl} style={styles.button}>
        Vezi toate notificările
      </Button>
    </Section>
  </EmailLayout>
);

export default NotificationPlatformDigestEmail;
