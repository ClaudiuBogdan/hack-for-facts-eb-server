import { sql } from 'kysely';
import { err, ok } from 'neverthrow';

import { type UserDbClient } from '@/infra/database/client.js';

import { mapUserDataEventRow, mapUserDataRecordRow } from './kysely-user-data-mutation-repo.js';
import { createDatabaseError } from '../../core/errors.js';
import { type UserDataReadPort } from '../../core/ports.js';

type RecordRow = Parameters<typeof mapUserDataRecordRow>[0];

export const makeUserDataReadRepo = (deps: { db: UserDbClient }): UserDataReadPort => {
  const { db } = deps;

  return {
    findByKey: async (ownerId, category, logicalKey) => {
      try {
        const row = await db
          .selectFrom('user_data_records')
          .selectAll()
          .where('owner_id', '=', ownerId)
          .where('category', '=', category)
          .where('logical_key', '=', logicalKey)
          .executeTakeFirst();
        return ok(row === undefined ? null : mapUserDataRecordRow(row));
      } catch {
        return err(createDatabaseError('Failed to find user-data record by key', true));
      }
    },

    findById: async (ownerId, recordId) => {
      try {
        const row = await db
          .selectFrom('user_data_records')
          .selectAll()
          .where('owner_id', '=', ownerId)
          .where('record_id', '=', recordId)
          .executeTakeFirst();
        return ok(row === undefined ? null : mapUserDataRecordRow(row));
      } catch {
        return err(createDatabaseError('Failed to find user-data record by id', true));
      }
    },

    listByCategory: async (ownerId, category, page) => {
      try {
        let query = db
          .selectFrom('user_data_records')
          .selectAll()
          .where('owner_id', '=', ownerId)
          .where('category', '=', category)
          .orderBy('logical_key', 'asc')
          .limit(page.limit + 1);
        if (page.cursor !== null) query = query.where('logical_key', '>', page.cursor);
        const rows = await query.execute();
        const items = rows.slice(0, page.limit).map(mapUserDataRecordRow);
        return ok({
          items,
          nextCursor: rows.length > page.limit ? (items.at(-1)?.identity.logicalKey ?? null) : null,
        });
      } catch {
        return err(createDatabaseError('Failed to list user-data records', true));
      }
    },

    findByTarget: async (ownerId, category, target) => {
      try {
        const rows = await db
          .selectFrom('user_data_records')
          .selectAll()
          .where('owner_id', '=', ownerId)
          .where('category', '=', category)
          .where('target_type', '=', target.targetType)
          .where('target_id', '=', target.targetId)
          .execute();
        return ok(rows.map(mapUserDataRecordRow));
      } catch {
        return err(createDatabaseError('Failed to find user-data records by target', true));
      }
    },

    syncSince: async (ownerId, cursor, limit) => {
      try {
        const result = await db
          .with('page', (queryBuilder) => {
            let query = queryBuilder
              .selectFrom('user_data_records')
              .selectAll()
              .where('owner_id', '=', ownerId)
              .where('last_event_seq', '>', cursor.lastSeq)
              .orderBy('last_event_seq', 'asc')
              .limit(limit);
            if (cursor.cycleHighWater !== null)
              query = query.where('last_event_seq', '<=', cursor.cycleHighWater);
            if (cursor.category !== null) query = query.where('category', '=', cursor.category);
            return query;
          })
          .with('high_water', (queryBuilder) => {
            let query = queryBuilder
              .selectFrom('user_data_records')
              .select(sql<string>`coalesce(max(last_event_seq), 0)::text`.as('owner_high_water'))
              .where('owner_id', '=', ownerId);
            if (cursor.category !== null) query = query.where('category', '=', cursor.category);
            return query;
          })
          .selectFrom('high_water')
          .leftJoin('page', (join) => join.onTrue())
          .selectAll('page')
          .select('high_water.owner_high_water')
          .orderBy('page.last_event_seq', 'asc')
          .execute();
        const ownerHighWater = result[0]?.owner_high_water ?? '0';
        const items = result
          .filter((row): row is typeof row & RecordRow => row.record_id !== null)
          .map(mapUserDataRecordRow);
        return ok({ items, ownerHighWater });
      } catch {
        return err(createDatabaseError('Failed to synchronize user-data records', true));
      }
    },

    historyByRecord: async (ownerId, recordId, page) => {
      try {
        let query = db
          .selectFrom('user_data_events')
          .selectAll()
          .where('owner_id', '=', ownerId)
          .where('record_id', '=', recordId)
          .orderBy('revision', 'desc')
          .limit(page.limit + 1);
        if (page.beforeRevision !== null)
          query = query.where('revision', '<', String(page.beforeRevision));
        const rows = await query.execute();
        const items = rows.slice(0, page.limit).map(mapUserDataEventRow);
        return ok({
          items,
          nextCursor: rows.length > page.limit ? String(items.at(-1)?.revision ?? '') : null,
        });
      } catch {
        return err(createDatabaseError('Failed to load user-data record history', true));
      }
    },
  };
};
