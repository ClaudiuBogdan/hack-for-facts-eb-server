/**
 * Shared Kernel — Document repo (foundation §4.5).
 *
 * Reads `search.documents` as the rebuildable projection. Per-source modules
 * own their native facts; this exposes the shared document view (detail + by
 * CUI). Bounded.
 *
 * PRIVACY. Both reads were, until 2026-08-12, entirely unfiltered — no
 * visibility, no tombstone, no containment — and they returned the raw `cuis`
 * array. Nothing called them yet, which is the only reason it was not a live
 * leak: the consumer matrix found six references and every one was container
 * wiring. A latent path is still a path, and it is cheaper to gate before the
 * first caller arrives than to find every caller afterwards. Both the row filter
 * and the field scrub come from `document-privacy.ts` so they cannot drift from
 * the sibling search paths.
 */

import { sql, type Kysely } from 'kysely';
import { err, ok, type Result } from 'neverthrow';

import {
  isWithheldLookupKey,
  scrubWithheldIdentifiers,
  servableDocumentRowSql,
  servableIdentifierSetSql,
} from './document-privacy.js';
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
  // Scrubbed at the mapper, so no read path here can echo a withheld
  // identifier by forgetting to filter at its own call site. `Document.cuis` is
  // declared non-null, so an all-withheld array becomes `[]` rather than being
  // omitted — dropping the field would change the shape for every consumer.
  cuis: [...scrubWithheldIdentifiers(row.cuis)],
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
        .where(servableDocumentRowSql)
        .where(servableIdentifierSetSql)
        .limit(1)
        .executeTakeFirst();
      return ok(row === undefined ? null : mapDoc(row));
    } catch (error) {
      return err(databaseError('findById failed', error));
    }
  },

  async listByCui(cui: Cui, limit: number): Promise<Result<readonly Document[], ApiError>> {
    const capped = Math.min(Math.max(limit, 1), 100);
    // See `isWithheldLookupKey`: the row filter alone still let a dual-keyed
    // public act be retrieved BY the person's identifier.
    if (isWithheldLookupKey(cui)) return ok([]);
    try {
      const rows = await db
        .selectFrom('search.documents')
        .select([...DOC_COLUMNS])
        .where(sql<boolean>`${cui} = any(cuis)`)
        .where(servableDocumentRowSql)
        .where(servableIdentifierSetSql)
        .orderBy(sql`doc_date desc nulls last`)
        .limit(capped)
        .execute();
      return ok(rows.map(mapDoc));
    } catch (error) {
      return err(databaseError('listByCui failed', error));
    }
  },
});
