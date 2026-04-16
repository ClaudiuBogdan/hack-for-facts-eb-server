import { Decimal } from 'decimal.js';
import { err, ok } from 'neverthrow';
import pinoLogger from 'pino';
import { describe, expect, it, vi } from 'vitest';

import { buildAnafForexebugDigestScopeKey } from '@/modules/notification-delivery/index.js';
import {
  composeExistingOutbox,
  composeSubscription,
} from '@/modules/notification-delivery/shell/queue/workers/compose-worker.js';

import {
  createTestNotification,
  createTestDeliveryRecord,
  makeFakeDeliveryRepo,
  makeFakeExtendedNotificationsRepo,
  makeFakeTokenSigner,
} from '../../fixtures/fakes.js';

import type { TemplateError } from '@/modules/email-templates/core/ports.js';
import type {
  DataFetcher,
  DeliveryRepository,
  UpdateDeliveryStatusInput,
} from '@/modules/notification-delivery/core/ports.js';
import type { SendJobPayload } from '@/modules/notification-delivery/core/types.js';
import type { Queue } from 'bullmq';

const testLogger = pinoLogger({ level: 'silent' });

const makeDataFetcher = (
  options: Partial<Pick<DataFetcher, 'fetchNewsletterData' | 'fetchAlertData'>> = {}
): DataFetcher => ({
  async fetchNewsletterData(entityCui, periodKey, periodType) {
    if (options.fetchNewsletterData !== undefined) {
      return options.fetchNewsletterData(entityCui, periodKey, periodType);
    }

    return ok({
      entityName: 'Primaria Test',
      entityCui: '123',
      periodLabel: 'martie 2026',
      totalIncome: new Decimal('100'),
      totalExpenses: new Decimal('50'),
      budgetBalance: new Decimal('50'),
      currency: 'RON',
    });
  },
  async fetchAlertData(config, periodKey) {
    if (options.fetchAlertData !== undefined) {
      return options.fetchAlertData(config, periodKey);
    }

    return ok(null);
  },
});

const makeEmailRenderer = (
  options: {
    renderError?: TemplateError;
    onRender?: (props: {
      templateType: string;
      preferencesUrl?: string;
      selectedEntities?: string[];
      entityName?: string;
      ctaUrl?: string;
    }) => void;
  } = {}
) => ({
  async render(props: {
    templateType: string;
    preferencesUrl?: string;
    selectedEntities?: string[];
    entityName?: string;
    ctaUrl?: string;
  }) {
    options.onRender?.(props);

    if (options.renderError !== undefined) {
      return err(options.renderError);
    }

    return ok({
      subject: props.templateType === 'welcome' ? 'Bun venit pe Transparenta.eu' : 'Subscription',
      html: `<p>${props.templateType}</p>`,
      text: props.templateType,
      templateName: props.templateType,
      templateVersion: '1.0.0',
    });
  },
  getTemplates() {
    return [];
  },
  getTemplate() {
    return undefined;
  },
});

const makeSendQueue = (
  jobs: { data: SendJobPayload; opts: Record<string, unknown> | undefined }[]
): Queue<SendJobPayload> => {
  return {
    add: async (_name: string, data: SendJobPayload, opts?: Record<string, unknown>) => {
      jobs.push({ data, opts });
      return {} as never;
    },
  } as unknown as Queue<SendJobPayload>;
};

