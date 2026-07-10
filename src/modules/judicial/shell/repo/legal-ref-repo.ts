/**
 * Judicial module — case legal-references repo (plan 08 §4, JD-3). SAFE (no PII),
 * empty until gate #11. Two hard privacy rules (S2):
 *
 *  1. Rows with `source_field = 'solution_summary'` are EXCLUDED from the served
 *     projection — their `raw_text` span is a substring of a forbidden column.
 *  2. The served `citation` is a NORMALIZED token rebuilt from act_type/number/year
 *     — the repo NEVER selects `raw_text`, `span_start`, or `span_end` (those are
 *     not even on the table row type).
 */

import { sql, type Kysely } from 'kysely';
import { err, ok, type Result } from 'neverthrow';

import {
  buildNextCursor,
  databaseError,
  decodeCursor,
  invalidInput,
  type ApiError,
  type CursorPage,
  type CursorPageRequest,
  type ProdDatabase,
} from '@/modules/shared/index.js';

import { FORBIDDEN_REF_SOURCE_FIELD } from './constants.js';
import { clampLimit } from './filter-helpers.js';

import type { JudicialLegalRefRepo } from '../../core/ports.js';
import type { JudicialCaseCitation, JudicialLegalRef } from '../../core/types.js';

type Db = Kysely<ProdDatabase>;
const ID_RE = /^\d+$/u;
const MAX_LIST = 50;

interface RefRow {
  case_legal_reference_id: string;
  case_id: string;
  act_type: string | null;
  act_number: string | null;
  act_year: number | null;
  issuer_slug: string | null;
  article_fragment: string | null;
  target_act_id: string | null;
  resolution_status: string | null;
  confidence_score: string | null;
}

/** Rebuild a safe citation token from act fields (never the raw source span). */
const citationToken = (r: RefRow): string => {
  const parts: string[] = [];
  if (r.act_type !== null) parts.push(r.act_type);
  if (r.act_number !== null) parts.push(r.act_number);
  if (r.act_year !== null) parts.push(`/${String(r.act_year)}`);
  return parts.join(' ').replace(/\s+\//u, '/').trim();
};

const mapRef = (r: RefRow): JudicialLegalRef => ({
  caseLegalReferenceId: r.case_legal_reference_id,
  caseId: r.case_id,
  actType: r.act_type,
  actNumber: r.act_number,
  actYear: r.act_year,
  issuerSlug: r.issuer_slug,
  articleFragment: r.article_fragment,
  targetActId: r.target_act_id,
  resolutionStatus: r.resolution_status,
  confidenceScore: r.confidence_score,
  citation: citationToken(r),
});

export const makeJudicialLegalRefRepo = (db: Db): JudicialLegalRefRepo => {
  const listForCase = async (
    caseId: string
  ): Promise<Result<readonly JudicialLegalRef[], ApiError>> => {
    if (!ID_RE.test(caseId)) return ok([]);
    try {
      // EXCLUDE source_field='solution_summary' (S2). raw_text/span_* never selected.
      const r = await sql<RefRow>`
        select lr.case_legal_reference_id::text as case_legal_reference_id,
               lr.case_id::text as case_id, lr.act_type, lr.act_number, lr.act_year,
               lr.issuer_slug, lr.article_fragment, lr.target_act_id::text as target_act_id,
               lr.resolution_status, lr.confidence_score::text as confidence_score
        from justice.case_legal_references lr
        where lr.case_id = ${caseId}::bigint
          and lr.source_field <> ${FORBIDDEN_REF_SOURCE_FIELD}
        order by lr.case_legal_reference_id asc
      `.execute(db);
      return ok(r.rows.map(mapRef));
    } catch (error) {
      return err(databaseError('legalRef.listForCase failed', error));
    }
  };

  const casesCitingAct = async (
    targetActId: string,
    page: CursorPageRequest
  ): Promise<Result<CursorPage<JudicialCaseCitation>, ApiError>> => {
    if (!ID_RE.test(targetActId)) return err(invalidInput('invalid act id', 'targetActId'));
    const limit = clampLimit(page.first, MAX_LIST);
    const fhash = `judicial_cases_citing:${targetActId}`;
    let cursorRefId: string | undefined;
    if (page.after !== undefined) {
      const decoded = decodeCursor(page.after, { sort: 'refId', dir: 'desc', fhash });
      if (decoded.isErr()) return err(decoded.error);
      cursorRefId = decoded.value.keys[0];
    }
    const cursorSql =
      cursorRefId !== undefined
        ? sql` and lr.case_legal_reference_id < ${cursorRefId}::bigint`
        : sql``;
    try {
      const r = await sql<{
        ref_id: string;
        case_id: string;
        institution_code: string;
        case_number: string;
        act_type: string | null;
        act_number: string | null;
        act_year: number | null;
      }>`
        select lr.case_legal_reference_id::text as ref_id, c.case_id::text as case_id,
               c.institution_code, c.case_number, lr.act_type, lr.act_number, lr.act_year
        from justice.case_legal_references lr
        join justice.cases c on c.case_id = lr.case_id
        where lr.target_act_id = ${targetActId}::bigint
          and lr.source_field <> ${FORBIDDEN_REF_SOURCE_FIELD}${cursorSql}
        order by lr.case_legal_reference_id desc
        limit ${limit + 1}
      `.execute(db);
      const hasMore = r.rows.length > limit;
      const rows = hasMore ? r.rows.slice(0, limit) : r.rows;
      const items: JudicialCaseCitation[] = rows.map((row) => ({
        caseId: row.case_id,
        institutionCode: row.institution_code,
        caseNumber: row.case_number,
        actType: row.act_type,
        actNumber: row.act_number,
        actYear: row.act_year,
      }));
      let next: string | null = null;
      if (hasMore) {
        const lastRow = rows[rows.length - 1];
        if (lastRow !== undefined) {
          next = buildNextCursor({ sort: 'refId', dir: 'desc', fhash, lastKeys: [lastRow.ref_id] });
        }
      }
      return ok({ items, next });
    } catch (error) {
      return err(databaseError('legalRef.casesCitingAct failed', error));
    }
  };

  return { listForCase, casesCitingAct };
};
