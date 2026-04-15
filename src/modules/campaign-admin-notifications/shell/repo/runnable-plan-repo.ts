import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { sql } from 'kysely';
import { err, ok, type Result } from 'neverthrow';

import { parseDbTimestamp } from '@/common/utils/parse-db-timestamp.js';

import { createDatabaseError, type CampaignAdminNotificationError } from '../../core/errors.js';

import type {
  CampaignNotificationRunnablePlanCreationInput,
  CampaignNotificationRunnablePlanRepository,
} from '../../core/ports.js';
import type { CampaignNotificationStoredPlan } from '../../core/types.js';
import type { UserDbClient } from '@/infra/database/client.js';
import type { Logger } from 'pino';

interface RunnablePlanRepoDeps {
  db: UserDbClient;
  logger: Logger;
}

interface RunnablePlanRow {
  id: string;
  actor_user_id: string;
  campaign_key: string;
  runnable_id: string;
  template_id: string;
  template_version: string;
  payload_hash: string;
  watermark: string;
  summary_json: unknown;
  rows_json: unknown;
  created_at: unknown;
  expires_at: unknown;
  consumed_at: unknown;
}

const getValidationMessage = (schema: unknown, payload: unknown, fallback: string): string => {
  const message = [...Value.Errors(schema as Parameters<typeof Value.Errors>[0], payload)]
    .map((error) => `${error.path}: ${error.message}`)
    .join(', ');

  return message === '' ? fallback : message;
};

const RunnablePlanSummarySchema = Type.Object(
  {
    totalRowCount: Type.Number({ minimum: 0 }),
    willSendCount: Type.Number({ minimum: 0 }),
    alreadySentCount: Type.Number({ minimum: 0 }),
    alreadyPendingCount: Type.Number({ minimum: 0 }),
    ineligibleCount: Type.Number({ minimum: 0 }),
    missingDataCount: Type.Number({ minimum: 0 }),
  },
  { additionalProperties: false }
);

const RunnablePlanPreviewRowSchema = Type.Object(
  {
    rowKey: Type.String({ minLength: 1 }),
    userId: Type.String({ minLength: 1 }),
    entityCui: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    entityName: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    recordKey: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    interactionId: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    interactionLabel: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    reviewStatus: Type.Union([Type.Literal('approved'), Type.Literal('rejected'), Type.Null()]),
    reviewedAt: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    status: Type.Union([
      Type.Literal('will_send'),
      Type.Literal('already_sent'),
      Type.Literal('already_pending'),
      Type.Literal('ineligible'),
      Type.Literal('missing_data'),
    ]),
    reasonCode: Type.String({ minLength: 1 }),
    statusMessage: Type.String({ minLength: 1 }),
    hasExistingDelivery: Type.Boolean(),
    existingDeliveryStatus: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    sendMode: Type.Union([Type.Literal('create'), Type.Literal('reuse_claimable'), Type.Null()]),
  },
  { additionalProperties: false }
);

const RunnablePlanStoredRowSchema = Type.Object(
  {
    preview: RunnablePlanPreviewRowSchema,
    executionData: Type.Union([Type.Object({}, { additionalProperties: true }), Type.Null()]),
  },
  { additionalProperties: false }
);

const RunnablePlanRowsSchema = Type.Array(RunnablePlanStoredRowSchema);

const mapStoredPlan = (
  row: RunnablePlanRow
): Result<CampaignNotificationStoredPlan, CampaignAdminNotificationError> => {
  if (!Value.Check(RunnablePlanSummarySchema, row.summary_json)) {
    return err(createDatabaseError('Invalid campaign notification run plan summary.', false));
  }

  if (!Value.Check(RunnablePlanRowsSchema, row.rows_json)) {
    return err(createDatabaseError('Invalid campaign notification run plan rows.', false));
  }

  try {
    return ok({
      planId: row.id,
      actorUserId: row.actor_user_id,
      campaignKey: row.campaign_key as CampaignNotificationStoredPlan['campaignKey'],
      runnableId: row.runnable_id,
      templateId: row.template_id,
      templateVersion: row.template_version,
      payloadHash: row.payload_hash,
      watermark: row.watermark,
      summary: row.summary_json as CampaignNotificationStoredPlan['summary'],
      rows: row.rows_json as CampaignNotificationStoredPlan['rows'],
      createdAt: parseDbTimestamp(
        row.created_at,
        'campaignnotificationrunplans.created_at'
      ).toISOString(),
      expiresAt: parseDbTimestamp(
        row.expires_at,
        'campaignnotificationrunplans.expires_at'
      ).toISOString(),
      consumedAt:
        row.consumed_at === null
          ? null
          : parseDbTimestamp(
              row.consumed_at,
              'campaignnotificationrunplans.consumed_at'
            ).toISOString(),
    });
  } catch (error) {
    return err(
      createDatabaseError(
        error instanceof Error ? error.message : 'Invalid campaign notification run plan.',
        false
      )
    );
  }
};

