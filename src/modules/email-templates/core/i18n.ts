/**
 * Email Templates Module - i18n Translations
 *
 * Romanian and English translations for email content.
 */

import type { SupportedLanguage, AlertOperator, NewsletterPeriodType } from './types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Translation Keys
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Common translations used across templates.
 */
export interface CommonTranslations {
  /** Email footer text */
  footer: {
    unsubscribe: string;
    preferences: string;
    poweredBy: string;
    copyright: string;
  };
  /** Generic labels */
  labels: {
    viewDetails: string;
    viewOnline: string;
    loading: string;
  };
}

/**
 * Newsletter template translations.
 */
export interface NewsletterTranslations {
  /** Subject line patterns */
  subject: {
    monthly: string;
    quarterly: string;
    yearly: string;
  };
  /** Email body text */
  body: {
    greeting: string;
    intro: {
      monthly: string;
      quarterly: string;
      yearly: string;
    };
    summaryTitle: string;
    income: string;
    expenses: string;
    balance: string;
    viewFullReport: string;
    closing: string;
  };
  /** Entity info section */
  entityInfo: {
    cui: string;
    county: string;
    population: string;
    populationUnit: string;
  };
  /** Change indicators */
  change: {
    vsLastPeriod: string;
    increase: string;
    decrease: string;
    noChange: string;
  };
  /** Top categories section */
  categories: {
    title: string;
    ofTotal: string;
  };
  /** Funding sources section */
  funding: {
    title: string;
  };
  /** Per capita section */
  perCapita: {
    title: string;
    income: string;
    expenses: string;
  };
  /** Additional CTAs */
  cta: {
    viewOnMap: string;
  };
}

/**
 * Alert template translations.
 */
export interface AlertTranslations {
  /** Subject line */
  subject: string;
  /** Email body text */
  body: {
    greeting: string;
    intro: string;
    conditionsTitle: string;
    viewData: string;
    closing: string;
  };
  /** Operator labels */
  operators: Record<AlertOperator, string>;
}

/**
 * All translations for a language.
 */
export interface Translations {
  common: CommonTranslations;
  newsletter: NewsletterTranslations;
  alert: AlertTranslations;
}

// ─────────────────────────────────────────────────────────────────────────────
// Romanian Translations
// ─────────────────────────────────────────────────────────────────────────────

