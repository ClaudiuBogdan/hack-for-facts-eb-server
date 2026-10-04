/**
 * Judicial module — case legal-references repo (plan 08 §4, JD-3). SAFE (no PII).
 * The served projection rules (S2, A1):
 *
 *  1. Rows with `source_field = 'solution_summary'` are EXCLUDED from both
 *     readers — that token is a substring of a forbidden column.
 *  2. `citation` is the EXACT stored extracted token (`raw_text`), with its
 *     `source_field` and nullable `hearing_index` anchor — unmodified, never the
 *     surrounding source sentence, never rebuilt from the act fields (which stay
 *     as stored, including NULL identity for an unresolved token). The span
 *     offsets are not on the table row type.
 *  3. The reverse list keeps reference-row grain (several references in one
 *     case stay several rows), ordered by reference id DESC; every row's cursor
 *     is built here from its own reference id.
 *  4. (A3) A digit-string id above int8 is rejected as InvalidInput BEFORE SQL
 *     instead of reaching `::bigint` as a database error. The reverse target is
 *     fully guarded here (it is only ever a direct argument). The by-case read is
 *     also the detail child read, so non-digit ids keep their existing empty
 *     result here; the DIRECT by-case entry is fully guarded in the usecase.
 */

import { sql, type Kysely } from 'kysely';
import { err, ok, type Result } from 'neverthrow';

import {
  buildNextCursor,
  databaseError,
  invalidInput,
  type ApiError,
  type CursorPage,
  type CursorPageRequest,
  type ProdDatabase,
} from '@/modules/shared/index.js';

import { decodeJudicialCursor, isCanonicalBigintText } from './cases-repo.js';
import { FORBIDDEN_REF_SOURCE_FIELD } from './constants.js';
import { clampLimit } from './filter-helpers.js';
import {
  isJudicialDirectId,
  type JudicialCaseCitation,
  type JudicialCursorItem,
  type JudicialLegalRef,
} from '../../core/types.js';

import type { JudicialLegalRefRepo } from '../../core/ports.js';

type Db = Kysely<ProdDatabase>;
const ID_RE = /^\d+$/u;
const MAX_LIST = 50;

interface RefRow {
  case_legal_reference_id: string;
  case_id: string;
  citation: string;
  source_field: string;
  hearing_index: number | null;
  act_type: string | null;
  act_number: string | null;
  act_year: number | null;
  issuer_slug: string | null;
  article_fragment: string | null;
  target_act_id: string | null;
  resolution_status: string | null;
  confidence_score: string | null;
}

const mapRef = (r: RefRow): JudicialLegalRef => ({
  caseLegalReferenceId: r.case_legal_reference_id,
  caseId: r.case_id,
  sourceField: r.source_field,
  hearingIndex: r.hearing_index,
  actType: r.act_type,
  actNumber: r.act_number,
  actYear: r.act_year,
  issuerSlug: r.issuer_slug,
  articleFragment: r.article_fragment,
  targetActId: r.target_act_id,
  resolutionStatus: r.resolution_status,
  confidenceScore: r.confidence_score,
  citation: r.citation,
});

export const makeJudicialLegalRefRepo = (db: Db): JudicialLegalRefRepo => {
  const listForCase = async (
    caseId: string
  ): Promise<Result<readonly JudicialLegalRef[], ApiError>> => {
    if (!ID_RE.test(caseId)) return ok([]);
    if (!isJudicialDirectId(caseId)) {
      return err(
        invalidInput(
          'caseId must be a decimal digit string of at most 9223372036854775807',
          'caseId'
        )
      );
    }
    try {
      // EXCLUDE source_field='solution_summary' (S2). The stored token only; the
      // span offsets and the surrounding source text are never selected.
      const r = await sql<RefRow>`
        select lr.case_legal_reference_id::text as case_legal_reference_id,
               lr.case_id::text as case_id, lr.raw_text as citation, lr.source_field,
               lr.hearing_index, lr.act_type, lr.act_number, lr.act_year,
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
  ): Promise<Result<CursorPage<JudicialCursorItem<JudicialCaseCitation>>, ApiError>> => {
    if (!ID_RE.test(targetActId)) return err(invalidInput('invalid act id', 'targetActId'));
    if (!isJudicialDirectId(targetActId)) {
      return err(
        invalidInput(
          'targetActId must be a decimal digit string of at most 9223372036854775807',
          'targetActId'
        )
      );
    }
    const limit = clampLimit(page.first, MAX_LIST);
    // Unchanged identity: earlier valid end cursors (built from the reference id)
    // stay usable; earlier per-edge `caseId` cursors are a sort mismatch.
    const fhash = `judicial_cases_citing:${targetActId}`;
    let cursorRefId: string | undefined;
    if (page.after !== undefined) {
      const decoded = decodeJudicialCursor(page.after, { sort: 'refId', dir: 'desc', fhash }, [
        isCanonicalBigintText,
      ]);
      if (decoded.isErr()) return err(decoded.error);
      cursorRefId = decoded.value[0];
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
      const items: JudicialCursorItem<JudicialCaseCitation>[] = r.rows
        .slice(0, limit)
        .map((row) => ({
          node: {
            caseId: row.case_id,
            institutionCode: row.institution_code,
            caseNumber: row.case_number,
            actType: row.act_type,
            actNumber: row.act_number,
            actYear: row.act_year,
          },
          cursor: buildNextCursor({ sort: 'refId', dir: 'desc', fhash, lastKeys: [row.ref_id] }),
        }));
      const next = r.rows.length > limit ? (items[items.length - 1]?.cursor ?? null) : null;
      return ok({ items, next });
    } catch (error) {
      return err(databaseError('legalRef.casesCitingAct failed', error));
    }
  };

  return { listForCase, casesCitingAct };
};
