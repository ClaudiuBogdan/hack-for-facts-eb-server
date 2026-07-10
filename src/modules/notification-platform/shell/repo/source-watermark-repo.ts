import { sql } from 'kysely';
import { err, ok } from 'neverthrow';

import { toDatabaseError } from './repo-helpers.js';

import type { SourceWatermarkRepo } from '../../core/events/ports.js';
import type { UserDbClient } from '@/infra/database/client.js';

export class KyselySourceWatermarkRepo implements SourceWatermarkRepo {
  public constructor(private readonly db: UserDbClient) {}

  public async get(sourceId: string) {
    try {
      const row = await this.db
        .selectFrom('notification_source_watermarks')
        .select('watermark')
        .where('source_id', '=', sourceId)
        .executeTakeFirst();
      return ok(row?.watermark ?? null);
    } catch (error) {
      return err(toDatabaseError('Get notification source watermark', error));
    }
  }

  public async compareAndSet(input: Parameters<SourceWatermarkRepo['compareAndSet']>[0]) {
    try {
      if (input.expected !== null) {
        const result = await sql<{ source_id: string }>`
          UPDATE notification_source_watermarks
          SET watermark = ${input.next}, updated_at = now()
          WHERE source_id = ${input.sourceId}
            AND watermark IS NOT DISTINCT FROM ${input.expected}
          RETURNING source_id
        `.execute(this.db);
        return ok(result.rows.length === 1);
      }

      const result = await sql<{ source_id: string }>`
        INSERT INTO notification_source_watermarks(source_id, watermark, updated_at)
        VALUES (${input.sourceId}, ${input.next}, now())
        ON CONFLICT (source_id) DO UPDATE
          SET watermark = EXCLUDED.watermark, updated_at = EXCLUDED.updated_at
          WHERE notification_source_watermarks.watermark IS NOT DISTINCT FROM ${input.expected}
        RETURNING source_id
      `.execute(this.db);
      return ok(result.rows.length === 1);
    } catch (error) {
      return err(toDatabaseError('Compare and set notification source watermark', error));
    }
  }
}

export const makeSourceWatermarkRepo = (db: UserDbClient): SourceWatermarkRepo =>
  new KyselySourceWatermarkRepo(db);
