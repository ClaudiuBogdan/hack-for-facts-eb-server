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
  /** Condition labels */
  condition: {
    threshold: string;
    actualValue: string;
  };
}

/**
 * Welcome template translations.
 */
export interface WelcomeTranslations {
  subject: string;
  body: {
    greeting: string;
    intro: string;
    registeredAtLabel: string;
    benefits: string[];
    cta: string;
    closing: string;
  };
}

/**
 * Public debate campaign welcome translations.
 */
export interface PublicDebateCampaignWelcomeTranslations {
  subject: string;
  body: {
    greeting: string;
    intro: string;
    entityLabel: string;
    acceptedTermsAtLabel: string;
    benefits: string[];
    cta: string;
    closing: string;
  };
}

/**
 * Public debate entity subscription translations.
 */
export interface PublicDebateEntitySubscriptionTranslations {
  subject: string;
  body: {
    greeting: string;
    intro: string;
    entityLabel: string;
    acceptedTermsAtLabel: string;
    whatHappensNextTitle: string;
    whatHappensNext: string[];
    cta: string;
    closing: string;
  };
}

/**
 * Digest template translations.
 */
export interface DigestTranslations {
  /** Subject line with {period} placeholder */
  subject: string;
  /** Email body text */
  body: {
    heading: string;
    intro: string;
    summaryBadge: string;
  };
  /** Section labels and links */
  sections: {
    entityReport: string;
    alert: string;
    period: string;
    income: string;
    expenses: string;
    balance: string;
    viewFullReport: string;
    viewSourceData: string;
    topCategories: string;
  };
  /** Condition labels */
  condition: {
    threshold: string;
    actualValue: string;
  };
  /** Alert status labels */
  alertStatus: {
    triggered: string;
    monitoring: string;
    currentValue: string;
  };
}

/**
 * All translations for a language.
 */
