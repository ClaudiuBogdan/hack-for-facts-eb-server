/**
 * Legal module — `LegalRetrievalRepo` (plan §3.5). Full-text + semantic RAG over
 * `legal.section_embeddings` / `legal.document_embeddings` (HNSW) with an
 * ILIKE/trigram fallback when the semantic gate is off (`qVec === null`).
 *
 * HNSW-PARAMETER RULE (BINDING §3.5): the query vector MUST be bound as a literal
 * `$n::vector` — a vector arriving via CTE/join silently falls back to an 8s exact
 * scan. We format the JS number[] into a `'[...]'::vector(768)` literal bound
 * through Kysely's `sql` tag. The partial HNSW indexes require the `config_key`
 * predicate (`'article-v1'` / `'general-v1'`) to be hit. The GUCs
 * (`statement_timeout`, `hnsw.ef_search`) are applied via `SET LOCAL` INSIDE an
 * explicit transaction — outside a txn `SET LOCAL` is a no-op (each simple-query
 * statement is its own implicit txn), so the semantic path runs in `db.transaction`.
 *
 * Pre-filter (§5.2-C): `includeHistorical=false` excludes abrogated/repealed acts
 * (status in 'in-vigoare','modificat','abrogat-partial','suspendat','necunoscut');
 * `source_extraction_status='suspicious'` summaries are excluded from RAG serving.
 */

import { sql, type Kysely, type RawBuilder, type SqlBool } from 'kysely';
import { err, ok, type Result } from 'neverthrow';

import {
  type ApiError,
  type FilterInput,
  type ProdDatabase,
  databaseError,
  toConditionBuilders,
} from '@/modules/shared/index.js';

import { mapAct, mapSummary, toStatus, type ActRow } from './mappers.js';
import { LEGAL_LIVE_STATUSES } from '../../core/legal-engine-filter.js';
import { sectionFusionKey } from '../../core/legal-search-fusion.js';
import { legalActsSpec } from '../filters/legal-acts.spec.js';

import type { LegalRetrievalQuery, LegalRetrievalRepo, LegalSectionKey } from '../../core/ports.js';
import type { LegalDocHit, LegalSectionHit } from '../../core/types.js';

type Db = Kysely<ProdDatabase>;

const SECTION_CONFIG = 'article-v1';
const DOC_CONFIG = 'general-v1';
const STMT_TIMEOUT_MS = 5000;
const EF_SEARCH = 150;
const MAX_LIMIT = 50;

const clampLimit = (n: number): number => Math.min(Math.max(Math.floor(n), 1), MAX_LIMIT);

/** A `'[1,2,3]'::vector` literal bound as a single SQL parameter (the §3.5 rule). */
const vectorParam = (vec: readonly number[]): RawBuilder<unknown> => {
  const literal = `[${vec.map((x) => (Number.isFinite(x) ? x : 0)).join(',')}]`;
  return sql`${literal}::vector`;
};

/** Compile the act-level pre-filter (status/domain/category/type/year) over alias `a`/`s`. */
const preFilterConditions = (filter: FilterInput): Result<RawBuilder<SqlBool>, ApiError> => {
  const built = toConditionBuilders(legalActsSpec, filter);
  if (built.isErr()) return err(built.error);
  if (built.value.length === 0) return ok(sql<SqlBool>`true`);
  return ok(sql<SqlBool>`${sql.join(built.value, sql` and `)}`);
};

const historicalGate = (includeHistorical: boolean): RawBuilder<unknown> =>
  includeHistorical
    ? sql`true`
    : sql`a.status in (${sql.join(
        LEGAL_LIVE_STATUSES.map((s) => sql`${s}`),
        sql`, `
      )})`;

const ESC = (s: string): string => s.replace(/[\\%_]/gu, (m) => `\\${m}`);

