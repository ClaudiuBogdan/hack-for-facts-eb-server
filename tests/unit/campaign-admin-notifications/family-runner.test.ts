import { err, ok } from 'neverthrow';
import { describe, expect, it } from 'vitest';

import { createDatabaseError } from '@/modules/campaign-admin-notifications/core/errors.js';
import {
  runCampaignNotificationFamilyBulk,
  runCampaignNotificationFamilySingle,
  type CampaignNotificationFamilyDefinition,
} from '@/modules/campaign-admin-notifications/index.js';

describe('campaign notification family runners', () => {
  it('returns NotFoundError when the single candidate does not exist', async () => {
    const family: CampaignNotificationFamilyDefinition<
      { id: string },
      never,
      { id: string },
      { label: string },
      { value: string },
      never
    > = {
      familyId: 'family',
      campaignKey: 'funky',
      templateId: 'template',
      async loadSingleCandidate() {
        return ok(null);
      },
      async captureBulkWatermark() {
        return ok('watermark');
      },
      async loadBulkPage() {
        return ok({ items: [], nextCursor: null, hasMore: false });
      },
      async enrichCandidate(candidate) {
        return ok({ label: candidate.id });
      },
      planCandidate() {
        return { disposition: 'skip', reason: 'unused' };
      },
      async executePlan() {
        return ok({
          kind: 'skipped',
          familyId: 'family',
          reason: 'unused',
          category: 'skipped',
          createdOutboxIds: [],
          reusedOutboxIds: [],
          queuedOutboxIds: [],
          enqueueFailedOutboxIds: [],
        });
      },
    };

    const result = await runCampaignNotificationFamilySingle(family, {
      candidate: { id: 'missing' },
      context: {
        campaignKey: 'funky',
        triggerSource: 'campaign_admin',
        actorUserId: 'admin-1',
        dryRun: false,
      },
    });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.type).toBe('NotFoundError');
    }
  });

  it('maps delegated single outcomes to family_single results', async () => {
    const family: CampaignNotificationFamilyDefinition<
      { id: string },
      never,
      { id: string },
      { label: string },
      { value: string },
      never
    > = {
      familyId: 'family',
      campaignKey: 'funky',
      templateId: 'template',
      async loadSingleCandidate(input) {
        return ok({ id: input.id });
      },
      async captureBulkWatermark() {
        return ok('watermark');
      },
      async loadBulkPage() {
        return ok({ items: [], nextCursor: null, hasMore: false });
      },
      async enrichCandidate(candidate) {
        return ok({ label: candidate.id });
      },
      planCandidate() {
        return { disposition: 'delegate', reason: 'delegate', target: 'external_flow' };
      },
      async executePlan() {
        return ok({
          kind: 'delegated',
          familyId: 'family',
          reason: 'delegate',
          target: 'external_flow',
          createdOutboxIds: [],
          reusedOutboxIds: [],
          queuedOutboxIds: [],
          enqueueFailedOutboxIds: [],
        });
      },
    };

    const result = await runCampaignNotificationFamilySingle(family, {
      candidate: { id: 'candidate-1' },
      context: {
        campaignKey: 'funky',
        triggerSource: 'campaign_admin',
        actorUserId: 'admin-1',
        dryRun: false,
      },
    });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value).toEqual({
        kind: 'family_single',
        familyId: 'family',
        status: 'delegated',
        reason: 'delegate',
        delegateTarget: 'external_flow',
        createdOutboxIds: [],
        reusedOutboxIds: [],
        queuedOutboxIds: [],
        enqueueFailedOutboxIds: [],
      });
    }
  });

  it('aggregates queued, delegated, stale, and ineligible bulk outcomes', async () => {
    const candidates = [{ id: 'queue' }, { id: 'delegate' }, { id: 'stale' }, { id: 'ineligible' }];

    const family: CampaignNotificationFamilyDefinition<
      never,
      { kind: string },
      { id: string },
      { label: string },
      { value: string },
      number
    > = {
      familyId: 'family',
      campaignKey: 'funky',
      templateId: 'template',
      async loadSingleCandidate() {
        return ok(null);
      },
      async captureBulkWatermark() {
        return ok('2026-04-13T12:00:00.000Z');
      },
      async loadBulkPage() {
        return ok({
          items: candidates,
          nextCursor: null,
          hasMore: false,
        });
      },
      async enrichCandidate(candidate) {
        return ok({ label: candidate.id });
      },
      planCandidate({ candidate }) {
        if (candidate.id === 'delegate') {
          return { disposition: 'delegate', reason: 'delegate', target: 'external_flow' };
        }
        if (candidate.id === 'queue') {
          return { disposition: 'queue', queuedPlan: { value: candidate.id } };
        }

        return { disposition: 'skip', reason: candidate.id };
      },
      async executePlan({ candidate, context }) {
        if (candidate.id === 'queue') {
          return ok({
            kind: 'prepared',
            familyId: 'family',
            reason: 'eligible_now',
            dryRun: context.dryRun,
            source: 'created',
            createdOutboxIds: ['outbox-1'],
            reusedOutboxIds: [],
            queuedOutboxIds: context.dryRun ? [] : ['outbox-1'],
            enqueueFailedOutboxIds: [],
          });
        }

        if (candidate.id === 'delegate') {
          return ok({
            kind: 'delegated',
            familyId: 'family',
            reason: 'delegate',
            target: 'external_flow',
            createdOutboxIds: [],
            reusedOutboxIds: [],
            queuedOutboxIds: [],
            enqueueFailedOutboxIds: [],
          });
        }

        if (candidate.id === 'stale') {
          return ok({
            kind: 'skipped',
            familyId: 'family',
            reason: 'stale_occurrence',
            category: 'stale',
            createdOutboxIds: [],
            reusedOutboxIds: [],
            queuedOutboxIds: [],
            enqueueFailedOutboxIds: [],
          });
        }

        return ok({
          kind: 'skipped',
          familyId: 'family',
          reason: 'ineligible_now',
          category: 'ineligible',
          createdOutboxIds: [],
          reusedOutboxIds: [],
          queuedOutboxIds: [],
          enqueueFailedOutboxIds: [],
        });
      },
    };

    const result = await runCampaignNotificationFamilyBulk(family, {
      filters: { kind: 'all' },
      limit: 10,
      context: {
        campaignKey: 'funky',
        triggerSource: 'campaign_admin',
        actorUserId: 'admin-1',
        dryRun: true,
      },
    });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value).toEqual(
        expect.objectContaining({
          kind: 'family_bulk',
          familyId: 'family',
          dryRun: true,
          candidateCount: 4,
          plannedCount: 1,
          eligibleCount: 1,
          queuedCount: 1,
          delegatedCount: 1,
          ineligibleCount: 1,
          staleCount: 1,
          hasMoreCandidates: false,
        })
      );
    }
  });

  it('returns an error when bulk candidate loading fails', async () => {
    const family: CampaignNotificationFamilyDefinition<
      never,
      { kind: string },
      { id: string },
      { label: string },
      { value: string },
      number
    > = {
      familyId: 'family',
      campaignKey: 'funky',
      templateId: 'template',
      async loadSingleCandidate() {
        return ok(null);
      },
      async captureBulkWatermark() {
        return ok('2026-04-13T12:00:00.000Z');
      },
      async loadBulkPage() {
        return err(createDatabaseError('load failed', false));
      },
      async enrichCandidate(candidate) {
        return ok({ label: candidate.id });
      },
      planCandidate() {
        return { disposition: 'queue', queuedPlan: { value: 'unused' } };
      },
      async executePlan() {
        return ok({
          kind: 'prepared',
          familyId: 'family',
          reason: 'eligible_now',
          dryRun: false,
          source: 'created',
          createdOutboxIds: ['outbox-1'],
          reusedOutboxIds: [],
          queuedOutboxIds: ['outbox-1'],
          enqueueFailedOutboxIds: [],
        });
      },
    };

    const result = await runCampaignNotificationFamilyBulk(family, {
      filters: { kind: 'all' },
      limit: 10,
      context: {
        campaignKey: 'funky',
        triggerSource: 'campaign_admin',
        actorUserId: 'admin-1',
        dryRun: false,
      },
    });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.type).toBe('DatabaseError');
    }
  });
});
