import { randomUUID } from 'node:crypto';

import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { err, ok, type Result } from 'neverthrow';

import { FUNKY_NOTIFICATION_GLOBAL_TYPE } from '@/common/campaign-keys.js';
import {
  BUDGET_CONTESTATION_INTERACTION_ID,
  BUDGET_DOCUMENT_INTERACTION_ID,
  BUDGET_PUBLICATION_DATE_INTERACTION_ID,
  BUDGET_STATUS_INTERACTION_ID,
  CITY_HALL_CONTACT_INTERACTION_ID,
  CITY_HALL_WEBSITE_INTERACTION_ID,
  DEBATE_REQUEST_INTERACTION_ID,
  PARTICIPATION_REPORT_INTERACTION_ID,
} from '@/common/campaign-user-interactions.js';
import { buildCampaignEntityUrl } from '@/common/utils/build-campaign-entity-url.js';
import {
  TEMPLATE_VERSION,
  type WeeklyProgressDigestProps,
} from '@/modules/email-templates/index.js';
import {
  buildCampaignAdminInteractionStepLink,
  buildCampaignProvocariStepPath,
  getWeeklyDigestCursor,
  getCampaignAdminInteractionConfig,
  getCampaignAdminReviewConfig,
  type CampaignAdminInteractionConfig,
  type CampaignAdminInteractionRow,
  type LearningProgressRepository,
} from '@/modules/learning-progress/index.js';
import {
  enqueueWeeklyProgressDigestNotification,
  getErrorMessage,
  parseWeeklyProgressDigestOutboxMetadata,
  WEEKLY_PROGRESS_DIGEST_TEMPLATE_ID,
  type ComposeJobScheduler,
  type DeliveryRepository,
  type EnqueueWeeklyProgressDigestNotificationResult,
  type ExtendedNotificationsRepository,
} from '@/modules/notification-delivery/index.js';

import {
  createDatabaseError,
  createValidationError,
  type CampaignAdminNotificationError,
} from '../../core/errors.js';
import { listSchemaFields } from '../shared/schema-field-descriptors.js';

import type { CampaignNotificationRunnableTemplateDefinition } from '../../core/ports.js';
import type {
  CampaignNotificationRunnablePlanRow,
  CampaignNotificationRunnablePlanSummary,
  CampaignNotificationStoredPlanRow,
} from '../../core/types.js';
import type { EntityRepository } from '@/modules/entity/index.js';

const RUNNABLE_ID = 'weekly_progress_digest';
const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;
const MAX_PLAN_ROW_COUNT = 200;
const BUCHAREST_TIME_ZONE = 'Europe/Bucharest';
const MAX_DIGEST_ITEMS = 5;
const FEEDBACK_SNIPPET_LIMIT = 280;

const WeeklyProgressDigestSelectorsSchema = Type.Object(
  {
    userId: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false }
);

const WeeklyProgressDigestFiltersSchema = Type.Object({}, { additionalProperties: false });

interface WeeklyProgressDigestSelectors {
  readonly userId?: string;
}

interface WeeklyProgressDigestExecutionData {
  readonly kind: 'weekly_progress_digest';
  readonly notificationInput: {
    readonly userId: string;
    readonly weekKey: string;
    readonly periodLabel: string;
    readonly watermarkAt: string;
    readonly summary: WeeklyProgressDigestProps['summary'];
    readonly items: WeeklyProgressDigestProps['items'];
    readonly primaryCta: WeeklyProgressDigestProps['primaryCta'];
    readonly secondaryCtas: WeeklyProgressDigestProps['secondaryCtas'];
    readonly allUpdatesUrl?: string | null;
  };
}

interface WeeklyDigestCandidate {
  readonly userId: string;
  readonly previewEntityCui: string | null;
  readonly previewEntityName: string | null;
  readonly summary: WeeklyProgressDigestProps['summary'];
  readonly items: WeeklyProgressDigestProps['items'];
  readonly primaryCta: WeeklyProgressDigestProps['primaryCta'];
  readonly secondaryCtas: WeeklyProgressDigestProps['secondaryCtas'];
  readonly allUpdatesUrl?: string | null;
}

const DIGEST_INTERACTION_IDS = [
  CITY_HALL_WEBSITE_INTERACTION_ID,
  BUDGET_DOCUMENT_INTERACTION_ID,
  BUDGET_PUBLICATION_DATE_INTERACTION_ID,
  BUDGET_STATUS_INTERACTION_ID,
  CITY_HALL_CONTACT_INTERACTION_ID,
  DEBATE_REQUEST_INTERACTION_ID,
  PARTICIPATION_REPORT_INTERACTION_ID,
  BUDGET_CONTESTATION_INTERACTION_ID,
] as const;
const DIGEST_INTERACTION_ID_SET = new Set<string>(DIGEST_INTERACTION_IDS);
const DIGEST_NEXT_STEP_ORDER = [
  CITY_HALL_WEBSITE_INTERACTION_ID,
  BUDGET_DOCUMENT_INTERACTION_ID,
  BUDGET_PUBLICATION_DATE_INTERACTION_ID,
  BUDGET_STATUS_INTERACTION_ID,
  CITY_HALL_CONTACT_INTERACTION_ID,
  DEBATE_REQUEST_INTERACTION_ID,
] as const;
const STATUS_TONE_BY_KIND = {
  rejected: 'danger',
  failed: 'danger',
  pending: 'warning',
  draft: 'warning',
  approved: 'success',
} as const satisfies Record<string, WeeklyProgressDigestProps['items'][number]['statusTone']>;

const createEmptySummary = (): CampaignNotificationRunnablePlanSummary => ({
  totalRowCount: 0,
  willSendCount: 0,
  alreadySentCount: 0,
  alreadyPendingCount: 0,
  ineligibleCount: 0,
  missingDataCount: 0,
});

