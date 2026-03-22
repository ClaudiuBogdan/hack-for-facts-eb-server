import { sql } from 'kysely';
import { describe, expect, it } from 'vitest';

import { dockerAvailable } from './setup.js';
import { getTestClients } from '../infra/test-db.js';

describe('Institution email workflow schema', () => {
  it('creates institution threads and generic resend rows', async () => {
    if (!dockerAvailable) {
      return;
    }

    const { userDb } = getTestClients();

    const insertedThread = await userDb
      .insertInto('institutionemailthreads')
      .values({
        entity_cui: '12345678',
        owner_user_id: null,
        campaign_ref: null,
        request_type: 'cerere_544',
        thread_key: 'inst-thread-1',
        subject: 'Cerere informatii',
        status: 'draft',
        metadata: JSON.stringify({}),
      })
      .returning(['thread_key', 'owner_user_id', 'campaign_ref', 'request_type'])
      .executeTakeFirstOrThrow();

    expect(insertedThread.owner_user_id).toBeNull();
    expect(insertedThread.campaign_ref).toBeNull();
    expect(insertedThread.request_type).toBe('cerere_544');
    expect(insertedThread.thread_key).toBe('inst-thread-1');

    const insertedEventWithoutThread = await userDb
      .insertInto('resend_wh_emails')
      .values({
        svix_id: 'svix_test_null_thread',
        event_type: 'email.sent',
        event_created_at: new Date('2026-03-22T12:00:00.000Z'),
        email_id: 'email_shared_1',
        from_address: 'noreply@transparenta.eu',
        to_addresses: ['contact@institutie.ro'],
        subject: 'Cerere informatii',
        email_created_at: new Date('2026-03-22T12:00:00.000Z'),
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
      })
      .returning(['thread_key'])
      .executeTakeFirstOrThrow();

    const insertedEventWithThread = await userDb
      .insertInto('resend_wh_emails')
      .values({
        svix_id: 'svix_test_thread_key',
        event_type: 'email.delivered',
        event_created_at: new Date('2026-03-22T12:05:00.000Z'),
        email_id: 'email_shared_1',
        from_address: 'contact@institutie.ro',
        to_addresses: ['inbox@transparenta.eu'],
        subject: 'Cerere informatii',
        email_created_at: new Date('2026-03-22T12:00:00.000Z'),
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
        thread_key: 'inst-thread-1',
      })
      .returning(['thread_key', 'email_id'])
      .executeTakeFirstOrThrow();

    expect(insertedEventWithoutThread.thread_key).toBeNull();
    expect(insertedEventWithThread.thread_key).toBe('inst-thread-1');
    expect(insertedEventWithThread.email_id).toBe('email_shared_1');
  });

  it('enforces thread status and uniqueness constraints', async () => {
    if (!dockerAvailable) {
      return;
    }

    const { userDb } = getTestClients();

    await expect(
      sql`
        INSERT INTO institutionemailthreads (
          entity_cui,
          owner_user_id,
          campaign_ref,
          request_type,
          thread_key,
          subject,
          status,
          metadata
        ) VALUES (
          ${'87654321'},
          ${null},
          ${null},
          ${'generic'},
          ${'thread-invalid-status'},
          ${'Subiect'},
          ${'invalid'},
          ${sql`${JSON.stringify({})}::jsonb`}
        )
      `.execute(userDb)
    ).rejects.toThrow();

    await userDb
      .insertInto('institutionemailthreads')
      .values({
        entity_cui: '87654321',
        owner_user_id: null,
        campaign_ref: 'campaign-1',
        request_type: 'generic',
        thread_key: 'thread-dup',
        subject: 'Subiect',
        status: 'draft',
        metadata: JSON.stringify({}),
      })
      .execute();

    await expect(
      userDb
        .insertInto('institutionemailthreads')
        .values({
          entity_cui: '87654321',
          owner_user_id: null,
          campaign_ref: 'campaign-2',
          request_type: 'generic',
          thread_key: 'thread-dup',
          subject: 'Alt subiect',
          status: 'draft',
          metadata: JSON.stringify({}),
        })
        .execute()
    ).rejects.toThrow();

    await userDb
      .insertInto('resend_wh_emails')
      .values({
        svix_id: 'svix_dup',
        event_type: 'email.received',
        event_created_at: new Date('2026-03-22T13:01:00.000Z'),
        email_id: 'email_dup_1',
        from_address: 'contact@institutie.ro',
        to_addresses: ['inbox@transparenta.eu'],
        subject: 'Salut',
        email_created_at: new Date('2026-03-22T13:01:00.000Z'),
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
        thread_key: 'thread-dup',
      })
      .execute();

    await expect(
      userDb
        .insertInto('resend_wh_emails')
        .values({
          svix_id: 'svix_dup',
          event_type: 'email.received',
          event_created_at: new Date('2026-03-22T13:02:00.000Z'),
          email_id: 'email_dup_2',
          from_address: 'contact@institutie.ro',
          to_addresses: ['inbox@transparenta.eu'],
          subject: 'Salut din nou',
          email_created_at: new Date('2026-03-22T13:02:00.000Z'),
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
        })
        .execute()
    ).rejects.toThrow();
  });

  it('queries provider rows by thread_key and allows multiple events per email', async () => {
    if (!dockerAvailable) {
      return;
    }

    const { userDb } = getTestClients();

    await userDb
      .insertInto('institutionemailthreads')
      .values({
        entity_cui: '55555555',
        owner_user_id: 'user_1',
        campaign_ref: null,
        request_type: 'public_debate',
        thread_key: 'query-thread',
        subject: 'Dezbatere publica',
        status: 'waiting_reply',
        metadata: JSON.stringify({}),
      })
      .execute();

    await userDb
      .insertInto('resend_wh_emails')
      .values({
        svix_id: 'svix_query_1',
        event_type: 'email.sent',
        event_created_at: new Date('2026-03-22T14:00:00.000Z'),
        email_id: 'email_query_1',
        from_address: 'noreply@transparenta.eu',
        to_addresses: ['office@primarie.ro'],
        subject: 'Dezbatere publica',
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
      })
      .execute();

    await userDb
      .insertInto('resend_wh_emails')
      .values({
        svix_id: 'svix_query_2',
        event_type: 'email.delivered',
        event_created_at: new Date('2026-03-22T14:01:00.000Z'),
        email_id: 'email_query_1',
        from_address: 'noreply@transparenta.eu',
        to_addresses: ['office@primarie.ro'],
        subject: 'Dezbatere publica',
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
      })
      .execute();

    const linkedEvents = await userDb
      .selectFrom('resend_wh_emails')
      .select(['svix_id', 'email_id', 'event_type'])
      .where('thread_key', '=', 'query-thread')
      .orderBy('event_type', 'asc')
      .execute();

    expect(linkedEvents).toHaveLength(2);
    expect(linkedEvents[0]?.email_id).toBe('email_query_1');
    expect(linkedEvents[1]?.email_id).toBe('email_query_1');
  });
});