export interface Translations {
  common: CommonTranslations;
  newsletter: NewsletterTranslations;
  alert: AlertTranslations;
  welcome: WelcomeTranslations;
  publicDebateCampaignWelcome: PublicDebateCampaignWelcomeTranslations;
  publicDebateEntitySubscription: PublicDebateEntitySubscriptionTranslations;
  digest: DigestTranslations;
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
    condition: {
      threshold: 'Valoare',
      actualValue: 'Valoare reală',
    },
  },
  welcome: {
    subject: 'Bun venit pe Transparenta.eu',
    body: {
      greeting: 'Bună ziua!',
      intro:
        'Contul tău pe Transparenta.eu este activ. Aici poți vedea cum sunt cheltuiți banii publici în România, pe baza datelor oficiale de execuție bugetară.',
      registeredAtLabel: 'Cont creat la',
      benefits: [
        'Urmărește primării și instituții publice',
        'Setează alerte pe indicatori bugetari',
        'Primește rapoarte periodice direct pe email',
      ],
      cta: 'Explorează platforma',
      closing: 'Dacă nu ai solicitat crearea acestui cont, poți ignora acest mesaj.',
    },
  },
  publicDebateCampaignWelcome: {
    subject: 'Ai intrat în campania de dezbatere publică',
    body: {
      greeting: 'Bun venit în campanie!',
      intro:
        'Ai acceptat termenii campaniei de dezbatere publică și urmărirea pentru prima entitate este activă.',
      entityLabel: 'Prima entitate urmărită',
      acceptedTermsAtLabel: 'Înscriere confirmată la',
      benefits: [
        'Primești email când există actualizări despre cererea de dezbatere publică',
        'Poți urmări mai multe instituții în aceeași campanie',
        'Poți opri notificările din preferințe în orice moment',
      ],
      cta: 'Vezi entitatea pe platformă',
      closing: 'Îți vom trimite următoarele mesaje doar pentru actualizările din această campanie.',
    },
  },
  publicDebateEntitySubscription: {
    subject: 'Abonare nouă la o instituție din campanie',
    body: {
      greeting: 'Abonare confirmată',
      intro:
        'Ai acceptat termenii pentru încă o entitate și vom trimite actualizări despre evoluția cererii de dezbatere publică pentru aceasta.',
      entityLabel: 'Entitate urmărită',
      acceptedTermsAtLabel: 'Abonare confirmată la',
      whatHappensNextTitle: 'Ce urmează',
      whatHappensNext: [
        'Primești email când cererea este trimisă sau dacă apar probleme la trimitere',
        'Primești email când instituția răspunde',
        'Primești email când răspunsul este revizuit și starea firului se schimbă',
      ],
      cta: 'Vezi entitatea pe platformă',
      closing:
        'Dacă nu mai vrei aceste actualizări, poți dezactiva notificările pentru entitate din preferințe.',
    },
  },
  digest: {
    subject: 'Actualizare date ANAF / Forexebug - {period}',
    body: {
      heading: 'Actualizare date ANAF / Forexebug',
      intro:
        'Date noi de execuție bugetară sunt disponibile pentru {period}, pe baza raportărilor ANAF / Forexebug.',
      summaryBadge: '{reports} rapoarte \u00b7 {alerts} alerte',
    },
    sections: {
      entityReport: 'Raport entitate',
      alert: 'Alertă',
      period: 'Perioada',
      income: 'Venituri',
      expenses: 'Cheltuieli',
      balance: 'Sold',
      viewFullReport: 'Vezi raportul complet \u2192',
      viewSourceData: 'Vezi datele sursă \u2192',
      topCategories: 'Top cheltuieli',
    },
    condition: {
      threshold: 'Valoare',
      actualValue: 'Valoare reală',
    },
    alertStatus: {
      triggered: 'Condiție îndeplinită',
      monitoring: 'Monitorizare activă',
      currentValue: 'Valoare curentă',
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
    condition: {
      threshold: 'Value',
      actualValue: 'Actual value',
    },
  },
  welcome: {
    subject: 'Welcome to Transparenta.eu',
    body: {
      greeting: 'Hello!',
      intro:
        'Your account on Transparenta.eu is active. Here you can see how public money is spent in Romania, based on official budget execution data.',
      registeredAtLabel: 'Account created on',
      benefits: [
        'Follow municipalities and public institutions',
        'Set alerts on budget indicators',
        'Receive periodic reports directly by email',
      ],
      cta: 'Explore the platform',
      closing: 'If you did not request this account, you can ignore this message.',
    },
  },
  publicDebateCampaignWelcome: {
    subject: 'You joined the public debate campaign',
    body: {
      greeting: 'Welcome to the campaign!',
      intro:
        'You accepted the campaign terms and your first public debate campaign follow is now active.',
      entityLabel: 'First followed entity',
      acceptedTermsAtLabel: 'Enrollment confirmed at',
      benefits: [
        'You receive email updates when the public debate request changes state',
        'You can follow multiple institutions in the same campaign',
        'You can pause campaign notifications from preferences at any time',
      ],
      cta: 'View entity on the platform',
      closing: 'We will only send follow-up messages for updates that belong to this campaign.',
    },
  },
  publicDebateEntitySubscription: {
    subject: 'New institution follow confirmed',
    body: {
      greeting: 'Subscription confirmed',
      intro:
        'You accepted the terms for another entity and we will send updates about that public debate request as well.',
      entityLabel: 'Followed entity',
      acceptedTermsAtLabel: 'Subscription confirmed at',
      whatHappensNextTitle: 'What happens next',
      whatHappensNext: [
        'You receive email when the request is sent or if sending fails',
        'You receive email when the institution replies',
        'You receive email when the reply is reviewed and the thread status changes',
      ],
      cta: 'View entity on the platform',
      closing:
        'If you no longer want these updates, you can disable notifications for this entity from preferences.',
    },
  },
  digest: {
    subject: 'ANAF / Forexebug data update - {period}',
    body: {
      heading: 'ANAF / Forexebug data update',
      intro:
        'New budget execution data is available for {period}, based on ANAF / Forexebug reports.',
      summaryBadge: '{reports} reports \u00b7 {alerts} alerts',
    },
    sections: {
      entityReport: 'Entity report',
      alert: 'Alert',
      period: 'Period',
      income: 'Income',
      expenses: 'Expenses',
      balance: 'Balance',
      viewFullReport: 'View full report \u2192',
      viewSourceData: 'View source data \u2192',
      topCategories: 'Top expenses',
    },
    condition: {
      threshold: 'Value',
      actualValue: 'Actual value',
    },
    alertStatus: {
      triggered: 'Condition met',
      monitoring: 'Active monitoring',
      currentValue: 'Current value',
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
 * Gets the subject line for a welcome email.
 */
export const getWelcomeSubject = (lang: SupportedLanguage): string => {
  return getTranslations(lang).welcome.subject;
};

/**
 * Gets the subject line for the first public debate campaign welcome email.
 */
export const getPublicDebateCampaignWelcomeSubject = (lang: SupportedLanguage): string => {
  return getTranslations(lang).publicDebateCampaignWelcome.subject;
};

/**
 * Gets the subject line for a public debate entity subscription email.
 */
export const getPublicDebateEntitySubscriptionSubject = (lang: SupportedLanguage): string => {
  return getTranslations(lang).publicDebateEntitySubscription.subject;
};

/**
 * Gets the operator label.
 */
export const getOperatorLabel = (lang: SupportedLanguage, operator: AlertOperator): string => {
  const t = getTranslations(lang);
  return t.alert.operators[operator];
};

/**
 * Gets the subject line for a digest email.
 */
export const getDigestSubject = (lang: SupportedLanguage, periodLabel: string): string => {
  const t = getTranslations(lang);
  return interpolate(t.digest.subject, { period: periodLabel });
};

/**
 * Gets the summary badge text for a digest (e.g., "3 rapoarte · 2 alerte").
 */
export const getDigestSummaryBadge = (
  lang: SupportedLanguage,
  reportCount: number,
  alertCount: number
): string => {
  const t = getTranslations(lang);
  return interpolate(t.digest.body.summaryBadge, {
    reports: reportCount,
    alerts: alertCount,
  });
};