const addSummaryRow = (
  summary: CampaignNotificationRunnablePlanSummary,
  status: CampaignNotificationRunnablePlanRow['status']
): CampaignNotificationRunnablePlanSummary => {
  switch (status) {
    case 'will_send':
      return {
        ...summary,
        totalRowCount: summary.totalRowCount + 1,
        willSendCount: summary.willSendCount + 1,
      };
    case 'already_sent':
      return {
        ...summary,
        totalRowCount: summary.totalRowCount + 1,
        alreadySentCount: summary.alreadySentCount + 1,
      };
    case 'already_pending':
      return {
        ...summary,
        totalRowCount: summary.totalRowCount + 1,
        alreadyPendingCount: summary.alreadyPendingCount + 1,
      };
    case 'ineligible':
      return {
        ...summary,
        totalRowCount: summary.totalRowCount + 1,
        ineligibleCount: summary.ineligibleCount + 1,
      };
    case 'missing_data':
      return {
        ...summary,
        totalRowCount: summary.totalRowCount + 1,
        missingDataCount: summary.missingDataCount + 1,
      };
  }
};

const getPrimaryPreviewEntity = (items: WeeklyProgressDigestProps['items']) => {
  const firstItem = items[0];
  if (firstItem === undefined) {
    return {
      entityCui: null,
      entityName: null,
    };
  }

  const entityName = firstItem.entityName;
  return {
    entityCui: null,
    entityName,
  };
};

const basePreviewRow = (input: {
  userId: string;
  entityCui: string | null;
  entityName: string | null;
  status: CampaignNotificationRunnablePlanRow['status'];
  reasonCode: string;
  statusMessage: string;
  hasExistingDelivery: boolean;
  existingDeliveryStatus: string | null;
  sendMode: CampaignNotificationRunnablePlanRow['sendMode'];
  weekKey: string;
}): CampaignNotificationRunnablePlanRow => {
  return {
    rowKey: `${input.userId}:${input.weekKey}`,
    userId: input.userId,
    entityCui: input.entityCui,
    entityName: input.entityName,
    recordKey: null,
    interactionId: null,
    interactionLabel: 'Weekly progress digest',
    reviewStatus: null,
    reviewedAt: null,
    status: input.status,
    reasonCode: input.reasonCode,
    statusMessage: input.statusMessage,
    hasExistingDelivery: input.hasExistingDelivery,
    existingDeliveryStatus: input.existingDeliveryStatus,
    sendMode: input.sendMode,
  };
};

const toStatusMessage = (input: {
  readonly status: CampaignNotificationRunnablePlanRow['status'];
  readonly reasonCode: string;
}): string => {
  switch (input.reasonCode) {
    case 'eligible_now':
      return 'Ready to send.';
    case 'existing_failed_transient':
      return 'A retryable failed weekly digest already exists and can be reused.';
    case 'existing_pending':
      return 'A weekly digest is already pending for this user and week.';
    case 'existing_sent':
      return 'A weekly digest was already sent for this user and week.';
    case 'existing_not_replayable':
      return 'A previous weekly digest already exists and cannot be replayed.';
    case 'missing_preference':
      return 'The user does not currently have an active Funky campaign email preference.';
    case 'inactive_preference':
      return 'The Funky campaign email preference is inactive.';
    case 'global_unsubscribe':
      return 'The user is globally unsubscribed from email notifications.';
    case 'no_digest_items':
      return 'The user has no weekly digest-worthy changes since the current cursor watermark.';
    case 'invalid_existing_snapshot':
      return 'The existing weekly digest snapshot could not be loaded safely.';
    default:
      return input.status === 'will_send'
        ? 'Ready to send.'
        : 'The weekly digest is not sendable for this user.';
  }
};

const getWeekStartUtc = (date: Date): Date => {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: BUCHAREST_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts = formatter.formatToParts(date).reduce<Record<string, string>>((acc, part) => {
    if (part.type !== 'literal') {
      acc[part.type] = part.value;
    }
    return acc;
  }, {});

  const localDate = new Date(
    Date.UTC(Number(parts['year']), Number(parts['month']) - 1, Number(parts['day']))
  );
  const day = localDate.getUTCDay();
  const mondayOffset = (day + 6) % 7;
  localDate.setUTCDate(localDate.getUTCDate() - mondayOffset);
  return localDate;
};

const buildWeekKey = (date: Date): string => {
  const weekStart = getWeekStartUtc(date);
  const thursday = new Date(weekStart);
  thursday.setUTCDate(weekStart.getUTCDate() + 3);
  const weekYear = thursday.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(weekYear, 0, 4));
  const firstWeekStart = getWeekStartUtc(firstThursday);
  const diffDays = Math.round(
    (weekStart.getTime() - firstWeekStart.getTime()) / (24 * 60 * 60 * 1000)
  );
  const weekNumber = Math.floor(diffDays / 7) + 1;
  return `${String(weekYear)}-W${String(weekNumber).padStart(2, '0')}`;
};

const buildPeriodLabel = (date: Date): string => {
  const weekStart = getWeekStartUtc(date);
  const weekEnd = new Date(weekStart);
  weekEnd.setUTCDate(weekStart.getUTCDate() + 6);
  const formatter = new Intl.DateTimeFormat('ro-RO', {
    timeZone: BUCHAREST_TIME_ZONE,
    day: 'numeric',
    month: 'long',
  });
  return `${formatter.format(weekStart)} - ${formatter.format(weekEnd)}`;
};

const sanitizeFeedbackSnippet = (feedbackText: string | null | undefined): string | undefined => {
  if (feedbackText === undefined || feedbackText === null) {
    return undefined;
  }

  const withoutTags = feedbackText.replace(/<[^>]+>/gu, ' ');
  let withoutControlChars = '';
  for (const character of withoutTags) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint >= 32 && codePoint !== 127) {
      withoutControlChars += character;
    }
  }
  const sanitized = withoutControlChars.replace(/\s+/gu, ' ').trim();
  if (sanitized === '') {
    return undefined;
  }

  return sanitized.length <= FEEDBACK_SNIPPET_LIMIT
    ? sanitized
    : `${sanitized.slice(0, FEEDBACK_SNIPPET_LIMIT - 3)}...`;
};

