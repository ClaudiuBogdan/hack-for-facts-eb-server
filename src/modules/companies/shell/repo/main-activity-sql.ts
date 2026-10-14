/**
 * Companies repo — the ANAF-assumed main activity (scrapper migrations
 * 20261013T220000 and 20261013T220030, contract v2: the trailing
 * `fiscal_time_basis` / `fiscal_raw_retrieved_at` columns of the current and
 * evidence views). Shell-only SQL over the FOUR public views and nothing
 * else: `main_caen_current_assignments`, `main_caen_class_flags`,
 * `main_caen_public_resolutions`, `main_caen_public_supports`. Never the base
 * history tables, the corrections, the refresh log, the unbound probes, the
 * fiscal admissions or raw custody.
 *
 * The views decide currentness and source / edition withdrawal at read time
 * (owner rights; the digests they compare are SECURITY DEFINER). The feature
 * is optional: a missing view, column, function or grant (a capability
 * SQLSTATE) is the typed `unavailable` state of THIS part, never an error of
 * the legacy ONRC / v3 profile and never a registry capability loss.
 *
 * Every row is validated (TypeBox) and every vocabulary value is checked:
 * an unknown status, currentness, basis, form, custody or policy fails the
 * part closed (`Database` error), never mapped to a nearby value. Times are
 * rendered in SQL as UTC ISO-8601 text; ids as bigint text.
 */

import { createHash } from 'node:crypto';

import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { sql, type Kysely } from 'kysely';
import { err, ok, type Result } from 'neverthrow';

import { databaseError, type ApiError, type ProdDatabase } from '@/modules/shared/index.js';

import { isCapabilityError } from './registry-sql.js';
import {
  MAIN_ACTIVITY_CURRENTNESS,
  MAIN_ACTIVITY_EVIDENCE_CUSTODIES,
  MAIN_ACTIVITY_FISCAL_TIME_BASES,
  MAIN_ACTIVITY_JSON_TYPES,
  MAIN_ACTIVITY_LABEL_SOURCE,
  MAIN_ACTIVITY_LEGACY_ROLE_BASIS,
  MAIN_ACTIVITY_MATCH_BASES,
  MAIN_ACTIVITY_POLICIES,
  MAIN_ACTIVITY_POLICY_V1,
  MAIN_ACTIVITY_REVISION_BASES,
  MAIN_ACTIVITY_ROLE_BASES,
  MAIN_ACTIVITY_SELECTING_STATUSES,
  MAIN_ACTIVITY_STATUSES,
  MAIN_ACTIVITY_TOKEN_FORMS,
  MAIN_ACTIVITY_V3_FORMS,
  MAIN_CLASS_FLAG_BOUND,
  MAIN_FLAG_CURRENTNESS,
  absentEvidenceProblem,
  isLegacyCustody,
  isMainCode,
  isMainRevision,
  mainActivityCacheKey,
  mainRoleBasisAllowed,
  oneOf,
  parseCandidateKeys,
  publicMainToken,
  visibleEvidenceTimeProblem,
  withdrawnEvidenceTimeProblem,
  type CompanyMainActivity,
  type CompanyMainActivityAnafEvidence,
  type CompanyMainActivityCandidateKey,
  type CompanyMainActivityEvidence,
  type CompanyMainActivityEvidenceEntry,
  type CompanyMainActivityHistoryKind,
  type CompanyMainActivityHistoryRows,
  type CompanyMainActivityKey,
  type CompanyMainActivityOutcome,
  type CompanyMainAssignmentRead,
  type CompanyMainClassFlag,
  type CompanyMainFlagsRead,
  type MainEvidenceTime,
} from '../../core/main-activity.js';

type Db = Kysely<ProdDatabase>;

const Text = Type.String();
const NullableText = Type.Union([Type.String(), Type.Null()]);
const NullableBool = Type.Union([Type.Boolean(), Type.Null()]);
const NullableTextArray = Type.Union([Type.Array(Type.String()), Type.Null()]);

