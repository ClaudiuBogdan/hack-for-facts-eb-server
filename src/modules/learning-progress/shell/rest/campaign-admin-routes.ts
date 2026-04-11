import { type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { err, fromThrowable, ok, type Result } from 'neverthrow';

import { FUNKY_CAMPAIGN_KEY } from '@/common/campaign-keys.js';
import {
  CITY_HALL_WEBSITE_INTERACTION_ID,
  DEBATE_REQUEST_INTERACTION_ID,
  parseBudgetDocumentPayloadValue,
  parseBudgetPublicationDatePayloadValue,
  parseBudgetStatusReportPayloadValue,
  parseCityHallContactPayloadValue,
  parseContestationBuilderPayloadValue,
  parseDebateRequestPayloadValue,
  parseParticipationReportPayloadValue,
} from '@/common/campaign-user-interactions.js';
import { requireAuth } from '@/modules/auth/index.js';
import {
  EMAIL_REGEX,
  getHttpStatusForError as getCorrespondenceHttpStatusForError,
  normalizeEmailAddress,
  type InstitutionCorrespondenceError,
} from '@/modules/institution-correspondence/index.js';

import {
  CampaignAdminCursorSchema,
  CampaignAdminMetaResponseSchema,
  CampaignAdminInteractionListItemSchema,
  CampaignAdminListQuerySchema,
  CampaignAdminListResponseSchema,
  CampaignAdminSubmitReviewsBodySchema,
  CampaignAdminSubmitReviewsResponseSchema,
  CampaignKeyParamsSchema,
  ErrorResponseSchema,
  type CampaignAdminListQuery,
  type CampaignAdminSubmitReviewsBody,
  type CampaignKeyParams,
} from './campaign-admin-schemas.js';
import {
  createConflictError,
  createInvalidEventError,
  createNotFoundError,
  getHttpStatusForError,
  type LearningProgressError,
} from '../../core/errors.js';
import { validateRecordKeyPrefix } from '../../core/namespace.js';
import { submitInteractionReviews } from '../../core/usecases/submit-interaction-reviews.js';

import type { LearningProgressRepository } from '../../core/ports.js';
import type {
  ApprovedReviewSideEffectPlan,
  CampaignAdminCampaignKey,
  CampaignAdminInteractionRow,
  CampaignAdminListCursor,
  CampaignAdminRiskFlagCandidate,
  ListCampaignAdminInteractionRowsInput,
  CampaignAdminSubmissionPath,
  ReviewDecision,
} from '../../core/types.js';
import type { CampaignAdminPermissionAuthorizer } from '../security/clerk-campaign-admin-permission-checker.js';
import type { EntityProfileRepository, EntityRepository } from '@/modules/entity/index.js';
import type { FastifyBaseLogger, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';

type CampaignAdminInteractionListItem = Static<typeof CampaignAdminInteractionListItemSchema>;
type CampaignAdminSortKey = NonNullable<CampaignAdminListQuery['sortBy']>;
type CampaignAdminSortOrder = NonNullable<CampaignAdminListQuery['sortOrder']>;

interface CampaignAdminPageCursor {
  readonly userId: string;
  readonly recordKey: string;
  readonly sortBy: CampaignAdminSortKey | null;
  readonly sortOrder: CampaignAdminSortOrder | null;
}

interface CampaignAdminNormalizedSort {
  readonly sortBy: CampaignAdminSortKey;
  readonly sortOrder: CampaignAdminSortOrder;
}

type CampaignReviewProjectionKind =
  | 'public_debate_request'
  | 'website_url'
  | 'budget_document'
  | 'budget_publication_date'
  | 'budget_status'
  | 'city_hall_contact'
  | 'participation_report'
  | 'contestation';
interface CampaignInteractionStepLocation {
  moduleSlug: string;
  challengeSlug: string;
  stepSlug: string;
}

interface CampaignReviewInteractionConfig {
  campaignKey: CampaignAdminCampaignKey;
  interactionId: string;
  label: string | null;
  projection: CampaignReviewProjectionKind;
  interactionStepLocation: CampaignInteractionStepLocation | null;
  reviewableSubmissionPath?: CampaignAdminSubmissionPath;
  supportsInstitutionThreadSummary: boolean;
}

interface CampaignReviewConfig {
  campaignKey: CampaignAdminCampaignKey;
  permissionName: string;
  interactions: readonly CampaignReviewInteractionConfig[];
}

interface CampaignAdminAccessContext {
  userId: string;
  config: CampaignReviewConfig;
}

declare module 'fastify' {
  interface FastifyRequest {
    campaignAdminAccess: CampaignAdminAccessContext | null;
  }
}

const FUNKY_CAMPAIGN_ADMIN_PERMISSION = 'campaign:funky_admin' as const;
const DEFAULT_PAGE_LIMIT = 50;
const INTERNAL_ROW_FETCH_LIMIT = 500;
const MAX_CAMPAIGN_ADMIN_LIST_ROWS = 5000;
const SORT_VALUE_COLLATOR = new Intl.Collator('en', {
  numeric: true,
  sensitivity: 'base',
});

// Maintenance note: check /docs/guides/INTERACTIVE-ELEMENT-CHECKS-AND-TRIGGERS.md.
const CAMPAIGN_REVIEW_CONFIGS: Readonly<Record<CampaignAdminCampaignKey, CampaignReviewConfig>> = {
  [FUNKY_CAMPAIGN_KEY]: {
    campaignKey: FUNKY_CAMPAIGN_KEY,
    permissionName: FUNKY_CAMPAIGN_ADMIN_PERMISSION,
    interactions: [
      {
        campaignKey: FUNKY_CAMPAIGN_KEY,
        interactionId: DEBATE_REQUEST_INTERACTION_ID,
        label: 'Public debate request',
        projection: 'public_debate_request',
        interactionStepLocation: {
          moduleSlug: 'civic-campaign',
          challengeSlug: 'civic-monitor-and-request',
          stepSlug: '04-debate-request',
        },
        reviewableSubmissionPath: 'request_platform',
        supportsInstitutionThreadSummary: true,
      },
      {
        campaignKey: FUNKY_CAMPAIGN_KEY,
        interactionId: CITY_HALL_WEBSITE_INTERACTION_ID,
        label: 'City hall website',
        projection: 'website_url',
        interactionStepLocation: {
          moduleSlug: 'civic-campaign',
          challengeSlug: 'civic-monitor-and-request',
          stepSlug: '03-budget-status-2026',
        },
        supportsInstitutionThreadSummary: false,
      },
    ],
  },
};

export const CAMPAIGN_ADMIN_REVIEW_CAMPAIGN_KEYS = Object.freeze(
  Object.keys(CAMPAIGN_REVIEW_CONFIGS) as CampaignAdminCampaignKey[]
);

export interface MakeCampaignAdminUserInteractionRoutesDeps {
  learningProgressRepo: LearningProgressRepository;
  entityRepo: EntityRepository;
  entityProfileRepo: EntityProfileRepository;
  permissionAuthorizer: CampaignAdminPermissionAuthorizer;
  enabledCampaignKeys: readonly CampaignAdminCampaignKey[];
  prepareApproveReviews?: (input: {
    items: readonly ReviewDecision[];
  }) => Promise<
    Result<
      ApprovedReviewSideEffectPlan | null,
      LearningProgressError | InstitutionCorrespondenceError
    >
  >;
}

function isInstitutionCorrespondenceError(error: unknown): error is InstitutionCorrespondenceError {
  if (typeof error !== 'object' || error === null || !('type' in error) || !('message' in error)) {
    return false;
  }

  const candidate = error as { type?: unknown; message?: unknown };
  return typeof candidate.type === 'string' && candidate.type.startsWith('Correspondence');
}

function getCampaignReviewConfig(campaignKey: string): CampaignReviewConfig | null {
  const configMap = CAMPAIGN_REVIEW_CONFIGS as Partial<Record<string, CampaignReviewConfig>>;
  return configMap[campaignKey] ?? null;
}

function getCampaignInteractionConfig(
  config: CampaignReviewConfig,
  interactionId: string
): CampaignReviewInteractionConfig | null {
  return (
    config.interactions.find((interaction) => interaction.interactionId === interactionId) ?? null
  );
}

function encodeCursor(cursor: CampaignAdminPageCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf-8').toString('base64url');
}

function isCampaignAdminPageCursor(value: unknown): value is CampaignAdminPageCursor {
  return Value.Check(CampaignAdminCursorSchema, value);
}

function decodeCursor(encodedCursor: string): CampaignAdminPageCursor | null {
  const safeJsonParse = fromThrowable(JSON.parse);

  try {
    const decoded = Buffer.from(encodedCursor, 'base64url').toString('utf-8');
    const parseResult = safeJsonParse(decoded);
    if (parseResult.isErr()) {
      return null;
    }

    const payload: unknown = parseResult.value;
    return isCampaignAdminPageCursor(payload) ? payload : null;
  } catch {
    return null;
  }
}

function getDefaultSortOrder(sortBy: CampaignAdminSortKey): CampaignAdminSortOrder {
  switch (sortBy) {
    case 'updatedAt':
    case 'riskFlagCount':
      return 'desc';
    default:
      return 'asc';
  }
}

function normalizeRequestedSort(
  query: Pick<CampaignAdminListQuery, 'sortBy' | 'sortOrder'>
): CampaignAdminNormalizedSort | null {
  if (query.sortBy === undefined) {
    return null;
  }

  return {
    sortBy: query.sortBy,
    sortOrder: query.sortOrder ?? getDefaultSortOrder(query.sortBy),
  };
}

function getCampaignAdminReviewStatusLabel(
  status: CampaignAdminInteractionListItem['reviewStatus']
): string {
  switch (status) {
    case 'pending':
      return 'Pending';
    case 'approved':
      return 'Approved';
    case 'rejected':
      return 'Rejected';
    case null:
      return 'Not reviewed';
    default:
      return 'Unknown';
  }
}

function getCampaignAdminThreadPhaseLabel(
  value: CampaignAdminInteractionListItem['threadPhase']
): string {
  switch (value) {
    case 'sending':
      return 'Sending';
    case 'awaiting_reply':
      return 'Awaiting reply';
    case 'reply_received_unreviewed':
      return 'Reply received';
    case 'manual_follow_up_needed':
      return 'Manual follow-up';
    case 'resolved_positive':
      return 'Resolved positive';
    case 'resolved_negative':
      return 'Resolved negative';
    case 'closed_no_response':
      return 'Closed without reply';
    case 'failed':
      return 'Thread failed';
    case null:
      return 'No thread';
    default:
      return 'Unknown';
  }
}

function compareNullableValues<T>(
  left: T | null | undefined,
  right: T | null | undefined,
  compareValues: (leftValue: T, rightValue: T) => number,
  sortOrder: CampaignAdminSortOrder
): number {
  if (left === null || left === undefined) {
    return right === null || right === undefined ? 0 : 1;
  }

  if (right === null || right === undefined) {
    return -1;
  }

  const baseComparison = compareValues(left, right);
  return sortOrder === 'asc' ? baseComparison : -baseComparison;
}

function getEntitySortValue(item: CampaignAdminInteractionListItem): string | null {
  const trimmedEntityName = item.entityName?.trim();
  return trimmedEntityName !== undefined && trimmedEntityName !== ''
    ? trimmedEntityName
    : item.entityCui;
}

function getInteractionTypeSortValue(
  item: CampaignAdminInteractionListItem,
  config: CampaignReviewConfig
): string {
  const trimmedLabel = getCampaignInteractionConfig(config, item.interactionId)?.label?.trim();
  return trimmedLabel !== undefined && trimmedLabel !== '' ? trimmedLabel : item.interactionId;
}

function getSortValue(input: {
  item: CampaignAdminInteractionListItem;
  sortBy: CampaignAdminSortKey;
  config: CampaignReviewConfig;
}): string | number | null {
  const { item, sortBy, config } = input;

  switch (sortBy) {
    case 'reviewStatus':
      return getCampaignAdminReviewStatusLabel(item.reviewStatus);
    case 'userId':
      return item.userId;
    case 'organizationName':
      return item.organizationName;
    case 'entity':
      return getEntitySortValue(item);
    case 'updatedAt': {
      const timestamp = Date.parse(item.updatedAt);
      return Number.isFinite(timestamp) ? timestamp : null;
    }
    case 'riskFlagCount':
      return item.riskFlags.length;
    case 'threadPhase':
      return getCampaignAdminThreadPhaseLabel(item.threadPhase);
    case 'interactionType':
      return getInteractionTypeSortValue(item, config);
    case 'reviewedByUserId':
      return item.reviewedByUserId;
    default:
      return null;
  }
}

function compareItemTieBreakers(
  left: CampaignAdminInteractionListItem,
  right: CampaignAdminInteractionListItem
): number {
  if (left.updatedAt !== right.updatedAt) {
    return left.updatedAt.localeCompare(right.updatedAt);
  }

  if (left.userId !== right.userId) {
    return SORT_VALUE_COLLATOR.compare(left.userId, right.userId);
  }

  return SORT_VALUE_COLLATOR.compare(left.recordKey, right.recordKey);
}

function compareCampaignAdminInteractionItems(input: {
  left: CampaignAdminInteractionListItem;
  right: CampaignAdminInteractionListItem;
  sort: CampaignAdminNormalizedSort;
  config: CampaignReviewConfig;
}): number {
  const leftValue = getSortValue({
    item: input.left,
    sortBy: input.sort.sortBy,
    config: input.config,
  });
  const rightValue = getSortValue({
    item: input.right,
    sortBy: input.sort.sortBy,
    config: input.config,
  });

  const valueComparison =
    typeof leftValue === 'number' || typeof rightValue === 'number'
      ? compareNullableValues(
          typeof leftValue === 'number' ? leftValue : null,
          typeof rightValue === 'number' ? rightValue : null,
          (resolvedLeftValue, resolvedRightValue) => resolvedLeftValue - resolvedRightValue,
          input.sort.sortOrder
        )
      : compareNullableValues(
          typeof leftValue === 'string' ? leftValue : null,
          typeof rightValue === 'string' ? rightValue : null,
          (resolvedLeftValue, resolvedRightValue) =>
            SORT_VALUE_COLLATOR.compare(resolvedLeftValue, resolvedRightValue),
          input.sort.sortOrder
        );

  if (valueComparison !== 0) {
    return valueComparison;
  }

  return compareItemTieBreakers(input.left, input.right);
}

function sortCampaignAdminInteractionItems(input: {
  items: readonly CampaignAdminInteractionListItem[];
  sort: CampaignAdminNormalizedSort | null;
  config: CampaignReviewConfig;
}): readonly CampaignAdminInteractionListItem[] {
  if (input.sort === null) {
    return input.items;
  }

  const { sort } = input;
  return [...input.items].sort((left, right) =>
    compareCampaignAdminInteractionItems({
      left,
      right,
      sort,
      config: input.config,
    })
  );
}

function resolvePageStartIndex(input: {
  items: readonly CampaignAdminInteractionListItem[];
  cursor: CampaignAdminPageCursor | undefined;
  sort: CampaignAdminNormalizedSort | null;
}): number | null {
  if (input.cursor === undefined) {
    return 0;
  }

  const cursor = input.cursor;

  const expectedSortBy = input.sort?.sortBy ?? null;
  const expectedSortOrder = input.sort?.sortOrder ?? null;
  if (cursor.sortBy !== expectedSortBy || cursor.sortOrder !== expectedSortOrder) {
    return null;
  }

  const index = input.items.findIndex(
    (item) => item.userId === cursor.userId && item.recordKey === cursor.recordKey
  );

  return index === -1 ? null : index + 1;
}

function buildNextCursor(input: {
  items: readonly CampaignAdminInteractionListItem[];
  hasMore: boolean;
  sort: CampaignAdminNormalizedSort | null;
}): string | null {
  if (!input.hasMore || input.items.length === 0) {
    return null;
  }

  const lastItem = input.items.at(-1);
  if (lastItem === undefined) {
    return null;
  }

  return encodeCursor({
    userId: lastItem.userId,
    recordKey: lastItem.recordKey,
    sortBy: input.sort?.sortBy ?? null,
    sortOrder: input.sort?.sortOrder ?? null,
  });
}

function getReviewStatus(
  row: CampaignAdminInteractionRow
): CampaignAdminInteractionListItem['reviewStatus'] {
  if (row.record.review?.status !== undefined) {
    return row.record.review.status;
  }

  return row.record.phase === 'pending' ? 'pending' : null;
}

function getPendingReason(input: {
  reviewStatus: CampaignAdminInteractionListItem['reviewStatus'];
  riskFlags: readonly CampaignAdminInteractionListItem['riskFlags'][number][];
}): CampaignAdminInteractionListItem['pendingReason'] {
  if (input.reviewStatus !== 'pending') {
    return null;
  }

  if (input.riskFlags.includes('invalid_institution_email')) {
    return 'invalid_institution_email';
  }

  if (input.riskFlags.includes('missing_official_email')) {
    return 'missing_official_email';
  }

  if (input.riskFlags.includes('institution_email_mismatch')) {
    return 'institution_email_mismatch';
  }

  if (input.riskFlags.includes('institution_thread_failed')) {
    return 'institution_thread_failed';
  }

  return 'awaiting_manual_review';
}

function getLastAuditAt(row: CampaignAdminInteractionRow): string | null {
  let lastAuditAt: string | null = null;

  for (const auditEvent of row.auditEvents) {
    if (lastAuditAt === null || auditEvent.at > lastAuditAt) {
      lastAuditAt = auditEvent.at;
    }
  }

  return lastAuditAt;
}

function toNullableTrimmedString(value: string | null | undefined): string | null {
  const trimmedValue = value?.trim();
  return trimmedValue === undefined || trimmedValue === '' ? null : trimmedValue;
}

function buildCampaignProvocariStepPath(
  entityCui: string,
  stepLocation: CampaignInteractionStepLocation
): string {
  const encodedEntityCui = encodeURIComponent(entityCui.trim());
  const encodeSegment = (value: string) => encodeURIComponent(value.trim());

  return `/primarie/${encodedEntityCui}/buget/provocari/${encodeSegment(stepLocation.moduleSlug)}/${encodeSegment(stepLocation.challengeSlug)}/${encodeSegment(stepLocation.stepSlug)}`;
}

function extractEntityCui(row: Pick<CampaignAdminInteractionRow, 'record'>): string | null {
  if (row.record.scope.type !== 'entity') {
    return null;
  }

  const entityCui = row.record.scope.entityCui;
  return typeof entityCui === 'string' ? toNullableTrimmedString(entityCui) : null;
}

function extractWebsiteUrl(row: Pick<CampaignAdminInteractionRow, 'record'>): string | null {
  if (row.record.value?.kind === 'url') {
    return toNullableTrimmedString(row.record.value.url.value);
  }

  if (row.record.value?.kind !== 'json') {
    return null;
  }

  const candidate = row.record.value.json.value['websiteUrl'];
  return typeof candidate === 'string' ? toNullableTrimmedString(candidate) : null;
}

function selectReviewableInteractions(input: {
  config: CampaignReviewConfig;
  interactionId?: string;
  submissionPath?: CampaignAdminSubmissionPath;
  requiresInstitutionThreadSummary: boolean;
}): readonly CampaignReviewInteractionConfig[] {
  let interactions = input.config.interactions;

  if (input.interactionId !== undefined) {
    interactions = interactions.filter(
      (interaction) => interaction.interactionId === input.interactionId
    );
  }

  if (input.submissionPath !== undefined) {
    interactions = interactions.filter(
      (interaction) =>
        interaction.reviewableSubmissionPath === undefined ||
        interaction.reviewableSubmissionPath === input.submissionPath
    );
  }

  if (input.requiresInstitutionThreadSummary) {
    interactions = interactions.filter(
      (interaction) => interaction.supportsInstitutionThreadSummary
    );
  }

  return interactions;
}

function collectUniqueEntityCuis(values: readonly (string | null)[]): string[] {
  return [...new Set(values.filter((value): value is string => value !== null))];
}

async function loadOfficialEmailMapForEntityCuis(input: {
  entityCuis: readonly string[];
  entityProfileRepo: EntityProfileRepository;
  log: Pick<FastifyBaseLogger, 'warn'>;
  failureMessage: string;
}): Promise<{
  officialEmailMap: Map<string, string | null>;
  lookupFailed: boolean;
}> {
  if (input.entityCuis.length === 0) {
    return {
      officialEmailMap: new Map(),
      lookupFailed: false,
    };
  }

  const profilesResult = await input.entityProfileRepo.getByEntityCuis([...input.entityCuis]);
  if (profilesResult.isErr()) {
    input.log.warn(
      { error: profilesResult.error, entityCuis: input.entityCuis },
      input.failureMessage
    );
    return {
      officialEmailMap: new Map(),
      lookupFailed: true,
    };
  }

  return {
    officialEmailMap: new Map(
      input.entityCuis.map((entityCui) => [
        entityCui,
        toNullableTrimmedString(profilesResult.value.get(entityCui)?.official_email),
      ])
    ),
    lookupFailed: false,
  };
}

async function loadOfficialEmailMap(
  rows: readonly CampaignAdminInteractionRow[],
  entityProfileRepo: EntityProfileRepository,
  log: Pick<FastifyBaseLogger, 'warn'>
): Promise<{
  officialEmailMap: Map<string, string | null>;
  lookupFailed: boolean;
}> {
  const entityCuis = collectUniqueEntityCuis(
    rows.flatMap((row) => {
      if (row.record.interactionId !== DEBATE_REQUEST_INTERACTION_ID) {
        return [];
      }

      const entityCui = extractEntityCui(row);
      return entityCui !== null ? [entityCui] : [];
    })
  );

  return loadOfficialEmailMapForEntityCuis({
    entityCuis,
    entityProfileRepo,
    log,
    failureMessage: 'Failed to load entity profiles for campaign-admin interaction review list',
  });
}

async function loadEntityNameMap(
  rows: readonly CampaignAdminInteractionRow[],
  entityRepo: EntityRepository,
  log: Pick<FastifyBaseLogger, 'warn'>
): Promise<Map<string, string | null>> {
  const entityCuis = [
    ...new Set(
      rows.flatMap((row) => {
        const entityCui = extractEntityCui(row);
        return entityCui !== null ? [entityCui] : [];
      })
    ),
  ];

  if (entityCuis.length === 0) {
    return new Map();
  }

  const entitiesResult = await entityRepo.getByIds(entityCuis);
  if (entitiesResult.isErr()) {
    log.warn(
      { error: entitiesResult.error, entityCuis },
      'Failed to load entity names for campaign-admin interaction review list'
    );
    return new Map();
  }

  return new Map(
    entityCuis.map((entityCui) => [
      entityCui,
      toNullableTrimmedString(entitiesResult.value.get(entityCui)?.name ?? null),
    ])
  );
}

function isCampaignAdminRiskFlagCandidateRisky(input: {
  candidate: CampaignAdminRiskFlagCandidate;
  interactionConfig: CampaignReviewInteractionConfig | null;
  officialEmail: string | null;
  officialEmailLookupFailed: boolean;
}): boolean {
  if (input.interactionConfig?.projection !== 'public_debate_request') {
    return false;
  }

  const institutionEmail = toNullableTrimmedString(input.candidate.institutionEmail);
  if (institutionEmail === null || !EMAIL_REGEX.test(institutionEmail)) {
    return true;
  }

  if (input.candidate.threadPhase === 'failed') {
    return true;
  }

  if (input.officialEmailLookupFailed) {
    return false;
  }

  if (input.officialEmail === null) {
    return true;
  }

  return normalizeEmailAddress(input.officialEmail) !== normalizeEmailAddress(institutionEmail);
}

async function countRiskFlaggedCampaignAdminItems(input: {
  riskFlagCandidates: readonly CampaignAdminRiskFlagCandidate[];
  config: CampaignReviewConfig;
  entityProfileRepo: EntityProfileRepository;
  log: Pick<FastifyBaseLogger, 'warn'>;
}): Promise<number> {
  const configByInteractionId = new Map(
    input.config.interactions.map((interaction) => [interaction.interactionId, interaction])
  );
  const entityCuis = collectUniqueEntityCuis(
    input.riskFlagCandidates.flatMap((candidate) => {
      const interactionConfig = configByInteractionId.get(candidate.interactionId) ?? null;
      if (interactionConfig?.projection !== 'public_debate_request') {
        return [];
      }

      return candidate.entityCui !== null ? [candidate.entityCui] : [];
    })
  );
  const { officialEmailMap, lookupFailed } = await loadOfficialEmailMapForEntityCuis({
    entityCuis,
    entityProfileRepo: input.entityProfileRepo,
    log: input.log,
    failureMessage: 'Failed to load entity profiles for campaign-admin interaction stats',
  });

  let riskFlagged = 0;

  for (const candidate of input.riskFlagCandidates) {
    const interactionConfig = configByInteractionId.get(candidate.interactionId) ?? null;
    const officialEmail =
      candidate.entityCui !== null ? (officialEmailMap.get(candidate.entityCui) ?? null) : null;

    if (
      isCampaignAdminRiskFlagCandidateRisky({
        candidate,
        interactionConfig,
        officialEmail,
        officialEmailLookupFailed: lookupFailed,
      })
    ) {
      riskFlagged += candidate.count;
    }
  }

  return riskFlagged;
}

function formatCampaignAdminInteractionRow(input: {
  row: CampaignAdminInteractionRow;
  interactionConfig: CampaignReviewInteractionConfig | null;
  entityName: string | null;
  officialEmail: string | null;
  officialEmailLookupFailed: boolean;
}): CampaignAdminInteractionListItem {
  const { row, interactionConfig, entityName, officialEmail, officialEmailLookupFailed } = input;
  const reviewStatus = getReviewStatus(row);
  const payloadSummary = (() => {
    switch (interactionConfig?.projection) {
      case 'public_debate_request': {
        if (row.record.value?.kind !== 'json') {
          return null;
        }

        const payload = parseDebateRequestPayloadValue(row.record.value.json.value);
        if (payload === null) {
          return null;
        }

        return {
          kind: 'public_debate_request' as const,
          institutionEmail: toNullableTrimmedString(payload.primariaEmail),
          organizationName: payload.organizationName ?? null,
          submissionPath: payload.submissionPath ?? null,
          isNgo: payload.isNgo,
        };
      }
      case 'website_url':
        return {
          kind: 'website_url' as const,
          websiteUrl: extractWebsiteUrl(row),
        };
      case 'budget_document': {
        if (row.record.value?.kind !== 'json') {
          return null;
        }

        const payload = parseBudgetDocumentPayloadValue(row.record.value.json.value);
        if (payload === null) {
          return null;
        }

        return {
          kind: 'budget_document' as const,
          documentUrl: toNullableTrimmedString(payload.documentUrl),
          documentTypes: [...payload.documentTypes],
        };
      }
      case 'budget_publication_date': {
        if (row.record.value?.kind !== 'json') {
          return null;
        }

        const payload = parseBudgetPublicationDatePayloadValue(row.record.value.json.value);
        if (payload === null) {
          return null;
        }

        return {
          kind: 'budget_publication_date' as const,
          publicationDate: toNullableTrimmedString(payload.publicationDate),
          sources: payload.sources.map((source) => ({
            type: source.type,
            url: toNullableTrimmedString(source.url),
          })),
        };
      }
      case 'budget_status': {
        if (row.record.value?.kind !== 'json') {
          return null;
        }

        const payload = parseBudgetStatusReportPayloadValue(row.record.value.json.value);
        if (payload === null) {
          return null;
        }

        return {
          kind: 'budget_status' as const,
          isPublished: payload.isPublished,
          budgetStage: payload.budgetStage,
        };
      }
      case 'city_hall_contact': {
        if (row.record.value?.kind !== 'json') {
          return null;
        }

        const payload = parseCityHallContactPayloadValue(row.record.value.json.value);
        if (payload === null) {
          return null;
        }

        return {
          kind: 'city_hall_contact' as const,
          email: toNullableTrimmedString(payload.email),
          phone: toNullableTrimmedString(payload.phone),
        };
      }
      case 'participation_report': {
        if (row.record.value?.kind !== 'json') {
          return null;
        }

        const payload = parseParticipationReportPayloadValue(row.record.value.json.value);
        if (payload === null) {
          return null;
        }

        return {
          kind: 'participation_report' as const,
          debateTookPlace: payload.debateTookPlace,
          approximateAttendees: payload.approximateAttendees,
          citizensAllowedToSpeak: payload.citizensAllowedToSpeak,
          citizenInputsRecorded: payload.citizenInputsRecorded,
          observations: toNullableTrimmedString(payload.observations),
        };
      }
      case 'contestation': {
        if (row.record.value?.kind !== 'json') {
          return null;
        }

        const payload = parseContestationBuilderPayloadValue(row.record.value.json.value);
        if (payload === null) {
          return null;
        }

        return {
          kind: 'contestation' as const,
          contestedItem: toNullableTrimmedString(payload.contestedItem),
          reasoning: toNullableTrimmedString(payload.reasoning),
          impact: toNullableTrimmedString(payload.impact),
          proposedChange: toNullableTrimmedString(payload.proposedChange),
          senderName: toNullableTrimmedString(payload.senderName),
          submissionPath: payload.submissionPath ?? null,
          institutionEmail: toNullableTrimmedString(payload.primariaEmail),
        };
      }
      default:
        return null;
    }
  })();
  const entityCui = extractEntityCui(row);
  const institutionEmail =
    payloadSummary?.kind === 'public_debate_request' ? payloadSummary.institutionEmail : null;
  const riskFlags: CampaignAdminInteractionListItem['riskFlags'] = [];
  const threadSummary =
    interactionConfig?.supportsInstitutionThreadSummary === true ? row.threadSummary : null;
  const interactionElementLink =
    entityCui !== null &&
    interactionConfig?.interactionStepLocation !== null &&
    interactionConfig?.interactionStepLocation !== undefined
      ? buildCampaignProvocariStepPath(entityCui, interactionConfig.interactionStepLocation)
      : null;

  if (interactionConfig?.projection === 'public_debate_request') {
    if (institutionEmail === null || !EMAIL_REGEX.test(institutionEmail)) {
      riskFlags.push('invalid_institution_email');
    } else if (!officialEmailLookupFailed && officialEmail === null) {
      riskFlags.push('missing_official_email');
    } else if (
      !officialEmailLookupFailed &&
      officialEmail !== null &&
      normalizeEmailAddress(officialEmail) !== normalizeEmailAddress(institutionEmail)
    ) {
      riskFlags.push('institution_email_mismatch');
    }

    if (threadSummary?.threadPhase === 'failed') {
      riskFlags.push('institution_thread_failed');
    }
  }

  const pendingReason = getPendingReason({
    reviewStatus,
    riskFlags,
  });

  return {
    userId: row.userId,
    recordKey: row.recordKey,
    campaignKey: row.campaignKey,
    interactionId: row.record.interactionId,
    lessonId: row.record.lessonId,
    entityCui,
    entityName,
    scopeType: row.record.scope.type,
    phase: row.record.phase,
    reviewStatus,
    pendingReason,
    submittedAt: row.record.submittedAt ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    reviewedAt: row.record.review?.reviewedAt ?? null,
    reviewedByUserId: row.record.review?.reviewedByUserId ?? null,
    reviewSource: row.record.review?.reviewSource ?? null,
    feedbackText: row.record.review?.feedbackText ?? null,
    payloadKind: row.record.value?.kind ?? null,
    payloadSummary,
    institutionEmail,
    websiteUrl: payloadSummary?.kind === 'website_url' ? payloadSummary.websiteUrl : null,
    organizationName:
      payloadSummary?.kind === 'public_debate_request' ? payloadSummary.organizationName : null,
    interactionElementLink,
    submissionPath:
      payloadSummary?.kind === 'public_debate_request' || payloadSummary?.kind === 'contestation'
        ? payloadSummary.submissionPath
        : null,
    isNgo: payloadSummary?.kind === 'public_debate_request' ? payloadSummary.isNgo : null,
    riskFlags,
    threadId: threadSummary?.threadId ?? null,
    threadPhase: threadSummary?.threadPhase ?? null,
    lastEmailAt: threadSummary?.lastEmailAt ?? null,
    lastReplyAt: threadSummary?.lastReplyAt ?? null,
    nextActionAt: threadSummary?.nextActionAt ?? null,
    submittedEventCount: row.auditEvents.filter((event) => event.type === 'submitted').length,
    evaluatedEventCount: row.auditEvents.filter((event) => event.type === 'evaluated').length,
    lastAuditAt: getLastAuditAt(row),
  };
}

async function formatCampaignAdminInteractionRows(input: {
  rows: readonly CampaignAdminInteractionRow[];
  config: CampaignReviewConfig;
  entityRepo: EntityRepository;
  entityProfileRepo: EntityProfileRepository;
  log: Pick<FastifyBaseLogger, 'warn'>;
}): Promise<readonly CampaignAdminInteractionListItem[]> {
  const entityNameMap = await loadEntityNameMap(input.rows, input.entityRepo, input.log);
  const { officialEmailMap, lookupFailed } = await loadOfficialEmailMap(
    input.rows,
    input.entityProfileRepo,
    input.log
  );
  const configByInteractionId = new Map(
    input.config.interactions.map((interaction) => [interaction.interactionId, interaction])
  );

  return input.rows.map((row) =>
    formatCampaignAdminInteractionRow({
      row,
      interactionConfig: configByInteractionId.get(row.record.interactionId) ?? null,
      entityName: (() => {
        const entityCui = extractEntityCui(row);
        return entityCui !== null ? (entityNameMap.get(entityCui) ?? null) : null;
      })(),
      officialEmail: (() => {
        const entityCui = extractEntityCui(row);
        return entityCui !== null ? (officialEmailMap.get(entityCui) ?? null) : null;
      })(),
      officialEmailLookupFailed: lookupFailed,
    })
  );
}

async function loadAllCampaignAdminInteractionRows(input: {
  repo: LearningProgressRepository;
  query: Omit<ListCampaignAdminInteractionRowsInput, 'cursor' | 'limit'>;
}): Promise<Result<readonly CampaignAdminInteractionRow[], LearningProgressError>> {
  const rows: CampaignAdminInteractionRow[] = [];
  let cursor: CampaignAdminListCursor | undefined;

  for (;;) {
    const result = await input.repo.listCampaignAdminInteractionRows({
      ...input.query,
      limit: INTERNAL_ROW_FETCH_LIMIT,
      ...(cursor !== undefined ? { cursor } : {}),
    });

    if (result.isErr()) {
      return err(result.error);
    }

    rows.push(...result.value.rows);
    if (rows.length > MAX_CAMPAIGN_ADMIN_LIST_ROWS) {
      return err(
        createInvalidEventError(
          `Campaign review query matched too many rows. Narrow the filters to ${String(MAX_CAMPAIGN_ADMIN_LIST_ROWS)} rows or fewer.`
        )
      );
    }

    if (!result.value.hasMore || result.value.nextCursor === null) {
      return ok(rows);
    }

    cursor = result.value.nextCursor;
  }
}

async function ensureCampaignAdminAccess(input: {
  campaignKey: string;
  userId: string;
  permissionAuthorizer: CampaignAdminPermissionAuthorizer;
  enabledCampaignKeys: ReadonlySet<string>;
}): Promise<
  | { ok: true; config: CampaignReviewConfig }
  | { ok: false; statusCode: 403 | 404; error: string; message: string }
> {
  if (!input.enabledCampaignKeys.has(input.campaignKey)) {
    return {
      ok: false,
      statusCode: 404,
      error: 'NotFoundError',
      message: 'Campaign review queue not found',
    };
  }

  const config = getCampaignReviewConfig(input.campaignKey);
  if (config === null) {
    return {
      ok: false,
      statusCode: 404,
      error: 'NotFoundError',
      message: 'Campaign review queue not found',
    };
  }

  const allowed = await input.permissionAuthorizer.hasPermission({
    userId: input.userId,
    permissionName: config.permissionName,
  });
  if (!allowed) {
    return {
      ok: false,
      statusCode: 403,
      error: 'ForbiddenError',
      message: 'You do not have permission to manage this campaign review queue',
    };
  }

  return { ok: true, config };
}

function sendCampaignAdminError(
  reply: FastifyReply,
  statusCode: 401 | 403 | 404,
  error: string,
  message: string
) {
  return reply.status(statusCode).send({
    ok: false,
    error,
    message,
    retryable: false,
  });
}

function getRequestCampaignKey(request: FastifyRequest): string | null {
  const params = request.params as { campaignKey?: unknown };
  return typeof params.campaignKey === 'string' ? params.campaignKey : null;
}

function getCampaignAdminAccess(request: FastifyRequest): CampaignAdminAccessContext {
  const access = request.campaignAdminAccess;
  if (access === null) {
    throw new Error('Campaign admin access context missing from request');
  }

  return access;
}

function makeCampaignAdminAuthHook(input: {
  permissionAuthorizer: CampaignAdminPermissionAuthorizer;
  enabledCampaignKeys: ReadonlySet<string>;
}) {
  // Spec: docs/specs/specs-202604110932-campaign-admin-fail-closed-authorization.md
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    request.campaignAdminAccess = null;

    const campaignKey = getRequestCampaignKey(request);
    if (campaignKey === null) {
      void sendCampaignAdminError(reply, 404, 'NotFoundError', 'Campaign review queue not found');
      return;
    }

    const authResult = requireAuth(request.auth);
    if (authResult.isErr()) {
      void sendCampaignAdminError(reply, 401, authResult.error.type, authResult.error.message);
      return;
    }

    const access = await ensureCampaignAdminAccess({
      campaignKey,
      userId: authResult.value as string,
      permissionAuthorizer: input.permissionAuthorizer,
      enabledCampaignKeys: input.enabledCampaignKeys,
    });

    if (!access.ok) {
      void sendCampaignAdminError(reply, access.statusCode, access.error, access.message);
      return;
    }

    request.campaignAdminAccess = {
      userId: authResult.value as string,
      config: access.config,
    };
  };
}

async function validateCampaignReviewItems(input: {
  items: readonly ReviewDecision[];
  config: CampaignReviewConfig;
  repo: LearningProgressRepository;
  reviewerUserId: string;
}): Promise<Result<{ pendingItems: readonly ReviewDecision[] }, LearningProgressError>> {
  const pendingItems: ReviewDecision[] = [];

  for (const item of input.items) {
    const rowResult = await loadCampaignReviewRow({
      config: input.config,
      repo: input.repo,
      userId: item.userId,
      recordKey: item.recordKey,
    });
    if (rowResult.isErr()) {
      return err(rowResult.error);
    }

    const row = rowResult.value;
    if (row === null) {
      return err(createNotFoundError(`Interaction record "${item.recordKey}" was not found.`));
    }

    if (row.record.phase === 'pending') {
      pendingItems.push(item);
      continue;
    }

    if (
      isIdempotentCampaignAdminReviewRetry({
        row,
        item,
        reviewerUserId: input.reviewerUserId,
      })
    ) {
      continue;
    }

    return err(
      createConflictError(
        `Interaction record "${item.recordKey}" is no longer reviewable because it is not pending.`
      )
    );
  }

  return ok({ pendingItems });
}

function getCampaignReviewableInteractions(
  config: CampaignReviewConfig
): ListCampaignAdminInteractionRowsInput['reviewableInteractions'] {
  return config.interactions.map((interaction) => ({
    interactionId: interaction.interactionId,
    ...(interaction.reviewableSubmissionPath !== undefined
      ? { reviewableSubmissionPath: interaction.reviewableSubmissionPath }
      : {}),
  }));
}

async function loadCampaignReviewRow(input: {
  config: CampaignReviewConfig;
  repo: LearningProgressRepository;
  userId: string;
  recordKey: string;
}): Promise<Result<CampaignAdminInteractionRow | null, LearningProgressError>> {
  const rowResult = await input.repo.listCampaignAdminInteractionRows({
    campaignKey: input.config.campaignKey,
    reviewableInteractions: getCampaignReviewableInteractions(input.config),
    userId: input.userId,
    recordKey: input.recordKey,
    limit: 1,
  });

  if (rowResult.isErr()) {
    return err(rowResult.error);
  }

  return ok(rowResult.value.rows[0] ?? null);
}

function normalizeReviewFeedbackText(feedbackText: string | undefined): string | null {
  if (feedbackText === undefined) {
    return null;
  }

  const trimmedFeedbackText = feedbackText.trim();
  return trimmedFeedbackText === '' ? null : trimmedFeedbackText;
}

function isIdempotentCampaignAdminReviewRetry(input: {
  row: CampaignAdminInteractionRow;
  item: ReviewDecision;
  reviewerUserId: string;
}): boolean {
  const review = input.row.record.review;
  if (review === undefined || review === null) {
    return false;
  }

  return (
    review.status === input.item.status &&
    review.reviewedAt !== null &&
    review.reviewedAt === input.row.record.updatedAt &&
    review.reviewedByUserId === input.reviewerUserId &&
    review.reviewSource === 'campaign_admin_api' &&
    normalizeReviewFeedbackText(review.feedbackText ?? undefined) ===
      normalizeReviewFeedbackText(input.item.feedbackText)
  );
}

async function loadReviewedResponseRows(input: {
  items: readonly ReviewDecision[];
  config: CampaignReviewConfig;
  repo: LearningProgressRepository;
}): Promise<Result<readonly CampaignAdminInteractionRow[], LearningProgressError>> {
  const rows: CampaignAdminInteractionRow[] = [];

  for (const item of input.items) {
    const rowResult = await loadCampaignReviewRow({
      config: input.config,
      repo: input.repo,
      userId: item.userId,
      recordKey: item.recordKey,
    });

    if (rowResult.isErr()) {
      return err(rowResult.error);
    }

    const row = rowResult.value;
    if (row !== null) {
      rows.push(row);
    }
  }

  return ok(rows);
}

export const makeCampaignAdminUserInteractionRoutes = (
  deps: MakeCampaignAdminUserInteractionRoutesDeps
): FastifyPluginAsync => {
  if (typeof deps.permissionAuthorizer.hasPermission !== 'function') {
    throw new Error('Campaign admin routes require a permission authorizer');
  }

  if (deps.enabledCampaignKeys.length === 0) {
    throw new Error('Campaign admin routes require at least one enabled campaign key.');
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- FastifyPluginAsync uses async plugin factories
  return async (fastify) => {
    const enabledCampaignKeys = new Set<string>(deps.enabledCampaignKeys);
    fastify.decorateRequest('campaignAdminAccess', null);
    fastify.addHook(
      'preHandler',
      makeCampaignAdminAuthHook({
        permissionAuthorizer: deps.permissionAuthorizer,
        enabledCampaignKeys,
      })
    );

    fastify.get<{ Params: CampaignKeyParams }>(
      '/api/v1/admin/campaigns/:campaignKey/user-interactions/meta',
      {
        schema: {
          params: CampaignKeyParamsSchema,
          response: {
            200: CampaignAdminMetaResponseSchema,
            401: ErrorResponseSchema,
            403: ErrorResponseSchema,
            404: ErrorResponseSchema,
            500: ErrorResponseSchema,
          },
        },
      },
      async (request, reply) => {
        const access = getCampaignAdminAccess(request);
        const reviewableInteractions = selectReviewableInteractions({
          config: access.config,
          requiresInstitutionThreadSummary: false,
        });
        const statsResult = await deps.learningProgressRepo.getCampaignAdminStats({
          campaignKey: access.config.campaignKey,
          reviewableInteractions,
        });

        if (statsResult.isErr()) {
          const statusCode = getHttpStatusForError(statsResult.error);
          return reply.status(statusCode).send({
            ok: false,
            error: statsResult.error.type,
            message: statsResult.error.message,
            retryable: 'retryable' in statsResult.error ? statsResult.error.retryable : false,
          });
        }

        const riskFlagged = await countRiskFlaggedCampaignAdminItems({
          riskFlagCandidates: statsResult.value.riskFlagCandidates,
          config: access.config,
          entityProfileRepo: deps.entityProfileRepo,
          log: request.log,
        });

        return reply.status(200).send({
          ok: true,
          data: {
            availableInteractionTypes: access.config.interactions.map((interaction) => ({
              interactionId: interaction.interactionId,
              label: interaction.label,
            })),
            stats: {
              ...statsResult.value.stats,
              riskFlagged,
            },
          },
        });
      }
    );

    fastify.get<{ Params: CampaignKeyParams; Querystring: CampaignAdminListQuery }>(
      '/api/v1/admin/campaigns/:campaignKey/user-interactions',
      {
        schema: {
          params: CampaignKeyParamsSchema,
          querystring: CampaignAdminListQuerySchema,
          response: {
            200: CampaignAdminListResponseSchema,
            400: ErrorResponseSchema,
            401: ErrorResponseSchema,
            403: ErrorResponseSchema,
            404: ErrorResponseSchema,
            500: ErrorResponseSchema,
          },
        },
      },
      async (request, reply) => {
        const access = getCampaignAdminAccess(request);

        if (request.query.recordKeyPrefix !== undefined) {
          const prefixResult = validateRecordKeyPrefix(request.query.recordKeyPrefix);
          if (prefixResult.isErr()) {
            return reply.status(400).send({
              ok: false,
              error: prefixResult.error.type,
              message: prefixResult.error.message,
              retryable: false,
            });
          }
        }

        const decodedCursor =
          request.query.cursor !== undefined ? decodeCursor(request.query.cursor) : undefined;
        if (request.query.cursor !== undefined && decodedCursor === null) {
          return reply.status(400).send({
            ok: false,
            error: 'ValidationError',
            message: 'Invalid campaign review cursor',
            retryable: false,
          });
        }
        const cursor = decodedCursor ?? undefined;

        const limit = request.query.limit ?? DEFAULT_PAGE_LIMIT;
        const requestedSort = normalizeRequestedSort(request.query);
        const selectedInteractions = selectReviewableInteractions({
          config: access.config,
          ...(request.query.interactionId !== undefined
            ? { interactionId: request.query.interactionId }
            : {}),
          ...(request.query.submissionPath !== undefined
            ? { submissionPath: request.query.submissionPath }
            : {}),
          requiresInstitutionThreadSummary:
            request.query.hasInstitutionThread !== undefined ||
            request.query.threadPhase !== undefined,
        });

        if (selectedInteractions.length === 0) {
          return reply.status(200).send({
            ok: true,
            data: {
              items: [],
              page: {
                limit,
                hasMore: false,
                nextCursor: null,
                ...(requestedSort !== null
                  ? {
                      sortBy: requestedSort.sortBy,
                      sortOrder: requestedSort.sortOrder,
                    }
                  : {}),
              },
            },
          });
        }

        const listQuery: Omit<ListCampaignAdminInteractionRowsInput, 'cursor' | 'limit'> = {
          campaignKey: access.config.campaignKey,
          reviewableInteractions: selectedInteractions.map((interaction) => ({
            interactionId: interaction.interactionId,
            ...(interaction.reviewableSubmissionPath !== undefined
              ? { reviewableSubmissionPath: interaction.reviewableSubmissionPath }
              : {}),
          })),
          ...(request.query.phase !== undefined ? { phase: request.query.phase } : {}),
          ...(request.query.reviewStatus !== undefined
            ? { reviewStatus: request.query.reviewStatus }
            : {}),
          ...(request.query.lessonId !== undefined ? { lessonId: request.query.lessonId } : {}),
          ...(request.query.entityCui !== undefined ? { entityCui: request.query.entityCui } : {}),
          ...(request.query.scopeType !== undefined ? { scopeType: request.query.scopeType } : {}),
          ...(request.query.payloadKind !== undefined
            ? { payloadKind: request.query.payloadKind }
            : {}),
          ...(request.query.submissionPath !== undefined
            ? { submissionPath: request.query.submissionPath }
            : {}),
          ...(request.query.userId !== undefined ? { userId: request.query.userId } : {}),
          ...(request.query.recordKey !== undefined ? { recordKey: request.query.recordKey } : {}),
          ...(request.query.recordKeyPrefix !== undefined
            ? { recordKeyPrefix: request.query.recordKeyPrefix }
            : {}),
          ...(request.query.submittedAtFrom !== undefined
            ? { submittedAtFrom: request.query.submittedAtFrom }
            : {}),
          ...(request.query.submittedAtTo !== undefined
            ? { submittedAtTo: request.query.submittedAtTo }
            : {}),
          ...(request.query.updatedAtFrom !== undefined
            ? { updatedAtFrom: request.query.updatedAtFrom }
            : {}),
          ...(request.query.updatedAtTo !== undefined
            ? { updatedAtTo: request.query.updatedAtTo }
            : {}),
          ...(request.query.hasInstitutionThread !== undefined
            ? { hasInstitutionThread: request.query.hasInstitutionThread }
            : {}),
          ...(request.query.threadPhase !== undefined
            ? { threadPhase: request.query.threadPhase }
            : {}),
        };

        const rowsResult = await loadAllCampaignAdminInteractionRows({
          repo: deps.learningProgressRepo,
          query: listQuery,
        });

        if (rowsResult.isErr()) {
          const statusCode = getHttpStatusForError(rowsResult.error);
          return reply.status(statusCode as 400 | 500).send({
            ok: false,
            error: rowsResult.error.type,
            message: rowsResult.error.message,
            retryable: 'retryable' in rowsResult.error ? rowsResult.error.retryable : false,
          });
        }

        const allItems = await formatCampaignAdminInteractionRows({
          rows: rowsResult.value,
          config: access.config,
          entityRepo: deps.entityRepo,
          entityProfileRepo: deps.entityProfileRepo,
          log: request.log,
        });
        const sortedItems = sortCampaignAdminInteractionItems({
          items: allItems,
          sort: requestedSort,
          config: access.config,
        });
        const pageStartIndex = resolvePageStartIndex({
          items: sortedItems,
          cursor,
          sort: requestedSort,
        });

        if (pageStartIndex === null) {
          return reply.status(400).send({
            ok: false,
            error: 'ValidationError',
            message: 'Invalid campaign review cursor',
            retryable: false,
          });
        }

        const items = sortedItems.slice(pageStartIndex, pageStartIndex + limit);
        const hasMore = pageStartIndex + limit < sortedItems.length;

        return reply.status(200).send({
          ok: true,
          data: {
            items,
            page: {
              limit,
              hasMore,
              nextCursor: buildNextCursor({
                items,
                hasMore,
                sort: requestedSort,
              }),
              ...(requestedSort !== null
                ? {
                    sortBy: requestedSort.sortBy,
                    sortOrder: requestedSort.sortOrder,
                  }
                : {}),
            },
          },
        });
      }
    );

    fastify.post<{ Params: CampaignKeyParams; Body: CampaignAdminSubmitReviewsBody }>(
      '/api/v1/admin/campaigns/:campaignKey/user-interactions/reviews',
      {
        schema: {
          params: CampaignKeyParamsSchema,
          body: CampaignAdminSubmitReviewsBodySchema,
          response: {
            200: CampaignAdminSubmitReviewsResponseSchema,
            400: ErrorResponseSchema,
            401: ErrorResponseSchema,
            403: ErrorResponseSchema,
            404: ErrorResponseSchema,
            409: ErrorResponseSchema,
            500: ErrorResponseSchema,
            502: ErrorResponseSchema,
          },
        },
      },
      async (request, reply) => {
        const access = getCampaignAdminAccess(request);

        const validationResult = await validateCampaignReviewItems({
          items: request.body.items,
          config: access.config,
          repo: deps.learningProgressRepo,
          reviewerUserId: access.userId,
        });

        if (validationResult.isErr()) {
          const statusCode = getHttpStatusForError(validationResult.error);
          return reply.status(statusCode as 404 | 409 | 500).send({
            ok: false,
            error: validationResult.error.type,
            message: validationResult.error.message,
            retryable:
              'retryable' in validationResult.error ? validationResult.error.retryable : false,
          });
        }

        let approvedReviewSideEffectPlan: ApprovedReviewSideEffectPlan | null = null;
        if (deps.prepareApproveReviews !== undefined) {
          const sideEffectResult = await deps.prepareApproveReviews({
            items: request.body.items,
          });

          if (sideEffectResult.isErr()) {
            const statusCode = isInstitutionCorrespondenceError(sideEffectResult.error)
              ? getCorrespondenceHttpStatusForError(sideEffectResult.error)
              : getHttpStatusForError(sideEffectResult.error);

            return reply.status(statusCode as 400 | 404 | 409 | 500 | 502).send({
              ok: false,
              error: sideEffectResult.error.type,
              message: sideEffectResult.error.message,
              retryable:
                'retryable' in sideEffectResult.error ? sideEffectResult.error.retryable : false,
            });
          }

          approvedReviewSideEffectPlan = sideEffectResult.value;
        }

        if (validationResult.value.pendingItems.length > 0) {
          const result = await submitInteractionReviews(
            { repo: deps.learningProgressRepo },
            {
              items: validationResult.value.pendingItems,
              actor: {
                actor: 'admin',
                actorUserId: access.userId,
                actorPermission: access.config.permissionName,
                actorSource: 'campaign_admin_api',
              },
            }
          );

          if (result.isErr()) {
            const statusCode = getHttpStatusForError(result.error);
            return reply.status(statusCode as 400 | 404 | 409 | 500).send({
              ok: false,
              error: result.error.type,
              message: result.error.message,
              retryable: 'retryable' in result.error ? result.error.retryable : false,
            });
          }
        }

        if (approvedReviewSideEffectPlan !== null) {
          try {
            await approvedReviewSideEffectPlan.afterCommit();
          } catch (error) {
            const postCommitError =
              error instanceof Error && error.cause !== undefined ? error.cause : error;
            request.log.error(
              {
                error: postCommitError,
                campaignKey: access.config.campaignKey,
                itemCount: request.body.items.length,
                recordKeys: request.body.items.map((item) => item.recordKey),
              },
              'Campaign-admin approval side effects failed after commit'
            );

            if (isInstitutionCorrespondenceError(postCommitError)) {
              const retryable = 'retryable' in postCommitError ? postCommitError.retryable : false;
              return reply.status(getCorrespondenceHttpStatusForError(postCommitError)).send({
                ok: false,
                error: postCommitError.type,
                message: postCommitError.message,
                retryable,
              });
            }

            if (isLearningProgressErrorCandidate(postCommitError)) {
              return reply
                .status(getHttpStatusForError(postCommitError) as 400 | 404 | 409 | 500)
                .send({
                  ok: false,
                  error: postCommitError.type,
                  message: postCommitError.message,
                  retryable: 'retryable' in postCommitError ? postCommitError.retryable : false,
                });
            }

            return reply.status(502).send({
              ok: false,
              error: 'PostCommitSideEffectError',
              message:
                'Review was saved, but the follow-up side effects failed. Retry the same request to continue.',
              retryable: true,
            });
          }
        }

        const responseRowsResult = await loadReviewedResponseRows({
          items: request.body.items,
          config: access.config,
          repo: deps.learningProgressRepo,
        });

        if (responseRowsResult.isErr()) {
          const statusCode = getHttpStatusForError(responseRowsResult.error);
          return reply.status(statusCode as 404 | 500).send({
            ok: false,
            error: responseRowsResult.error.type,
            message: responseRowsResult.error.message,
            retryable:
              'retryable' in responseRowsResult.error ? responseRowsResult.error.retryable : false,
          });
        }

        const items = await formatCampaignAdminInteractionRows({
          rows: responseRowsResult.value,
          config: access.config,
          entityRepo: deps.entityRepo,
          entityProfileRepo: deps.entityProfileRepo,
          log: request.log,
        });

        return reply.status(200).send({
          ok: true,
          data: {
            items,
          },
        });
      }
    );
  };
};
function isLearningProgressErrorCandidate(error: unknown): error is LearningProgressError {
  if (typeof error !== 'object' || error === null || !('type' in error) || !('message' in error)) {
    return false;
  }

  const candidate = error as { type?: unknown; message?: unknown };
  return (
    typeof candidate.type === 'string' &&
    typeof candidate.message === 'string' &&
    (candidate.type === 'DatabaseError' ||
      candidate.type === 'TooManyEventsError' ||
      candidate.type === 'InvalidEventError' ||
      candidate.type === 'NotFoundError' ||
      candidate.type === 'ConflictError')
  );
}