const compareTimestamps = (leftTimestamp: string, rightTimestamp: string): number => {
  const leftValue = Date.parse(leftTimestamp);
  const rightValue = Date.parse(rightTimestamp);

  if (!Number.isNaN(leftValue) && !Number.isNaN(rightValue)) {
    if (leftValue < rightValue) return -1;
    if (leftValue > rightValue) return 1;
    return 0;
  }

  return leftTimestamp.localeCompare(rightTimestamp);
};

const getInteractionConfigMap = (): Map<string, CampaignAdminInteractionConfig> => {
  const config = getCampaignAdminReviewConfig('funky');
  return new Map(
    (config?.interactions ?? [])
      .filter((interaction) => DIGEST_INTERACTION_ID_SET.has(interaction.interactionId))
      .map((interaction) => [interaction.interactionId, interaction])
  );
};

const interactionConfigMap = getInteractionConfigMap();

const getEntityCui = (row: CampaignAdminInteractionRow): string | null => {
  return row.record.scope.type === 'entity' ? row.record.scope.entityCui : null;
};

const buildStepLink = (
  platformBaseUrl: string,
  row: CampaignAdminInteractionRow,
  interactionConfig: CampaignAdminInteractionConfig | null
): string | null => {
  const path = buildCampaignAdminInteractionStepLink({
    record: row.record,
    interactionConfig,
  });
  if (path === null) {
    return null;
  }

  try {
    return new URL(path, platformBaseUrl).toString();
  } catch {
    return null;
  }
};

const buildStepLinkFromConfig = (input: {
  platformBaseUrl: string;
  entityCui: string;
  interactionConfig: CampaignAdminInteractionConfig | null;
}): string | null => {
  if (
    input.interactionConfig?.interactionStepLocation === null ||
    input.interactionConfig === null
  ) {
    return null;
  }

  try {
    return new URL(
      buildCampaignProvocariStepPath(
        input.entityCui,
        input.interactionConfig.interactionStepLocation
      ),
      input.platformBaseUrl
    ).toString();
  } catch {
    return null;
  }
};

const getDigestStateKind = (
  row: CampaignAdminInteractionRow
): 'approved' | 'rejected' | 'pending' | 'draft' | 'failed' | null => {
  if (row.record.review?.status === 'approved') {
    return 'approved';
  }

  if (row.record.review?.status === 'rejected') {
    return 'rejected';
  }

  if (row.record.phase === 'pending') {
    return 'pending';
  }

  if (row.record.phase === 'draft') {
    return 'draft';
  }

  if (row.record.phase === 'failed') {
    return 'failed';
  }

  return null;
};

const getStatusLabel = (stateKind: NonNullable<ReturnType<typeof getDigestStateKind>>): string => {
  switch (stateKind) {
    case 'approved':
      return 'A fost validat';
    case 'rejected':
      return 'Mai are nevoie de o corectură';
    case 'pending':
      return 'Este în verificare';
    case 'draft':
      return 'Este salvat, dar netrimis';
    case 'failed':
      return 'Nu a putut fi finalizat';
  }
};

const buildDigestItemCopy = (input: {
  row: CampaignAdminInteractionRow;
  entityName: string;
  interactionLabel: string;
  stateKind: NonNullable<ReturnType<typeof getDigestStateKind>>;
  actionLabel: string;
  actionUrl: string;
}): WeeklyProgressDigestProps['items'][number] => {
  const feedbackSnippet = sanitizeFeedbackSnippet(input.row.record.review?.feedbackText);

  switch (input.stateKind) {
    case 'rejected':
      return {
        itemKey: input.row.recordKey,
        interactionId: input.row.record.interactionId,
        interactionLabel: input.interactionLabel,
        entityName: input.entityName,
        statusLabel: getStatusLabel(input.stateKind),
        statusTone: STATUS_TONE_BY_KIND[input.stateKind],
        title: `${input.interactionLabel} trebuie corectat`,
        description: 'Am găsit o problemă care te împiedică să mergi mai departe.',
        updatedAt: input.row.updatedAt,
        ...(input.row.record.review?.reviewedAt !== null &&
        input.row.record.review?.reviewedAt !== undefined
          ? { reviewedAt: input.row.record.review.reviewedAt }
          : {}),
        ...(feedbackSnippet !== undefined ? { feedbackSnippet } : {}),
        actionLabel: input.actionLabel,
        actionUrl: input.actionUrl,
      };
    case 'failed':
      return {
        itemKey: input.row.recordKey,
        interactionId: input.row.record.interactionId,
        interactionLabel: input.interactionLabel,
        entityName: input.entityName,
        statusLabel: getStatusLabel(input.stateKind),
        statusTone: STATUS_TONE_BY_KIND[input.stateKind],
        title: `${input.interactionLabel} nu a putut fi finalizat`,
        description: 'Revenirea la acest pas este cel mai rapid mod de a continua.',
        updatedAt: input.row.updatedAt,
        actionLabel: input.actionLabel,
        actionUrl: input.actionUrl,
      };
    case 'pending':
      return {
        itemKey: input.row.recordKey,
        interactionId: input.row.record.interactionId,
        interactionLabel: input.interactionLabel,
        entityName: input.entityName,
        statusLabel: getStatusLabel(input.stateKind),
        statusTone: STATUS_TONE_BY_KIND[input.stateKind],
        title: `${input.interactionLabel} este în verificare`,
        description: 'Între timp, poți continua cu pasul următor dacă este disponibil.',
        updatedAt: input.row.updatedAt,
        actionLabel: input.actionLabel,
        actionUrl: input.actionUrl,
      };
    case 'draft':
      return {
        itemKey: input.row.recordKey,
        interactionId: input.row.record.interactionId,
        interactionLabel: input.interactionLabel,
        entityName: input.entityName,
        statusLabel: getStatusLabel(input.stateKind),
        statusTone: STATUS_TONE_BY_KIND[input.stateKind],
        title: `${input.interactionLabel} a rămas netrimis`,
        description: 'Ai deja informația salvată, deci poți reveni fără să o iei de la capăt.',
        updatedAt: input.row.updatedAt,
        actionLabel: input.actionLabel,
        actionUrl: input.actionUrl,
      };
    case 'approved':
      return {
        itemKey: input.row.recordKey,
        interactionId: input.row.record.interactionId,
        interactionLabel: input.interactionLabel,
        entityName: input.entityName,
        statusLabel: getStatusLabel(input.stateKind),
        statusTone: STATUS_TONE_BY_KIND[input.stateKind],
        title: `${input.interactionLabel} a fost validat`,
        description: 'Poți merge mai departe cu pasul următor recomandat.',
        updatedAt: input.row.updatedAt,
        ...(input.row.record.review?.reviewedAt !== null &&
        input.row.record.review?.reviewedAt !== undefined
          ? { reviewedAt: input.row.record.review.reviewedAt }
          : {}),
        actionLabel: input.actionLabel,
        actionUrl: input.actionUrl,
      };
  }
};

