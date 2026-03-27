import { err, ok } from 'neverthrow';
import { describe, expect, it } from 'vitest';

import {
  PUBLIC_DEBATE_REQUEST_TYPE,
  sendPlatformRequest,
  makePublicDebateTemplateRenderer,
} from '@/modules/institution-correspondence/index.js';

import { makeInMemoryCorrespondenceRepo } from './fake-repo.js';

describe('sendPlatformRequest', () => {
  it('creates a thread, sends the email with a shared reply-to inbox, and appends the outbound entry', async () => {
    const repo = makeInMemoryCorrespondenceRepo();
    const sentEmails: Record<string, unknown>[] = [];

    const result = await sendPlatformRequest(
      {
        repo,
        emailSender: {
          getFromAddress() {
            return 'noreply@transparenta.eu';
          },
          async send(params) {
            sentEmails.push(params as unknown as Record<string, unknown>);
            return ok({ emailId: 'email-1' });
          },
        },
        templateRenderer: makePublicDebateTemplateRenderer(),
        auditCcRecipients: ['audit@transparenta.test'],
        platformBaseUrl: 'https://transparenta.test',
        captureAddress: 'debate@transparenta.test',
      },
      {
        ownerUserId: 'user-1',
        entityCui: '12345678',
        institutionEmail: 'contact@primarie.ro',
        requesterOrganizationName: null,
      }
    );

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.created).toBe(true);
      expect(result.value.thread.phase).toBe('awaiting_reply');
      expect(result.value.thread.record.captureAddress).toBe('debate@transparenta.test');
      expect(result.value.thread.record.correspondence).toHaveLength(1);
      expect(result.value.thread.record.subject).toContain('[teu:');
      expect(result.value.thread.record.correspondence[0]?.direction).toBe('outbound');
      expect(result.value.thread.record.correspondence[0]?.resendEmailId).toBe('email-1');
      expect(result.value.thread.record.correspondence[0]?.fromAddress).toBe(
        'noreply@transparenta.eu'
      );
      expect(sentEmails[0]?.['cc']).toEqual(['audit@transparenta.test']);
      expect(sentEmails[0]?.['replyTo']).toEqual(['debate@transparenta.test']);
    }
  });

  it('validates the institution email', async () => {
    const repo = makeInMemoryCorrespondenceRepo();

    const result = await sendPlatformRequest(
      {
        repo,
        emailSender: {
          getFromAddress() {
            return 'noreply@transparenta.eu';
          },
          async send() {
            return ok({ emailId: 'email-1' });
          },
        },
        templateRenderer: makePublicDebateTemplateRenderer(),
        auditCcRecipients: [],
        platformBaseUrl: 'https://transparenta.test',
        captureAddress: 'debate@transparenta.test',
      },
      {
        ownerUserId: 'user-1',
        entityCui: '12345678',
        institutionEmail: 'bad-email',
      }
    );

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.type).toBe('CorrespondenceValidationError');
    }
  });

  it('marks the thread failed when provider send fails', async () => {
    const repo = makeInMemoryCorrespondenceRepo();

    const result = await sendPlatformRequest(
      {
        repo,
        emailSender: {
          getFromAddress() {
            return 'noreply@transparenta.eu';
          },
          async send() {
            return err({
              type: 'SERVER' as const,
              message: 'Provider failed',
              retryable: true,
            });
          },
        },
        templateRenderer: makePublicDebateTemplateRenderer(),
        auditCcRecipients: [],
        platformBaseUrl: 'https://transparenta.test',
        captureAddress: 'debate@transparenta.test',
      },
      {
        ownerUserId: 'user-1',
        entityCui: '12345678',
        institutionEmail: 'contact@primarie.ro',
      }
    );

    expect(result.isErr()).toBe(true);

    const threads = repo.snapshotThreads();
    const failedThread = threads.find(
      (t) => t.entityCui === '12345678' && t.record.campaign === PUBLIC_DEBATE_REQUEST_TYPE
    );
    expect(failedThread).toBeDefined();
    expect(failedThread?.phase).toBe('failed');
    expect(failedThread?.record.correspondence).toHaveLength(0);

    // findPlatformSendThreadByEntity should still see failed platform sends for dedupe
    const lookupResult = await repo.findPlatformSendThreadByEntity({
      entityCui: '12345678',
      campaign: PUBLIC_DEBATE_REQUEST_TYPE,
    });
    expect(lookupResult.isOk()).toBe(true);
    if (lookupResult.isOk()) {
      expect(lookupResult.value?.phase).toBe('failed');
    }
  });
});
