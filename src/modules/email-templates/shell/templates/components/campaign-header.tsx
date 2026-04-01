import { Img, Section, Text } from '@react-email/components';
// eslint-disable-next-line @typescript-eslint/naming-convention -- React is a third-party naming standard
import * as React from 'react';

const FUNKY_LOGO_URL = 'https://funky.ong/wp-content/uploads/2024/03/Funky_RED_RGB-1.png';
const CAMPAIGN_RED = '#ef2d00';

const styles = {
  headerBand: {
    backgroundColor: '#ffffff',
    borderRadius: '12px 12px 0 0',
    padding: '28px 28px 20px',
  },
  topRow: {
    width: '100%',
    borderCollapse: 'collapse' as const,
  },
  hashtagCell: {
    verticalAlign: 'middle' as const,
  },
  hashtag: {
    fontSize: '16px',
    fontWeight: '700',
    color: CAMPAIGN_RED,
    textDecoration: 'underline',
    margin: '0',
    lineHeight: '24px',
  },
  logoCell: {
    verticalAlign: 'middle' as const,
    paddingLeft: '12px',
  },
  logo: {
    display: 'block',
    height: '24px',
    width: 'auto',
  },
  headline: {
    fontSize: '30px',
    lineHeight: '36px',
    fontWeight: '900',
    color: '#111827',
    margin: '16px 0 0',
  },
};

export const CampaignHeader: React.FC = () => (
  <Section style={styles.headerBand} className="email-header">
    <table style={styles.topRow}>
      <tbody>
        <tr>
          <td style={styles.hashtagCell}>
            <Text style={styles.hashtag}>#ProvocareCivic&#259;2026</Text>
          </td>
          <td style={styles.logoCell}>
            <Img
              src={FUNKY_LOGO_URL}
              height="24"
              alt="Funky Citizens"
              style={styles.logo}
            />
          </td>
          <td style={{ width: '99%' }} />
        </tr>
      </tbody>
    </table>
    <Text style={styles.headline}>Cu ochii pe{'\n'}bugetele locale!</Text>
  </Section>
);

export default CampaignHeader;
