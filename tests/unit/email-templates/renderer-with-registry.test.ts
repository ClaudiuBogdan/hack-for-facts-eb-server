import pinoLogger from 'pino';
import { describe, expect, it } from 'vitest';

import { makeEmailRenderer } from '@/modules/email-templates/shell/renderer/index.js';

import type {
  WelcomeEmailProps,
  AlertSeriesProps,
  AnafForexebugDigestProps,
  NewsletterEntityProps,
  PublicDebateCampaignWelcomeProps,
  PublicDebateEntitySubscriptionProps,
  PublicDebateEntityUpdateProps,
} from '@/modules/email-templates/core/types.js';

const testLogger = pinoLogger({ level: 'silent' });

describe('EmailRenderer (registry-backed)', () => {
  const renderer = makeEmailRenderer({ logger: testLogger });

  it('renders welcome template successfully', async () => {
    const props: WelcomeEmailProps = {
      templateType: 'welcome',
      lang: 'ro',
      unsubscribeUrl: 'https://transparenta.eu/unsub/token',
      platformBaseUrl: 'https://transparenta.eu',
      copyrightYear: 2026,
      registeredAt: '2026-03-28T15:00:00.000Z',
    };

    const result = await renderer.render(props);
    expect(result.isOk()).toBe(true);

    const rendered = result._unsafeUnwrap();
    expect(rendered.subject).toBe('Bun venit pe Transparenta.eu');
    expect(rendered.html).toContain('Bună ziua!');
    expect(rendered.html).toContain('Cont creat la');
    expect(rendered.html).toContain('2026');
    expect(rendered.html).toContain('Transparenta.eu');
    expect(rendered.text.length).toBeGreaterThan(0);
    expect(rendered.templateName).toBe('welcome');
    expect(rendered.templateVersion).toBe('1.0.0');
  });

  it('renders alert_series template successfully', async () => {
    const props: AlertSeriesProps = {
      templateType: 'alert_series',
      lang: 'ro',
      unsubscribeUrl: 'https://transparenta.eu/unsub/token',
      platformBaseUrl: 'https://transparenta.eu',
      copyrightYear: 2026,
      title: 'Test alert',
      triggeredConditions: [{ operator: 'gt', threshold: '100', actualValue: '150', unit: 'RON' }],
    };

    const result = await renderer.render(props);
    expect(result.isOk()).toBe(true);

    const rendered = result._unsafeUnwrap();
    expect(rendered.templateName).toBe('alert_series');
  });

  it('renders public_debate_campaign_welcome template successfully', async () => {
    const props: PublicDebateCampaignWelcomeProps = {
      templateType: 'public_debate_campaign_welcome',
      lang: 'ro',
      unsubscribeUrl: 'https://transparenta.eu/unsub/token',
      preferencesUrl: 'https://transparenta.eu/provocare/notificari',
      platformBaseUrl: 'https://transparenta.eu',
      copyrightYear: 2026,
      campaignKey: 'funky',
      entityCui: '12345678',
      entityName: 'Primăria Municipiului Exemplu',
      acceptedTermsAt: '2026-04-01T10:00:00.000Z',
    };

    const result = await renderer.render(props);
    expect(result.isOk()).toBe(true);

    const rendered = result._unsafeUnwrap();
    expect(rendered.subject).toBe(
      'Bun venit în provocarea civică „Cu ochii pe bugetele locale 2026” - Funky Citizens x Transparenta.eu'
    );
    expect(rendered.html).toContain('Salutare,');
    expect(rendered.html).toContain('Vezi localitatea în platformă');
    expect(rendered.html).toContain('această pagină');
    expect(rendered.html).toContain('Primăria Municipiului Exemplu');
    expect(rendered.templateName).toBe('public_debate_campaign_welcome');
  });

  it('renders public_debate_entity_subscription template successfully', async () => {
    const props: PublicDebateEntitySubscriptionProps = {
      templateType: 'public_debate_entity_subscription',
      lang: 'ro',
      unsubscribeUrl: 'https://transparenta.eu/unsub/token',
      preferencesUrl: 'https://transparenta.eu/provocare/notificari',
      platformBaseUrl: 'https://transparenta.eu',
      copyrightYear: 2026,
      campaignKey: 'funky',
      entityCui: '87654321',
      entityName: 'Municipiul Exemplu',
      acceptedTermsAt: '2026-04-02T11:00:00.000Z',
      selectedEntities: ['Municipiul Exemplu', 'Municipiul Test'],
    };

    const result = await renderer.render(props);
    expect(result.isOk()).toBe(true);

    const rendered = result._unsafeUnwrap();
    expect(rendered.subject).toBe(
      'Ai ales o nouă localitate în provocarea civică „Cu ochii pe bugetele locale 2026” - Funky Citizens x Transparenta.eu'
    );
    expect(rendered.html).toContain('Salutare,');
    expect(rendered.html).toContain('Localitățile selectate de tine:');
    expect(rendered.html).toContain('Municipiul Exemplu');
    expect(rendered.html).toContain('Municipiul Test');
    expect(rendered.templateName).toBe('public_debate_entity_subscription');
  });

  it('renders public_debate_entity_update template successfully', async () => {
    const props: PublicDebateEntityUpdateProps = {
      templateType: 'public_debate_entity_update',
      lang: 'ro',
      unsubscribeUrl: 'https://transparenta.eu/unsub/token',
      preferencesUrl: 'https://transparenta.eu/provocare/notificari',
      platformBaseUrl: 'https://transparenta.eu',
      copyrightYear: 2026,
      eventType: 'reply_received',
      campaignKey: 'funky',
      entityCui: '87654321',
      entityName: 'Municipiul Exemplu',
      threadId: 'thread-1',
      threadKey: 'thread-key-1',
      phase: 'reply_received_unreviewed',
      institutionEmail: 'contact@primarie.ro',
      subjectLine: 'Solicitare organizare dezbatere publica - buget local 2026',
      occurredAt: '2026-04-03T10:00:00.000Z',
      replyTextPreview: 'Va comunicam ca solicitarea a fost primita.',
    };

    const result = await renderer.render(props);
    expect(result.isOk()).toBe(true);

    const rendered = result._unsafeUnwrap();
    expect(rendered.subject).toBe(
      'A sosit un răspuns: Municipiul Exemplu - „Cu ochii pe bugetele locale 2026”'
    );
    expect(rendered.html).toContain('Salutare,');
    expect(rendered.text).toContain('Primăria din Municipiul Exemplu a trimis un răspuns.');
    expect(rendered.html).toContain('A sosit un răspuns');
    expect(rendered.text).toContain(
      'Pentru participarea la dezbatere, îți recomandăm să parcurgi atât proiectul de buget, cât și execuția anilor precedenți.'
    );
    expect(rendered.text).toContain('Mulțumim că ești parte din această provocare civică!');
    expect(rendered.templateName).toBe('public_debate_entity_update');
  });

  it('renders public_debate_entity_update failed-send copy accurately', async () => {
    const props: PublicDebateEntityUpdateProps = {
      templateType: 'public_debate_entity_update',
      lang: 'ro',
      unsubscribeUrl: 'https://transparenta.eu/unsub/token',
      preferencesUrl: 'https://transparenta.eu/provocare/notificari',
      platformBaseUrl: 'https://transparenta.eu',
      copyrightYear: 2026,
      eventType: 'thread_failed',
      campaignKey: 'funky',
      entityCui: '87654321',
      entityName: 'Municipiul Exemplu',
      threadId: 'thread-1',
      threadKey: 'thread-key-1',
      phase: 'thread_failed',
      institutionEmail: 'contact@primarie.ro',
      subjectLine: 'Solicitare organizare dezbatere publica - buget local 2026',
      occurredAt: '2026-04-03T10:00:00.000Z',
    };

    const result = await renderer.render(props);
    expect(result.isOk()).toBe(true);

    const rendered = result._unsafeUnwrap();
    expect(rendered.subject).toBe(
      'Trimiterea a eșuat: Municipiul Exemplu - „Cu ochii pe bugetele locale 2026”'
    );
    expect(rendered.text).toContain(
      'A apărut o problemă la trimiterea cererii pentru organizarea unei dezbateri publice în Municipiul Exemplu.'
    );
    expect(rendered.text).not.toContain(
      'Cererea ta pentru organizarea unei dezbateri publice în Municipiul Exemplu a fost trimisă către Primărie.'
    );
    expect(rendered.html).toContain('Trimiterea a eșuat');
  });

  it('renders anaf_forexebug_digest template successfully', async () => {
    const props: AnafForexebugDigestProps = {
      templateType: 'anaf_forexebug_digest',
      lang: 'ro',
      unsubscribeUrl: 'https://transparenta.eu/unsub/token',
      preferencesUrl: 'https://transparenta.eu/settings/notifications',
      platformBaseUrl: 'https://transparenta.eu',
      copyrightYear: 2026,
      periodKey: '2026-03',
      periodLabel: 'martie 2026',
      sections: [
        {
          kind: 'newsletter_entity',
          notificationId: 'notification-1',
          notificationType: 'newsletter_entity_monthly',
          entityName: 'Primaria Test',
          entityCui: '123',
          periodLabel: 'martie 2026',
          summary: {
            totalIncome: '100',
            totalExpenses: '50',
            budgetBalance: '50',
            currency: 'RON',
          },
        },
      ],
    };

    const result = await renderer.render(props);
    expect(result.isOk()).toBe(true);

    const rendered = result._unsafeUnwrap();
    expect(rendered.templateName).toBe('anaf_forexebug_digest');
  });

  it('renders anaf_forexebug_digest with both report and alert sections', async () => {
    const props: AnafForexebugDigestProps = {
      templateType: 'anaf_forexebug_digest',
      lang: 'ro',
      unsubscribeUrl: 'https://transparenta.eu/unsub/token',
      preferencesUrl: 'https://transparenta.eu/settings/notifications',
      platformBaseUrl: 'https://transparenta.eu',
      copyrightYear: 2026,
      periodKey: '2026-03',
      periodLabel: 'martie 2026',
      sections: [
        {
          kind: 'newsletter_entity',
          notificationId: 'notification-1',
          notificationType: 'newsletter_entity_monthly',
          entityName: 'Municipiul Sibiu',
          entityCui: '4240600',
          periodLabel: 'martie 2026',
          summary: {
            totalIncome: '280050000',
            totalExpenses: '182370000',
            budgetBalance: '97680000',
            currency: 'RON',
          },
          previousPeriodComparison: {
            incomeChangePercent: '12.3',
            expensesChangePercent: '8.7',
            balanceChangePercent: '23.1',
          },
          topExpenseCategories: [
            { name: 'Învățământ', amount: '45200000', percentage: '24.8' },
            { name: 'Sănătate', amount: '32100000', percentage: '17.6' },
          ],
          detailsUrl: 'https://transparenta.eu/entities/4240600',
        },
        {
          kind: 'alert_series',
          notificationId: 'notification-2',
          notificationType: 'alert_series_analytics',
          title: 'Cheltuieli neobișnuite detectate',
          description: 'Au fost detectate cheltuieli care depășesc pragurile normale.',
          actualValue: '1500000',
          unit: 'RON',
          triggeredConditions: [
            { operator: 'gt', threshold: '1000000', actualValue: '1500000', unit: 'RON' },
          ],
          dataSourceUrl: 'https://transparenta.eu/entities/4267117/analytics',
        },
      ],
    };

    const result = await renderer.render(props);
    expect(result.isOk()).toBe(true);

    const rendered = result._unsafeUnwrap();
    expect(rendered.html).toContain('Municipiul Sibiu');
    expect(rendered.html).toContain('280,05 mil. RON');
    expect(rendered.html).toContain('Cheltuieli neobișnuite detectate');
    expect(rendered.html).toContain('mai mare decât');
    expect(rendered.html).toContain('1 rapoarte');
    expect(rendered.html).toContain('1 alerte');
    expect(rendered.html).toContain('Condiție îndeplinită');
    expect(rendered.html).toContain('Valoare curentă');
    expect(rendered.html).toContain('Vezi datele sursă');
    expect(rendered.html).toMatch(
      /border:\s*1px solid #E5E7EB[^"]*border-left:\s*3px solid #4F46E5/i
    );
  });

  it('renders newsletter_entity tables with tbody wrappers', async () => {
    const props: NewsletterEntityProps = {
      templateType: 'newsletter_entity',
      lang: 'ro',
      unsubscribeUrl: 'https://transparenta.eu/unsub/token',
      preferencesUrl: 'https://transparenta.eu/settings/notifications',
      platformBaseUrl: 'https://transparenta.eu',
      copyrightYear: 2026,
      entityName: 'Primaria Test',
      entityCui: '123',
      population: 1500,
      periodType: 'monthly',
      periodLabel: 'martie 2026',
      summary: {
        totalIncome: '100',
        totalExpenses: '50',
        budgetBalance: '50',
        currency: 'RON',
      },
      topExpenseCategories: [
        { name: 'Învățământ', amount: '20', percentage: '40' },
        { name: 'Sănătate', amount: '15', percentage: '30' },
      ],
      fundingSources: [
        { name: 'Buget local', percentage: '60' },
        { name: 'Fonduri UE', percentage: '40' },
      ],
    };

    const result = await renderer.render(props);
    expect(result.isOk()).toBe(true);

    const rendered = result._unsafeUnwrap();
    expect(rendered.html).toContain('style="border-radius:4px;overflow:hidden">');
    expect(rendered.html).toContain(
      'style="border-radius:6px;overflow:hidden;margin-bottom:16px">'
    );
  });

  it('rejects digest payloads with empty alert units', async () => {
    const props: AnafForexebugDigestProps = {
      templateType: 'anaf_forexebug_digest',
      lang: 'ro',
      unsubscribeUrl: 'https://transparenta.eu/unsub/token',
      platformBaseUrl: 'https://transparenta.eu',
      copyrightYear: 2026,
      periodKey: '2026-03',
      periodLabel: 'martie 2026',
      sections: [
        {
          kind: 'alert_series',
          notificationId: 'notification-1',
          notificationType: 'alert_series_analytics',
          title: 'Alertă',
          actualValue: '150',
          unit: '',
          triggeredConditions: [
            { operator: 'gt', threshold: '100', actualValue: '150', unit: 'RON' },
          ],
        },
      ],
    };

    const result = await renderer.render(props);
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().type).toBe('VALIDATION_ERROR');
  });

  it('rejects newsletter payloads with fractional population', async () => {
    const props = {
      templateType: 'newsletter_entity',
      lang: 'ro',
      unsubscribeUrl: 'https://transparenta.eu/unsub/token',
      platformBaseUrl: 'https://transparenta.eu',
      copyrightYear: 2026,
      entityName: 'Primaria Test',
      entityCui: '123',
      population: 12.5,
      periodType: 'monthly',
      periodLabel: 'martie 2026',
      summary: {
        totalIncome: '100',
        totalExpenses: '50',
        budgetBalance: '50',
        currency: 'RON',
      },
    };

    const result = await renderer.render(props as NewsletterEntityProps);
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().type).toBe('VALIDATION_ERROR');
  });

  it('returns TEMPLATE_NOT_FOUND for unknown template type', async () => {
    const props = {
      templateType: 'nonexistent' as 'welcome',
      lang: 'ro' as const,
      unsubscribeUrl: 'https://transparenta.eu/unsub/token',
      platformBaseUrl: 'https://transparenta.eu',
      copyrightYear: 2026,
      registeredAt: '2026-03-28T15:00:00.000Z',
    };

    const result = await renderer.render(props);
    expect(result.isErr()).toBe(true);

    const error = result._unsafeUnwrapErr();
    expect(error.type).toBe('TEMPLATE_NOT_FOUND');
  });

  it('returns VALIDATION_ERROR for invalid welcome payload', async () => {
    const props = {
      templateType: 'welcome' as const,
      lang: 'ro' as const,
      unsubscribeUrl: 'https://transparenta.eu/unsub/token',
      platformBaseUrl: 'https://transparenta.eu',
      copyrightYear: 2026,
      // missing registeredAt
    };

    const result = await renderer.render(props as unknown as WelcomeEmailProps);
    expect(result.isErr()).toBe(true);

    const error = result._unsafeUnwrapErr();
    expect(error.type).toBe('VALIDATION_ERROR');
    expect(error.message).toContain('registeredAt');
  });

  it('getTemplates() returns all registered templates', () => {
    const templates = renderer.getTemplates();
    expect(templates).toHaveLength(7);
    const names = templates.map((t) => t.name);
    expect(names).toContain('welcome');
    expect(names).toContain('alert_series');
    expect(names).toContain('newsletter_entity');
    expect(names).toContain('anaf_forexebug_digest');
    expect(names).toContain('public_debate_campaign_welcome');
    expect(names).toContain('public_debate_entity_subscription');
    expect(names).toContain('public_debate_entity_update');
  });

  it('getTemplate() returns metadata for a specific template', () => {
    const meta = renderer.getTemplate('welcome');
    expect(meta).toBeDefined();
    expect(meta?.name).toBe('welcome');
    expect(meta?.version).toBe('1.0.0');
    expect(meta?.exampleProps).toBeDefined();
  });

  it('getTemplate() returns undefined for unknown type', () => {
    expect(renderer.getTemplate('nonexistent' as 'welcome')).toBeUndefined();
  });
});