/** UTC ISO-8601 text of a timestamptz (independent of the session time zone). */
const isoUtc = (column: string) =>
  sql<
    string | null
  >`to_char(${sql.ref(column)} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

// ─────────────────────────────────────────────────────────────────────────────
// Current assignment + class flags (ONE statement, one snapshot)
// ─────────────────────────────────────────────────────────────────────────────

const AssignmentSchema = Type.Object({
  resolution_id: Text,
  support_id: Text,
  status: NullableText,
  main_role_basis: NullableText,
  policy_version: NullableText,
  anaf_original_token: NullableText,
  anaf_json_type: NullableText,
  anaf_token_form: NullableText,
  anaf_canonical_digits: NullableText,
  anaf_assumed_code: NullableText,
  anaf_v3_form: NullableText,
  revision_basis: NullableText,
  match_basis: NullableText,
  candidate_keys: NullableTextArray,
  resolved_revision: NullableText,
  resolved_code: NullableText,
  resolved_label: NullableText,
  correction_id: NullableText,
  edition_id: NullableText,
  edition_source_published_at: NullableText,
  onrc_caen_coverage: NullableText,
  fiscal_source_snapshot_id: NullableText,
  fiscal_source_hash: NullableText,
  fiscal_status_date: NullableText,
  fiscal_retrieved_at: NullableText,
  fiscal_source_url: NullableText,
  fiscal_raw_capture_id: NullableText,
  fiscal_raw_custody_id: NullableText,
  evidence_custody: NullableText,
  fiscal_time_basis: NullableText,
  fiscal_raw_retrieved_at: NullableText,
  derived_at: Text,
  evidence_at: Text,
  refreshed_at: Text,
  refresh_id: Text,
  content_epoch: Text,
  currentness: Text,
  anaf_withdrawn: Type.Boolean(),
  integrity_held: Type.Boolean(),
});
type AssignmentRow = Static<typeof AssignmentSchema>;

const FlagSchema = Type.Object({
  revision: Text,
  code: Text,
  is_main_caen: NullableBool,
  matches_assumed_main_code: NullableBool,
  currentness: Text,
  resolution_id: NullableText,
  edition_id: Text,
});

const AssignmentOnlySchema = Type.Object({
  assignment: Type.Union([Type.Record(Type.String(), Type.Unknown()), Type.Null()]),
});
const AssignmentAndFlagsSchema = Type.Object({
  assignment: Type.Union([Type.Record(Type.String(), Type.Unknown()), Type.Null()]),
  flags: Type.Array(FlagSchema),
});

const malformed = (what: string): ApiError =>
  databaseError(`main activity ${what} is not recognized by this reader`);

/** The selected key: all three fields for a selecting status, none otherwise. */
const resolvedKey = (
  row: Pick<AssignmentRow, 'resolved_revision' | 'resolved_code' | 'resolved_label'>,
  selecting: boolean
): Result<CompanyMainActivityKey | null, ApiError> => {
  const { resolved_revision: revision, resolved_code: code, resolved_label: label } = row;
  if (!selecting) {
    return revision === null && code === null && label === null
      ? ok(null)
      : err(malformed('selection'));
  }
  if (
    revision === null ||
    code === null ||
    label === null ||
    label.trim() === '' ||
    !isMainRevision(revision) ||
    !isMainCode(code)
  ) {
    return err(malformed('selection'));
  }
  return ok({ revision, code, label, labelSource: MAIN_ACTIVITY_LABEL_SOURCE });
};

/** A v3 form diagnosis only when it is one of its vocabulary (never free text). */
const v3FormOf = (value: string | null): string | null =>
  value !== null && MAIN_ACTIVITY_V3_FORMS.includes(value) ? value : null;

/**
 * The custody / time-basis / retrieval-time facts of a view row, vocabulary
 * checked (null = an unknown value: the caller fails closed). Six-digit text
 * is kept exactly as the view rendered it; never parsed into a Date.
 */
const evidenceTimeOf = (row: {
  readonly evidence_custody: string | null;
  readonly fiscal_time_basis: string | null;
  readonly fiscal_retrieved_at: string | null;
  readonly fiscal_raw_retrieved_at: string | null;
}): MainEvidenceTime | null => {
  const custody =
    row.evidence_custody === null
      ? null
      : oneOf(MAIN_ACTIVITY_EVIDENCE_CUSTODIES, row.evidence_custody);
  const timeBasis =
    row.fiscal_time_basis === null
      ? null
      : oneOf(MAIN_ACTIVITY_FISCAL_TIME_BASES, row.fiscal_time_basis);
  if (
    (row.evidence_custody !== null && custody === null) ||
    (row.fiscal_time_basis !== null && timeBasis === null)
  ) {
    return null;
  }
  return {
    custody,
    timeBasis,
    retrievedAt: row.fiscal_retrieved_at,
    rawRetrievedAt: row.fiscal_raw_retrieved_at,
  };
};

/**
 * The view's assignment row → the served shape (before the scope gate).
 * `witness` is the whole-row digest (`rowWitness`), the cache identity base.
 */
export const mapAssignment = (
  row: AssignmentRow,
  witness: string
): Result<CompanyMainActivity, ApiError> => {
  const currentness = oneOf(MAIN_ACTIVITY_CURRENTNESS, row.currentness);
  if (currentness === null) return err(malformed('currentness'));
  const policy = oneOf(MAIN_ACTIVITY_POLICIES, row.policy_version);
  if (policy === null) return err(malformed(`policy ${row.policy_version ?? '(none)'}`));
  const basis = oneOf(MAIN_ACTIVITY_ROLE_BASES, row.main_role_basis);
  if (basis === null || !mainRoleBasisAllowed(policy, basis)) return err(malformed('role basis'));
  // The view reports a fiscal withdrawal as currentness unless the edition's
  // withdrawal takes precedence: it is never source_withdrawn without it.
  if (currentness === 'source_withdrawn' && !row.anaf_withdrawn) {
    return err(malformed('source withdrawal'));
  }

  const status = row.status === null ? null : oneOf(MAIN_ACTIVITY_STATUSES, row.status);
  if (row.status !== null && status === null) return err(malformed('status'));
  // Suppressed by withdrawal (source / edition) or withheld while pending (a
  // source integrity hold); a current assignment always states its outcome.
  if (status === null && currentness === 'current') return err(malformed('status'));
  if (
    status !== null &&
    (currentness === 'source_withdrawn' || currentness === 'onrc_unavailable')
  ) {
    return err(malformed('status'));
  }
  const interpretationSuppressed = status === null;
  // A held source is never current and never interpreted; its token-derived
  // fields are suppressed by the view.
  if (
    row.integrity_held &&
    (currentness === 'current' ||
      !interpretationSuppressed ||
      row.anaf_original_token !== null ||
      row.anaf_token_form !== null ||
      row.anaf_canonical_digits !== null ||
      row.anaf_assumed_code !== null)
  ) {
    return err(malformed('integrity hold'));
  }
  if (
    interpretationSuppressed &&
    (row.match_basis !== null ||
      row.revision_basis !== null ||
      row.candidate_keys !== null ||
      row.correction_id !== null)
  ) {
    return err(malformed('suppressed interpretation'));
  }

  const matchBasis =
    row.match_basis === null ? null : oneOf(MAIN_ACTIVITY_MATCH_BASES, row.match_basis);
  if (row.match_basis !== null && matchBasis === null) return err(malformed('match basis'));
  const revisionBasis =
    row.revision_basis === null ? null : oneOf(MAIN_ACTIVITY_REVISION_BASES, row.revision_basis);
  if (row.revision_basis !== null && revisionBasis === null) {
    return err(malformed('revision basis'));
  }

  const selecting = status !== null && MAIN_ACTIVITY_SELECTING_STATUSES.includes(status);
  const resolved = resolvedKey(row, selecting);
  if (resolved.isErr()) return err(resolved.error);

  let candidates: readonly CompanyMainActivityCandidateKey[] | null = null;
  if (row.candidate_keys !== null) {
    candidates = parseCandidateKeys(row.candidate_keys);
    if (candidates === null) return err(malformed('candidate key'));
  } else if (!interpretationSuppressed) {
    return err(malformed('candidate keys'));
  }

  const time = evidenceTimeOf(row);
  if (time === null) return err(malformed('ANAF evidence'));
  let anaf: CompanyMainActivityAnafEvidence | null = null;
  // A withdrawn source: the WHOLE ANAF object is null, whatever currentness
  // says; its custody and times must be suppressed too (the role basis stays).
  if (row.anaf_withdrawn) {
    if (withdrawnEvidenceTimeProblem(time) !== null)
      return err(malformed('withdrawn ANAF evidence'));
  } else {
    // No source snapshot: exactly the no-source shape (never judged from the
    // status); a source: a stated, coherent time provenance.
    const problem =
      row.fiscal_source_snapshot_id === null
        ? absentEvidenceProblem({
            fiscal_source_hash: row.fiscal_source_hash,
            fiscal_status_date: row.fiscal_status_date,
            fiscal_retrieved_at: row.fiscal_retrieved_at,
            fiscal_source_url: row.fiscal_source_url,
            fiscal_raw_capture_id: row.fiscal_raw_capture_id,
            fiscal_raw_custody_id: row.fiscal_raw_custody_id,
            evidence_custody: row.evidence_custody,
            fiscal_time_basis: row.fiscal_time_basis,
            fiscal_raw_retrieved_at: row.fiscal_raw_retrieved_at,
            anaf_original_token: row.anaf_original_token,
            anaf_json_type: row.anaf_json_type,
            anaf_token_form: row.anaf_token_form,
            anaf_canonical_digits: row.anaf_canonical_digits,
            anaf_assumed_code: row.anaf_assumed_code,
            anaf_v3_form: row.anaf_v3_form,
          })
        : visibleEvidenceTimeProblem(time);
    if (problem !== null) return err(malformed(problem));
    // The current outcome is legacy exactly when its evidence is (v2 only);
    // absent evidence carries no legacy marker at all.
    if ((basis === MAIN_ACTIVITY_LEGACY_ROLE_BASIS) !== isLegacyCustody(time.custody)) {
      return err(malformed('legacy role basis / custody'));
    }
    if (policy === MAIN_ACTIVITY_POLICY_V1 && time.timeBasis === 'legacy_ms_projection') {
      return err(malformed('legacy evidence under policy v1'));
    }
    const jsonType =
      row.anaf_json_type === null ? null : oneOf(MAIN_ACTIVITY_JSON_TYPES, row.anaf_json_type);
    const tokenForm =
      row.anaf_token_form === null ? null : oneOf(MAIN_ACTIVITY_TOKEN_FORMS, row.anaf_token_form);
    if (
      (row.anaf_json_type !== null && jsonType === null) ||
      (row.anaf_token_form !== null && tokenForm === null)
    ) {
      return err(malformed('ANAF evidence'));
    }
    if (row.anaf_assumed_code !== null && !isMainCode(row.anaf_assumed_code)) {
      return err(malformed('assumed code'));
    }
    anaf = {
      // Only an economic-code digit form is ever served (defense in depth).
      originalToken: publicMainToken(row.anaf_json_type, row.anaf_original_token),
      jsonType,
      tokenForm,
      // '' = all zeros: never a digit match, served as no digits.
      canonicalDigits: row.anaf_canonical_digits === '' ? null : row.anaf_canonical_digits,
      assumedCode: row.anaf_assumed_code,
      v3Form: v3FormOf(row.anaf_v3_form),
      statusDate: row.fiscal_status_date,
      retrievedAt: row.fiscal_retrieved_at,
      // Null exactly for the no-source shape (absentEvidenceProblem).
      timeBasis: time.timeBasis,
      rawRetrievedAt: time.rawRetrievedAt,
      sourceUrl: row.fiscal_source_url,
      sourceSnapshotId: row.fiscal_source_snapshot_id,
      sourceHash: row.fiscal_source_hash,
      rawCaptureId: row.fiscal_raw_capture_id,
      rawCustodyId: row.fiscal_raw_custody_id,
      evidenceCustody: time.custody,
    };
  }

  const edition =
    row.edition_id === null
      ? null
      : {
          editionId: row.edition_id,
          sourcePublishedAt: row.edition_source_published_at,
          caenCoverage: row.onrc_caen_coverage,
        };
  if ((edition === null) !== (currentness === 'onrc_unavailable')) {
    return err(malformed('edition'));
  }

  return ok({
    policy,
    basis,
    currentness,
    anafWithdrawn: row.anaf_withdrawn,
    integrityHeld: row.integrity_held,
    status,
    matchBasis,
    revisionBasis,
    resolved: resolved.value,
    candidates,
    correctionId: row.correction_id,
    anaf,
    edition,
    derivedAt: row.derived_at,
    evidenceAt: row.evidence_at,
    refreshedAt: row.refreshed_at,
    resolutionId: row.resolution_id,
    supportId: row.support_id,
    refreshId: row.refresh_id,
    contentEpoch: row.content_epoch,
    cacheKey: mainActivityCacheKey(witness),
  });
};

const mapFlag = (row: Static<typeof FlagSchema>): Result<CompanyMainClassFlag, ApiError> => {
  const currentness = oneOf(MAIN_FLAG_CURRENTNESS, row.currentness);
  if (currentness === null || !isMainRevision(row.revision) || !isMainCode(row.code)) {
    return err(malformed('class flag'));
  }
  return ok({
    revision: row.revision,
    code: row.code,
    isMainCaen: row.is_main_caen,
    matchesAssumedMainCode: row.matches_assumed_main_code,
    currentness,
    resolutionId: row.resolution_id,
    editionId: row.edition_id,
  });
};

/** The public assignment row as one JSON object (the same text the witness digests). */
const assignmentObject = (cui: string) => sql`(select jsonb_build_object(
    'resolution_id', a.resolution_id::text,
    'support_id', a.support_id::text,
    'status', a.status,
    'main_role_basis', a.main_role_basis,
    'policy_version', a.policy_version,
    'anaf_original_token', a.anaf_original_token,
    'anaf_json_type', a.anaf_json_type,
    'anaf_token_form', a.anaf_token_form,
    'anaf_canonical_digits', a.anaf_canonical_digits,
    'anaf_assumed_code', a.anaf_assumed_code,
    'anaf_v3_form', a.anaf_v3_form,
    'revision_basis', a.revision_basis,
    'match_basis', a.match_basis,
    'candidate_keys', to_jsonb(a.candidate_keys),
    'resolved_revision', a.resolved_revision,
    'resolved_code', a.resolved_code,
    'resolved_label', a.resolved_label,
    'correction_id', a.correction_id::text,
    'edition_id', a.edition_id::text,
    'edition_source_published_at', a.edition_source_published_at::text,
    'onrc_caen_coverage', a.onrc_caen_coverage,
    'fiscal_source_snapshot_id', a.fiscal_source_snapshot_id,
    'fiscal_source_hash', a.fiscal_source_hash,
    'fiscal_status_date', a.fiscal_status_date::text,
    'fiscal_retrieved_at', ${isoUtc('a.fiscal_retrieved_at')},
    'fiscal_source_url', a.fiscal_source_url,
    'fiscal_raw_capture_id', a.fiscal_raw_capture_id::text,
    'fiscal_raw_custody_id', a.fiscal_raw_custody_id::text,
    'evidence_custody', a.evidence_custody,
    'fiscal_time_basis', a.fiscal_time_basis,
    'fiscal_raw_retrieved_at', ${isoUtc('a.fiscal_raw_retrieved_at')},
    'derived_at', ${isoUtc('a.derived_at')},
    'evidence_at', ${isoUtc('a.evidence_at')},
    'refreshed_at', ${isoUtc('a.refreshed_at')},
    'refresh_id', a.refresh_id::text,
    'content_epoch', a.content_epoch::text,
    'currentness', a.currentness,
    'anaf_withdrawn', a.anaf_withdrawn,
    'integrity_held', a.integrity_held)
  from companies_v2.main_caen_current_assignments a
  where a.cui = ${cui})`;

/**
 * The witness of a public assignment row: the digest of its whole JSON text
 * (jsonb renders keys in one canonical order), so ANY change of what the
 * view serves — including a masking that keeps ids, epoch and currentness —
 * changes it. Never the row content itself.
 */
export const rowWitness = (raw: Readonly<Record<string, unknown>>): string =>
  `a:${createHash('sha256').update(JSON.stringify(raw)).digest('hex')}`;

const assignmentRead = (
  raw: Readonly<Record<string, unknown>> | null
): Result<CompanyMainAssignmentRead, ApiError> => {
  if (raw === null) return ok({ state: 'none' });
  if (!Value.Check(AssignmentSchema, raw)) {
    return err(databaseError('main activity read is malformed'));
  }
  const witness = rowWitness(raw);
  const activity = mapAssignment(raw, witness);
  if (activity.isErr()) return err(activity.error);
  return ok({ state: 'row', activity: activity.value, witness });
};

/** The assignment alone (the singleton read, also the flag-view fallback). */
const readAssignmentOnly = async (
  db: Db,
  cui: string
): Promise<Result<CompanyMainAssignmentRead, ApiError>> => {
  try {
    const result = await sql<Record<string, unknown>>`
      select ${assignmentObject(cui)} as assignment`.execute(db);
    const row = result.rows[0];
    if (result.rows.length !== 1 || !Value.Check(AssignmentOnlySchema, row)) {
      return err(databaseError('main activity read is malformed'));
    }
    return assignmentRead(row.assignment);
  } catch (error) {
    if (isCapabilityError(error)) return ok({ state: 'unavailable' });
    return err(databaseError('main activity read failed', error));
  }
};

const flagsRead = (
  rows: readonly Static<typeof FlagSchema>[]
): Result<CompanyMainFlagsRead, ApiError> => {
  // Past the bound: refused (null flags), never truncated, never the main activity.
  if (rows.length > MAIN_CLASS_FLAG_BOUND) return ok({ state: 'overflow' });
  const flags: CompanyMainClassFlag[] = [];
  for (const flag of rows) {
    const mapped = mapFlag(flag);
    if (mapped.isErr()) return err(mapped.error);
    flags.push(mapped.value);
  }
  return ok({ state: 'read', flags });
};

/**
 * The company's current assignment and, only when a flag was selected, its
 * class flags in the SAME statement (one snapshot, so the header and the
 * badges can never come from two refreshes). The two availabilities are
 * independent: a flag view this runtime cannot read re-reads the assignment
 * alone (flags `unavailable`); a flag list past its bound is `overflow`
 * (null flags) and never refuses the main activity.
 */
export const readMainActivity = async (
  db: Db,
  cui: string,
  options: { readonly flags: boolean }
): Promise<Result<CompanyMainActivityEvidence, ApiError>> => {
  if (!options.flags) {
    const assignment = await readAssignmentOnly(db, cui);
    return assignment.map((a) => ({ assignment: a, flags: { state: 'not_requested' } }));
  }
  try {
    const result = await sql<Record<string, unknown>>`
      select ${assignmentObject(cui)} as assignment,
        coalesce((select jsonb_agg(jsonb_build_object(
            'revision', k.revision,
            'code', k.code,
            'is_main_caen', k.is_main_caen,
            'matches_assumed_main_code', k.matches_assumed_main_code,
            'currentness', k.currentness,
            'resolution_id', k.resolution_id::text,
            'edition_id', k.edition_id::text) order by k.revision, k.code)
          from (select f.revision, f.code, f.is_main_caen, f.matches_assumed_main_code,
                       f.currentness, f.resolution_id, f.edition_id
                  from companies_v2.main_caen_class_flags f
                 where f.cui = ${cui}
                 order by f.revision, f.code
                 limit ${MAIN_CLASS_FLAG_BOUND + 1}) k), '[]'::jsonb) as flags`.execute(db);
    const row = result.rows[0];
    if (result.rows.length !== 1 || !Value.Check(AssignmentAndFlagsSchema, row)) {
      return err(databaseError('main activity read is malformed'));
    }
    const assignment = assignmentRead(row.assignment);
    if (assignment.isErr()) return err(assignment.error);
    const flags = flagsRead(row.flags);
    if (flags.isErr()) return err(flags.error);
    return ok({ assignment: assignment.value, flags: flags.value });
  } catch (error) {
    if (!isCapabilityError(error)) return err(databaseError('main activity read failed', error));
    // Which view is unreadable is not told apart by the error: the
    // assignment alone decides the main activity; the flags stay unknown.
    const assignment = await readAssignmentOnly(db, cui);
    return assignment.map((a) => ({ assignment: a, flags: { state: 'unavailable' } }));
  }
};

/**
 * The witness (`mainActivityWitness`) of the company's assignment, read
 * fresh through the same projection: `unavailable`, `none` or `a:<digest>`.
 */
export const readMainActivityWitness = async (
  db: Db,
  cui: string
): Promise<Result<string, ApiError>> => {
  try {
    const result = await sql<Record<string, unknown>>`
      select ${assignmentObject(cui)} as assignment`.execute(db);
    const row = result.rows[0];
    if (result.rows.length !== 1 || !Value.Check(AssignmentOnlySchema, row)) {
      return err(databaseError('main activity witness is malformed'));
    }
    return ok(row.assignment === null ? 'none' : rowWitness(row.assignment));
  } catch (error) {
    if (isCapabilityError(error)) return ok('unavailable');
    return err(databaseError('main activity recheck failed', error));
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// History (public views, bounded keyset pages, newest first)
// ─────────────────────────────────────────────────────────────────────────────

const OutcomeSchema = Type.Object({
  resolution_id: Text,
  previous_resolution_id: NullableText,
  refresh_id: Text,
  reasons: Type.Array(Type.String()),
  policy_version: Text,
  main_role_basis: NullableText,
  status: NullableText,
  revision_basis: NullableText,
  match_basis: NullableText,
  anaf_original_token: NullableText,
  anaf_json_type: NullableText,
  anaf_token_form: NullableText,
  anaf_canonical_digits: NullableText,
  anaf_assumed_code: NullableText,
  edition_id: NullableText,
  candidate_keys: NullableTextArray,
  resolved_revision: NullableText,
  resolved_code: NullableText,
  resolved_label: NullableText,
  correction_id: NullableText,
  derived_at: Text,
  anaf_withdrawn: Type.Boolean(),
  onrc_withdrawn: Type.Boolean(),
});

const SupportSchema = Type.Object({
  support_id: Text,
  previous_support_id: NullableText,
  resolution_id: Text,
  refresh_id: Text,
  edition_id: NullableText,
  fiscal_source_snapshot_id: NullableText,
  fiscal_source_hash: NullableText,
  fiscal_status_date: NullableText,
  fiscal_retrieved_at: NullableText,
  fiscal_source_url: NullableText,
  fiscal_raw_capture_id: NullableText,
  fiscal_raw_custody_id: NullableText,
  evidence_custody: NullableText,
  fiscal_time_basis: NullableText,
  fiscal_raw_retrieved_at: NullableText,
  anaf_original_token: NullableText,
  anaf_json_type: NullableText,
  onrc_caen_coverage: NullableText,
  evidence_at: Text,
  anaf_withdrawn: Type.Boolean(),
  onrc_withdrawn: Type.Boolean(),
});

export const mapOutcome = (
  row: Static<typeof OutcomeSchema>
): Result<CompanyMainActivityOutcome, ApiError> => {
  const policy = oneOf(MAIN_ACTIVITY_POLICIES, row.policy_version);
  if (policy === null) return err(malformed(`policy ${row.policy_version}`));
  // The role basis is kept under withdrawal: a v2 legacy outcome stays legacy.
  const basis = oneOf(MAIN_ACTIVITY_ROLE_BASES, row.main_role_basis);
  const status = row.status === null ? null : oneOf(MAIN_ACTIVITY_STATUSES, row.status);
  const matchBasis =
    row.match_basis === null ? null : oneOf(MAIN_ACTIVITY_MATCH_BASES, row.match_basis);
  const revisionBasis =
    row.revision_basis === null ? null : oneOf(MAIN_ACTIVITY_REVISION_BASES, row.revision_basis);
  const jsonType =
    row.anaf_json_type === null ? null : oneOf(MAIN_ACTIVITY_JSON_TYPES, row.anaf_json_type);
  const tokenForm =
    row.anaf_token_form === null ? null : oneOf(MAIN_ACTIVITY_TOKEN_FORMS, row.anaf_token_form);
  if (
    basis === null ||
    !mainRoleBasisAllowed(policy, basis) ||
    (row.status !== null && status === null) ||
    (row.match_basis !== null && matchBasis === null) ||
    (row.revision_basis !== null && revisionBasis === null) ||
    (row.anaf_json_type !== null && jsonType === null) ||
    (row.anaf_token_form !== null && tokenForm === null)
  ) {
    return err(malformed('history outcome'));
  }
  // The interpretation is visible only while both sources are.
  const interpretationVisible = !row.anaf_withdrawn && !row.onrc_withdrawn;
  if ((status !== null) !== interpretationVisible) return err(malformed('history outcome'));
  let resolved: CompanyMainActivityKey | null = null;
  if (status !== null) {
    const key = resolvedKey(row, MAIN_ACTIVITY_SELECTING_STATUSES.includes(status));
    if (key.isErr()) return err(key.error);
    resolved = key.value;
  }
  const candidates = row.candidate_keys === null ? null : parseCandidateKeys(row.candidate_keys);
  if (row.candidate_keys !== null && candidates === null) {
    return err(malformed('history candidate key'));
  }
  return ok({
    resolutionId: row.resolution_id,
    previousResolutionId: row.previous_resolution_id,
    refreshId: row.refresh_id,
    reasons: row.reasons,
    policy,
    basis,
    status,
    revisionBasis,
    matchBasis,
    anaf: row.anaf_withdrawn
      ? null
      : {
          originalToken: publicMainToken(row.anaf_json_type, row.anaf_original_token),
          jsonType,
          tokenForm,
          canonicalDigits: row.anaf_canonical_digits === '' ? null : row.anaf_canonical_digits,
          assumedCode: row.anaf_assumed_code,
        },
    editionId: row.edition_id,
    candidates,
    resolved,
    correctionId: row.correction_id,
    derivedAt: row.derived_at,
    anafWithdrawn: row.anaf_withdrawn,
    onrcWithdrawn: row.onrc_withdrawn,
  });
};

export const mapEvidenceEntry = (
  row: Static<typeof SupportSchema>
): Result<CompanyMainActivityEvidenceEntry, ApiError> => {
  const time = evidenceTimeOf(row);
  const jsonType =
    row.anaf_json_type === null ? null : oneOf(MAIN_ACTIVITY_JSON_TYPES, row.anaf_json_type);
  if (time === null || (row.anaf_json_type !== null && jsonType === null)) {
    return err(malformed('history evidence'));
  }
  // Withdrawn evidence is suppressed, never rebuilt; visible evidence without
  // a source snapshot is exactly the no-source shape (the history carries no
  // status to guess from); with one, a stated, coherent time provenance.
  const problem = row.anaf_withdrawn
    ? withdrawnEvidenceTimeProblem(time)
    : row.fiscal_source_snapshot_id === null
      ? absentEvidenceProblem({
          fiscal_source_hash: row.fiscal_source_hash,
          fiscal_status_date: row.fiscal_status_date,
          fiscal_retrieved_at: row.fiscal_retrieved_at,
          fiscal_source_url: row.fiscal_source_url,
          fiscal_raw_capture_id: row.fiscal_raw_capture_id,
          fiscal_raw_custody_id: row.fiscal_raw_custody_id,
          evidence_custody: row.evidence_custody,
          fiscal_time_basis: row.fiscal_time_basis,
          fiscal_raw_retrieved_at: row.fiscal_raw_retrieved_at,
          anaf_original_token: row.anaf_original_token,
          anaf_json_type: row.anaf_json_type,
        })
      : visibleEvidenceTimeProblem(time);
  if (problem !== null) return err(malformed(`history evidence: ${problem}`));
  return ok({
    supportId: row.support_id,
    previousSupportId: row.previous_support_id,
    resolutionId: row.resolution_id,
    refreshId: row.refresh_id,
    editionId: row.edition_id,
    anaf: row.anaf_withdrawn
      ? null
      : {
          sourceSnapshotId: row.fiscal_source_snapshot_id,
          sourceHash: row.fiscal_source_hash,
          statusDate: row.fiscal_status_date,
          retrievedAt: row.fiscal_retrieved_at,
          // Null exactly for the no-source shape (absentEvidenceProblem).
          timeBasis: time.timeBasis,
          rawRetrievedAt: time.rawRetrievedAt,
          sourceUrl: row.fiscal_source_url,
          rawCaptureId: row.fiscal_raw_capture_id,
          rawCustodyId: row.fiscal_raw_custody_id,
          evidenceCustody: time.custody,
          originalToken: publicMainToken(row.anaf_json_type, row.anaf_original_token),
          jsonType,
        },
    caenCoverage: row.onrc_caen_coverage,
    evidenceAt: row.evidence_at,
    anafWithdrawn: row.anaf_withdrawn,
    onrcWithdrawn: row.onrc_withdrawn,
  });
};

export interface MainHistoryPageRequest {
  readonly kind: CompanyMainActivityHistoryKind;
  /** Exclusive upper id bound (the previous page's last id); null = newest. */
  readonly beforeId: string | null;
  /** Rows to read (page size + 1, to decide `hasNextPage`). */
  readonly limit: number;
}

const mapAll = <R, T>(rows: readonly R[], map: (row: R) => Result<T, ApiError>) => {
  const out: T[] = [];
  for (const row of rows) {
    const mapped = map(row);
    if (mapped.isErr()) return err(mapped.error);
    out.push(mapped.value);
  }
  return ok(out);
};

/**
 * One keyset page of the company's outcome or evidence history, newest
 * first, from the public views (withdrawal applied by the view at read time).
 */
export const readMainActivityHistory = async (
  db: Db,
  cui: string,
  request: MainHistoryPageRequest
): Promise<Result<CompanyMainActivityHistoryRows, ApiError>> => {
  // The previous page's last id bounds the keyset; null = the newest page.
  const before = (column: string) =>
    sql`and (${request.beforeId}::bigint is null or ${sql.ref(column)} < ${request.beforeId}::bigint)`;
  try {
    if (request.kind === 'outcomes') {
      const result = await sql<Record<string, unknown>>`
        select r.resolution_id::text as resolution_id,
               r.previous_resolution_id::text as previous_resolution_id,
               r.refresh_id::text as refresh_id,
               r.reasons, r.policy_version, r.main_role_basis, r.status,
               r.revision_basis, r.match_basis, r.anaf_original_token, r.anaf_json_type,
               r.anaf_token_form, r.anaf_canonical_digits, r.anaf_assumed_code,
               r.edition_id::text as edition_id, r.candidate_keys, r.resolved_revision,
               r.resolved_code, r.resolved_label, r.correction_id::text as correction_id,
               ${isoUtc('r.derived_at')} as derived_at,
               r.anaf_withdrawn, r.onrc_withdrawn
          from companies_v2.main_caen_public_resolutions r
         where r.cui = ${cui} ${before('r.resolution_id')}
         order by r.resolution_id desc
         limit ${request.limit}`.execute(db);
      const rows: Static<typeof OutcomeSchema>[] = [];
      for (const row of result.rows) {
        if (!Value.Check(OutcomeSchema, row)) {
          return err(databaseError('main activity history row is malformed'));
        }
        rows.push(row);
      }
      const outcomes = mapAll(rows, mapOutcome);
      if (outcomes.isErr()) return err(outcomes.error);
      return ok({ state: 'read', outcomes: outcomes.value, evidence: [] });
    }
    const result = await sql<Record<string, unknown>>`
      select s.support_id::text as support_id,
             s.previous_support_id::text as previous_support_id,
             s.resolution_id::text as resolution_id,
             s.refresh_id::text as refresh_id,
             s.edition_id::text as edition_id,
             s.fiscal_source_snapshot_id, s.fiscal_source_hash,
             s.fiscal_status_date::text as fiscal_status_date,
             ${isoUtc('s.fiscal_retrieved_at')} as fiscal_retrieved_at,
             s.fiscal_source_url,
             s.fiscal_raw_capture_id::text as fiscal_raw_capture_id,
             s.fiscal_raw_custody_id::text as fiscal_raw_custody_id,
             s.evidence_custody, s.fiscal_time_basis,
             ${isoUtc('s.fiscal_raw_retrieved_at')} as fiscal_raw_retrieved_at,
             s.anaf_original_token, s.anaf_json_type,
             s.onrc_caen_coverage,
             ${isoUtc('s.evidence_at')} as evidence_at,
             s.anaf_withdrawn, s.onrc_withdrawn
        from companies_v2.main_caen_public_supports s
       where s.cui = ${cui} ${before('s.support_id')}
       order by s.support_id desc
       limit ${request.limit}`.execute(db);
    const rows: Static<typeof SupportSchema>[] = [];
    for (const row of result.rows) {
      if (!Value.Check(SupportSchema, row)) {
        return err(databaseError('main activity history row is malformed'));
      }
      rows.push(row);
    }
    const evidence = mapAll(rows, mapEvidenceEntry);
    if (evidence.isErr()) return err(evidence.error);
    return ok({ state: 'read', outcomes: [], evidence: evidence.value });
  } catch (error) {
    if (isCapabilityError(error)) return ok({ state: 'unavailable' });
    return err(databaseError('main activity history read failed', error));
  }
};

const VisibilityRowSchema = Type.Object({
  id: Text,
  anaf_withdrawn: Type.Boolean(),
  onrc_withdrawn: Type.Boolean(),
});

/**
 * The CURRENT visibility of exact served history rows (by id), read fresh
 * from the same public view: per row its ANAF and ONRC withdrawal. A row the
 * view no longer serves (the company is no longer public) is absent. What a
 * served page's final decision compares; history rows are append-only, so
 * only their visibility can move.
 */
export const readMainActivityHistoryVisibility = async (
  db: Db,
  cui: string,
  kind: CompanyMainActivityHistoryKind,
  ids: readonly string[]
): Promise<Result<ReadonlyMap<string, string> | 'unavailable', ApiError>> => {
  if (ids.length === 0) return ok(new Map());
  try {
    const list = JSON.stringify(ids);
    const result =
      kind === 'outcomes'
        ? await sql<Record<string, unknown>>`
            select r.resolution_id::text as id, r.anaf_withdrawn, r.onrc_withdrawn
              from companies_v2.main_caen_public_resolutions r
             where r.cui = ${cui}
               and r.resolution_id in (select jsonb_array_elements_text(${list}::jsonb)::bigint)`.execute(
            db
          )
        : await sql<Record<string, unknown>>`
            select s.support_id::text as id, s.anaf_withdrawn, s.onrc_withdrawn
              from companies_v2.main_caen_public_supports s
             where s.cui = ${cui}
               and s.support_id in (select jsonb_array_elements_text(${list}::jsonb)::bigint)`.execute(
            db
          );
    const out = new Map<string, string>();
    for (const row of result.rows) {
      if (!Value.Check(VisibilityRowSchema, row)) {
        return err(databaseError('main activity history visibility is malformed'));
      }
      out.set(row.id, `${String(row.anaf_withdrawn)}:${String(row.onrc_withdrawn)}`);
    }
    return ok(out);
  } catch (error) {
    if (isCapabilityError(error)) return ok('unavailable');
    return err(databaseError('main activity history recheck failed', error));
  }
};
