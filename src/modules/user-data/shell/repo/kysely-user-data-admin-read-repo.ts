import { sql, type Expression, type SqlBool } from 'kysely';
import { err, ok } from 'neverthrow';

import { type UserDbClient } from '@/infra/database/client.js';

import { mapUserDataEventRow, mapUserDataRecordRow } from './kysely-user-data-mutation-repo.js';
import { createDatabaseError } from '../../core/errors.js';
import { type UserDataAdminReadPort } from '../../core/ports.js';
import { type CategoryRegistry } from '../../core/registry/registry.js';
import { type QueryFieldDefinition } from '../../core/registry/types.js';
import { type AdminRecordFilters } from '../../core/types.js';

const registeredPredicate = (
  field: QueryFieldDefinition,
  condition: Readonly<Record<string, unknown>>
): Expression<SqlBool> | null => {
  const operator = condition['operator'];
  const rawValue = condition['value'];
  if (operator !== 'eq' && operator !== 'in') return null;
  const annotationPath = field.path[0] === 'annotations';
  const path = annotationPath ? field.path.slice(1) : field.path;
  if (path.length === 0) return null;
  const extracted = annotationPath
    ? sql<string | null>`jsonb_extract_path_text(annotations, variadic ${path}::text[])`
    : sql<string | null>`jsonb_extract_path_text(payload, variadic ${path}::text[])`;
  if (operator === 'eq') return sql<SqlBool>`${extracted} = ${String(rawValue)}`;
  if (!Array.isArray(rawValue)) return null;
  const values = rawValue.map((value) => String(value));
  return sql<SqlBool>`${extracted} = any(${values}::text[])`;
};

const applyFilters = <Query extends { where(expression: Expression<SqlBool>): Query }>(
  initialQuery: Query,
  registry: CategoryRegistry,
  category: string,
  filters: AdminRecordFilters
): Query => {
  let query = initialQuery;
  if (filters.status !== undefined) query = query.where(sql<SqlBool>`status = ${filters.status}`);
  if (filters.target !== undefined) {
    query = query.where(sql<SqlBool>`target_type = ${filters.target.targetType}`);
    query = query.where(sql<SqlBool>`target_id = ${filters.target.targetId}`);
  }
  if (filters.createdAtFrom !== undefined)
    query = query.where(sql<SqlBool>`created_at >= ${filters.createdAtFrom}`);
  if (filters.createdAtTo !== undefined)
    query = query.where(sql<SqlBool>`created_at <= ${filters.createdAtTo}`);
  const definition = registry.get(category);
  if (definition === undefined || filters.query === undefined) return query;
  for (const [name, rawCondition] of Object.entries(filters.query)) {
    const field = definition.queryFields.find((candidate) => candidate.name === name);
    if (
      field === undefined ||
      rawCondition === null ||
      typeof rawCondition !== 'object' ||
      Array.isArray(rawCondition)
    )
      continue;
    const predicate = registeredPredicate(field, rawCondition as Readonly<Record<string, unknown>>);
    if (predicate !== null) query = query.where(predicate);
  }
  return query;
};

export const makeUserDataAdminReadRepo = (deps: {
  db: UserDbClient;
  registry: CategoryRegistry;
}): UserDataAdminReadPort => {
  const { db, registry } = deps;
  return {
    adminListByCategory: async (category, filters, page) => {
      try {
        let query = db
          .selectFrom('user_data_records')
          .selectAll()
          .where('category', '=', category)
          .orderBy('record_id', 'asc')
          .limit(page.limit + 1);
        query = applyFilters(query, registry, category, filters);
        if (page.cursor !== null) query = query.where('record_id', '>', page.cursor);
        const rows = await query.execute();
        const items = rows.slice(0, page.limit).map(mapUserDataRecordRow);
        return ok({
          items,
          nextCursor: rows.length > page.limit ? (items.at(-1)?.recordId ?? null) : null,
        });
      } catch {
        return err(createDatabaseError('Failed to list administrative user-data records', true));
      }
    },

    adminHistoryByCategory: async (category, recordId, page) => {
      try {
        let query = db
          .selectFrom('user_data_events')
          .selectAll()
          .where('category', '=', category)
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
        return err(
          createDatabaseError('Failed to load administrative user-data record history', true)
        );
      }
    },
  };
};
