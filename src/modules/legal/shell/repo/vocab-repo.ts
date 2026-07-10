/**
 * Legal module — `LegalVocabRepo` (plan §7.3). Resolves the discovery dimensions
 * `issuer` / `domain` / `category` / `act_type` / `status` to filter values for
 * R8 + the MCP discovery tool. Issuer resolution is diacritics-folded (handles the
 * cedilla/comma duplicates, NOTES §1.2). Enum dimensions resolve from the closed
 * controlled vocabs with live counts.
 */

import { sql, type Kysely } from 'kysely';
import { err, ok, type Result } from 'neverthrow';

import {
  type ApiError,
  type ProdDatabase,
  type ResolveHit,
  databaseError,
} from '@/modules/shared/index.js';

import type { LegalVocabRepo } from '../../core/usecases.js';

type Db = Kysely<ProdDatabase>;
const cap = (n: number): number => Math.min(Math.max(Math.floor(n), 1), 50);
const esc = (s: string): string => s.replace(/[\\%_]/gu, (m) => `\\${m}`);

export const makeLegalVocabRepo = (db: Db): LegalVocabRepo => {
  const resolveIssuers = async (
    q: string,
    limit: number
  ): Promise<Result<readonly ResolveHit[], ApiError>> => {
    const trimmed = q.trim();
    const capped = cap(limit);
    const pattern = `%${esc(trimmed)}%`;
    try {
      // Diacritics-fold both sides (unaccent-style replace) so "sanatate" matches
      // "Sănătate". issuer_slug is already folded; match the slug + count acts.
      const folded = trimmed
        .normalize('NFD')
        .replace(/[̀-ͯ]/gu, '')
        .toLowerCase()
        .replace(/\s+/gu, '-');
      const rows = await db
        .selectFrom('legal.acts as a')
        .select(['a.issuer_slug', sql<string>`count(*)`.as('cnt')])
        .where('a.issuer_slug', 'is not', null)
        .where(
          sql<boolean>`a.issuer_slug ilike ${`%${esc(folded)}%`} escape '\\' or a.issuer_slug ilike ${pattern} escape '\\'`
        )
        .groupBy('a.issuer_slug')
        .orderBy(sql`count(*) desc`)
        .limit(capped)
        .execute();
      return ok(
        rows
          .filter((r): r is { issuer_slug: string; cnt: string } => r.issuer_slug !== null)
          .map((r) => ({
            kind: 'issuer',
            value: r.issuer_slug,
            label: r.issuer_slug.replace(/-/gu, ' '),
            hint: `${r.cnt} acte`,
          }))
      );
    } catch (error) {
      return err(databaseError('resolveIssuers failed', error));
    }
  };

  const resolveEnum = async (
    dim: 'domain' | 'category' | 'act_type' | 'status',
    q: string,
    limit: number
  ): Promise<Result<readonly ResolveHit[], ApiError>> => {
    const capped = cap(limit);
    const pattern = `%${esc(q.trim())}%`;
    try {
      if (dim === 'act_type' || dim === 'status') {
        const col = dim === 'act_type' ? 'act_type' : 'status';
        const rows = await db
          .selectFrom('legal.acts as a')
          .select([sql.ref(`a.${col}`).as('value'), sql<string>`count(*)`.as('cnt')])
          .where(sql<boolean>`${sql.ref(`a.${col}`)} ilike ${pattern} escape '\\'`)
          .groupBy(sql.ref(`a.${col}`))
          .orderBy(sql`count(*) desc`)
          .limit(capped)
          .execute();
        return ok(
          rows
            .filter((r): r is { value: string; cnt: string } => r.value !== null)
            .map((r) => ({ kind: dim, value: r.value, label: r.value, hint: `${r.cnt} acte` }))
        );
      }
      if (dim === 'category') {
        const rows = await db
          .selectFrom('legal.document_summaries as s')
          .select(['s.document_category as value', sql<string>`count(*)`.as('cnt')])
          .where('s.document_category', 'is not', null)
          .where(sql<boolean>`s.document_category ilike ${pattern} escape '\\'`)
          .groupBy('s.document_category')
          .orderBy(sql`count(*) desc`)
          .limit(capped)
          .execute();
        return ok(
          rows
            .filter((r): r is { value: string; cnt: string } => r.value !== null)
            .map((r) => ({
              kind: 'category',
              value: r.value,
              label: r.value,
              hint: `${r.cnt} documente`,
            }))
        );
      }
      // domain: unnest the text[] and count.
      const rows = await db
        .selectFrom(sql`(select unnest(domains) as d from legal.document_summaries)`.as('x'))
        .select([sql.ref('x.d').as('value'), sql<string>`count(*)`.as('cnt')])
        .where(sql<boolean>`x.d ilike ${pattern} escape '\\'`)
        .groupBy(sql.ref('x.d'))
        .orderBy(sql`count(*) desc`)
        .limit(capped)
        .execute();
      return ok(
        rows
          .filter((r): r is { value: string; cnt: string } => r.value !== null)
          .map((r) => ({
            kind: 'domain',
            value: r.value,
            label: r.value,
            hint: `${r.cnt} documente`,
          }))
      );
    } catch (error) {
      return err(databaseError('resolveEnum failed', error));
    }
  };

  return { resolveIssuers, resolveEnum };
};
