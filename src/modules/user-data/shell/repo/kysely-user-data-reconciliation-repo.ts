import { sql } from 'kysely';
import { err, ok } from 'neverthrow';

import { type Clock } from '@/common/ports/clock.js';
import { type UserDbClient } from '@/infra/database/client.js';

import { createDatabaseError } from '../../core/errors.js';
import { type UserDataReconciliationPort } from '../../core/ports.js';
import {
  type ReconciliationViolation,
  type ReconciliationViolationKind,
} from '../../core/types.js';

interface ReconciliationRow {
  record_id: string;
  revision: string;
  max_revision: string | null;
  latest_revision: string | null;
  revision_mismatch: boolean;
  after_image_mismatch: boolean;
  missing_event: boolean;
  expired_receipts: string;
  checked_records: string;
}

const violation = (
  row: ReconciliationRow,
  kind: ReconciliationViolationKind,
  detail: string
): ReconciliationViolation => ({ recordId: row.record_id, kind, detail });

export const makeUserDataReconciliationRepo = (deps: {
  db: UserDbClient;
  clock: Clock;
}): UserDataReconciliationPort => ({
  async findViolations(input) {
    try {
      // Expiry is judged against the injected clock, matching the fake and the
      // rest of the store; the DB wall clock is never the time authority here.
      const cleanupCutoff = new Date(deps.clock.now().getTime() - 7 * 24 * 60 * 60 * 1000);
      const result = await sql<ReconciliationRow>`
        WITH recent AS (
          SELECT *
          FROM user_data_records
          ORDER BY last_event_seq DESC
          LIMIT ${input.limit}
        ), checked AS (
          SELECT
            record.record_id,
            record.revision,
            latest.revision AS latest_revision,
            revisions.max_revision,
            (revisions.max_revision IS NOT NULL AND record.revision <> revisions.max_revision)
              AS revision_mismatch,
            (latest.event_seq IS NOT NULL AND NOT (
              record.payload IS NOT DISTINCT FROM latest.payload
              AND record.annotations IS NOT DISTINCT FROM latest.annotations
              AND record.status = CASE WHEN latest.operation = 'delete' THEN 'deleted' ELSE 'active' END
              AND record.schema_version = latest.schema_version
            )) AS after_image_mismatch,
            NOT EXISTS (
              SELECT 1 FROM user_data_events referenced
              WHERE referenced.record_id = record.record_id
                AND referenced.event_seq = record.last_event_seq
                AND referenced.event_id = record.last_event_id
            ) AS missing_event
          FROM recent record
          LEFT JOIN LATERAL (
            SELECT event_seq, revision, operation, payload, annotations, schema_version
            FROM user_data_events
            WHERE record_id = record.record_id
            ORDER BY revision DESC
            LIMIT 1
          ) latest ON true
          LEFT JOIN LATERAL (
            SELECT MAX(revision) AS max_revision
            FROM user_data_events
            WHERE record_id = record.record_id
          ) revisions ON true
        ), expired AS (
          SELECT COUNT(*)::text AS count
          FROM user_data_idempotency_receipts
          WHERE expires_at < ${cleanupCutoff}
        ), totals AS (
          SELECT COUNT(*)::text AS count FROM recent
        )
        SELECT checked.*, expired.count AS expired_receipts, totals.count AS checked_records
        FROM checked CROSS JOIN expired CROSS JOIN totals
        UNION ALL
        SELECT
          '00000000-0000-0000-0000-000000000000'::uuid AS record_id,
          '0'::bigint AS revision,
          NULL::bigint AS latest_revision,
          NULL::bigint AS max_revision,
          false AS revision_mismatch,
          false AS after_image_mismatch,
          false AS missing_event,
          expired.count AS expired_receipts,
          totals.count AS checked_records
        FROM expired CROSS JOIN totals
        WHERE totals.count = '0'
      `.execute(deps.db);

      const rows = result.rows;
      const checkedRecords = Number(rows[0]?.checked_records ?? 0);
      const violations: ReconciliationViolation[] = [];
      for (const row of rows) {
        if (row.record_id === '00000000-0000-0000-0000-000000000000') continue;
        if (row.revision_mismatch) {
          violations.push(
            violation(
              row,
              'revisionMismatch',
              `recordId=${row.record_id} currentRevision=${row.revision} maxEventRevision=${row.max_revision ?? 'none'}`
            )
          );
        }
        if (row.after_image_mismatch) {
          violations.push(
            violation(
              row,
              'afterImageMismatch',
              `recordId=${row.record_id} currentRevision=${row.revision} latestEventRevision=${row.latest_revision ?? 'none'}`
            )
          );
        }
        if (row.missing_event) {
          violations.push(
            violation(row, 'missingEvent', `recordId=${row.record_id} revision=${row.revision}`)
          );
        }
      }
      const expiredReceipts = Number(rows[0]?.expired_receipts ?? 0);
      if (expiredReceipts > 0) {
        violations.push({
          recordId: 'receipts',
          kind: 'expiredReceipts',
          detail: `expiredReceiptCount=${String(expiredReceipts)}`,
        });
      }
      return ok({ checkedRecords, violations });
    } catch {
      return err(createDatabaseError('Failed to reconcile user-data store', true));
    }
  },
});
