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
  Img,
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
    backgroundColor: '#f0f2f8',
    fontFamily:
      '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Ubuntu, sans-serif',
    margin: '0',
    padding: '0',
  },
  container: {
    backgroundColor: '#ffffff',
    borderRadius: '12px',
    margin: '40px auto',
    padding: '0',
    maxWidth: '600px',
    boxShadow: '0 2px 8px rgba(0, 0, 0, 0.06)',
  },
  headerBand: {
    background: 'linear-gradient(135deg, #2563EB 0%, #7C3AED 50%, #D946EF 100%)',
    backgroundColor: '#5B4FE5',
    borderRadius: '12px 12px 0 0',
    padding: '20px 28px',
  },
  headerTable: {
    width: '100%',
    borderCollapse: 'collapse' as const,
  },
  headerLogoCell: {
    width: '40px',
    verticalAlign: 'middle' as const,
    paddingRight: '14px',
  },
  headerLogo: {
    width: '32px',
    height: '30px',
    display: 'block',
  },
  headerTitleCell: {
    verticalAlign: 'middle' as const,
    textAlign: 'center' as const,
  },
  headerTitle: {
    fontSize: '28px',
    fontWeight: '800',
    color: '#ffffff',
    textDecoration: 'none',
    letterSpacing: '-0.3px',
    lineHeight: '28px',
  },
  content: {
    padding: '32px 32px 24px',
  },
  footer: {
    padding: '20px 32px 28px',
    textAlign: 'center' as const,
  },
  footerText: {
    color: '#9CA3AF',
    fontSize: '12px',
    lineHeight: '18px',
    margin: '0 0 4px',
  },
  footerLink: {
    color: '#6D28D9',
    textDecoration: 'underline',
  },
  hr: {
    borderColor: '#E5E7EB',
    margin: '0 32px',
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
  /** Explicit year used in footer copyright copy */
  copyrightYear: number;
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
  copyrightYear,
  children,
}) => {
  const t = getTranslations(lang);

  return (
    <Html lang={lang}>
      <Head>
        <style
          dangerouslySetInnerHTML={{
            __html: `
              @media only screen and (max-width: 480px) {
                .email-container { border-radius: 0 !important; margin: 0 auto !important; box-shadow: none !important; }
                .email-header { border-radius: 0 !important; }
                .email-content { padding: 20px 16px 16px !important; }
                .email-footer { padding: 16px 16px 20px !important; }
                .email-hr { margin: 0 16px !important; }
                .digest-card { border-radius: 6px !important; margin-left: 0 !important; margin-right: 0 !important; padding: 12px !important; }
              }
            `,
          }}
        />
      </Head>
      <Preview>{previewText}</Preview>
      <Body style={styles.body}>
        <Container style={styles.container} className="email-container">
          {/* Header */}
          <Section style={styles.headerBand} className="email-header">
            <table style={styles.headerTable}>
              <tr>
                <td style={styles.headerLogoCell}>
                  <Link href={platformBaseUrl}>
                    <Img
                      src="https://transparenta.eu/logo.png"
                      width="32"
                      height="30"
                      alt=""
                      style={styles.headerLogo}
                    />
                  </Link>
                </td>
                <td style={styles.headerTitleCell}>
                  <Link href={platformBaseUrl} style={styles.headerTitle}>
                    Transparenta.eu
                  </Link>
                </td>
                <td style={{ width: '40px' }} />
              </tr>
            </table>
          </Section>

          {/* Content */}
          <Section style={styles.content} className="email-content">{children}</Section>

          {/* Footer */}
          <Hr style={styles.hr} className="email-hr" />
          <Section style={styles.footer} className="email-footer">
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
              {interpolate(t.common.footer.copyright, { year: copyrightYear })}
            </Text>
          </Section>
        </Container>
      </Body>
    </Html>
  );
};

export default EmailLayout;
