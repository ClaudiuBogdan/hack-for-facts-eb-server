import pinoLogger from 'pino';
import { describe, expect, it } from 'vitest';

import {
  makeInstitutionCorrespondenceRepo,
  makePlatformSendSuccessEvidenceLookup,
} from '@/modules/institution-correspondence/index.js';
import { makeResendWebhookEmailEventsRepo } from '@/modules/resend-webhooks/index.js';

import { dockerAvailable } from './setup.js';
import { getTestClients } from '../infra/test-db.js';

describe('Institution correspondence schema', () => {
  it('stores thread aggregates and resend metadata rows', async () => {
    if (!dockerAvailable) {
      return;
    }

    const { userDb } = getTestClients();

    const insertedThread = await userDb
      .insertInto('institutionemailthreads')
      .values({
        entity_cui: '12345678',
        campaign_key: 'public-debate-2026',
        thread_key: 'thread-key-1',
        phase: 'awaiting_reply',
        last_email_at: new Date('2026-03-22T12:00:00.000Z'),
        last_reply_at: null,
        next_action_at: null,
        closed_at: null,
        record: JSON.stringify({
          version: 1,
          campaign: 'funky',
          campaignKey: 'public-debate-2026',
          ownerUserId: 'user-1',
          subject: 'Solicitare [teu:thread-key-1]',
          submissionPath: 'platform_send',
          institutionEmail: 'contact@institutie.ro',
          ngoIdentity: 'funky_citizens',
          requesterOrganizationName: 'Asociatia Test',
          budgetPublicationDate: '2026-03-20T00:00:00.000Z',
          consentCapturedAt: null,
          contestationDeadlineAt: null,
          captureAddress: 'debate@transparenta.test',
          correspondence: [],
          latestReview: null,
          metadata: {},
        }),
      })
      .returning(['campaign_key', 'thread_key'])
      .executeTakeFirstOrThrow();

    expect(insertedThread.campaign_key).toBe('public-debate-2026');
    expect(insertedThread.thread_key).toBe('thread-key-1');

    const insertedEvent = await userDb
      .insertInto('resend_wh_emails')
      .values({
        svix_id: 'svix_test_metadata',
        event_type: 'email.received',
        event_created_at: new Date('2026-03-22T12:05:00.000Z'),
        email_id: 'email_shared_1',
        from_address: 'contact@institutie.ro',
        to_addresses: ['debate@transparenta.test'],
        subject: 'Salut [teu:thread-key-1]',
        email_created_at: new Date('2026-03-22T12:05:00.000Z'),
        broadcast_id: null,
        template_id: null,
        tags: null,
        bounce_type: null,
        bounce_sub_type: null,
        bounce_message: null,
        bounce_diagnostic_code: null,
        click_ip_address: null,
        click_link: null,
        click_timestamp: null,
        click_user_agent: null,
        thread_key: null,
        metadata: JSON.stringify({
          matchStatus: 'unmatched',
          matchReason: 'thread_key_missing',
        }),
      })
      .returning(['metadata'])
      .executeTakeFirstOrThrow();

    expect(insertedEvent.metadata).toBeDefined();
  });

  it('allows multiple threads for the same entity and campaign while keeping thread_key unique', async () => {
    if (!dockerAvailable) {
      return;
    }

    const { userDb } = getTestClients();

    await userDb
      .insertInto('institutionemailthreads')
      .values({
        entity_cui: '87654321',
        campaign_key: 'public-debate-2026',
        thread_key: 'thread-key-a',
        phase: 'awaiting_reply',
        record: JSON.stringify({
          version: 1,
          campaign: 'funky',
          campaignKey: 'public-debate-2026',
          ownerUserId: null,
          subject: 'Solicitare [teu:thread-key-a]',
          submissionPath: 'platform_send',
          institutionEmail: 'contact@institutie.ro',
          ngoIdentity: 'funky_citizens',
          requesterOrganizationName: null,
          budgetPublicationDate: null,
          consentCapturedAt: null,
          contestationDeadlineAt: null,
          captureAddress: 'debate@transparenta.test',
          correspondence: [],
          latestReview: null,
          metadata: {},
        }),
      })
      .execute();

    await expect(
      userDb
        .insertInto('institutionemailthreads')
        .values({
          entity_cui: '87654321',
          campaign_key: 'public-debate-2026',
          thread_key: 'thread-key-b',
          phase: 'sending',
          record: JSON.stringify({
            version: 1,
            campaign: 'funky',
            campaignKey: 'public-debate-2026',
            ownerUserId: null,
            subject: 'Solicitare [teu:thread-key-b]',
            submissionPath: 'self_send_cc',
            institutionEmail: 'contact@institutie.ro',
            ngoIdentity: 'funky_citizens',
            requesterOrganizationName: null,
            budgetPublicationDate: null,
            consentCapturedAt: null,
            contestationDeadlineAt: null,
            captureAddress: 'debate@transparenta.test',
            correspondence: [],
            latestReview: null,
            metadata: {},
          }),
        })
        .execute()
    ).resolves.toBeDefined();

    await expect(
      userDb
        .insertInto('institutionemailthreads')
        .values({
          entity_cui: '87654321',
          campaign_key: 'public-debate-2026',
          thread_key: 'thread-key-a',
          phase: 'sending',
          record: JSON.stringify({
            version: 1,
            campaign: 'funky',
            campaignKey: 'public-debate-2026',
            ownerUserId: null,
            subject: 'Solicitare [teu:thread-key-a]',
            submissionPath: 'platform_send',
            institutionEmail: 'contact@institutie.ro',
            ngoIdentity: 'funky_citizens',
            requesterOrganizationName: null,
            budgetPublicationDate: null,
            consentCapturedAt: null,
            contestationDeadlineAt: null,
            captureAddress: 'debate@transparenta.test',
            correspondence: [],
            latestReview: null,
            metadata: {},
          }),
        })
        .execute()
    ).rejects.toThrow();
  });

  it('queries provider rows by thread_key and preserves metadata for later routing review', async () => {
    if (!dockerAvailable) {
      return;
    }

    const { userDb } = getTestClients();

    await userDb
      .insertInto('resend_wh_emails')
      .values({
        svix_id: 'svix_query_1',
        event_type: 'email.sent',
        event_created_at: new Date('2026-03-22T14:00:00.000Z'),
        email_id: 'email_query_1',
        from_address: 'noreply@transparenta.eu',
        to_addresses: ['office@primarie.ro'],
        subject: 'Dezbatere publica [teu:query-thread]',
        email_created_at: new Date('2026-03-22T14:00:00.000Z'),
        broadcast_id: null,
        template_id: null,
        tags: JSON.stringify([{ name: 'thread_key', value: 'query-thread' }]),
        bounce_type: null,
        bounce_sub_type: null,
        bounce_message: null,
        bounce_diagnostic_code: null,
        click_ip_address: null,
        click_link: null,
        click_timestamp: null,
        click_user_agent: null,
        thread_key: 'query-thread',
        metadata: JSON.stringify({}),
      })
      .execute();

    await userDb
      .insertInto('resend_wh_emails')
      .values({
        svix_id: 'svix_query_2',
        event_type: 'email.received',
        event_created_at: new Date('2026-03-22T14:01:00.000Z'),
        email_id: 'email_query_2',
        from_address: 'office@primarie.ro',
        to_addresses: ['debate@transparenta.test'],
        subject: 'Re: Dezbatere publica [teu:query-thread]',
        email_created_at: new Date('2026-03-22T14:01:00.000Z'),
        broadcast_id: null,
        template_id: null,
        tags: null,
        bounce_type: null,
        bounce_sub_type: null,
        bounce_message: null,
        bounce_diagnostic_code: null,
        click_ip_address: null,
        click_link: null,
        click_timestamp: null,
        click_user_agent: null,
        thread_key: null,
        metadata: JSON.stringify({ matchStatus: 'unmatched' }),
      })
      .execute();

    const linkedEvents = await userDb
      .selectFrom('resend_wh_emails')
      .select(['svix_id', 'thread_key', 'metadata'])
      .where('svix_id', 'in', ['svix_query_1', 'svix_query_2'])
      .orderBy('svix_id', 'asc')
      .execute();

    expect(linkedEvents).toHaveLength(2);
    expect(linkedEvents[0]?.thread_key).toBe('query-thread');
    expect(linkedEvents[1]?.thread_key).toBeNull();
  });

  it('uses email_created_at as the canonical send timestamp when recovering delivered evidence', async () => {
    if (!dockerAvailable) {
      return;
    }

    const { userDb } = getTestClients();
    const logger = pinoLogger({ level: 'silent' });
    const evidenceLookup = makePlatformSendSuccessEvidenceLookup({
      db: userDb,
      logger,
    });

    await userDb
      .insertInto('resend_wh_emails')
      .values({
        svix_id: 'svix_lookup_delivered',
        event_type: 'email.delivered',
        event_created_at: new Date('2026-03-22T14:05:00.000Z'),
        email_id: 'email_lookup_delivered',
        from_address: 'noreply@transparenta.eu',
        to_addresses: ['office@primarie.ro'],
        subject: 'Dezbatere publica [teu:lookup-thread]',
        email_created_at: new Date('2026-03-22T14:00:00.000Z'),
        broadcast_id: null,
        template_id: null,
        tags: JSON.stringify([{ name: 'thread_key', value: 'lookup-thread' }]),
        bounce_type: null,
        bounce_sub_type: null,
        bounce_message: null,
        bounce_diagnostic_code: null,
        click_ip_address: null,
        click_link: null,
        click_timestamp: null,
        click_user_agent: null,
        thread_key: 'lookup-thread',
        metadata: JSON.stringify({}),
      })
      .execute();

    const evidenceResult =
      await evidenceLookup.findLatestSuccessfulSendByThreadKey('lookup-thread');

    expect(evidenceResult.isOk()).toBe(true);
    if (evidenceResult.isOk()) {
      expect(evidenceResult.value?.observedAt.toISOString()).toBe('2026-03-22T14:00:00.000Z');
      expect(evidenceResult.value?.resendEmailId).toBe('email_lookup_delivered');
      expect(evidenceResult.value?.threadKey).toBe('lookup-thread');
    }
  });

  it('round-trips typed object JSONB writes for thread records and resend metadata', async () => {
    if (!dockerAvailable) {
      return;
    }

    const { userDb } = getTestClients();
    const logger = pinoLogger({ level: 'silent' });
    const correspondenceRepo = makeInstitutionCorrespondenceRepo({
      db: userDb,
      logger,
    });
    const resendRepo = makeResendWebhookEmailEventsRepo({
      db: userDb,
      logger,
    });

    const createThreadResult = await correspondenceRepo.createThread({
      entityCui: '99999999',
      campaignKey: 'campaign-proof',
      threadKey: 'proof-thread-key',
      phase: 'sending',
      record: {
        version: 1,
        campaign: 'funky',
        campaignKey: 'campaign-proof',
        ownerUserId: 'user-proof',
        subject: 'Proof [teu:proof-thread-key]',
        submissionPath: 'platform_send',
        institutionEmail: 'proof@institutie.ro',
        ngoIdentity: 'funky_citizens',
        requesterOrganizationName: null,
        budgetPublicationDate: null,
        consentCapturedAt: null,
        contestationDeadlineAt: null,
        captureAddress: 'debate@transparenta.test',
        correspondence: [],
        latestReview: null,
        metadata: {
          proof: true,
        },
      },
    });

    expect(createThreadResult.isOk()).toBe(true);
    if (createThreadResult.isOk()) {
      expect(createThreadResult.value.record.metadata['proof']).toBe(true);
    }

    const insertEventResult = await resendRepo.insert({
      svixId: 'svix_proof_insert',
      event: {
        type: 'email.received',
        created_at: '2026-03-23T16:00:00.000Z',
        data: {
          email_id: 'email_proof_insert',
          from: 'proof@institutie.ro',
          to: ['debate@transparenta.test'],
          subject: 'Proof [teu:proof-thread-key]',
          created_at: '2026-03-23T16:00:00.000Z',
        },
      },
    });

    expect(insertEventResult.isOk()).toBe(true);
    if (insertEventResult.isErr()) {
      return;
    }

    const updateEventResult = await resendRepo.updateStoredEvent(insertEventResult.value.id, {
      metadata: {
        matchStatus: 'unmatched',
        matchReason: 'proof',
        rawMessage: {
          subject: 'Proof [teu:proof-thread-key]',
        },
      },
    });

    expect(updateEventResult.isOk()).toBe(true);
    if (updateEventResult.isOk()) {
      expect(updateEventResult.value.metadata['matchStatus']).toBe('unmatched');
      expect(updateEventResult.value.metadata['rawMessage']).toEqual({
        subject: 'Proof [teu:proof-thread-key]',
      });
    }
  });

  it('finds an existing platform-send thread by entity while ignoring self-send, failed threads, and other entities', async () => {
    if (!dockerAvailable) {
      return;
    }

    const { userDb } = getTestClients();
    const logger = pinoLogger({ level: 'silent' });
    const correspondenceRepo = makeInstitutionCorrespondenceRepo({
      db: userDb,
      logger,
    });

    await correspondenceRepo.createThread({
      entityCui: '42424242',
      campaignKey: null,
      threadKey: 'self-send-thread',
      phase: 'awaiting_reply',
      record: {
        version: 1,
        campaign: 'funky',
        campaignKey: null,
        ownerUserId: 'user-self',
        subject: 'Self send [teu:self-send-thread]',
        submissionPath: 'self_send_cc',
        institutionEmail: 'contact@entity.ro',
        ngoIdentity: 'funky_citizens',
        requesterOrganizationName: null,
        budgetPublicationDate: null,
        consentCapturedAt: null,
        contestationDeadlineAt: null,
        captureAddress: 'debate@transparenta.test',
        correspondence: [],
        latestReview: null,
        metadata: {},
      },
    });

    await correspondenceRepo.createThread({
      entityCui: '99999999',
      campaignKey: null,
      threadKey: 'other-entity-thread',
      phase: 'awaiting_reply',
      record: {
        version: 1,
        campaign: 'funky',
        campaignKey: null,
        ownerUserId: 'user-other',
        subject: 'Other entity [teu:other-entity-thread]',
        submissionPath: 'platform_send',
        institutionEmail: 'contact@other.ro',
        ngoIdentity: 'funky_citizens',
        requesterOrganizationName: null,
        budgetPublicationDate: null,
        consentCapturedAt: null,
        contestationDeadlineAt: null,
        captureAddress: 'debate@transparenta.test',
        correspondence: [],
        latestReview: null,
        metadata: {},
      },
    });

    // Failed threads should be ignored — allows retry
    await correspondenceRepo.createThread({
      entityCui: '42424242',
      campaignKey: null,
      threadKey: 'platform-thread-failed',
      phase: 'failed',
      record: {
        version: 1,
        campaign: 'funky',
        campaignKey: null,
        ownerUserId: 'user-platform',
        subject: 'Platform send [teu:platform-thread-failed]',
        submissionPath: 'platform_send',
        institutionEmail: 'contact@entity.ro',
        ngoIdentity: 'funky_citizens',
        requesterOrganizationName: null,
        budgetPublicationDate: null,
        consentCapturedAt: null,
        contestationDeadlineAt: null,
        captureAddress: 'debate@transparenta.test',
        correspondence: [],
        latestReview: null,
        metadata: {},
      },
    });

    // Should return null — only a failed thread exists for this entity
    const noActiveResult = await correspondenceRepo.findPlatformSendThreadByEntity({
      entityCui: '42424242',
      campaign: 'funky',
    });

    expect(noActiveResult.isOk()).toBe(true);
    if (noActiveResult.isOk()) {
      expect(noActiveResult.value).toBeNull();
    }

    // Add a non-failed platform-send thread
    await correspondenceRepo.createThread({
      entityCui: '42424242',
      campaignKey: null,
      threadKey: 'platform-thread-active',
      phase: 'awaiting_reply',
      record: {
        version: 1,
        campaign: 'funky',
        campaignKey: null,
        ownerUserId: 'user-platform',
        subject: 'Platform send [teu:platform-thread-active]',
        submissionPath: 'platform_send',
        institutionEmail: 'contact@entity.ro',
        ngoIdentity: 'funky_citizens',
        requesterOrganizationName: null,
        budgetPublicationDate: null,
        consentCapturedAt: null,
        contestationDeadlineAt: null,
        captureAddress: 'debate@transparenta.test',
        correspondence: [],
        latestReview: null,
        metadata: {},
      },
    });

    const threadResult = await correspondenceRepo.findPlatformSendThreadByEntity({
      entityCui: '42424242',
      campaign: 'funky',
    });

    expect(threadResult.isOk()).toBe(true);
    if (threadResult.isOk()) {
      expect(threadResult.value?.threadKey).toBe('platform-thread-active');
      expect(threadResult.value?.record.submissionPath).toBe('platform_send');
      expect(threadResult.value?.entityCui).toBe('42424242');
    }
  });

  it('appends an outbound correspondence entry with an ISO occurredAt timestamp', async () => {
    if (!dockerAvailable) {
      return;
    }

    const { userDb } = getTestClients();
    const logger = pinoLogger({ level: 'silent' });
    const correspondenceRepo = makeInstitutionCorrespondenceRepo({
      db: userDb,
      logger,
    });

    const createThreadResult = await correspondenceRepo.createThread({
      entityCui: '56565656',
      campaignKey: 'funky',
      threadKey: 'append-proof-thread',
      phase: 'sending',
      record: {
        version: 1,
        campaign: 'funky',
        campaignKey: 'funky',
        ownerUserId: 'user-proof',
        subject: 'Cerere dezbatere buget local - Comuna Test',
        submissionPath: 'platform_send',
        institutionEmail: 'contact@test.ro',
        ngoIdentity: 'funky_citizens',
        requesterOrganizationName: null,
        budgetPublicationDate: null,
        consentCapturedAt: '2026-04-03T16:43:04.930Z',
        contestationDeadlineAt: null,
        captureAddress: 'debate@transparenta.test',
        correspondence: [],
        latestReview: null,
        metadata: {},
      },
    });

    expect(createThreadResult.isOk()).toBe(true);
    if (createThreadResult.isErr()) {
      return;
    }

    const appendResult = await correspondenceRepo.appendCorrespondenceEntry({
      threadId: createThreadResult.value.id,
      phase: 'awaiting_reply',
      lastEmailAt: new Date('2026-04-03T16:43:04.930Z'),
      entry: {
        id: 'entry-proof-1',
        campaignKey: 'funky',
        direction: 'outbound',
        source: 'platform_send',
        resendEmailId: 'email-proof-1',
        messageId: null,
        fromAddress: 'funky@dev.transparenta.eu',
        toAddresses: ['contact@test.ro'],
        ccAddresses: ['weare@funky.ong', 'contact@transparenta.eu'],
        bccAddresses: [],
        subject: 'Cerere dezbatere buget local - Comuna Test',
        textBody: 'Domnule Primar,',
        htmlBody: '<p>Domnule Primar,</p>',
        headers: {},
        attachments: [],
        occurredAt: '2026-04-03T16:43:04.930Z',
        metadata: {
          threadKey: 'append-proof-thread',
        },
      },
    });

    expect(appendResult.isOk()).toBe(true);
    if (appendResult.isOk()) {
      expect(appendResult.value.phase).toBe('awaiting_reply');
      expect(appendResult.value.record.correspondence).toHaveLength(1);
      expect(appendResult.value.record.correspondence[0]?.occurredAt).toBe(
        '2026-04-03T16:43:04.930Z'
      );
    }
  });
});