export const makeLegalRetrievalRepo = (db: Db): LegalRetrievalRepo => {
  const searchSections = async (
    qVec: readonly number[] | null,
    q: LegalRetrievalQuery
  ): Promise<Result<readonly LegalSectionHit[], ApiError>> => {
    const limit = clampLimit(q.limit);
    const pre = preFilterConditions(q.filter);
    if (pre.isErr()) return err(pre.error);
    const liveGate = historicalGate(q.includeHistorical);

    try {
      if (qVec !== null && qVec.length > 0) {
        // Semantic path: HNSW over section_embeddings (config_key partial index).
        // The vector is a bound `::vector` literal; the join to acts is a post-rank
        // filter on the candidate set. We over-fetch (limit*4) before the act-level
        // pre-filter so a selective status/domain filter still yields `limit` hits.
        // Runs INSIDE a txn so `SET LOCAL` (timeout + ef_search) actually applies.
        const vec = vectorParam(qVec);
        const fetch = Math.min(limit * 4, 200);
        const rows = await db.transaction().execute(async (trx) => {
          await sql`set local statement_timeout = ${sql.lit(STMT_TIMEOUT_MS)}`.execute(trx);
          await sql`set local hnsw.ef_search = ${sql.lit(EF_SEARCH)}`.execute(trx);
          const r = await sql<SectionHitRow>`
            with cand as (
              select se.document_id, se.section_key, se.article_number, se.node_path,
                     (se.embedding <=> ${vec}) as dist
              from legal.section_embeddings se
              where se.config_key = ${SECTION_CONFIG}
              order by se.embedding <=> ${vec}
              limit ${sql.lit(fetch)}
            )
            select c.document_id, c.section_key, c.article_number, c.node_path, c.dist,
                   a.act_id, a.display_citation, a.status,
                   n.label as node_label, n.char_start, n.char_end,
                   s.summary, s.plain_language_summary, s.source_extraction_status
            from cand c
            -- canonical-only serving (§5.2-C): 1,764 non-canonical docs DO carry
            -- section embeddings, so the embedding→document join MUST require
            -- canonical, else a non-canonical expression is served as the act text.
            join legal.acts a on a.canonical_document_id = c.document_id
            join legal.act_documents d on d.document_id = c.document_id and d.is_canonical
            left join legal.document_summaries s on s.document_id = c.document_id
            left join legal.document_nodes n on n.document_id = c.document_id and n.path = c.node_path
            where ${pre.value} and ${liveGate}
              and (s.source_extraction_status is distinct from 'suspicious')
            order by c.dist asc
            limit ${sql.lit(limit)}
          `.execute(trx);
          return r.rows;
        });
        return ok(rows.map(toSectionHit));
      }

      // Lexical fallback (semantic gate off). The section corpus is 2.9M rows, so
      // we MUST NOT ILIKE-scan it. Instead go ACT-FIRST: pick the top candidate
      // acts by the indexed display_citation trigram (small set), then fetch a
      // bounded slice of each act's canonical-document sections. This keeps the
      // fallback fast (no full section scan) and bounded; never errors.
      const pattern = `%${ESC(q.q.trim())}%`;
      const result = await db.transaction().execute(async (trx) => {
        await sql`set local statement_timeout = ${sql.lit(STMT_TIMEOUT_MS)}`.execute(trx);
        const r = await sql<SectionHitRow>`
          with cand_acts as (
            select a.act_id, a.display_citation, a.status, a.canonical_document_id, a.in_degree
            from legal.acts a
            left join legal.act_documents d on d.act_id = a.act_id and d.is_canonical
            left join legal.document_summaries s on s.document_id = d.document_id
            where a.display_citation ilike ${pattern} escape '\\'
              and ${pre.value} and ${liveGate}
            order by a.in_degree desc
            limit 20
          )
          select se.document_id, se.section_key, se.article_number, se.node_path, 0::float8 as dist,
                 ca.act_id, ca.display_citation, ca.status,
                 n.label as node_label, n.char_start, n.char_end,
                 ds.summary, ds.plain_language_summary, ds.source_extraction_status
          from cand_acts ca
          join legal.section_embeddings se
            on se.document_id = ca.canonical_document_id and se.config_key = ${SECTION_CONFIG}
          left join legal.document_summaries ds on ds.document_id = se.document_id
          left join legal.document_nodes n on n.document_id = se.document_id and n.path = se.node_path
          where (ds.source_extraction_status is distinct from 'suspicious')
          order by ca.in_degree desc, se.section_key asc
          limit ${sql.lit(limit)}
        `.execute(trx);
        return r.rows;
      });
      return ok(result.map(toSectionHit));
    } catch (error) {
      return err(databaseError('searchSections failed', error));
    }
  };

  const searchDocs = async (
    qVec: readonly number[] | null,
    q: LegalRetrievalQuery
  ): Promise<Result<readonly LegalDocHit[], ApiError>> => {
    const limit = clampLimit(q.limit);
    const pre = preFilterConditions(q.filter);
    if (pre.isErr()) return err(pre.error);
    const liveGate = historicalGate(q.includeHistorical);

    try {
      if (qVec !== null && qVec.length > 0) {
        const vec = vectorParam(qVec);
        const fetch = Math.min(limit * 4, 200);
        const rows = await db.transaction().execute(async (trx) => {
          await sql`set local statement_timeout = ${sql.lit(STMT_TIMEOUT_MS)}`.execute(trx);
          await sql`set local hnsw.ef_search = ${sql.lit(EF_SEARCH)}`.execute(trx);
          const r = await sql<DocHitRow>`
            with cand as (
              select de.document_id, (de.embedding <=> ${vec}) as dist
              from legal.document_embeddings de
              where de.config_key = ${DOC_CONFIG}
              order by de.embedding <=> ${vec}
              limit ${sql.lit(fetch)}
            )
            select ${ACT_AND_SUMMARY_COLS}, c.dist
            from cand c
            -- canonical-only serving (§5.2-C): the doc-embedding hit must map to the
            -- act's CANONICAL document, never a non-canonical expression.
            join legal.acts a on a.canonical_document_id = c.document_id
            join legal.act_documents d on d.document_id = c.document_id and d.is_canonical
            left join legal.document_summaries s on s.document_id = c.document_id
            where ${pre.value} and ${liveGate}
              and (s.source_extraction_status is distinct from 'suspicious')
            order by c.dist asc
            limit ${sql.lit(limit)}
          `.execute(trx);
          return r.rows;
        });
        return ok(rows.map(toDocHit));
      }

      // Lexical doc fallback (semantic gate off). Match ONLY the indexed
      // display_citation (identity/prefix) — NOT a full ILIKE over the 224k summary
      // texts, which is a 10s seq scan. Topical "about X" lexical ranking belongs to
      // OpenSearch BM25 (the hybrid lexical channel, §7.2), not Postgres. Bounded +
      // statement-timeout-guarded; degrades to "fewer results", never an error.
      const pattern = `%${ESC(q.q.trim())}%`;
      const result = await db.transaction().execute(async (trx) => {
        await sql`set local statement_timeout = ${sql.lit(STMT_TIMEOUT_MS)}`.execute(trx);
        const r = await sql<DocHitRow>`
          select ${ACT_AND_SUMMARY_COLS}, 0::float8 as dist
          from legal.acts a
          left join legal.act_documents d on d.act_id = a.act_id and d.is_canonical
          left join legal.document_summaries s on s.document_id = d.document_id
          where ${pre.value} and ${liveGate}
            and (s.source_extraction_status is distinct from 'suspicious')
            and a.display_citation ilike ${pattern} escape '\\'
          order by a.in_degree desc
          limit ${sql.lit(limit)}
        `.execute(trx);
        return r.rows;
      });
      return ok(result.map(toDocHit));
    } catch (error) {
      return err(databaseError('searchDocs failed', error));
    }
  };

  /**
   * Engine-hit hydration. Reads the section catalogue from
   * `legal.section_embeddings` — today that IS the catalogue (it is the only
   * prod table carrying `section_key` + `node_path`), which is why the SQL
   * paths above join it too; if a dedicated sections table ever lands, this is
   * the one place to repoint.
   *
   * The canonical-only join is NOT optional: 1,764 non-canonical documents
   * carry section rows, and serving one presents a superseded expression as
   * the act's text.
   */
  const hydrateSections = async (
    keys: readonly LegalSectionKey[]
  ): Promise<Result<ReadonlyMap<string, LegalSectionHit>, ApiError>> => {
    if (keys.length === 0) return ok(new Map());
    const documentIds = keys.map((k) => k.documentId);
    const sectionKeys = keys.map((k) => k.sectionKey);
    try {
      const rows = await db.transaction().execute(async (trx) => {
        await sql`set local statement_timeout = ${sql.lit(STMT_TIMEOUT_MS)}`.execute(trx);
        const r = await sql<SectionHitRow>`
          select se.document_id, se.section_key, se.article_number, se.node_path,
                 0::float8 as dist,
                 a.act_id, a.display_citation, a.status,
                 n.label as node_label, n.char_start, n.char_end,
                 s.summary, s.plain_language_summary, s.source_extraction_status
          from unnest(${documentIds}::text[], ${sectionKeys}::text[])
               as k(document_id, section_key)
          join legal.section_embeddings se
            on se.document_id = k.document_id
           and se.section_key = k.section_key
           and se.config_key = ${SECTION_CONFIG}
          join legal.acts a on a.canonical_document_id = se.document_id
          join legal.act_documents d
            on d.document_id = se.document_id and d.is_canonical
          left join legal.document_summaries s on s.document_id = se.document_id
          left join legal.document_nodes n
            on n.document_id = se.document_id and n.path = se.node_path
          where (s.source_extraction_status is distinct from 'suspicious')
        `.execute(trx);
        return r.rows;
      });
      return ok(
        new Map(
          rows.map((row) => [sectionFusionKey(row.document_id, row.section_key), toSectionHit(row)])
        )
      );
    } catch (error) {
      return err(databaseError('hydrateSections failed', error));
    }
  };

  return { searchSections, searchDocs, hydrateSections };
};