const getRecordsForUser = async (
  repo: LearningProgressRepository,
  userId: string
): Promise<Result<CampaignAdminInteractionRow[], CampaignAdminNotificationError>> => {
  const recordsResult = await repo.getRecords(userId);
  if (recordsResult.isErr()) {
    return err(
      createDatabaseError(
        recordsResult.error.message,
        'retryable' in recordsResult.error ? recordsResult.error.retryable : true
      )
    );
  }

  return ok(
    recordsResult.value
      .filter((row) => DIGEST_INTERACTION_ID_SET.has(row.record.interactionId))
      .map((row) => ({
        userId: row.userId,
        recordKey: row.recordKey,
        campaignKey: 'funky',
        record: row.record,
        auditEvents: row.auditEvents,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        threadSummary: null,
      }))
  );
};

const buildEntityNameMap = async (
  entityRepo: EntityRepository,
  rows: readonly CampaignAdminInteractionRow[]
): Promise<Result<Map<string, string>, CampaignAdminNotificationError>> => {
  const entityCuis = [
    ...new Set(
      rows.flatMap((row) => {
        const entityCui = getEntityCui(row);
        return entityCui === null ? [] : [entityCui];
      })
    ),
  ];
  const names = new Map<string, string>();

  for (const entityCui of entityCuis) {
    const entityResult = await entityRepo.getById(entityCui);
    if (entityResult.isErr()) {
      return err(
        createDatabaseError(
          'Failed to load entity for weekly progress digest.',
          'retryable' in entityResult.error ? entityResult.error.retryable : true
        )
      );
    }

    const entityName = entityResult.value?.name.trim();
    names.set(entityCui, entityName !== undefined && entityName !== '' ? entityName : entityCui);
  }

  return ok(names);
};

interface NextStepCandidate {
  label: string;
  url: string;
  entityCui: string | null;
  entityName: string | null;
  updatedAt: string | null;
}

interface EntityDigestState {
  entityCui: string;
  entityName: string;
  latestByInteraction: Map<string, CampaignAdminInteractionRow>;
  updatedAt: string | null;
}

const dedupeCtas = (candidates: readonly NextStepCandidate[]): NextStepCandidate[] => {
  const seen = new Set<string>();
  const unique: NextStepCandidate[] = [];

  for (const candidate of candidates) {
    if (seen.has(candidate.url)) {
      continue;
    }

    seen.add(candidate.url);
    unique.push(candidate);
  }

  return unique;
};

const buildEntityDigestStates = (input: {
  rows: readonly CampaignAdminInteractionRow[];
  entityNameMap: Map<string, string>;
}): Map<string, EntityDigestState> => {
  const byEntity = new Map<string, CampaignAdminInteractionRow[]>();

  for (const row of input.rows) {
    const entityCui = getEntityCui(row);
    if (entityCui === null) {
      continue;
    }

    const existing = byEntity.get(entityCui) ?? [];
    existing.push(row);
    byEntity.set(entityCui, existing);
  }

  const states = new Map<string, EntityDigestState>();
  for (const [entityCui, rows] of byEntity.entries()) {
    const latestByInteraction = new Map<string, CampaignAdminInteractionRow>();
    for (const row of rows) {
      const existing = latestByInteraction.get(row.record.interactionId);
      if (existing === undefined || compareTimestamps(existing.updatedAt, row.updatedAt) < 0) {
        latestByInteraction.set(row.record.interactionId, row);
      }
    }

    const entityName = input.entityNameMap.get(entityCui) ?? entityCui;
    const entityUpdatedAt =
      [...rows]
        .map((row) => row.updatedAt)
        .sort((left, right) => compareTimestamps(right, left))[0] ?? null;

    states.set(entityCui, {
      entityCui,
      entityName,
      latestByInteraction,
      updatedAt: entityUpdatedAt,
    });
  }

  return states;
};

const hasStartedInteraction = (row: CampaignAdminInteractionRow | undefined): boolean => {
  if (row === undefined) {
    return false;
  }

  return row.record.phase !== 'idle' && row.record.phase !== 'draft';
};

const buildFallbackAction = (
  platformBaseUrl: string,
  entityState: EntityDigestState | null,
  row: CampaignAdminInteractionRow
): NextStepCandidate => {
  if (entityState !== null) {
    return {
      label: 'Vezi provocarea',
      url: buildCampaignEntityUrl(platformBaseUrl, entityState.entityCui),
      entityCui: entityState.entityCui,
      entityName: entityState.entityName,
      updatedAt: entityState.updatedAt,
    };
  }

  const interactionConfig = interactionConfigMap.get(row.record.interactionId) ?? null;
  return {
    label: 'Vezi provocarea',
    url: buildStepLink(platformBaseUrl, row, interactionConfig) ?? platformBaseUrl,
    entityCui: null,
    entityName: null,
    updatedAt: row.updatedAt,
  };
};

