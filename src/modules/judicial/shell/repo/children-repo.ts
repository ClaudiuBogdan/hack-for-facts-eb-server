/**
 * Judicial module — case children repos (plan 08 §4): hearings, appeals, parties.
 * All are bounded by a single `case_id` (PK seeks). All are NAME-FREE:
 *  - hearings NEVER select solution/solution_summary (the table row type has no
 *    such field — a select on either is a compile error, the structural guarantee).
 *  - parties have NO name column; the SELECT lists only the projected + privacy-
 *    predicate columns.
 */

import { sql, type Kysely } from 'kysely';
import { err, ok, type Result } from 'neverthrow';

import { databaseError, type ApiError, type ProdDatabase } from '@/modules/shared/index.js';

import { CLASSIFIER_VERSION, PUBLISHABLE_PARTY_KINDS, PUBLISHABLE_RULES } from './constants.js';

import type {
  JudicialAppealRepo,
  JudicialHearingRepo,
  JudicialPartyRepo,
} from '../../core/ports.js';
import type {
  JudicialAppeal,
  JudicialHearing,
  JudicialParty,
  JudicialPartyKind,
} from '../../core/types.js';

type Db = Kysely<ProdDatabase>;
const ID_RE = /^\d+$/u;

// ── hearings ───────────────────────────────────────────────────────────────────

interface HearingRow {
  case_id: string;
  hearing_index: number;
  hearing_at: string | null;
  panel: string | null;
  pronouncement_date: string | null;
  document_number: string | null;
  document_date: string | null;
}

export const makeJudicialHearingRepo = (db: Db): JudicialHearingRepo => ({
  async listForCase(caseId: string): Promise<Result<readonly JudicialHearing[], ApiError>> {
    if (!ID_RE.test(caseId)) return ok([]);
    try {
      // Note the explicit column list: solution / solution_summary are NOT selected
      // (and are not on the table row type). hearing_at is timestamptz → ISO.
      const r = await sql<HearingRow>`
        select h.case_id::text as case_id, h.hearing_index, h.hearing_at,
               h.panel, to_char(h.pronouncement_date, 'YYYY-MM-DD') as pronouncement_date,
               h.document_number, to_char(h.document_date, 'YYYY-MM-DD') as document_date
        from justice.case_hearings h
        where h.case_id = ${caseId}::bigint
        order by h.hearing_index asc
      `.execute(db);
      return ok(
        r.rows.map((row) => ({
          caseId: row.case_id,
          hearingIndex: row.hearing_index,
          hearingAt: row.hearing_at === null ? null : new Date(row.hearing_at).toISOString(),
          panel: row.panel,
          pronouncementDate: row.pronouncement_date,
          documentNumber: row.document_number,
          documentDate: row.document_date,
        }))
      );
    } catch (error) {
      return err(databaseError('hearings.listForCase failed', error));
    }
  },
});

// ── appeals ────────────────────────────────────────────────────────────────────

interface AppealRow {
  case_id: string;
  appeal_index: number;
  appeal_declared_at: string | null;
  appeal_type: string | null;
}

export const makeJudicialAppealRepo = (db: Db): JudicialAppealRepo => ({
  async listForCase(caseId: string): Promise<Result<readonly JudicialAppeal[], ApiError>> {
    if (!ID_RE.test(caseId)) return ok([]);
    try {
      const r = await sql<AppealRow>`
        select a.case_id::text as case_id, a.appeal_index,
               to_char(a.appeal_declared_at, 'YYYY-MM-DD') as appeal_declared_at, a.appeal_type
        from justice.case_appeals a
        where a.case_id = ${caseId}::bigint
        order by a.appeal_index asc
      `.execute(db);
      return ok(
        r.rows.map((row) => ({
          caseId: row.case_id,
          appealIndex: row.appeal_index,
          appealDeclaredAt: row.appeal_declared_at,
          appealType: row.appeal_type,
        }))
      );
    } catch (error) {
      return err(databaseError('appeals.listForCase failed', error));
    }
  },
});

// ── parties (NAME-FREE) ─────────────────────────────────────────────────────────

interface PartyRow {
  case_id: string;
  party_index: number;
  party_kind: string;
  role_normalized: string | null;
  name_key_id: string | null;
  // classifier_rule/version are read ONLY to compute the per-row `publishable`
  // flag (the privacy predicate); they are NOT projected to the view model.
  classifier_rule: string | null;
  classifier_version: string | null;
}

const PUBLISHABLE_RULE_SET = new Set<string>(PUBLISHABLE_RULES);
const PUBLISHABLE_KIND_SET = new Set<string>(PUBLISHABLE_PARTY_KINDS);

/** Re-assert the per-row publishability predicate (mirrors the dictionary gate). */
const rowPublishable = (row: PartyRow): boolean =>
  PUBLISHABLE_KIND_SET.has(row.party_kind) &&
  row.classifier_rule !== null &&
  PUBLISHABLE_RULE_SET.has(row.classifier_rule) &&
  row.classifier_version === CLASSIFIER_VERSION;

export const makeJudicialPartyRepo = (db: Db): JudicialPartyRepo => ({
  async listForCase(caseId: string): Promise<Result<readonly JudicialParty[], ApiError>> {
    if (!ID_RE.test(caseId)) return ok([]);
    try {
      // SELECTs no name column — case_parties has none by design. classifier_rule/
      // version feed the per-row `publishable` flag and are not exposed.
      const r = await sql<PartyRow>`
        select p.case_id::text as case_id, p.party_index, p.party_kind,
               p.role_normalized, p.name_key_id::text as name_key_id,
               p.classifier_rule, p.classifier_version
        from justice.case_parties p
        where p.case_id = ${caseId}::bigint
        order by p.party_index asc
      `.execute(db);
      return ok(
        r.rows.map((row) => ({
          caseId: row.case_id,
          partyIndex: row.party_index,
          partyKind: row.party_kind as JudicialPartyKind,
          roleNormalized: row.role_normalized,
          nameKeyId: row.name_key_id,
          publishable: rowPublishable(row),
        }))
      );
    } catch (error) {
      return err(databaseError('parties.listForCase failed', error));
    }
  },
});
