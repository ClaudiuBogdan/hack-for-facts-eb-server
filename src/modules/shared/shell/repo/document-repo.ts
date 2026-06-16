/**
 * Shared Kernel — Document repo (foundation §4.5).
 *
 * Reads `search.documents` as the rebuildable projection. Per-source modules
 * own their native facts; this exposes the shared document view (detail + by
 * CUI). Bounded.
 */

import { sql, type Kysely } from 'kysely';
import { err, ok, type Result } from 'neverthrow';

import { databaseError, type ApiError } from '../../core/errors.js';

import type { DocumentRepo } from '../../core/ports.js';
import type { Cui, Document } from '../../core/types.js';
import type { ProdDatabase } from '../db/types.js';

type Db = Kysely<ProdDatabase>;

const DOC_COLUMNS = [
  'doc_id',
  'doc_type',
  'title',
  'body',
  'cuis',
  'doc_date',
  'amount_ron',
  'county_name',
  'url',
  'attrs',
] as const;

const mapDoc = (row: {
  doc_id: string;
  doc_type: string;
  title: string;
  body: string | null;
  cuis: string[];
  doc_date: string | null;
  amount_ron: string | null;
  county_name: string | null;
  url: string | null;
  attrs: Record<string, unknown>;
}): Document => ({
  docId: row.doc_id,
  docType: row.doc_type,
  title: row.title,
  body: row.body,
  cuis: row.cuis,
  docDate: row.doc_date,
  amountRon: row.amount_ron,
  countyName: row.county_name,
  url: row.url,
  attrs: row.attrs,
});

export const makeDocumentRepo = (db: Db): DocumentRepo => ({
  async findById(docId: string): Promise<Result<Document | null, ApiError>> {
    try {
      const row = await db
        .selectFrom('search.documents')
        .select([...DOC_COLUMNS])
        .where('doc_id', '=', docId)
        .limit(1)
        .executeTakeFirst();
      return ok(row === undefined ? null : mapDoc(row));
    } catch (error) {
      return err(databaseError('findById failed', error));
    }
  },

  async listByCui(cui: Cui, limit: number): Promise<Result<readonly Document[], ApiError>> {
    const capped = Math.min(Math.max(limit, 1), 100);
    try {
      const rows = await db
        .selectFrom('search.documents')
        .select([...DOC_COLUMNS])
        .where(sql<boolean>`${cui} = any(cuis)`)
        .orderBy(sql`doc_date desc nulls last`)
        .limit(capped)
        .execute();
      return ok(rows.map(mapDoc));
    } catch (error) {
      return err(databaseError('listByCui failed', error));
    }
  },
});