const buildRetryOrResumeAction = (input: {
  platformBaseUrl: string;
  row: CampaignAdminInteractionRow;
  stateKind: 'rejected' | 'failed' | 'draft';
  entityState: EntityDigestState | null;
}): NextStepCandidate | null => {
  const interactionConfig = interactionConfigMap.get(input.row.record.interactionId) ?? null;
  const url = buildStepLink(input.platformBaseUrl, input.row, interactionConfig);
  if (url === null) {
    return null;
  }

  const interactionLabel = interactionConfig?.label ?? input.row.record.interactionId;
  return {
    label:
      input.stateKind === 'draft'
        ? `Continuă ${interactionLabel}`
        : input.stateKind === 'failed'
          ? `Reia ${interactionLabel}`
          : `Corectează ${interactionLabel}`,
    url,
    entityCui: input.entityState?.entityCui ?? getEntityCui(input.row),
    entityName: input.entityState?.entityName ?? null,
    updatedAt: input.row.updatedAt,
  };
};

const buildReviewableNextStepAction = (input: {
  platformBaseUrl: string;
  entityState: EntityDigestState;
}): NextStepCandidate | null => {
  for (const interactionId of DIGEST_NEXT_STEP_ORDER) {
    const latestRow = input.entityState.latestByInteraction.get(interactionId);
    if (hasStartedInteraction(latestRow)) {
      continue;
    }

    const interactionConfig = interactionConfigMap.get(interactionId) ?? null;
    const url = buildStepLinkFromConfig({
      platformBaseUrl: input.platformBaseUrl,
      entityCui: input.entityState.entityCui,
      interactionConfig,
    });
    if (url === null) {
      continue;
    }

    return {
      label:
        interactionId === DEBATE_REQUEST_INTERACTION_ID
          ? 'Continuă cererea de dezbatere'
          : `Continuă cu ${interactionConfig?.label ?? 'pasul următor'}`,
      url,
      entityCui: input.entityState.entityCui,
      entityName: input.entityState.entityName,
      updatedAt: input.entityState.updatedAt,
    };
  }

  return null;
};

const buildPostDebateAction = (input: {
  platformBaseUrl: string;
  entityState: EntityDigestState;
}): NextStepCandidate | null => {
  const campaignConfig = getCampaignAdminReviewConfig('funky');
  if (campaignConfig === null) {
    return null;
  }

  const debateReadyForParticipation = (() => {
    const debateRow = input.entityState.latestByInteraction.get(DEBATE_REQUEST_INTERACTION_ID);
    return (
      debateRow !== undefined &&
      (debateRow.record.phase === 'resolved' || debateRow.record.review?.status === 'approved')
    );
  })();

  if (!debateReadyForParticipation) {
    return null;
  }

  const participationRow = input.entityState.latestByInteraction.get(
    PARTICIPATION_REPORT_INTERACTION_ID
  );
  const participationDone = participationRow?.record.phase === 'resolved';
  if (!participationDone) {
    const participationConfig = getCampaignAdminInteractionConfig(
      campaignConfig,
      PARTICIPATION_REPORT_INTERACTION_ID
    );
    const url = buildStepLinkFromConfig({
      platformBaseUrl: input.platformBaseUrl,
      entityCui: input.entityState.entityCui,
      interactionConfig: participationConfig,
    });
    if (url === null) {
      return null;
    }

    return {
      label: 'Trimite raportul de participare',
      url,
      entityCui: input.entityState.entityCui,
      entityName: input.entityState.entityName,
      updatedAt: input.entityState.updatedAt,
    };
  }

  const contestationStarted = hasStartedInteraction(
    input.entityState.latestByInteraction.get(BUDGET_CONTESTATION_INTERACTION_ID)
  );
  if (contestationStarted) {
    return null;
  }

  const contestationConfig = getCampaignAdminInteractionConfig(
    campaignConfig,
    BUDGET_CONTESTATION_INTERACTION_ID
  );
  const url = buildStepLinkFromConfig({
    platformBaseUrl: input.platformBaseUrl,
    entityCui: input.entityState.entityCui,
    interactionConfig: contestationConfig,
  });
  if (url === null) {
    return null;
  }

  return {
    label: 'Continuă cu contestația bugetului',
    url,
    entityCui: input.entityState.entityCui,
    entityName: input.entityState.entityName,
    updatedAt: input.entityState.updatedAt,
  };
};

const resolveDigestItemAction = (input: {
  platformBaseUrl: string;
  row: CampaignAdminInteractionRow;
  entityState: EntityDigestState | null;
}): NextStepCandidate => {
  const stateKind = getDigestStateKind(input.row);
  if (stateKind === 'rejected' || stateKind === 'failed' || stateKind === 'draft') {
    const retryOrResume = buildRetryOrResumeAction({
      platformBaseUrl: input.platformBaseUrl,
      row: input.row,
      stateKind,
      entityState: input.entityState,
    });
    if (retryOrResume !== null) {
      return retryOrResume;
    }
  }

  if (input.entityState !== null) {
    const nextReviewable = buildReviewableNextStepAction({
      platformBaseUrl: input.platformBaseUrl,
      entityState: input.entityState,
    });
    if (nextReviewable !== null) {
      return nextReviewable;
    }

    const postDebate = buildPostDebateAction({
      platformBaseUrl: input.platformBaseUrl,
      entityState: input.entityState,
    });
    if (postDebate !== null) {
      return postDebate;
    }
  }

  return buildFallbackAction(input.platformBaseUrl, input.entityState, input.row);
};