describe('compose worker helpers', () => {
  it('composes transactional welcome emails from existing outbox metadata', async () => {
    const jobs: { data: SendJobPayload; opts: Record<string, unknown> | undefined }[] = [];
    let renderedPreferencesUrl: string | undefined;
    const deliveryRepo = makeFakeDeliveryRepo({
      deliveries: [
        createTestDeliveryRecord({
          id: 'outbox-welcome-1',
          notificationType: 'transactional_welcome',
          referenceId: null,
          scopeKey: 'welcome',
          deliveryKey: 'transactional_welcome:user-1',
          metadata: {
            source: 'clerk_webhook.user_created',
            sourceEventId: 'evt-1',
            registeredAt: '2026-03-28T12:00:00.000Z',
          },
        }),
      ],
    });

    const result = await composeExistingOutbox(
      {
        sendQueue: makeSendQueue(jobs),
        deliveryRepo,
        notificationsRepo: makeFakeExtendedNotificationsRepo(),
        tokenSigner: makeFakeTokenSigner(),
        dataFetcher: makeDataFetcher(),
        emailRenderer: makeEmailRenderer({
          onRender: (props) => {
            renderedPreferencesUrl = props.preferencesUrl;
          },
        }),
        platformBaseUrl: 'https://transparenta.eu',
        apiBaseUrl: 'https://api.transparenta.eu',
        log: testLogger,
      },
      {
        runId: 'run-1',
        kind: 'outbox',
        outboxId: 'outbox-welcome-1',
      }
    );

    expect(result.status).toBe('composed');
    expect(jobs).toEqual([
      {
        data: { outboxId: 'outbox-welcome-1' },
        opts: {
          jobId: 'send-outbox-welcome-1',
          attempts: 3,
          backoff: {
            type: 'exponential',
            delay: 5000,
          },
          removeOnComplete: true,
          removeOnFail: true,
        },
      },
    ]);

    const outbox = await deliveryRepo.findById('outbox-welcome-1');
    expect(outbox.isOk()).toBe(true);
    if (outbox.isOk()) {
      expect(outbox.value?.templateName).toBe('welcome');
      expect(outbox.value?.renderedSubject).toBe('Bun venit pe Transparenta.eu');
      expect(outbox.value?.renderedHtml).toContain('welcome');
    }
    expect(renderedPreferencesUrl).toBe('https://transparenta.eu/settings/notifications');
  });

  it('composes public debate campaign welcome emails from existing outbox metadata', async () => {
    const jobs: { data: SendJobPayload; opts: Record<string, unknown> | undefined }[] = [];
    let renderedPreferencesUrl: string | undefined;
    let renderedCtaUrl: string | undefined;
    const deliveryRepo = makeFakeDeliveryRepo({
      deliveries: [
        createTestDeliveryRecord({
          id: 'outbox-public-debate-welcome-1',
          notificationType: 'funky:outbox:welcome',
          referenceId: 'notification-global-1',
          scopeKey: 'funky:delivery:welcome',
          deliveryKey: 'funky:outbox:welcome:user-1',
          metadata: {
            campaignKey: 'funky',
            entityCui: '12345678',
            entityName: 'Primaria Test',
            acceptedTermsAt: '2026-04-01T10:00:00.000Z',
          },
        }),
      ],
    });

    const result = await composeExistingOutbox(
      {
        sendQueue: makeSendQueue(jobs),
        deliveryRepo,
        notificationsRepo: makeFakeExtendedNotificationsRepo(),
        tokenSigner: makeFakeTokenSigner(),
        dataFetcher: makeDataFetcher(),
        emailRenderer: makeEmailRenderer({
          onRender: (props) => {
            renderedPreferencesUrl = props.preferencesUrl;
            renderedCtaUrl = props.ctaUrl;
          },
        }),
        platformBaseUrl: 'https://transparenta.eu',
        apiBaseUrl: 'https://api.transparenta.eu',
        log: testLogger,
      },
      {
        runId: 'run-public-debate-welcome-1',
        kind: 'outbox',
        outboxId: 'outbox-public-debate-welcome-1',
      }
    );

    expect(result).toEqual({
      runId: 'run-public-debate-welcome-1',
      outboxId: 'outbox-public-debate-welcome-1',
      status: 'composed',
    });
    expect(jobs).toHaveLength(1);

    const outbox = await deliveryRepo.findById('outbox-public-debate-welcome-1');
    expect(outbox.isOk()).toBe(true);
    if (outbox.isOk()) {
      expect(outbox.value?.templateName).toBe('public_debate_campaign_welcome');
      expect(outbox.value?.renderedHtml).toContain('public_debate_campaign_welcome');
    }
    expect(renderedPreferencesUrl).toBe('https://transparenta.eu/provocare/notificari');
    expect(renderedCtaUrl).toBe('https://transparenta.eu/primarie/12345678');
  });

  it('composes public debate entity subscription emails from existing outbox metadata', async () => {
    const jobs: { data: SendJobPayload; opts: Record<string, unknown> | undefined }[] = [];
    let renderedSelectedEntities: string[] | undefined;
    let renderedCtaUrl: string | undefined;
    const deliveryRepo = makeFakeDeliveryRepo({
      deliveries: [
        createTestDeliveryRecord({
          id: 'outbox-public-debate-entity-subscription-1',
          notificationType: 'funky:outbox:entity_subscription',
          referenceId: 'notification-entity-1',
          scopeKey: 'funky:delivery:entity_subscription_87654321',
          deliveryKey: 'funky:outbox:entity_subscription:user-1:87654321',
          metadata: {
            campaignKey: 'funky',
            entityCui: '87654321',
            entityName: 'Municipiul Test',
            acceptedTermsAt: '2026-04-02T11:00:00.000Z',
            selectedEntities: ['Municipiul Test', 'Municipiul Exemplu'],
          },
        }),
      ],
    });

    const result = await composeExistingOutbox(
      {
        sendQueue: makeSendQueue(jobs),
        deliveryRepo,
        notificationsRepo: makeFakeExtendedNotificationsRepo(),
        tokenSigner: makeFakeTokenSigner(),
        dataFetcher: makeDataFetcher(),
        emailRenderer: makeEmailRenderer({
          onRender(props) {
            renderedSelectedEntities = props.selectedEntities;
            renderedCtaUrl = props.ctaUrl;
          },
        }),
        platformBaseUrl: 'https://transparenta.eu',
        apiBaseUrl: 'https://api.transparenta.eu',
        log: testLogger,
      },
      {
        runId: 'run-public-debate-entity-subscription-1',
        kind: 'outbox',
        outboxId: 'outbox-public-debate-entity-subscription-1',
      }
    );

    expect(result).toEqual({
      runId: 'run-public-debate-entity-subscription-1',
      outboxId: 'outbox-public-debate-entity-subscription-1',
      status: 'composed',
    });

    const outbox = await deliveryRepo.findById('outbox-public-debate-entity-subscription-1');
    expect(outbox.isOk()).toBe(true);
    if (outbox.isOk()) {
      expect(outbox.value?.templateName).toBe('public_debate_entity_subscription');
      expect(outbox.value?.renderedHtml).toContain('public_debate_entity_subscription');
    }
    expect(renderedSelectedEntities).toEqual(['Municipiul Test', 'Municipiul Exemplu']);
    expect(renderedCtaUrl).toBe('https://transparenta.eu/primarie/87654321');
  });

  it('composes public debate entity update emails from outbox metadata', async () => {
    const jobs: { data: SendJobPayload; opts: Record<string, unknown> | undefined }[] = [];
    let renderedTemplateType: string | undefined;
    let renderedEntityName: string | undefined;
    const deliveryRepo = makeFakeDeliveryRepo({
      deliveries: [
        createTestDeliveryRecord({
          id: 'outbox-public-debate-1',
          notificationType: 'funky:outbox:entity_update',
          referenceId: 'notif-1',
          scopeKey: 'funky:delivery:reply_thread-1_reply-1',
          deliveryKey: 'user-1:notif-1:funky:delivery:reply_thread-1_reply-1',
          metadata: {
            campaignKey: 'funky',
            eventType: 'reply_received',
            entityCui: '12345678',
            entityName: 'Municipiul Test',
            threadId: 'thread-1',
            threadKey: 'thread-key-1',
            phase: 'reply_received_unreviewed',
            institutionEmail: 'contact@primarie.ro',
            subject: 'Solicitare organizare dezbatere publica',
            occurredAt: '2026-03-31T10:00:00.000Z',
            replyTextPreview: 'Va comunicam ca solicitarea a fost primita.',
          },
        }),
      ],
    });

    const result = await composeExistingOutbox(
      {
        sendQueue: makeSendQueue(jobs),
        deliveryRepo,
        notificationsRepo: makeFakeExtendedNotificationsRepo(),
        tokenSigner: makeFakeTokenSigner(),
        dataFetcher: makeDataFetcher(),
        emailRenderer: makeEmailRenderer({
          onRender(props) {
            renderedTemplateType = props.templateType;
            renderedEntityName = props.entityName;
          },
        }),
        platformBaseUrl: 'https://transparenta.eu',
        apiBaseUrl: 'https://api.transparenta.eu',
        log: testLogger,
      },
      {
        runId: 'run-public-debate-1',
        kind: 'outbox',
        outboxId: 'outbox-public-debate-1',
      }
    );

    expect(result.status).toBe('composed');
    expect(renderedTemplateType).toBe('public_debate_entity_update');
    expect(renderedEntityName).toBe('Municipiul Test');
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.data).toEqual({ outboxId: 'outbox-public-debate-1' });

    const outbox = await deliveryRepo.findById('outbox-public-debate-1');
    expect(outbox.isOk()).toBe(true);
    if (outbox.isOk()) {
      expect(outbox.value?.templateName).toBe('public_debate_entity_update');
      expect(outbox.value?.renderedHtml).toContain('public_debate_entity_update');
    }
  });

  it('composes requester thread_started public debate emails with the shared update template', async () => {
    const jobs: { data: SendJobPayload; opts: Record<string, unknown> | undefined }[] = [];
    let renderedTemplateType: string | undefined;
    const deliveryRepo = makeFakeDeliveryRepo({
      deliveries: [
        createTestDeliveryRecord({
          id: 'outbox-public-debate-thread-started-requester',
          notificationType: 'funky:outbox:entity_update',
          referenceId: 'notif-1',
          scopeKey: 'funky:delivery:thread_started_thread-1',
          deliveryKey: 'user-1:notif-1:funky:delivery:thread_started_thread-1',
          metadata: {
            campaignKey: 'funky',
            eventType: 'thread_started',
            entityCui: '12345678',
            entityName: 'Municipiul Test',
            threadId: 'thread-1',
            threadKey: 'thread-key-1',
            phase: 'awaiting_reply',
            institutionEmail: 'contact@primarie.ro',
            subject: 'Solicitare organizare dezbatere publica',
            occurredAt: '2026-03-31T10:00:00.000Z',
            recipientRole: 'requester',
          },
        }),
      ],
    });

    const result = await composeExistingOutbox(
      {
        sendQueue: makeSendQueue(jobs),
        deliveryRepo,
        notificationsRepo: makeFakeExtendedNotificationsRepo(),
        tokenSigner: makeFakeTokenSigner(),
        dataFetcher: makeDataFetcher(),
        emailRenderer: makeEmailRenderer({
          onRender(props) {
            renderedTemplateType = props.templateType;
          },
        }),
        platformBaseUrl: 'https://transparenta.eu',
        apiBaseUrl: 'https://api.transparenta.eu',
        log: testLogger,
      },
      {
        runId: 'run-public-debate-thread-started-requester',
        kind: 'outbox',
        outboxId: 'outbox-public-debate-thread-started-requester',
      }
    );

    expect(result.status).toBe('composed');
    expect(renderedTemplateType).toBe('public_debate_entity_update');
    expect(jobs).toHaveLength(1);

    const outbox = await deliveryRepo.findById('outbox-public-debate-thread-started-requester');
    expect(outbox.isOk()).toBe(true);
    if (outbox.isOk()) {
      expect(outbox.value?.templateName).toBe('public_debate_entity_update');
      expect(outbox.value?.renderedHtml).toContain('public_debate_entity_update');
    }
  });

  it('composes legacy thread_started public debate emails without recipientRole using the shared update template', async () => {
    const jobs: { data: SendJobPayload; opts: Record<string, unknown> | undefined }[] = [];
    let renderedTemplateType: string | undefined;
    const deliveryRepo = makeFakeDeliveryRepo({
      deliveries: [
        createTestDeliveryRecord({
          id: 'outbox-public-debate-thread-started-legacy',
          notificationType: 'funky:outbox:entity_update',
          referenceId: 'notif-legacy',
          scopeKey: 'funky:delivery:thread_started_thread-1',
          deliveryKey: 'user-2:notif-legacy:funky:delivery:thread_started_thread-1',
          metadata: {
            campaignKey: 'funky',
            eventType: 'thread_started',
            entityCui: '12345678',
            entityName: 'Municipiul Test',
            threadId: 'thread-1',
            threadKey: 'thread-key-1',
            phase: 'awaiting_reply',
            institutionEmail: 'contact@primarie.ro',
            subject: 'Solicitare organizare dezbatere publica',
            occurredAt: '2026-03-31T10:00:00.000Z',
          },
        }),
      ],
    });

    const result = await composeExistingOutbox(
      {
        sendQueue: makeSendQueue(jobs),
        deliveryRepo,
        notificationsRepo: makeFakeExtendedNotificationsRepo(),
        tokenSigner: makeFakeTokenSigner(),
        dataFetcher: makeDataFetcher(),
        emailRenderer: makeEmailRenderer({
          onRender(props) {
            renderedTemplateType = props.templateType;
          },
        }),
        platformBaseUrl: 'https://transparenta.eu',
        apiBaseUrl: 'https://api.transparenta.eu',
        log: testLogger,
      },
      {
        runId: 'run-public-debate-thread-started-legacy',
        kind: 'outbox',
        outboxId: 'outbox-public-debate-thread-started-legacy',
      }
    );

    expect(result.status).toBe('composed');
    expect(renderedTemplateType).toBe('public_debate_entity_update');
    expect(jobs).toHaveLength(1);

    const outbox = await deliveryRepo.findById('outbox-public-debate-thread-started-legacy');
    expect(outbox.isOk()).toBe(true);
    if (outbox.isOk()) {
      expect(outbox.value?.templateName).toBe('public_debate_entity_update');
      expect(outbox.value?.renderedHtml).toContain('public_debate_entity_update');
    }
  });

  it('composes subscriber thread_started public debate emails with the subscriber template', async () => {
    const jobs: { data: SendJobPayload; opts: Record<string, unknown> | undefined }[] = [];
    let renderedTemplateType: string | undefined;
    let renderedCtaUrl: string | undefined;
    const deliveryRepo = makeFakeDeliveryRepo({
      deliveries: [
        createTestDeliveryRecord({
          id: 'outbox-public-debate-thread-started-subscriber',
          notificationType: 'funky:outbox:entity_update',
          referenceId: 'notif-1',
          scopeKey: 'funky:delivery:thread_started_thread-1',
          deliveryKey: 'user-2:notif-1:funky:delivery:thread_started_thread-1',
          metadata: {
            campaignKey: 'funky',
            eventType: 'thread_started',
            entityCui: '12345678',
            entityName: 'Municipiul Test',
            threadId: 'thread-1',
            threadKey: 'thread-key-1',
            phase: 'awaiting_reply',
            institutionEmail: 'contact@primarie.ro',
            subject: 'Solicitare organizare dezbatere publica',
            occurredAt: '2026-03-31T10:00:00.000Z',
            recipientRole: 'subscriber',
          },
        }),
      ],
    });

    const result = await composeExistingOutbox(
      {
        sendQueue: makeSendQueue(jobs),
        deliveryRepo,
        notificationsRepo: makeFakeExtendedNotificationsRepo(),
        tokenSigner: makeFakeTokenSigner(),
        dataFetcher: makeDataFetcher(),
        emailRenderer: makeEmailRenderer({
          onRender(props) {
            renderedTemplateType = props.templateType;
            if ('ctaUrl' in props && typeof props.ctaUrl === 'string') {
              renderedCtaUrl = props.ctaUrl;
            }
          },
        }),
        platformBaseUrl: 'https://transparenta.eu',
        apiBaseUrl: 'https://api.transparenta.eu',
        log: testLogger,
      },
      {
        runId: 'run-public-debate-thread-started-subscriber',
        kind: 'outbox',
        outboxId: 'outbox-public-debate-thread-started-subscriber',
      }
    );

    expect(result.status).toBe('composed');
    expect(renderedTemplateType).toBe('public_debate_entity_update_thread_started_subscriber');
    expect(renderedCtaUrl).toBe('https://transparenta.eu/primarie/12345678');
    expect(jobs).toHaveLength(1);

    const outbox = await deliveryRepo.findById('outbox-public-debate-thread-started-subscriber');
    expect(outbox.isOk()).toBe(true);
    if (outbox.isOk()) {
      expect(outbox.value?.templateName).toBe(
        'public_debate_entity_update_thread_started_subscriber'
      );
      expect(outbox.value?.renderedHtml).toContain(
        'public_debate_entity_update_thread_started_subscriber'
      );
    }
  });

  it('composes admin-only public debate failure emails from outbox metadata', async () => {
    const jobs: { data: SendJobPayload; opts: Record<string, unknown> | undefined }[] = [];
    let renderedTemplateType: string | undefined;
    const deliveryRepo = makeFakeDeliveryRepo({
      deliveries: [
        createTestDeliveryRecord({
          id: 'outbox-public-debate-admin-failure-1',
          userId: 'admin:alert@example.com',
          toEmail: 'alert@example.com',
          notificationType: 'funky:outbox:admin_failure',
          referenceId: null,
          scopeKey: 'funky:delivery:admin_failure_thread-1',
          deliveryKey: 'admin:alert@example.com:admin_failure:thread-1',
          metadata: {
            campaignKey: 'funky',
            entityCui: '12345678',
            entityName: 'Municipiul Test',
            threadId: 'thread-1',
            threadKey: 'thread-key-1',
            phase: 'failed',
            institutionEmail: 'contact@primarie.ro',
            subject: 'Cerere dezbatere buget local - Municipiul Test',
            occurredAt: '2026-03-31T10:00:00.000Z',
            failureMessage: 'Provider returned 422 validation_error',
          },
        }),
      ],
    });

    const result = await composeExistingOutbox(
      {
        sendQueue: makeSendQueue(jobs),
        deliveryRepo,
        notificationsRepo: makeFakeExtendedNotificationsRepo(),
        tokenSigner: makeFakeTokenSigner(),
        dataFetcher: makeDataFetcher(),
        emailRenderer: makeEmailRenderer({
          onRender(props) {
            renderedTemplateType = props.templateType;
          },
        }),
        platformBaseUrl: 'https://transparenta.eu',
        apiBaseUrl: 'https://api.transparenta.eu',
        log: testLogger,
      },
      {
        runId: 'run-public-debate-admin-failure-1',
        kind: 'outbox',
        outboxId: 'outbox-public-debate-admin-failure-1',
      }
    );

    expect(result.status).toBe('composed');
    expect(renderedTemplateType).toBe('public_debate_admin_failure');
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.data).toEqual({ outboxId: 'outbox-public-debate-admin-failure-1' });

    const outbox = await deliveryRepo.findById('outbox-public-debate-admin-failure-1');
    expect(outbox.isOk()).toBe(true);
    if (outbox.isOk()) {
      expect(outbox.value?.templateName).toBe('public_debate_admin_failure');
      expect(outbox.value?.renderedHtml).toContain('public_debate_admin_failure');
    }
  });

  it('composes reviewed-interaction emails from outbox metadata', async () => {
    const jobs: { data: SendJobPayload; opts: Record<string, unknown> | undefined }[] = [];
    let renderedTemplateType: string | undefined;
    const deliveryRepo = makeFakeDeliveryRepo({
      deliveries: [
        createTestDeliveryRecord({
          id: 'outbox-reviewed-interaction-1',
          notificationType: 'funky:outbox:admin_reviewed_interaction',
          referenceId: 'notif-reviewed-1',
          scopeKey:
            'reviewed_interaction:funky:user-1:funky:interaction:budget_document:record-1:2026-04-13T12:00:00.000Z:rejected',
          deliveryKey:
            'reviewed_interaction:funky:user-1:funky:interaction:budget_document:record-1:2026-04-13T12:00:00.000Z:rejected',
          metadata: {
            campaignKey: 'funky',
            familyId: 'admin_reviewed_interaction',
            recordKey: 'record-1',
            interactionId: 'funky:interaction:budget_document',
            interactionLabel: 'Document buget',
            reviewStatus: 'rejected',
            reviewedAt: '2026-04-13T12:00:00.000Z',
            feedbackText: 'Documentul trimis nu este suficient de clar.',
            userId: 'user-1',
            entityCui: '12345678',
            entityName: 'Municipiul Exemplu',
            nextStepLinks: [
              {
                kind: 'retry_interaction',
                label: 'Revino la pasul pentru documentul de buget',
                url: 'https://transparenta.eu/retry',
              },
            ],
          },
        }),
      ],
    });

    const result = await composeExistingOutbox(
      {
        sendQueue: makeSendQueue(jobs),
        deliveryRepo,
        notificationsRepo: makeFakeExtendedNotificationsRepo(),
        tokenSigner: makeFakeTokenSigner(),
        dataFetcher: makeDataFetcher(),
        emailRenderer: makeEmailRenderer({
          onRender(props) {
            renderedTemplateType = props.templateType;
          },
        }),
        platformBaseUrl: 'https://transparenta.eu',
        apiBaseUrl: 'https://api.transparenta.eu',
        log: testLogger,
      },
      {
        runId: 'run-reviewed-interaction-1',
        kind: 'outbox',
        outboxId: 'outbox-reviewed-interaction-1',
      }
    );

    expect(result.status).toBe('composed');
    expect(renderedTemplateType).toBe('admin_reviewed_user_interaction');
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.data).toEqual({ outboxId: 'outbox-reviewed-interaction-1' });

    const outbox = await deliveryRepo.findById('outbox-reviewed-interaction-1');
    expect(outbox.isOk()).toBe(true);
    if (outbox.isOk()) {
      expect(outbox.value?.templateName).toBe('admin_reviewed_user_interaction');
      expect(outbox.value?.renderedHtml).toContain('admin_reviewed_user_interaction');
    }
  });

  it('marks reviewed-interaction outbox rows failed_permanent when metadata is invalid', async () => {
    const jobs: { data: SendJobPayload; opts: Record<string, unknown> | undefined }[] = [];
    const deliveryRepo = makeFakeDeliveryRepo({
      deliveries: [
        createTestDeliveryRecord({
          id: 'outbox-reviewed-interaction-invalid',
          notificationType: 'funky:outbox:admin_reviewed_interaction',
          referenceId: 'notif-reviewed-invalid',
          scopeKey: 'reviewed_interaction:invalid',
          deliveryKey: 'reviewed_interaction:invalid',
          metadata: {
            campaignKey: 'funky',
            familyId: 'admin_reviewed_interaction',
            entityCui: '12345678',
          },
        }),
      ],
    });

    const result = await composeExistingOutbox(
      {
        sendQueue: makeSendQueue(jobs),
        deliveryRepo,
        notificationsRepo: makeFakeExtendedNotificationsRepo(),
        tokenSigner: makeFakeTokenSigner(),
        dataFetcher: makeDataFetcher(),
        emailRenderer: makeEmailRenderer(),
        platformBaseUrl: 'https://transparenta.eu',
        apiBaseUrl: 'https://api.transparenta.eu',
        log: testLogger,
      },
      {
        runId: 'run-reviewed-interaction-invalid',
        kind: 'outbox',
        outboxId: 'outbox-reviewed-interaction-invalid',
      }
    );

    expect(result).toEqual({
      runId: 'run-reviewed-interaction-invalid',
      outboxId: 'outbox-reviewed-interaction-invalid',
      status: 'failed_permanent',
      error: expect.stringContaining('Invalid reviewed interaction metadata'),
    });
    expect(jobs).toEqual([]);

    const outbox = await deliveryRepo.findById('outbox-reviewed-interaction-invalid');
    expect(outbox.isOk()).toBe(true);
    if (outbox.isOk()) {
      expect(outbox.value?.status).toBe('failed_permanent');
    }
  });

  it('marks public debate update outbox rows failed_permanent when required metadata is missing', async () => {
    const jobs: { data: SendJobPayload; opts: Record<string, unknown> | undefined }[] = [];
    const deliveryRepo = makeFakeDeliveryRepo({
      deliveries: [
        createTestDeliveryRecord({
          id: 'outbox-public-debate-invalid',
          notificationType: 'funky:outbox:entity_update',
          referenceId: 'notif-invalid',
          scopeKey: 'funky:delivery:reply_thread-1_reply-1',
          deliveryKey: 'user-1:notif-invalid:funky:delivery:reply_thread-1_reply-1',
          metadata: {
            campaignKey: 'funky',
            eventType: 'reply_received',
            entityCui: '12345678',
            threadId: 'thread-1',
            threadKey: 'thread-key-1',
            phase: 'reply_received_unreviewed',
            institutionEmail: 'contact@primarie.ro',
            occurredAt: '2026-03-31T10:00:00.000Z',
          },
        }),
      ],
    });

    const result = await composeExistingOutbox(
      {
        sendQueue: makeSendQueue(jobs),
        deliveryRepo,
        notificationsRepo: makeFakeExtendedNotificationsRepo(),
        tokenSigner: makeFakeTokenSigner(),
        dataFetcher: makeDataFetcher(),
        emailRenderer: makeEmailRenderer(),
        platformBaseUrl: 'https://transparenta.eu',
        apiBaseUrl: 'https://api.transparenta.eu',
        log: testLogger,
      },
      {
        runId: 'run-public-debate-invalid',
        kind: 'outbox',
        outboxId: 'outbox-public-debate-invalid',
      }
    );

    expect(result).toEqual({
      runId: 'run-public-debate-invalid',
      outboxId: 'outbox-public-debate-invalid',
      status: 'failed_permanent',
      error: 'Invalid public debate update metadata: subject is required',
    });
    expect(jobs).toEqual([]);
  });

  it('marks thread-started public debate update outbox rows failed_permanent when recipientRole metadata is invalid', async () => {
    const jobs: { data: SendJobPayload; opts: Record<string, unknown> | undefined }[] = [];
    const deliveryRepo = makeFakeDeliveryRepo({
      deliveries: [
        createTestDeliveryRecord({
          id: 'outbox-public-debate-invalid-thread-started-recipient-role',
          notificationType: 'funky:outbox:entity_update',
          referenceId: 'notif-invalid-thread-started-recipient-role',
          scopeKey: 'funky:delivery:thread_started_thread-1',
          deliveryKey:
            'user-1:notif-invalid-thread-started-recipient-role:funky:delivery:thread_started_thread-1',
          metadata: {
            campaignKey: 'funky',
            eventType: 'thread_started',
            entityCui: '12345678',
            entityName: 'Municipiul Test',
            threadId: 'thread-1',
            threadKey: 'thread-key-1',
            phase: 'awaiting_reply',
            institutionEmail: 'contact@primarie.ro',
            subject: 'Solicitare organizare dezbatere publica',
            occurredAt: '2026-03-31T10:00:00.000Z',
            recipientRole: 'typo',
          },
        }),
      ],
    });

    const result = await composeExistingOutbox(
      {
        sendQueue: makeSendQueue(jobs),
        deliveryRepo,
        notificationsRepo: makeFakeExtendedNotificationsRepo(),
        tokenSigner: makeFakeTokenSigner(),
        dataFetcher: makeDataFetcher(),
        emailRenderer: makeEmailRenderer(),
        platformBaseUrl: 'https://transparenta.eu',
        apiBaseUrl: 'https://api.transparenta.eu',
        log: testLogger,
      },
      {
        runId: 'run-public-debate-invalid-thread-started-recipient-role',
        kind: 'outbox',
        outboxId: 'outbox-public-debate-invalid-thread-started-recipient-role',
      }
    );

    expect(result).toEqual({
      runId: 'run-public-debate-invalid-thread-started-recipient-role',
      outboxId: 'outbox-public-debate-invalid-thread-started-recipient-role',
      status: 'failed_permanent',
      error: 'Invalid public debate update metadata: recipientRole is invalid for thread_started',
    });
    expect(jobs).toEqual([]);
  });

  it('marks public debate update outbox rows failed_permanent when template rendering fails', async () => {
    const jobs: { data: SendJobPayload; opts: Record<string, unknown> | undefined }[] = [];
    const deliveryRepo = makeFakeDeliveryRepo({
      deliveries: [
        createTestDeliveryRecord({
          id: 'outbox-public-debate-render-error',
          notificationType: 'funky:outbox:entity_update',
          referenceId: 'notif-render-error',
          scopeKey: 'funky:delivery:reply_thread-1_reply-1',
          deliveryKey: 'user-1:notif-render-error:funky:delivery:reply_thread-1_reply-1',
          metadata: {
            campaignKey: 'funky',
            eventType: 'reply_received',
            entityCui: '12345678',
            threadId: 'thread-1',
            threadKey: 'thread-key-1',
            phase: 'reply_received_unreviewed',
            institutionEmail: 'contact@primarie.ro',
            subject: 'Solicitare organizare dezbatere publica',
            occurredAt: '2026-03-31T10:00:00.000Z',
          },
        }),
      ],
    });

    const result = await composeExistingOutbox(
      {
        sendQueue: makeSendQueue(jobs),
        deliveryRepo,
        notificationsRepo: makeFakeExtendedNotificationsRepo(),
        tokenSigner: makeFakeTokenSigner(),
        dataFetcher: makeDataFetcher(),
        emailRenderer: makeEmailRenderer({
          renderError: {
            type: 'RENDER_ERROR',
            message: 'Public debate template exploded',
            templateType: 'public_debate_entity_update',
          },
        }),
        platformBaseUrl: 'https://transparenta.eu',
        apiBaseUrl: 'https://api.transparenta.eu',
        log: testLogger,
      },
      {
        runId: 'run-public-debate-render-error',
        kind: 'outbox',
        outboxId: 'outbox-public-debate-render-error',
      }
    );

    expect(result).toEqual({
      runId: 'run-public-debate-render-error',
      outboxId: 'outbox-public-debate-render-error',
      status: 'failed_permanent',
      error: 'RENDER_ERROR: Public debate template exploded',
    });
    expect(jobs).toEqual([]);
  });

  it('marks welcome outbox rows failed_permanent when render fails', async () => {
    const jobs: { data: SendJobPayload; opts: Record<string, unknown> | undefined }[] = [];
    const deliveryRepo = makeFakeDeliveryRepo({
      deliveries: [
        createTestDeliveryRecord({
          id: 'outbox-welcome-render-error',
          notificationType: 'transactional_welcome',
          referenceId: null,
          scopeKey: 'welcome',
          deliveryKey: 'transactional_welcome:user-render-error',
          metadata: {
            source: 'clerk_webhook.user_created',
            sourceEventId: 'evt-render-error',
            registeredAt: '2026-03-28T12:00:00.000Z',
          },
        }),
      ],
    });

    const result = await composeExistingOutbox(
      {
        sendQueue: makeSendQueue(jobs),
        deliveryRepo,
        notificationsRepo: makeFakeExtendedNotificationsRepo(),
        tokenSigner: makeFakeTokenSigner(),
        dataFetcher: makeDataFetcher(),
        emailRenderer: makeEmailRenderer({
          renderError: {
            type: 'RENDER_ERROR',
            message: 'Welcome template exploded',
            templateType: 'welcome',
          },
        }),
        platformBaseUrl: 'https://transparenta.eu',
        apiBaseUrl: 'https://api.transparenta.eu',
        log: testLogger,
      },
      {
        runId: 'run-welcome-render-error',
        kind: 'outbox',
        outboxId: 'outbox-welcome-render-error',
      }
    );

    expect(result).toEqual({
      runId: 'run-welcome-render-error',
      outboxId: 'outbox-welcome-render-error',
      status: 'failed_permanent',
      error: 'RENDER_ERROR: Welcome template exploded',
    });
    expect(jobs).toEqual([]);

    const outbox = await deliveryRepo.findById('outbox-welcome-render-error');
    expect(outbox.isOk()).toBe(true);
    if (outbox.isOk()) {
      expect(outbox.value?.status).toBe('failed_permanent');
      expect(outbox.value?.lastError).toBe('RENDER_ERROR: Welcome template exploded');
      expect(outbox.value?.renderedSubject).toBeNull();
    }
  });

  it('marks welcome outbox rows failed_permanent when metadata is invalid', async () => {
    const jobs: { data: SendJobPayload; opts: Record<string, unknown> | undefined }[] = [];
    const deliveryRepo = makeFakeDeliveryRepo({
      deliveries: [
        createTestDeliveryRecord({
          id: 'outbox-welcome-invalid-metadata',
          notificationType: 'transactional_welcome',
          referenceId: null,
          scopeKey: 'welcome',
          deliveryKey: 'transactional_welcome:user-invalid-metadata',
          metadata: {
            source: 'clerk_webhook.user_created',
            sourceEventId: 'evt-invalid-metadata',
            registeredAt: '',
          },
        }),
      ],
    });

    const result = await composeExistingOutbox(
      {
        sendQueue: makeSendQueue(jobs),
        deliveryRepo,
        notificationsRepo: makeFakeExtendedNotificationsRepo(),
        tokenSigner: makeFakeTokenSigner(),
        dataFetcher: makeDataFetcher(),
        emailRenderer: makeEmailRenderer(),
        platformBaseUrl: 'https://transparenta.eu',
        apiBaseUrl: 'https://api.transparenta.eu',
        log: testLogger,
      },
      {
        runId: 'run-welcome-invalid-metadata',
        kind: 'outbox',
        outboxId: 'outbox-welcome-invalid-metadata',
      }
    );

    expect(result).toEqual({
      runId: 'run-welcome-invalid-metadata',
      outboxId: 'outbox-welcome-invalid-metadata',
      status: 'failed_permanent',
      error: 'Invalid welcome outbox metadata: registeredAt is required',
    });
    expect(jobs).toEqual([]);

    const outbox = await deliveryRepo.findById('outbox-welcome-invalid-metadata');
    expect(outbox.isOk()).toBe(true);
    if (outbox.isOk()) {
      expect(outbox.value?.status).toBe('failed_permanent');
      expect(outbox.value?.lastError).toBe(
        'Invalid welcome outbox metadata: registeredAt is required'
      );
      expect(outbox.value?.renderedSubject).toBeNull();
    }
  });

  it('marks public debate entity subscription outbox rows failed_permanent when metadata is invalid', async () => {
    const deliveryRepo = makeFakeDeliveryRepo({
      deliveries: [
        createTestDeliveryRecord({
          id: 'outbox-public-debate-entity-subscription-invalid',
          notificationType: 'funky:outbox:entity_subscription',
          referenceId: 'notification-entity-1',
          scopeKey: 'funky:delivery:entity_subscription_87654321',
          deliveryKey: 'funky:outbox:entity_subscription:user-1:87654321',
          metadata: {
            campaignKey: 'funky',
            entityCui: '87654321',
            acceptedTermsAt: '2026-04-02T11:00:00.000Z',
          },
        }),
      ],
    });

    const result = await composeExistingOutbox(
      {
        sendQueue: makeSendQueue([]),
        deliveryRepo,
        notificationsRepo: makeFakeExtendedNotificationsRepo(),
        tokenSigner: makeFakeTokenSigner(),
        dataFetcher: makeDataFetcher(),
        emailRenderer: makeEmailRenderer(),
        platformBaseUrl: 'https://transparenta.eu',
        apiBaseUrl: 'https://api.transparenta.eu',
        log: testLogger,
      },
      {
        runId: 'run-public-debate-entity-subscription-invalid',
        kind: 'outbox',
        outboxId: 'outbox-public-debate-entity-subscription-invalid',
      }
    );

    expect(result).toEqual({
      runId: 'run-public-debate-entity-subscription-invalid',
      outboxId: 'outbox-public-debate-entity-subscription-invalid',
      status: 'failed_permanent',
      error: 'Invalid public debate entity subscription metadata: entityName is required',
    });

    const outbox = await deliveryRepo.findById('outbox-public-debate-entity-subscription-invalid');
    expect(outbox.isOk()).toBe(true);
    if (outbox.isOk()) {
      expect(outbox.value?.status).toBe('failed_permanent');
      expect(outbox.value?.lastError).toBe(
        'Invalid public debate entity subscription metadata: entityName is required'
      );
    }
  });

  it('composes ANAF / Forexebug digest emails from existing outbox metadata', async () => {
    const jobs: { data: SendJobPayload; opts: Record<string, unknown> | undefined }[] = [];
    let renderedPreferencesUrl: string | undefined;
    const notificationsRepo = makeFakeExtendedNotificationsRepo({
      notifications: [
        createTestNotification({
          id: 'notification-1',
          userId: 'user-1',
          entityCui: '123',
          notificationType: 'newsletter_entity_monthly',
        }),
        createTestNotification({
          id: 'notification-2',
          userId: 'user-1',
          notificationType: 'alert_series_analytics',
          config: { conditions: [], filter: {} },
        }),
      ],
    });
    const deliveryRepo = makeFakeDeliveryRepo({
      deliveries: [
        createTestDeliveryRecord({
          id: 'outbox-bundle-1',
          notificationType: 'anaf_forexebug_digest',
          referenceId: null,
          scopeKey: buildAnafForexebugDigestScopeKey('2026-03'),
          deliveryKey: 'digest:anaf_forexebug:user-1:2026-03',
          metadata: {
            digestType: 'anaf_forexebug_digest',
            periodLabel: 'martie 2026',
            sourceNotificationIds: ['notification-1', 'notification-2'],
            itemCount: 2,
          },
        }),
      ],
    });

    const result = await composeExistingOutbox(
      {
        sendQueue: makeSendQueue(jobs),
        deliveryRepo,
        notificationsRepo,
        tokenSigner: makeFakeTokenSigner(),
        dataFetcher: makeDataFetcher(),
        emailRenderer: makeEmailRenderer({
          onRender: (props) => {
            renderedPreferencesUrl = props.preferencesUrl;
          },
        }),
        platformBaseUrl: 'https://transparenta.eu',
        apiBaseUrl: 'https://api.transparenta.eu',
        log: testLogger,
      },
      {
        runId: 'run-bundle-1',
        kind: 'outbox',
        outboxId: 'outbox-bundle-1',
      }
    );

    expect(result.status).toBe('composed');
    const outbox = await deliveryRepo.findById('outbox-bundle-1');
    expect(outbox.isOk()).toBe(true);
    if (outbox.isOk()) {
      expect(outbox.value?.templateName).toBe('anaf_forexebug_digest');
    }
    expect(renderedPreferencesUrl).toBe('https://transparenta.eu/settings/notifications');
    expect(jobs).toHaveLength(1);
  });

  it('still composes legacy raw monthly digest scopes during rollout', async () => {
    const jobs: { data: SendJobPayload; opts: Record<string, unknown> | undefined }[] = [];
    const notificationsRepo = makeFakeExtendedNotificationsRepo({
      notifications: [
        createTestNotification({
          id: 'notification-legacy-1',
          userId: 'user-1',
          entityCui: '123',
          notificationType: 'newsletter_entity_monthly',
        }),
      ],
    });
    const deliveryRepo = makeFakeDeliveryRepo({
      deliveries: [
        createTestDeliveryRecord({
          id: 'outbox-bundle-legacy-scope',
          notificationType: 'anaf_forexebug_digest',
          referenceId: null,
          scopeKey: '2026-03',
          deliveryKey: 'digest:anaf_forexebug:user-1:2026-03',
          metadata: {
            digestType: 'anaf_forexebug_digest',
            periodLabel: 'martie 2026',
            sourceNotificationIds: ['notification-legacy-1'],
            itemCount: 1,
          },
        }),
      ],
    });

    const result = await composeExistingOutbox(
      {
        sendQueue: makeSendQueue(jobs),
        deliveryRepo,
        notificationsRepo,
        tokenSigner: makeFakeTokenSigner(),
        dataFetcher: makeDataFetcher(),
        emailRenderer: makeEmailRenderer(),
        platformBaseUrl: 'https://transparenta.eu',
        apiBaseUrl: 'https://api.transparenta.eu',
        log: testLogger,
      },
      {
        runId: 'run-bundle-legacy-scope',
        kind: 'outbox',
        outboxId: 'outbox-bundle-legacy-scope',
      }
    );

    expect(result.status).toBe('composed');
    expect(jobs).toHaveLength(1);
  });

  it('marks bundle outbox rows failed_permanent when digest scope is malformed', async () => {
    const jobs: { data: SendJobPayload; opts: Record<string, unknown> | undefined }[] = [];
    const deliveryRepo = makeFakeDeliveryRepo({
      deliveries: [
        createTestDeliveryRecord({
          id: 'outbox-bundle-invalid-scope',
          notificationType: 'anaf_forexebug_digest',
          referenceId: null,
          scopeKey: 'digest:anaf_forexebug:welcome',
          deliveryKey: 'digest:anaf_forexebug:user-1:welcome',
          metadata: {
            digestType: 'anaf_forexebug_digest',
            sourceNotificationIds: ['notification-1'],
            itemCount: 1,
          },
        }),
      ],
    });

    const result = await composeExistingOutbox(
      {
        sendQueue: makeSendQueue(jobs),
        deliveryRepo,
        notificationsRepo: makeFakeExtendedNotificationsRepo(),
        tokenSigner: makeFakeTokenSigner(),
        dataFetcher: makeDataFetcher(),
        emailRenderer: makeEmailRenderer(),
        platformBaseUrl: 'https://transparenta.eu',
        apiBaseUrl: 'https://api.transparenta.eu',
        log: testLogger,
      },
      {
        runId: 'run-bundle-invalid-scope',
        kind: 'outbox',
        outboxId: 'outbox-bundle-invalid-scope',
      }
    );

    expect(result).toEqual({
      runId: 'run-bundle-invalid-scope',
      outboxId: 'outbox-bundle-invalid-scope',
      status: 'failed_permanent',
      error: 'Invalid ANAF / Forexebug digest scope: digest:anaf_forexebug:welcome',
    });
    expect(jobs).toEqual([]);

    const outbox = await deliveryRepo.findById('outbox-bundle-invalid-scope');
    expect(outbox.isOk()).toBe(true);
    if (outbox.isOk()) {
      expect(outbox.value?.status).toBe('failed_permanent');
      expect(outbox.value?.lastError).toBe(
        'Invalid ANAF / Forexebug digest scope: digest:anaf_forexebug:welcome'
      );
    }
  });

  it('marks bundle outbox rows failed_permanent when render fails', async () => {
    const jobs: { data: SendJobPayload; opts: Record<string, unknown> | undefined }[] = [];
    const notificationsRepo = makeFakeExtendedNotificationsRepo({
      notifications: [
        createTestNotification({
          id: 'notification-render-fail-1',
          userId: 'user-1',
          entityCui: '123',
          notificationType: 'newsletter_entity_monthly',
        }),
      ],
    });
    const deliveryRepo = makeFakeDeliveryRepo({
      deliveries: [
        createTestDeliveryRecord({
          id: 'outbox-bundle-render-error',
          notificationType: 'anaf_forexebug_digest',
          referenceId: null,
          scopeKey: buildAnafForexebugDigestScopeKey('2026-03'),
          deliveryKey: 'digest:anaf_forexebug:user-1:2026-03',
          metadata: {
            digestType: 'anaf_forexebug_digest',
            periodLabel: 'martie 2026',
            sourceNotificationIds: ['notification-render-fail-1'],
            itemCount: 1,
          },
        }),
      ],
    });

    const result = await composeExistingOutbox(
      {
        sendQueue: makeSendQueue(jobs),
        deliveryRepo,
        notificationsRepo,
        tokenSigner: makeFakeTokenSigner(),
        dataFetcher: makeDataFetcher(),
        emailRenderer: makeEmailRenderer({
          renderError: {
            type: 'RENDER_ERROR',
            message: 'Digest template exploded',
            templateType: 'anaf_forexebug_digest',
          },
        }),
        platformBaseUrl: 'https://transparenta.eu',
        apiBaseUrl: 'https://api.transparenta.eu',
        log: testLogger,
      },
      {
        runId: 'run-bundle-render-error',
        kind: 'outbox',
        outboxId: 'outbox-bundle-render-error',
      }
    );

    expect(result).toEqual({
      runId: 'run-bundle-render-error',
      outboxId: 'outbox-bundle-render-error',
      status: 'failed_permanent',
      error: 'RENDER_ERROR: Digest template exploded',
    });
    expect(jobs).toEqual([]);

    const outbox = await deliveryRepo.findById('outbox-bundle-render-error');
    expect(outbox.isOk()).toBe(true);
    if (outbox.isOk()) {
      expect(outbox.value?.status).toBe('failed_permanent');
      expect(outbox.value?.lastError).toBe('RENDER_ERROR: Digest template exploded');
      expect(outbox.value?.renderedSubject).toBeNull();
    }
  });

  it('retries bundle compose when source data fetch fails transiently', async () => {
    const jobs: { data: SendJobPayload; opts: Record<string, unknown> | undefined }[] = [];
    const notificationsRepo = makeFakeExtendedNotificationsRepo({
      notifications: [
        createTestNotification({
          id: 'notification-1',
          userId: 'user-1',
          entityCui: '123',
          notificationType: 'newsletter_entity_monthly',
        }),
      ],
    });
    const deliveryRepo = makeFakeDeliveryRepo({
      deliveries: [
        createTestDeliveryRecord({
          id: 'outbox-bundle-failed',
          notificationType: 'anaf_forexebug_digest',
          referenceId: null,
          scopeKey: buildAnafForexebugDigestScopeKey('2026-03'),
          deliveryKey: 'digest:anaf_forexebug:user-1:2026-03',
          metadata: {
            digestType: 'anaf_forexebug_digest',
            periodLabel: 'martie 2026',
            sourceNotificationIds: ['notification-1'],
            itemCount: 1,
          },
        }),
      ],
    });

    await expect(
      composeExistingOutbox(
        {
          sendQueue: makeSendQueue(jobs),
          deliveryRepo,
          notificationsRepo,
          tokenSigner: makeFakeTokenSigner(),
          dataFetcher: makeDataFetcher({
            fetchNewsletterData: async () =>
              err({
                type: 'DatabaseError',
                message: 'Budget query failed',
                retryable: true,
              }),
          }),
          emailRenderer: makeEmailRenderer(),
          platformBaseUrl: 'https://transparenta.eu',
          apiBaseUrl: 'https://api.transparenta.eu',
          log: testLogger,
        },
        {
          runId: 'run-bundle-failed',
          kind: 'outbox',
          outboxId: 'outbox-bundle-failed',
        }
      )
    ).rejects.toThrow('Budget query failed');

    expect(jobs).toEqual([]);

    const outbox = await deliveryRepo.findById('outbox-bundle-failed');
    expect(outbox.isOk()).toBe(true);
    if (outbox.isOk()) {
      expect(outbox.value?.status).toBe('pending');
      expect(outbox.value?.lastError).toBe(
        "Failed to build bundle section for 'notification-1': Budget query failed"
      );
    }
  });

  it('still creates subscription outbox rows with referenceId', async () => {
    const jobs: { data: SendJobPayload; opts: Record<string, unknown> | undefined }[] = [];
    const deliveryRepo = makeFakeDeliveryRepo();
    const notification = createTestNotification({
      id: 'notification-1',
      userId: 'user-1',
      notificationType: 'newsletter_entity_monthly',
      entityCui: '123',
    });

    const result = await composeSubscription(
      {
        sendQueue: makeSendQueue(jobs),
        deliveryRepo,
        notificationsRepo: makeFakeExtendedNotificationsRepo({
          notifications: [notification],
        }),
        tokenSigner: makeFakeTokenSigner(),
        dataFetcher: {
          async fetchNewsletterData() {
            return ok({
              entityName: 'Primaria Test',
              entityCui: '123',
              periodLabel: 'Martie 2026',
              totalIncome: new Decimal('100'),
              totalExpenses: new Decimal('50'),
              budgetBalance: new Decimal('50'),
              currency: 'RON',
            });
          },
          async fetchAlertData() {
            return ok(null);
          },
        },
        emailRenderer: makeEmailRenderer(),
        platformBaseUrl: 'https://transparenta.eu',
        apiBaseUrl: 'https://api.transparenta.eu',
        log: testLogger,
      },
      {
        runId: 'run-subscription-1',
        kind: 'subscription',
        notificationId: 'notification-1',
        periodKey: '2026-03',
      }
    );

    expect(result.status).toBe('composed');
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toEqual({
      data: { outboxId: expect.any(String) },
      opts: {
        jobId: expect.stringMatching(/^send-/u),
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 5000,
        },
        removeOnComplete: true,
        removeOnFail: true,
      },
    });

    const created = await deliveryRepo.findByDeliveryKey('user-1:notification-1:2026-03');
    expect(created.isOk()).toBe(true);
    if (created.isOk()) {
      expect(created.value?.referenceId).toBe('notification-1');
      expect(created.value?.notificationType).toBe('newsletter_entity_monthly');
    }
  });

  it('retries subscription compose when template data fetch fails transiently', async () => {
    const jobs: { data: SendJobPayload; opts: Record<string, unknown> | undefined }[] = [];
    const deliveryRepo = makeFakeDeliveryRepo();
    const notification = createTestNotification({
      id: 'notification-retry-1',
      userId: 'user-1',
      notificationType: 'newsletter_entity_monthly',
      entityCui: '123',
    });

    await expect(
      composeSubscription(
        {
          sendQueue: makeSendQueue(jobs),
          deliveryRepo,
          notificationsRepo: makeFakeExtendedNotificationsRepo({
            notifications: [notification],
          }),
          tokenSigner: makeFakeTokenSigner(),
          dataFetcher: makeDataFetcher({
            fetchNewsletterData: async () =>
              err({
                type: 'DatabaseError',
                message: 'Temporary newsletter outage',
                retryable: true,
              }),
          }),
          emailRenderer: makeEmailRenderer(),
          platformBaseUrl: 'https://transparenta.eu',
          apiBaseUrl: 'https://api.transparenta.eu',
          log: testLogger,
        },
        {
          runId: 'run-subscription-retry',
          kind: 'subscription',
          notificationId: 'notification-retry-1',
          periodKey: '2026-03',
        }
      )
    ).rejects.toThrow('Temporary newsletter outage');

    expect(jobs).toEqual([]);

    const created = await deliveryRepo.findByDeliveryKey('user-1:notification-retry-1:2026-03');
    expect(created.isOk()).toBe(true);
    if (created.isOk()) {
      expect(created.value).toBeNull();
    }
  });

  it('keeps skipped_no_data for genuine no-data subscription outcomes', async () => {
    const jobs: { data: SendJobPayload; opts: Record<string, unknown> | undefined }[] = [];
    const deliveryRepo = makeFakeDeliveryRepo();
    const notification = createTestNotification({
      id: 'notification-alert-1',
      userId: 'user-1',
      notificationType: 'alert_series_analytics',
      config: { conditions: [], filter: {} },
    });

    const result = await composeSubscription(
      {
        sendQueue: makeSendQueue(jobs),
        deliveryRepo,
        notificationsRepo: makeFakeExtendedNotificationsRepo({
          notifications: [notification],
        }),
        tokenSigner: makeFakeTokenSigner(),
        dataFetcher: makeDataFetcher({
          fetchAlertData: async () => ok(null),
        }),
        emailRenderer: makeEmailRenderer(),
        platformBaseUrl: 'https://transparenta.eu',
        apiBaseUrl: 'https://api.transparenta.eu',
        log: testLogger,
      },
      {
        runId: 'run-subscription-no-data',
        kind: 'subscription',
        notificationId: 'notification-alert-1',
        periodKey: '2026-03',
      }
    );

    expect(result).toEqual({
      runId: 'run-subscription-no-data',
      notificationId: 'notification-alert-1',
      status: 'skipped_no_data',
    });
    expect(jobs).toEqual([]);
  });

  it('marks bundle outbox rows failed_permanent when no renderable sections remain', async () => {
    const jobs: { data: SendJobPayload; opts: Record<string, unknown> | undefined }[] = [];
    const deliveryRepo = makeFakeDeliveryRepo({
      deliveries: [
        createTestDeliveryRecord({
          id: 'outbox-bundle-empty',
          notificationType: 'anaf_forexebug_digest',
          referenceId: null,
          scopeKey: buildAnafForexebugDigestScopeKey('2026-03'),
          deliveryKey: 'digest:anaf_forexebug:user-1:2026-03',
          metadata: {
            digestType: 'anaf_forexebug_digest',
            periodLabel: 'martie 2026',
            sourceNotificationIds: ['missing-notification'],
            itemCount: 1,
          },
        }),
      ],
    });

    const result = await composeExistingOutbox(
      {
        sendQueue: makeSendQueue(jobs),
        deliveryRepo,
        notificationsRepo: makeFakeExtendedNotificationsRepo(),
        tokenSigner: makeFakeTokenSigner(),
        dataFetcher: makeDataFetcher(),
        emailRenderer: makeEmailRenderer(),
        platformBaseUrl: 'https://transparenta.eu',
        apiBaseUrl: 'https://api.transparenta.eu',
        log: testLogger,
      },
      {
        runId: 'run-bundle-empty',
        kind: 'outbox',
        outboxId: 'outbox-bundle-empty',
      }
    );

    expect(result.status).toBe('failed_permanent');
    expect(jobs).toEqual([]);

    const outbox = await deliveryRepo.findById('outbox-bundle-empty');
    expect(outbox.isOk()).toBe(true);
    if (outbox.isOk()) {
      expect(outbox.value?.status).toBe('failed_permanent');
      expect(outbox.value?.lastError).toBe('No renderable bundle items');
    }
  });

  it('skips existing outbox rows that already reached a terminal state', async () => {
    const jobs: { data: SendJobPayload; opts: Record<string, unknown> | undefined }[] = [];
    const deliveryRepo = makeFakeDeliveryRepo({
      deliveries: [
        createTestDeliveryRecord({
          id: 'outbox-welcome-delivered',
          notificationType: 'transactional_welcome',
          referenceId: null,
          scopeKey: 'welcome',
          deliveryKey: 'transactional_welcome:user-1',
          status: 'delivered',
          renderedSubject: 'Already sent',
          renderedHtml: '<p>sent</p>',
          renderedText: 'sent',
        }),
      ],
    });

    const result = await composeExistingOutbox(
      {
        sendQueue: makeSendQueue(jobs),
        deliveryRepo,
        notificationsRepo: makeFakeExtendedNotificationsRepo(),
        tokenSigner: makeFakeTokenSigner(),
        dataFetcher: makeDataFetcher(),
        emailRenderer: makeEmailRenderer(),
        platformBaseUrl: 'https://transparenta.eu',
        apiBaseUrl: 'https://api.transparenta.eu',
        log: testLogger,
      },
      {
        runId: 'run-terminal',
        kind: 'outbox',
        outboxId: 'outbox-welcome-delivered',
      }
    );

    expect(result).toEqual({
      runId: 'run-terminal',
      outboxId: 'outbox-welcome-delivered',
      status: 'skipped_terminal_state',
    });
    expect(jobs).toEqual([]);
  });

  it('re-enqueues send for existing outbox rows that are already ready to send', async () => {
    const jobs: { data: SendJobPayload; opts: Record<string, unknown> | undefined }[] = [];
    const deliveryRepo = makeFakeDeliveryRepo({
      deliveries: [
        createTestDeliveryRecord({
          id: 'outbox-ready-to-send',
          notificationType: 'transactional_welcome',
          referenceId: null,
          scopeKey: 'welcome',
          deliveryKey: 'transactional_welcome:user-ready',
          status: 'pending',
          renderedSubject: 'Ready',
          renderedHtml: '<p>ready</p>',
          renderedText: 'ready',
        }),
      ],
    });

    const result = await composeExistingOutbox(
      {
        sendQueue: makeSendQueue(jobs),
        deliveryRepo,
        notificationsRepo: makeFakeExtendedNotificationsRepo(),
        tokenSigner: makeFakeTokenSigner(),
        dataFetcher: makeDataFetcher(),
        emailRenderer: makeEmailRenderer(),
        platformBaseUrl: 'https://transparenta.eu',
        apiBaseUrl: 'https://api.transparenta.eu',
        log: testLogger,
      },
      {
        runId: 'run-ready-to-send',
        kind: 'outbox',
        outboxId: 'outbox-ready-to-send',
      }
    );

    expect(result).toEqual({
      runId: 'run-ready-to-send',
      outboxId: 'outbox-ready-to-send',
      status: 'requeued_send',
      resendQueued: true,
    });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.data).toEqual({ outboxId: 'outbox-ready-to-send' });
  });

  it('does not throw when the compose claim was already released concurrently', async () => {
    const jobs: { data: SendJobPayload; opts: Record<string, unknown> | undefined }[] = [];
    const baseRepo = makeFakeDeliveryRepo({
      deliveries: [
        createTestDeliveryRecord({
          id: 'outbox-welcome-release-race',
          notificationType: 'transactional_welcome',
          referenceId: null,
          scopeKey: 'welcome',
          deliveryKey: 'transactional_welcome:user-race',
          metadata: {
            source: 'clerk_webhook.user_created',
            sourceEventId: 'evt-race',
            registeredAt: '2026-03-28T12:00:00.000Z',
          },
        }),
      ],
    });

    let releaseCallCount = 0;
    const deliveryRepo = {
      ...baseRepo,
      updateStatusIfCurrentIn: vi.fn(
        async (
          outboxId: string,
          allowedStatuses: readonly string[],
          nextStatus: string,
          input?: Partial<UpdateDeliveryStatusInput>
        ) => {
          if (
            Array.isArray(allowedStatuses) &&
            allowedStatuses.length === 1 &&
            allowedStatuses[0] === 'composing'
          ) {
            releaseCallCount++;
            if (releaseCallCount === 1) {
              return ok(false);
            }
          }

          return baseRepo.updateStatusIfCurrentIn(
            outboxId,
            allowedStatuses as Parameters<DeliveryRepository['updateStatusIfCurrentIn']>[1],
            nextStatus as Parameters<DeliveryRepository['updateStatusIfCurrentIn']>[2],
            input
          );
        }
      ),
    } satisfies DeliveryRepository;

    const result = await composeExistingOutbox(
      {
        sendQueue: makeSendQueue(jobs),
        deliveryRepo,
        notificationsRepo: makeFakeExtendedNotificationsRepo(),
        tokenSigner: makeFakeTokenSigner(),
        dataFetcher: makeDataFetcher(),
        emailRenderer: makeEmailRenderer(),
        platformBaseUrl: 'https://transparenta.eu',
        apiBaseUrl: 'https://api.transparenta.eu',
        log: testLogger,
      },
      {
        runId: 'run-release-race',
        kind: 'outbox',
        outboxId: 'outbox-welcome-release-race',
      }
    );

    expect(result.status).toBe('composed');
    expect(jobs).toHaveLength(1);
  });

  it('re-enqueues send when a duplicate subscription outbox already has rendered content', async () => {
    const jobs: { data: SendJobPayload; opts: Record<string, unknown> | undefined }[] = [];
    const notification = createTestNotification({
      id: 'notification-ready-duplicate',
      userId: 'user-1',
      entityCui: '123',
      notificationType: 'newsletter_entity_monthly',
    });
    const deliveryRepo = makeFakeDeliveryRepo({
      deliveries: [
        createTestDeliveryRecord({
          id: 'outbox-duplicate-ready',
          userId: 'user-1',
          notificationType: 'newsletter_entity_monthly',
          referenceId: 'notification-ready-duplicate',
          scopeKey: '2026-03',
          deliveryKey: 'user-1:notification-ready-duplicate:2026-03',
          status: 'pending',
          renderedSubject: 'Ready duplicate',
          renderedHtml: '<p>ready duplicate</p>',
          renderedText: 'ready duplicate',
        }),
      ],
    });

    const result = await composeSubscription(
      {
        sendQueue: makeSendQueue(jobs),
        deliveryRepo,
        notificationsRepo: makeFakeExtendedNotificationsRepo({
          notifications: [notification],
        }),
        tokenSigner: makeFakeTokenSigner(),
        dataFetcher: makeDataFetcher(),
        emailRenderer: makeEmailRenderer(),
        platformBaseUrl: 'https://transparenta.eu',
        apiBaseUrl: 'https://api.transparenta.eu',
        log: testLogger,
      },
      {
        runId: 'run-subscription-duplicate-ready',
        kind: 'subscription',
        notificationId: 'notification-ready-duplicate',
        periodKey: '2026-03',
      }
    );

    expect(result).toEqual({
      runId: 'run-subscription-duplicate-ready',
      notificationId: 'notification-ready-duplicate',
      outboxId: 'outbox-duplicate-ready',
      status: 'requeued_send',
    });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.data).toEqual({ outboxId: 'outbox-duplicate-ready' });
  });
});
