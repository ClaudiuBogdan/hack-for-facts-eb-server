import { describe, expect, it } from 'vitest';

import {
  prepareSelfSend,
  makePublicDebateTemplateRenderer,
} from '@/modules/institution-correspondence/index.js';

describe('prepareSelfSend', () => {
  it('returns a shared capture address and a subject carrying the generated thread key', async () => {
    const result = await prepareSelfSend(
      {
        templateRenderer: makePublicDebateTemplateRenderer(),
        auditCcRecipients: ['audit@transparenta.test'],
        captureAddress: 'debate@transparenta.test',
      },
      {
        ownerUserId: 'user-1',
        entityCui: '12345678',
        institutionEmail: 'contact@primarie.ro',
        requesterOrganizationName: 'Asociatia Test',
        budgetPublicationDate: '2026-03-20',
      }
    );

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.created).toBe(true);
      expect(result.value.existingThread).toBeNull();
      expect(result.value.threadKey).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      );
      expect(result.value.captureAddress).toBe('debate@transparenta.test');
      expect(result.value.cc).toEqual(['debate@transparenta.test', 'audit@transparenta.test']);
      expect(result.value.subject).toContain(result.value.threadKey);
      expect(result.value.subject).toContain('[teu:');
      expect(result.value.body).toContain('Asociatia Test');
    }
  });

  it('validates the institution email', async () => {
    const result = await prepareSelfSend(
      {
        templateRenderer: makePublicDebateTemplateRenderer(),
        auditCcRecipients: [],
        captureAddress: 'debate@transparenta.test',
      },
      {
        ownerUserId: 'user-1',
        entityCui: '12345678',
        institutionEmail: 'not-an-email',
      }
    );

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.type).toBe('CorrespondenceValidationError');
    }
  });
});