const buildDigestCandidate = async (input: {
  userId: string;
  repo: LearningProgressRepository;
  entityRepo: EntityRepository;
  platformBaseUrl: string;
  watermarkAt: string | null;
  upperBoundAt: string;
}): Promise<Result<WeeklyDigestCandidate | null, CampaignAdminNotificationError>> => {
  const rowsResult = await getRecordsForUser(input.repo, input.userId);
  if (rowsResult.isErr()) {
    return err(rowsResult.error);
  }

  const rows = rowsResult.value;
  if (rows.length === 0) {
    return ok(null);
  }

  const entityNameMapResult = await buildEntityNameMap(input.entityRepo, rows);
  if (entityNameMapResult.isErr()) {
    return err(entityNameMapResult.error);
  }

  const entityNameMap = entityNameMapResult.value;
  const entityStates = buildEntityDigestStates({
    rows,
    entityNameMap,
  });
  const changedRows = rows
    .filter((row) => {
      const stateKind = getDigestStateKind(row);
      return (
        stateKind !== null &&
        (input.watermarkAt === null || compareTimestamps(row.updatedAt, input.watermarkAt) > 0) &&
        compareTimestamps(row.updatedAt, input.upperBoundAt) <= 0
      );
    })
    .sort((left, right) => {
      const leftKind = getDigestStateKind(left);
      const rightKind = getDigestStateKind(right);
      const leftWeight =
        leftKind === 'rejected'
          ? 0
          : leftKind === 'failed'
            ? 1
            : leftKind === 'pending'
              ? 2
              : leftKind === 'approved'
                ? 3
                : 4;
      const rightWeight =
        rightKind === 'rejected'
          ? 0
          : rightKind === 'failed'
            ? 1
            : rightKind === 'pending'
              ? 2
              : rightKind === 'approved'
                ? 3
                : 4;
      if (leftWeight !== rightWeight) {
        return leftWeight - rightWeight;
      }

      const timestampComparison = compareTimestamps(right.updatedAt, left.updatedAt);
      if (timestampComparison !== 0) {
        return timestampComparison;
      }

      return left.recordKey.localeCompare(right.recordKey);
    });

  if (changedRows.length === 0) {
    return ok(null);
  }

  const orderedActions = dedupeCtas(
    changedRows.map((row) => {
      const entityCui = getEntityCui(row);
      return resolveDigestItemAction({
        platformBaseUrl: input.platformBaseUrl,
        row,
        entityState: entityCui === null ? null : (entityStates.get(entityCui) ?? null),
      });
    })
  );
  const primaryCta = orderedActions[0];
  if (primaryCta === undefined) {
    return ok(null);
  }

  const items = changedRows.slice(0, MAX_DIGEST_ITEMS).flatMap((row) => {
    const stateKind = getDigestStateKind(row);
    if (stateKind === null) {
      return [];
    }

    const interactionConfig = interactionConfigMap.get(row.record.interactionId) ?? null;
    const interactionLabel = interactionConfig?.label ?? row.record.interactionId;
    const entityCui = getEntityCui(row);
    const entityName =
      entityCui !== null ? (entityNameMap.get(entityCui) ?? entityCui) : 'Localitate';
    const inlineAction = resolveDigestItemAction({
      platformBaseUrl: input.platformBaseUrl,
      row,
      entityState: entityCui === null ? null : (entityStates.get(entityCui) ?? null),
    });

    return [
      buildDigestItemCopy({
        row,
        entityName,
        interactionLabel,
        stateKind,
        actionLabel: inlineAction.label,
        actionUrl: inlineAction.url,
      }),
    ];
  });

  const summary: WeeklyProgressDigestProps['summary'] = {
    totalItemCount: changedRows.length,
    visibleItemCount: items.length,
    hiddenItemCount: Math.max(changedRows.length - items.length, 0),
    actionNowCount: changedRows.filter((row) => {
      const stateKind = getDigestStateKind(row);
      return stateKind === 'rejected' || stateKind === 'failed' || stateKind === 'draft';
    }).length,
    approvedCount: changedRows.filter((row) => getDigestStateKind(row) === 'approved').length,
    rejectedCount: changedRows.filter((row) => getDigestStateKind(row) === 'rejected').length,
    pendingCount: changedRows.filter((row) => getDigestStateKind(row) === 'pending').length,
    draftCount: changedRows.filter((row) => getDigestStateKind(row) === 'draft').length,
    failedCount: changedRows.filter((row) => getDigestStateKind(row) === 'failed').length,
  };

  const previewEntity = getPrimaryPreviewEntity(items);
  return ok({
    userId: input.userId,
    previewEntityCui: previewEntity.entityCui,
    previewEntityName: previewEntity.entityName,
    summary,
    items,
    primaryCta,
    secondaryCtas: orderedActions.slice(1, 3).map(({ label, url }) => ({ label, url })),
    allUpdatesUrl: null,
  });
};

type WeeklyProgressDigestNotificationInput = WeeklyProgressDigestExecutionData['notificationInput'];

const buildNotificationInputFromCandidate = (input: {
  candidate: WeeklyDigestCandidate;
  weekKey: string;
  periodLabel: string;
  watermarkAt: string;
}): WeeklyProgressDigestNotificationInput => {
  return {
    userId: input.candidate.userId,
    weekKey: input.weekKey,
    periodLabel: input.periodLabel,
    watermarkAt: input.watermarkAt,
    summary: input.candidate.summary,
    items: input.candidate.items,
    primaryCta: input.candidate.primaryCta,
    secondaryCtas: input.candidate.secondaryCtas,
    ...(input.candidate.allUpdatesUrl !== undefined
      ? { allUpdatesUrl: input.candidate.allUpdatesUrl }
      : {}),
  };
};

const buildNotificationInputFromMetadata = (metadata: {
  userId: string;
  weekKey: string;
  periodLabel: string;
  watermarkAt: string;
  summary: WeeklyProgressDigestProps['summary'];
  items: WeeklyProgressDigestProps['items'];
  primaryCta: WeeklyProgressDigestProps['primaryCta'];
  secondaryCtas: WeeklyProgressDigestProps['secondaryCtas'];
  allUpdatesUrl?: string | null;
}): WeeklyProgressDigestNotificationInput => {
  return {
    userId: metadata.userId,
    weekKey: metadata.weekKey,
    periodLabel: metadata.periodLabel,
    watermarkAt: metadata.watermarkAt,
    summary: metadata.summary,
    items: metadata.items,
    primaryCta: metadata.primaryCta,
    secondaryCtas: metadata.secondaryCtas,
    ...(metadata.allUpdatesUrl !== undefined ? { allUpdatesUrl: metadata.allUpdatesUrl } : {}),
  };
};

