import { ok } from 'neverthrow';
import { describe, expect, it } from 'vitest';

import { createAdminReviewedInteractionFamily } from '@/modules/campaign-admin-notifications/shell/registry/admin-reviewed-interaction-trigger.js';

import {
  makeFakeDeliveryRepo,
  makeFakeExtendedNotificationsRepo,
  makeFakeLearningProgressRepo,
  createTestInteractiveRecord,
} from '../../fixtures/fakes.js';

const composeJobScheduler = {
  async enqueue() {
    return ok(undefined);
  },
};

const entityRepo = {
  async getById(cui: string) {
    return ok({
      cui,
      name: `Entity ${cui}`,
      entity_type: null,
      default_report_type: 'Executie bugetara detaliata' as const,
      uat_id: null,
      is_uat: false,
      address: null,
      last_updated: new Date(),
      main_creditor_1_cui: null,
      main_creditor_2_cui: null,
    });
  },
  async getByIds() {
    return ok(new Map());
  },
  async getAll() {
    throw new Error('not implemented');
  },
  async getChildren() {
    throw new Error('not implemented');
  },
  async getParents() {
    throw new Error('not implemented');
  },
  async getCountyEntity() {
    throw new Error('not implemented');
  },
};

describe('createAdminReviewedInteractionFamily', () => {
  it('skips auto-review reuse approvals because they are not direct admin reviews', () => {
    const family = createAdminReviewedInteractionFamily({
      learningProgressRepo: makeFakeLearningProgressRepo(),
      extendedNotificationsRepo: makeFakeExtendedNotificationsRepo(),
      deliveryRepo: makeFakeDeliveryRepo(),
      composeJobScheduler,
      entityRepo,
      platformBaseUrl: 'https://transparenta.test',
    });
    const candidate = {
      userId: 'user-1',
      recordKey: 'funky:interaction:budget_document::entity:12345678',
      campaignKey: 'funky' as const,
      record: createTestInteractiveRecord({
        key: 'funky:interaction:budget_document::entity:12345678',
        interactionId: 'funky:interaction:budget_document',
        lessonId: 'civic-monitor-and-request',
        kind: 'custom',
        scope: { type: 'entity', entityCui: '12345678' },
        completionRule: { type: 'resolved' },
        phase: 'resolved',
        value: {
          kind: 'json',
          json: {
            value: {
              documentUrl: 'https://primarie.test/buget.pdf',
              documentTypes: ['pdf'],
              submittedAt: '2026-04-16T10:00:00.000Z',
            },
          },
        },
        review: {
          status: 'approved',
          reviewedAt: '2026-04-16T10:05:00.000Z',
          reviewSource: 'auto_review_reuse_match',
        },
        updatedAt: '2026-04-16T10:05:00.000Z',
        submittedAt: '2026-04-16T10:00:00.000Z',
      }),
      auditEvents: [],
      createdAt: '2026-04-16T10:00:00.000Z',
      updatedAt: '2026-04-16T10:05:00.000Z',
      threadSummary: null,
    };

    const plan = family.planCandidate({
      candidate,
      enrichment: {
        interactionConfig: null,
        interactionLabel: 'Budget document',
        entityCui: '12345678',
        entityName: 'Entity 12345678',
        nextStepLinks: [],
      },
      context: {
        campaignKey: 'funky',
        actorUserId: 'admin-1',
        triggerSource: 'campaign_admin',
      },
    });

    expect(plan).toEqual({
      disposition: 'skip',
      reason: 'not_admin_reviewed',
    });
  });
});
