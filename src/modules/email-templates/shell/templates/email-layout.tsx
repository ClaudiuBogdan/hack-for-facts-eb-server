/**
 * Email Layout Component
 *
 * Base layout for all email templates with consistent header/footer.
 */

import {
  Html,
  Head,
  Body,
  Container,
  Section,
  Hr,
  Text,
  Link,
  Preview,
} from '@react-email/components';
// eslint-disable-next-line @typescript-eslint/naming-convention -- React is a third-party naming standard
import * as React from 'react';

import { getTranslations, interpolate } from '../../core/i18n.js';

import type { SupportedLanguage } from '../../core/types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Styles
// ─────────────────────────────────────────────────────────────────────────────

const styles = {
  body: {
    backgroundColor: '#f6f9fc',
    fontFamily:
      '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Ubuntu, sans-serif',
    margin: '0',
    padding: '0',
  },
  container: {
    backgroundColor: '#ffffff',
    borderRadius: '8px',
    margin: '40px auto',
    padding: '20px 0',
    maxWidth: '600px',
  },
  header: {
    padding: '20px 32px',
    textAlign: 'center' as const,
  },
  logo: {
    fontSize: '24px',
    fontWeight: '700',
    color: '#1a1a2e',
    textDecoration: 'none',
  },
  content: {
    padding: '0 32px',
  },
  footer: {
    padding: '20px 32px',
    textAlign: 'center' as const,
  },
  footerText: {
    color: '#8898aa',
    fontSize: '12px',
    lineHeight: '16px',
    margin: '0',
  },
  footerLink: {
    color: '#8898aa',
    textDecoration: 'underline',
  },
  hr: {
    borderColor: '#e6ebf1',
    margin: '20px 0',
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Props
// ─────────────────────────────────────────────────────────────────────────────

export interface EmailLayoutProps {
  /** Language for content */
  lang: SupportedLanguage;
  /** Preview text shown in email list */
  previewText: string;
  /** Unsubscribe URL */
  unsubscribeUrl: string;
  /** Preferences URL (optional) */
  preferencesUrl?: string;
  /** Platform base URL */
  platformBaseUrl: string;
  /** Main content */
  children: React.ReactNode;
}

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

export const EmailLayout: React.FC<EmailLayoutProps> = ({
  lang,
  previewText,
  unsubscribeUrl,
  preferencesUrl,
  platformBaseUrl,
  children,
}) => {
  const t = getTranslations(lang);
  const currentYear = new Date().getFullYear();

  return (
    <Html lang={lang}>
      <Head />
      <Preview>{previewText}</Preview>
      <Body style={styles.body}>
        <Container style={styles.container}>
          {/* Header */}
          <Section style={styles.header}>
            <Link href={platformBaseUrl} style={styles.logo}>
              Transparenta.eu
            </Link>
          </Section>

          {/* Content */}
          <Section style={styles.content}>{children}</Section>

          {/* Footer */}
          <Hr style={styles.hr} />
          <Section style={styles.footer}>
            <Text style={styles.footerText}>
              <Link href={unsubscribeUrl} style={styles.footerLink}>
                {t.common.footer.unsubscribe}
              </Link>
              {preferencesUrl !== undefined && (
                <>
                  {' | '}
                  <Link href={preferencesUrl} style={styles.footerLink}>
                    {t.common.footer.preferences}
                  </Link>
                </>
              )}
            </Text>
            <Text style={styles.footerText}>
              {interpolate(t.common.footer.copyright, { year: currentYear })}
            </Text>
          </Section>
        </Container>
      </Body>
    </Html>
  );
};

export default EmailLayout;