const buildCandidateFromNotificationInput = (
  notificationInput: WeeklyProgressDigestNotificationInput
): WeeklyDigestCandidate => {
  const previewEntity = getPrimaryPreviewEntity(notificationInput.items);

  return {
    userId: notificationInput.userId,
    previewEntityCui: previewEntity.entityCui,
    previewEntityName: previewEntity.entityName,
    summary: notificationInput.summary,
    items: notificationInput.items,
    primaryCta: notificationInput.primaryCta,
    secondaryCtas: notificationInput.secondaryCtas,
    ...(notificationInput.allUpdatesUrl !== undefined
      ? { allUpdatesUrl: notificationInput.allUpdatesUrl }
      : {}),
  };
};

const toStoredDryRunRow = (input: {
  candidate: WeeklyDigestCandidate;
  weekKey: string;
  watermark: string;
  periodLabel: string;
  evaluation: EnqueueWeeklyProgressDigestNotificationResult;
  notificationInput: WeeklyProgressDigestNotificationInput | null;
}): CampaignNotificationStoredPlanRow => {
  const status =
    input.notificationInput === null
      ? 'missing_data'
      : input.evaluation.reason === 'existing_pending'
        ? 'already_pending'
        : input.evaluation.reason === 'existing_sent' ||
            input.evaluation.reason === 'existing_not_replayable'
          ? 'already_sent'
          : input.evaluation.reason === 'ineligible_now'
            ? 'ineligible'
            : 'will_send';
  const reasonCode =
    input.notificationInput === null
      ? 'invalid_existing_snapshot'
      : input.evaluation.reason === 'ineligible_now'
        ? input.evaluation.eligibility.reason
        : input.evaluation.reason;
  const preview = basePreviewRow({
    userId: input.candidate.userId,
    entityCui: input.candidate.previewEntityCui,
    entityName: input.candidate.previewEntityName,
    status,
    reasonCode,
    statusMessage: toStatusMessage({
      status,
      reasonCode,
    }),
    hasExistingDelivery:
      input.evaluation.reason !== 'eligible_now' && input.evaluation.outboxId !== undefined,
    existingDeliveryStatus: input.evaluation.outboxStatus ?? null,
    sendMode:
      input.notificationInput === null
        ? null
        : input.evaluation.reason === 'existing_failed_transient'
          ? 'reuse_claimable'
          : input.evaluation.reason === 'eligible_now'
            ? 'create'
            : null,
    weekKey: input.weekKey,
  });

  return {
    preview,
    executionData:
      preview.status === 'will_send' && input.notificationInput !== null
        ? {
            kind: 'weekly_progress_digest',
            notificationInput: input.notificationInput,
          }
        : null,
  };
};

const parseExecutionData = (
  value: Record<string, unknown> | null
): WeeklyProgressDigestExecutionData | null => {
  if (value?.['kind'] !== 'weekly_progress_digest') {
    return null;
  }

  const notificationInput = value['notificationInput'];
  if (typeof notificationInput !== 'object' || notificationInput === null) {
    return null;
  }

  const candidate = notificationInput as Partial<
    WeeklyProgressDigestExecutionData['notificationInput']
  >;
  const primaryCta = candidate.primaryCta;
  const summary = candidate.summary;
  if (
    typeof candidate.userId !== 'string' ||
    typeof candidate.weekKey !== 'string' ||
    typeof candidate.periodLabel !== 'string' ||
    typeof candidate.watermarkAt !== 'string' ||
    typeof primaryCta !== 'object' ||
    !Array.isArray(candidate.secondaryCtas) ||
    !Array.isArray(candidate.items) ||
    typeof summary !== 'object'
  ) {
    return null;
  }

  return value as unknown as WeeklyProgressDigestExecutionData;
};

export interface WeeklyProgressDigestRunnableDeps {
  learningProgressRepo: LearningProgressRepository;
  extendedNotificationsRepo: ExtendedNotificationsRepository;
  deliveryRepo: DeliveryRepository;
  composeJobScheduler: ComposeJobScheduler;
  entityRepo: EntityRepository;
  platformBaseUrl: string;
}

