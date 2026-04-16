import { err, ok, type Result } from 'neverthrow';

import { FUNKY_CAMPAIGN_KEY } from '@/common/campaign-keys.js';

import {
  buildCampaignAutoReviewReuseFilters,
  getCampaignAdminReviewConfig,
} from '../campaign-admin-config.js';
import {
  autoResolvePendingInteractionFromReviewedMatch,
  AutoResolvePendingInteractionFromReviewedMatchDeps,
  AutoReviewReuseSkipReason,
} from './auto-resolve-pending-interaction-from-reviewed-match.js';

import type { LearningProgressError } from '../errors.js';
import type { LearningProgressRepository } from '../ports.js';
import type { CampaignAdminListCursor } from '../types.js';

export interface ReconcileAutoReviewReuseDeps {
  repo: LearningProgressRepository;
  onAutoApproved?: AutoResolvePendingInteractionFromReviewedMatchDeps['onAutoApproved'];
}

export interface ReconcileAutoReviewReuseInput {
  batchLimit: number;
}

export interface ReconcileAutoReviewReuseSummary {
  readonly attempts: number;
  readonly failures: number;
  readonly autoApproved: number;
  readonly skipped: Readonly<Partial<Record<AutoReviewReuseSkipReason, number>>>;
}

function incrementSkipCount(
  counts: Partial<Record<AutoReviewReuseSkipReason, number>>,
  reason: AutoReviewReuseSkipReason
): void {
  counts[reason] = (counts[reason] ?? 0) + 1;
}

export async function reconcileAutoReviewReuse(
  deps: ReconcileAutoReviewReuseDeps,
  input: ReconcileAutoReviewReuseInput
): Promise<Result<ReconcileAutoReviewReuseSummary, LearningProgressError>> {
  const campaignConfig = getCampaignAdminReviewConfig(FUNKY_CAMPAIGN_KEY);
  if (campaignConfig === null) {
    return ok({
      attempts: 0,
      failures: 0,
      autoApproved: 0,
      skipped: {},
    });
  }

  const interactions = buildCampaignAutoReviewReuseFilters(campaignConfig);
  if (interactions.length === 0) {
    return ok({
      attempts: 0,
      failures: 0,
      autoApproved: 0,
      skipped: {},
    });
  }

  const skipped: Partial<Record<AutoReviewReuseSkipReason, number>> = {};
  let cursor: CampaignAdminListCursor | undefined;
  let attempts = 0;
  let failures = 0;
  let autoApproved = 0;
  let hasMore = true;

  while (hasMore) {
    const pageResult = await deps.repo.listCampaignAdminInteractionRows({
      campaignKey: FUNKY_CAMPAIGN_KEY,
      interactions,
      phase: 'pending',
      limit: input.batchLimit,
      ...(cursor !== undefined ? { cursor } : {}),
    });
    if (pageResult.isErr()) {
      return err(pageResult.error);
    }

    for (const row of pageResult.value.rows) {
      attempts += 1;
      const autoResolveResult = await autoResolvePendingInteractionFromReviewedMatch(
        {
          repo: deps.repo,
          ...(deps.onAutoApproved !== undefined ? { onAutoApproved: deps.onAutoApproved } : {}),
        },
        {
          userId: row.userId,
          recordKey: row.recordKey,
        }
      );

      if (autoResolveResult.isErr()) {
        failures += 1;
        continue;
      }

      if (autoResolveResult.value.status === 'approved') {
        autoApproved += 1;
        continue;
      }

      incrementSkipCount(skipped, autoResolveResult.value.reason);
    }

    if (!pageResult.value.hasMore || pageResult.value.nextCursor === null) {
      hasMore = false;
      continue;
    }

    cursor = pageResult.value.nextCursor;
  }

  return ok({
    attempts,
    failures,
    autoApproved,
    skipped,
  });
}