const ro: Translations = {
  common: {
    footer: {
      unsubscribe: 'Dezabonare',
      preferences: 'Preferințe notificări',
      poweredBy: 'Trimis cu',
      copyright: '© {year} Transparenta.eu',
    },
    labels: {
      viewDetails: 'Vezi detalii',
      viewOnline: 'Vezi online',
      loading: 'Se încarcă...',
    },
  },
  newsletter: {
    subject: {
      monthly: 'Raport lunar {entity} - {period}',
      quarterly: 'Raport trimestrial {entity} - {period}',
      yearly: 'Raport anual {entity} - {period}',
    },
    body: {
      greeting: 'Bună ziua,',
      intro: {
        monthly: 'Iată rezumatul execuției bugetare pentru {entity} în luna {period}.',
        quarterly: 'Iată rezumatul execuției bugetare pentru {entity} în trimestrul {period}.',
        yearly: 'Iată rezumatul execuției bugetare pentru {entity} în anul {period}.',
      },
      summaryTitle: 'Rezumat bugetar',
      income: 'Venituri',
      expenses: 'Cheltuieli',
      balance: 'Sold',
      viewFullReport: 'Vezi raportul complet',
      closing: 'Pentru mai multe detalii, accesați platforma Transparenta.eu.',
    },
    entityInfo: {
      cui: 'CUI',
      county: 'Județ',
      population: 'Populație',
      populationUnit: 'locuitori',
    },
    change: {
      vsLastPeriod: 'vs. perioada anterioară',
      increase: 'creștere',
      decrease: 'scădere',
      noChange: 'fără modificări',
    },
    categories: {
      title: 'Top 5 Categorii de Cheltuieli',
      ofTotal: 'din total',
    },
    funding: {
      title: 'Surse de Finanțare',
    },
    perCapita: {
      title: 'Per Capita',
      income: 'Venituri per locuitor',
      expenses: 'Cheltuieli per locuitor',
    },
    cta: {
      viewOnMap: 'Explorează pe hartă',
    },
  },
  alert: {
    subject: 'Alertă: {title}',
    body: {
      greeting: 'Bună ziua,',
      intro: 'Una sau mai multe condiții ale alertei dumneavoastră au fost îndeplinite:',
      conditionsTitle: 'Condiții declanșate',
      viewData: 'Vezi datele sursă',
      closing: 'Puteți ajusta setările alertei din pagina de preferințe.',
    },
    operators: {
      gt: 'mai mare decât',
      gte: 'mai mare sau egal cu',
      lt: 'mai mic decât',
      lte: 'mai mic sau egal cu',
      eq: 'egal cu',
    },
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// English Translations
// ─────────────────────────────────────────────────────────────────────────────

const en: Translations = {
  common: {
    footer: {
      unsubscribe: 'Unsubscribe',
      preferences: 'Notification preferences',
      poweredBy: 'Sent with',
      copyright: '© {year} Transparenta.eu',
    },
    labels: {
      viewDetails: 'View details',
      viewOnline: 'View online',
      loading: 'Loading...',
    },
  },
  newsletter: {
    subject: {
      monthly: 'Monthly Report {entity} - {period}',
      quarterly: 'Quarterly Report {entity} - {period}',
      yearly: 'Annual Report {entity} - {period}',
    },
    body: {
      greeting: 'Hello,',
      intro: {
        monthly: 'Here is the budget execution summary for {entity} in {period}.',
        quarterly: 'Here is the budget execution summary for {entity} in Q{period}.',
        yearly: 'Here is the budget execution summary for {entity} in {period}.',
      },
      summaryTitle: 'Budget Summary',
      income: 'Income',
      expenses: 'Expenses',
      balance: 'Balance',
      viewFullReport: 'View full report',
      closing: 'For more details, visit Transparenta.eu platform.',
    },
    entityInfo: {
      cui: 'CUI',
      county: 'County',
      population: 'Population',
      populationUnit: 'residents',
    },
    change: {
      vsLastPeriod: 'vs. previous period',
      increase: 'increase',
      decrease: 'decrease',
      noChange: 'no change',
    },
    categories: {
      title: 'Top 5 Spending Categories',
      ofTotal: 'of total',
    },
    funding: {
      title: 'Funding Sources',
    },
    perCapita: {
      title: 'Per Capita',
      income: 'Income per resident',
      expenses: 'Expenses per resident',
    },
    cta: {
      viewOnMap: 'Explore on map',
    },
  },
  alert: {
    subject: 'Alert: {title}',
    body: {
      greeting: 'Hello,',
      intro: 'One or more conditions of your alert have been met:',
      conditionsTitle: 'Triggered conditions',
      viewData: 'View source data',
      closing: 'You can adjust alert settings from the preferences page.',
    },
    operators: {
      gt: 'greater than',
      gte: 'greater than or equal to',
      lt: 'less than',
      lte: 'less than or equal to',
      eq: 'equal to',
    },
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Translation Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * All translations by language.
 */
const translations: Record<SupportedLanguage, Translations> = { ro, en };

/**
 * Gets translations for a language.
 */
export const getTranslations = (lang: SupportedLanguage): Translations => {
  return translations[lang];
};

/**
 * Interpolates variables in a translation string.
 */
export const interpolate = (
  template: string,
  variables: Record<string, string | number>
): string => {
  return Object.entries(variables).reduce((result, [key, value]) => {
    return result.replace(new RegExp(`\\{${key}\\}`, 'g'), String(value));
  }, template);
};

/**
 * Gets the subject line for a newsletter.
 */
export const getNewsletterSubject = (
  lang: SupportedLanguage,
  periodType: NewsletterPeriodType,
  entityName: string,
  periodLabel: string
): string => {
  const t = getTranslations(lang);
  return interpolate(t.newsletter.subject[periodType], {
    entity: entityName,
    period: periodLabel,
  });
};

/**
 * Gets the intro text for a newsletter.
 */
export const getNewsletterIntro = (
  lang: SupportedLanguage,
  periodType: NewsletterPeriodType,
  entityName: string,
  periodLabel: string
): string => {
  const t = getTranslations(lang);
  return interpolate(t.newsletter.body.intro[periodType], {
    entity: entityName,
    period: periodLabel,
  });
};

/**
 * Gets the subject line for an alert.
 */
export const getAlertSubject = (lang: SupportedLanguage, title: string): string => {
  const t = getTranslations(lang);
  return interpolate(t.alert.subject, { title });
};

/**
 * Gets the operator label.
 */
export const getOperatorLabel = (lang: SupportedLanguage, operator: AlertOperator): string => {
  const t = getTranslations(lang);
  return t.alert.operators[operator];
};