export const makeWeeklyProgressDigestRunnableDefinition = (
  deps: WeeklyProgressDigestRunnableDeps
): CampaignNotificationRunnableTemplateDefinition => {
  return {
    runnableId: RUNNABLE_ID,
    campaignKey: 'funky',
    templateId: WEEKLY_PROGRESS_DIGEST_TEMPLATE_ID,
    templateVersion: TEMPLATE_VERSION,
    description:
      'Dry-run and send the weekly progress digest for the Funky campaign using stored plans.',
    selectorSchema: WeeklyProgressDigestSelectorsSchema,
    filterSchema: WeeklyProgressDigestFiltersSchema,
    selectors: listSchemaFields(WeeklyProgressDigestSelectorsSchema),
    filters: listSchemaFields(WeeklyProgressDigestFiltersSchema),
    targetKind: 'user',
    dryRunRequired: true,
    maxPlanRowCount: MAX_PLAN_ROW_COUNT,
    defaultPageSize: DEFAULT_PAGE_SIZE,
    maxPageSize: MAX_PAGE_SIZE,
    async dryRun(input) {
      if (
        !Value.Check(WeeklyProgressDigestSelectorsSchema, input.selectors) ||
        !Value.Check(WeeklyProgressDigestFiltersSchema, input.filters)
      ) {
        return err(createValidationError('Invalid weekly progress digest runnable payload.'));
      }

      const selectors = input.selectors as WeeklyProgressDigestSelectors;
      const activeNotificationsResult = await deps.extendedNotificationsRepo.findActiveByType(
        FUNKY_NOTIFICATION_GLOBAL_TYPE
      );
      if (activeNotificationsResult.isErr()) {
        return err(
          createDatabaseError(
            'Failed to enumerate weekly progress digest candidates.',
            'retryable' in activeNotificationsResult.error
              ? activeNotificationsResult.error.retryable
              : false
          )
        );
      }

      const weekKey = buildWeekKey(new Date());
      const watermark = new Date().toISOString();
      const periodLabel = buildPeriodLabel(new Date(watermark));
      const candidateUserIds =
        selectors.userId !== undefined
          ? [selectors.userId]
          : [
              ...new Set(
                activeNotificationsResult.value.map((notification) => notification.userId)
              ),
            ].sort();

      const rows: CampaignNotificationStoredPlanRow[] = [];
      let summary = createEmptySummary();

      for (const userId of candidateUserIds) {
        const cursorResult = await getWeeklyDigestCursor(
          { repo: deps.learningProgressRepo },
          { userId }
        );
        if (cursorResult.isErr()) {
          return err(
            createDatabaseError(
              cursorResult.error.message,
              'retryable' in cursorResult.error ? cursorResult.error.retryable : true
            )
          );
        }

        const candidateResult = await buildDigestCandidate({
          userId,
          repo: deps.learningProgressRepo,
          entityRepo: deps.entityRepo,
          platformBaseUrl: deps.platformBaseUrl,
          watermarkAt: cursorResult.value.watermarkAt,
          upperBoundAt: watermark,
        });
        if (candidateResult.isErr()) {
          return err(candidateResult.error);
        }

        const candidate = candidateResult.value;
        if (candidate === null) {
          continue;
        }

        const dryRunResult = await enqueueWeeklyProgressDigestNotification(
          {
            notificationsRepo: deps.extendedNotificationsRepo,
            deliveryRepo: deps.deliveryRepo,
            composeJobScheduler: deps.composeJobScheduler,
          },
          {
            runId: `campaign-admin-runnable-dry-run-${randomUUID()}`,
            dryRun: true,
            triggerSource: 'campaign_admin',
            triggeredByUserId: input.actorUserId,
            userId,
            weekKey,
            periodLabel,
            watermarkAt: watermark,
            summary: candidate.summary,
            items: candidate.items,
            primaryCta: candidate.primaryCta,
            secondaryCtas: candidate.secondaryCtas,
            ...(candidate.allUpdatesUrl !== undefined
              ? { allUpdatesUrl: candidate.allUpdatesUrl }
              : {}),
          }
        );
        if (dryRunResult.isErr()) {
          return err(
            createDatabaseError(
              getErrorMessage(dryRunResult.error),
              'retryable' in dryRunResult.error ? dryRunResult.error.retryable : false
            )
          );
        }

        let effectiveCandidate = candidate;
        let notificationInput: WeeklyProgressDigestNotificationInput | null =
          buildNotificationInputFromCandidate({
            candidate,
            weekKey,
            periodLabel,
            watermarkAt: watermark,
          });

        if (
          dryRunResult.value.reason === 'existing_failed_transient' &&
          dryRunResult.value.outboxId !== undefined
        ) {
          const existingOutboxResult = await deps.deliveryRepo.findById(
            dryRunResult.value.outboxId
          );
          if (existingOutboxResult.isErr()) {
            return err(
              createDatabaseError(
                getErrorMessage(existingOutboxResult.error),
                'retryable' in existingOutboxResult.error
                  ? existingOutboxResult.error.retryable
                  : false
              )
            );
          }

          const existingOutbox = existingOutboxResult.value;
          if (existingOutbox === null) {
            notificationInput = null;
          } else {
            const metadataResult = parseWeeklyProgressDigestOutboxMetadata(existingOutbox.metadata);
            if (metadataResult.isErr()) {
              notificationInput = null;
            } else {
              notificationInput = buildNotificationInputFromMetadata(metadataResult.value);
              effectiveCandidate = buildCandidateFromNotificationInput(notificationInput);
            }
          }
        }

        const storedRow = toStoredDryRunRow({
          candidate: effectiveCandidate,
          weekKey,
          watermark,
          periodLabel,
          evaluation: dryRunResult.value,
          notificationInput,
        });
        rows.push(storedRow);
        summary = addSummaryRow(summary, storedRow.preview.status);

        if (rows.length > MAX_PLAN_ROW_COUNT) {
          return err(
            createValidationError(
              `Dry run exceeds the ${String(MAX_PLAN_ROW_COUNT)} row safety cap. Narrow the selector scope.`
            )
          );
        }
      }

      return ok({
        watermark,
        summary,
        rows,
      });
    },
    async executeStoredRow(input) {
      const executionData = parseExecutionData(input.row.executionData);
      if (executionData === null) {
        return ok({ outcome: 'missing_data' as const });
      }

      const enqueueResult = await enqueueWeeklyProgressDigestNotification(
        {
          notificationsRepo: deps.extendedNotificationsRepo,
          deliveryRepo: deps.deliveryRepo,
          composeJobScheduler: deps.composeJobScheduler,
        },
        {
          runId: `campaign-admin-runnable-send-${randomUUID()}`,
          dryRun: false,
          triggerSource: 'campaign_admin',
          triggeredByUserId: input.actorUserId,
          ...executionData.notificationInput,
        }
      );
      if (enqueueResult.isErr()) {
        return err(
          createDatabaseError(
            getErrorMessage(enqueueResult.error),
            'retryable' in enqueueResult.error ? enqueueResult.error.retryable : false
          )
        );
      }

      if (enqueueResult.value.status === 'queued') {
        return ok({ outcome: 'queued' as const });
      }

      if (enqueueResult.value.status === 'recorded') {
        return ok({ outcome: 'enqueue_failed' as const });
      }

      if (enqueueResult.value.reason === 'existing_pending') {
        return ok({ outcome: 'already_pending' as const });
      }

      if (enqueueResult.value.reason === 'ineligible_now') {
        return ok({ outcome: 'ineligible' as const });
      }

      return ok({ outcome: 'already_sent' as const });
    },
  };
};
