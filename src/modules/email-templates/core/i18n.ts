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
    modulesIntro: string;
    localityLabel: string;
    cta: string;
    preferencesPrefix: string;
    preferencesLinkLabel: string;
    preferencesSuffix: string;
    preferencesFallback: string;
    closing: string;
    signature: string;
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
    updatesIntro: string;
    newLocalityLabel: string;
    selectedLocalitiesLabel: string;
    continuationIntro: string;
    benefits: string[];
    preferencesBulletPrefix: string;
    preferencesBulletLinkLabel: string;
    preferencesBulletSuffix: string;
    preferencesBulletFallback: string;
    cta: string;
    closing: string;
    signature: string;
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
    subject:
      'Bun venit în provocarea civică „Cu ochii pe bugetele locale 2026” - Funky Citizens x Transparenta.eu',
    body: {
      greeting: 'Salutare,',
      intro:
        'Îți mulțumim că te-ai înscris în provocarea civică „Cu ochii pe bugetele locale 2026”, o campanie realizată de Funky Citizens & Transparenta.eu',
      modulesIntro:
        'Participarea ta reprezintă un pas important spre a înțelege mai bine cum sunt planificați și cheltuiți banii publici în localitatea ta, dar și cum poți interveni informat(ă) în dezbaterea bugetului local. În perioada următoare, te invităm să parcurgi cele trei module din platformă, care te vor ghida pas cu pas în înțelegerea bugetelor publice.',
      localityLabel: 'Localitatea selectată de tine este:',
      cta: 'Vezi localitatea în platformă',
      preferencesPrefix:
        'Dacă dorești să parcurgi modulele pentru mai multe localități, poți schimba preferința din ',
      preferencesLinkLabel: 'această pagină',
      preferencesSuffix: '.',
      preferencesFallback:
        'Dacă dorești să parcurgi modulele pentru mai multe localități, poți schimba preferința din pagina de preferințe.',
      closing: 'Îți mulțumim că alegi să fii cu ochii pe bugetul local. Mult succes!',
      signature: 'Echipa Funky & Transparenta.eu',
    },
  },
  publicDebateEntitySubscription: {
    subject:
      'Ai ales o nouă localitate în provocarea civică „Cu ochii pe bugetele locale 2026” - Funky Citizens x Transparenta.eu',
    body: {
      greeting: 'Salutare,',
      intro: 'Am înregistrat modificarea făcută de tine în platformă.',
      updatesIntro:
        'De acum înainte, vei primi informații și actualizări legate de {entity}, în cadrul provocării civice „Cu ochii pe bugetele locale 2026”.',
      newLocalityLabel: 'Noua localitate selectată de tine este:',
      selectedLocalitiesLabel: 'Localitățile selectate de tine:',
      continuationIntro:
        'Te invităm să continui provocarea civică, dacă nu ai parcurs toate modulele. În continuare:',
      benefits: [
        'Primești email când există actualizări despre cererea de dezbatere publică;',
        'Poți urmări mai multe localități în aceeași campanie;',
      ],
      preferencesBulletPrefix: 'Poți opri notificările din ',
      preferencesBulletLinkLabel: 'preferințe',
      preferencesBulletSuffix: ' în orice moment.',
      preferencesBulletFallback: 'Poți opri notificările din preferințe în orice moment.',
      cta: 'Vezi localitatea în platformă',
      closing: 'Pe curând,',
      signature: 'Echipa Funky x Transparenta.eu',
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
    subject:
      'Welcome to the civic challenge "Cu ochii pe bugetele locale 2026" - Funky Citizens x Transparenta.eu',
    body: {
      greeting: 'Hello,',
      intro:
        'Thank you for joining the civic challenge "Cu ochii pe bugetele locale 2026", a campaign by Funky Citizens & Transparenta.eu.',
      modulesIntro:
        'Your participation is an important step toward better understanding how public money is planned and spent in your locality, and how you can take part in the local budget debate in an informed way. In the coming period, we invite you to go through the three modules on the platform, which will guide you step by step through public budget understanding.',
      localityLabel: 'Your selected locality is:',
      cta: 'View locality on the platform',
      preferencesPrefix:
        'If you want to go through the modules for more localities, you can change your preference on ',
      preferencesLinkLabel: 'this page',
      preferencesSuffix: '.',
      preferencesFallback:
        'If you want to go through the modules for more localities, you can change your preference from the preferences page.',
      closing: 'Thank you for choosing to keep an eye on the local budget. Good luck!',
      signature: 'The Funky & Transparenta.eu team',
    },
  },
  publicDebateEntitySubscription: {
    subject:
      'You selected a new locality in the civic challenge "Cu ochii pe bugetele locale 2026" - Funky Citizens x Transparenta.eu',
    body: {
      greeting: 'Hello,',
      intro: 'We recorded the change you made on the platform.',
      updatesIntro:
        'From now on, you will receive information and updates related to {entity} as part of the civic challenge "Cu ochii pe bugetele locale 2026".',
      newLocalityLabel: 'Your newly selected locality is:',
      selectedLocalitiesLabel: 'Your selected localities:',
      continuationIntro:
        'We invite you to continue the civic challenge if you have not completed all the modules yet. Next:',
      benefits: [
        'You receive email when there are updates about the public debate request;',
        'You can follow multiple localities in the same campaign;',
      ],
      preferencesBulletPrefix: 'You can stop notifications from ',
      preferencesBulletLinkLabel: 'preferences',
      preferencesBulletSuffix: ' at any time.',
      preferencesBulletFallback: 'You can stop notifications from preferences at any time.',
      cta: 'View locality on the platform',
      closing: 'See you soon,',
      signature: 'The Funky x Transparenta.eu team',
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