// ── row shapes + mappers ──────────────────────────────────────────────────────

const ACT_AND_SUMMARY_COLS = sql`
  a.act_id, a.act_natural_key, a.act_type, a.act_number, a.act_year,
  a.issuer_slug, a.canonical_document_id, a.display_citation, a.status,
  a.status_evidence, a.entry_into_force::text as entry_into_force, a.in_degree,
  s.document_id as s_document_id, s.description, s.summary, s.plain_language_summary,
  s.document_category, s.domains, s.affected_audiences, s.keywords, s.key_dates,
  s.penalties_mentioned, s.fiscal_impact, s.confidence, s.source_extraction_status
`;

interface SectionHitRow {
  document_id: string;
  section_key: string;
  article_number: string | null;
  node_path: string | null;
  dist: number;
  act_id: string;
  display_citation: string;
  status: string;
  node_label: string | null;
  char_start: number | null;
  char_end: number | null;
  summary: string | null;
  plain_language_summary: string | null;
  source_extraction_status: string | null;
}

const toSectionHit = (r: SectionHitRow): LegalSectionHit => ({
  actId: r.act_id,
  displayCitation: r.display_citation,
  status: toStatus(r.status),
  documentId: r.document_id,
  sectionKey: r.section_key,
  articleNumber: r.article_number,
  nodeLabel: r.node_label,
  nodePath: r.node_path,
  charStart: r.char_start,
  charEnd: r.char_end,
  snippet: r.summary ?? r.plain_language_summary ?? null,
  portalDeepLink: null, // filled by the usecase from clientBaseUrl + section
  provenance: null, // filled by the usecase in ONE batch over the result set
  score: Number.isFinite(r.dist) ? 1 - r.dist : 0, // cosine distance → similarity
});