export const makeCampaignNotificationRunnablePlanRepo = (
  deps: RunnablePlanRepoDeps
): CampaignNotificationRunnablePlanRepository => {
  const log = deps.logger.child({ component: 'CampaignNotificationRunnablePlanRepo' });

  return {
    async createPlan(input: CampaignNotificationRunnablePlanCreationInput) {
      try {
        await deps.db
          .deleteFrom('campaignnotificationrunplans')
          .where((eb) =>
            eb.or([eb('consumed_at', 'is not', null), sql<boolean>`expires_at <= now()`])
          )
          .execute();

        if (!Value.Check(RunnablePlanSummarySchema, input.summary)) {
          const message = getValidationMessage(
            RunnablePlanSummarySchema,
            input.summary,
            'Invalid campaign notification run plan summary.'
          );
          log.error(
            { summary: input.summary, message },
            'Invalid campaign notification run plan summary before insert'
          );
          return err(createDatabaseError(message, false));
        }

        if (!Value.Check(RunnablePlanRowsSchema, input.rows)) {
          const message = getValidationMessage(
            RunnablePlanRowsSchema,
            input.rows,
            'Invalid campaign notification run plan rows.'
          );
          log.error(
            { rows: input.rows, message },
            'Invalid campaign notification run plan rows before insert'
          );
          return err(createDatabaseError(message, false));
        }

        const inserted = await deps.db
          .insertInto('campaignnotificationrunplans')
          .values({
            actor_user_id: input.actorUserId,
            campaign_key: input.campaignKey,
            runnable_id: input.runnableId,
            template_id: input.templateId,
            template_version: input.templateVersion,
            payload_hash: input.payloadHash,
            watermark: input.watermark,
            summary_json: sql`${JSON.stringify(input.summary)}::jsonb`,
            rows_json: sql`${JSON.stringify(input.rows)}::jsonb`,
            expires_at: input.expiresAt,
          })
          .returningAll()
          .executeTakeFirst();

        if (inserted === undefined) {
          return err(
            createDatabaseError('Failed to create campaign notification run plan.', false)
          );
        }

        const mapped = mapStoredPlan(inserted as RunnablePlanRow);
        if (mapped.isErr()) {
          await deps.db
            .deleteFrom('campaignnotificationrunplans')
            .where('id', '=', inserted.id)
            .execute();
        }

        return mapped;
      } catch (error) {
        log.error({ error }, 'Failed to create campaign notification run plan');
        return err(createDatabaseError('Failed to create campaign notification run plan.'));
      }
    },

    async findPlanById(planId: string) {
      try {
        const row = await deps.db
          .selectFrom('campaignnotificationrunplans')
          .selectAll()
          .where('id', '=', planId)
          .executeTakeFirst();

        if (row === undefined) {
          return ok(null);
        }

        return mapStoredPlan(row as RunnablePlanRow);
      } catch (error) {
        log.error({ error, planId }, 'Failed to load campaign notification run plan');
        return err(createDatabaseError('Failed to load campaign notification run plan.'));
      }
    },

    async consumePlan(input) {
      try {
        const result = await deps.db
          .updateTable('campaignnotificationrunplans')
          .set({
            consumed_at: input.now,
          })
          .where('id', '=', input.planId)
          .where('consumed_at', 'is', null)
          .where(sql<boolean>`expires_at > ${input.now}::timestamptz`)
          .executeTakeFirst();

        return ok(Number(result.numUpdatedRows) > 0);
      } catch (error) {
        log.error(
          { error, planId: input.planId },
          'Failed to consume campaign notification run plan'
        );
        return err(createDatabaseError('Failed to consume campaign notification run plan.'));
      }
    },

    async releasePlan(input) {
      try {
        const result = await deps.db
          .updateTable('campaignnotificationrunplans')
          .set({
            consumed_at: null,
          })
          .where('id', '=', input.planId)
          .where('consumed_at', 'is not', null)
          .executeTakeFirst();

        return ok(Number(result.numUpdatedRows) > 0);
      } catch (error) {
        log.error(
          { error, planId: input.planId },
          'Failed to release campaign notification run plan'
        );
        return err(createDatabaseError('Failed to release campaign notification run plan.'));
      }
    },
  };
};