interface DocHitRow extends ActRow {
  dist: number;
  s_document_id: string | null;
  description: string | null;
  summary: string | null;
  plain_language_summary: string | null;
  document_category: string | null;
  domains: string[] | null;
  affected_audiences: string[] | null;
  keywords: string[] | null;
  key_dates: unknown;
  penalties_mentioned: boolean | null;
  fiscal_impact: string | null;
  confidence: number | null;
  source_extraction_status: string | null;
}

const toDocHit = (r: DocHitRow): LegalDocHit => {
  const act = mapAct(r);
  const summary =
    r.s_document_id === null
      ? null
      : mapSummary({
          document_id: r.s_document_id,
          description: r.description,
          summary: r.summary,
          plain_language_summary: r.plain_language_summary,
          document_category: r.document_category,
          domains: r.domains,
          affected_audiences: r.affected_audiences,
          keywords: r.keywords,
          key_dates: r.key_dates,
          penalties_mentioned: r.penalties_mentioned,
          fiscal_impact: r.fiscal_impact,
          confidence: r.confidence,
          source_extraction_status: r.source_extraction_status,
        });
  return {
    act,
    summary,
    // filled by the usecase in ONE batch over the result set
    provenance: null,
    score: Number.isFinite(r.dist) ? 1 - r.dist : 0,
  };
};
