/**
 * Companies repo — ONRC registry edition reads (scrapper migration
 * 20261003T172000). Shell-only SQL over the PUBLIC views:
 *
 *  - `onrc_current_publication` + `companies_analytics.privacy_state`: the
 *    scope capture and the fresh recheck (one statement each);
 *  - `onrc_published_*` with `edition_id` bound to the pinned scope for every
 *    data read. The `onrc_current_*` views are never read: they follow the
 *    pointer per statement, so two reads could see two editions.
 *
 * Never the base tables, never raw tokens, addresses, contacts, manifests or
 * object-store references: the views expose the allowed fields only, and
 * every view rechecks a known non-public core organization at statement
 * time. A missing view or grant (a capability SQLSTATE) is the typed
 * `unavailable` state, never an empty edition and never a legacy fallback.
 *
 * Per-CUI reads filter the identifier/observation views by (edition_id, cui).
 * The migration indexes those relations by their primary keys only
 * (edition_id + row number / identifier key): the reader EXPLAIN at 1-2
 * editions decides whether an index is needed. None is assumed here.
 */

import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { sql, type Kysely, type RawBuilder } from 'kysely';
import { err, ok, type Result } from 'neverthrow';

import {
  databaseError,
  invalidInput,
  isCountyTerritory,
  isUatPresentationTerritory,
  serviceUnavailable,
  type ApiError,
  type FieldFilter,
  type FilterInput,
  type ProdDatabase,
} from '@/modules/shared/index.js';

import { normalizeCountyNeedle, stringValues, isNullValue } from './filter-helpers.js';
import {
  CAEN_CATALOG_SOURCE,
  COMPANY_ACCESS_UNREADABLE_MESSAGE,
  COMPANY_REGISTRY_BASES,
  COMPANY_REGISTRY_COVERAGES,
  REGISTRY_STATE_REASON,
  isPublished,
  parseOnrcCaenSelector,
  unavailableRegistry,
  type CompanyRegistryBasis,
  type CompanyRegistryCaenObservation,
  type CompanyRegistryCoverage,
  type CompanyRegistryCuiProfile,
  type CompanyRegistryEnvelope,
  type CompanyRegistryEvidence,
  type CompanyRegistryIdentifier,
  type CompanyRegistryIdentityObservation,
  type CompanyRegistryProvenance,
  type CompanyRegistryRecheck,
  type CompanyRegistryState,
  type CompanyRegistryStatusObservation,
  type CompanyRegistryValue,
  type OnrcCaenSelector,
} from '../../core/registry.js';

import type {
  CompanyRegistrationEditionSide,
  CompanyRegistrationField,
  CompanyRegistrationValue,
  CompanyRegistryEdition,
} from '../../core/types.js';

type Db = Kysely<ProdDatabase>;

// ─────────────────────────────────────────────────────────────────────────────
// Shared helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * SQLSTATEs that mean "this runtime cannot read the object" (undefined
 * table/column/function/schema/object, insufficient privilege). Anything else
 * is a real error and is never masked as a capability.
 */
const CAPABILITY_SQLSTATES = new Set(['42P01', '42703', '42883', '3F000', '42704', '42501']);

export const isCapabilityError = (error: unknown): boolean => {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && CAPABILITY_SQLSTATES.has(code);
};

/** A text array built from a JSON parameter (no driver array coercion). */
export const textArray = (values: readonly string[]): RawBuilder<string[]> =>
  sql<string[]>`array(select jsonb_array_elements_text(${JSON.stringify(values)}::jsonb))`;

/** `column in (<values>)` over a JSON parameter. */
export const inTextList = (
  column: RawBuilder<unknown>,
  values: readonly string[]
): RawBuilder<boolean> =>
  sql<boolean>`${column} in (select jsonb_array_elements_text(${JSON.stringify(values)}::jsonb))`;

/** The pinned edition id as a typed SQL parameter. */
export const editionParam = (editionId: string): RawBuilder<unknown> => sql`${editionId}::bigint`;

/** Bounds of the per-CUI observation lists (counts are complete on the profile). */
export const IDENTIFIER_LIST_BOUND = 200;
export const OBSERVATION_LIST_BOUND = 500;

/** Romanian diacritic fold for SQL `translate()`; mirrors the kernel TS fold (§15.7). */
export const FOLD_FROM = 'ăâîșşțţĂÂÎȘŞȚŢ';
export const FOLD_TO = 'aaissttaaisstt';

/** Canonical county name of a county code (public county territory), or null. */
export const countyNameOf = (code: RawBuilder<unknown>): RawBuilder<string | null> =>
  sql<string | null>`(select t.county_name from core.territories t
    where t.county_code = ${code} and t.privacy_class = 'public' and ${isCountyTerritory('t')}
    order by t.id limit 1)`;

/** Canonical UAT name of a SIRUTA code (public UAT/locality territory), or null. */
export const uatNameOf = (siruta: RawBuilder<unknown>): RawBuilder<string | null> =>
  sql<string | null>`(select t.name from core.territories t
    where t.siruta_code = ${siruta} and t.privacy_class = 'public'
      and (${isUatPresentationTerritory('t')} or t.level = 'locality')
    order by (t.level = 'uat') desc, t.id limit 1)`;

// ─────────────────────────────────────────────────────────────────────────────
// Scope capture and recheck
// ─────────────────────────────────────────────────────────────────────────────

const NullableText = Type.Union([Type.String(), Type.Null()]);

const CaptureRowSchema = Type.Object({
  publication_state: Type.String(),
  edition_id: NullableText,
  publication_epoch: Type.String(),
  source_snapshot_id: NullableText,
  source_published_at: NullableText,
  interpretation_version: NullableText,
  dimension_policy_version: NullableText,
  eligibility_policy_version: NullableText,
  access_epoch: NullableText,
});

const RecheckRowSchema = Type.Object({
  publication_state: Type.String(),
  edition_id: NullableText,
  publication_epoch: Type.String(),
  access_epoch: NullableText,
  private_cuis: Type.Array(Type.String()),
});

const PrivateOnlyRowSchema = Type.Object({ private_cuis: Type.Array(Type.String()) });

/** The view's state vocabulary → the API's (`unavailable` there = not accessible = `withdrawn`). */
const stateFromView = (state: string, editionId: string | null): CompanyRegistryState | null => {
  if (state === 'published') return editionId === null ? null : 'published';
  if (state === 'unpublished') return 'unpublished';
  if (state === 'unavailable') return 'withdrawn';
  return null;
};

const accessEpochSql = sql<
  string | null
>`(select s.epoch::text from companies_analytics.privacy_state s where s.singleton)`;

/**
 * One statement: the publication envelope, the edition's eligibility policy
 * (from its profiles; the envelope view does not carry it) and the access
 * epoch, with the whole registry read footprint probed (`registryFootprint`).
 * Unreadable, also partially → the typed `unavailable` envelope.
 */
export const captureRegistryScope = async (
  db: Db
): Promise<Result<CompanyRegistryEnvelope, ApiError>> => {
  try {
    const result = await sql<Record<string, unknown>>`
      select c.publication_state,
             c.edition_id::text as edition_id,
             c.publication_epoch::text as publication_epoch,
             c.source_snapshot_id,
             c.source_published_at::text as source_published_at,
             c.interpretation_version,
             c.dimension_policy_version,
             (select pr.eligibility_policy_version
                from companies_v2.onrc_published_profiles pr
               where pr.edition_id = c.edition_id
               limit 1) as eligibility_policy_version,
             ${accessEpochSql} as access_epoch
      from companies_v2.onrc_current_publication c
      where ${registryFootprint}`.execute(db);
    const row = result.rows[0];
    if (result.rows.length !== 1 || !Value.Check(CaptureRowSchema, row)) {
      return err(databaseError('ONRC publication envelope is malformed'));
    }
    const state = stateFromView(row.publication_state, row.edition_id);
    if (state === null) return err(databaseError('ONRC publication state is not recognized'));
    if (row.access_epoch === null) {
      return ok(unavailableRegistry('the company access (privacy) epoch is not readable'));
    }
    const published = state === 'published';
    return ok({
      source: 'onrc',
      state,
      editionId: published ? row.edition_id : null,
      sourceSnapshotId: published ? row.source_snapshot_id : null,
      sourcePublishedAt: published ? row.source_published_at : null,
      interpretationVersion: published ? row.interpretation_version : null,
      dimensionPolicyVersion: published ? row.dimension_policy_version : null,
      eligibilityPolicyVersion: published ? row.eligibility_policy_version : null,
      publicationEpoch: row.publication_epoch,
      accessEpoch: row.access_epoch,
      reason: REGISTRY_STATE_REASON[state],
    });
  } catch (error) {
    if (isCapabilityError(error)) return ok(unavailableRegistry());
    return err(databaseError('ONRC registry scope capture failed', error));
  }
};

/**
 * The fresh recheck: the current publication, access epoch and read
 * footprint plus the returned CUIs whose KNOWN core organization is not
 * public (a NULL class fails closed), in one statement. The two halves fail
 * differently:
 *  - the ONRC half is optional: unreadable (publication, epoch or footprint)
 *    reads as `current: null`, a scope that no longer holds;
 *  - the parent-privacy half is mandatory: it is then read on its own, and
 *    an unreadable organizations check is an error, never an empty list.
 * For an `unavailable` scope only the organizations are read (nothing ONRC
 * was served).
 */
export const confirmRegistryScope = async (
  db: Db,
  scope: CompanyRegistryEnvelope,
  cuis: readonly string[]
): Promise<Result<CompanyRegistryRecheck, ApiError>> => {
  const returned = [...new Set(cuis)];
  const privateCuis = sql<string[]>`array(
    select o.cui from core.organizations o
    where ${inTextList(sql`o.cui`, returned)}
      and o.privacy_class is distinct from 'public'
    order by o.cui)`;
  const readPrivateCuis = async (): Promise<Result<readonly string[], ApiError>> => {
    // No returned CUI: no parent whose privacy must be established.
    if (returned.length === 0) return ok([]);
    try {
      const result = await sql<
        Record<string, unknown>
      >`select ${privateCuis} as private_cuis`.execute(db);
      const row = result.rows[0];
      if (!Value.Check(PrivateOnlyRowSchema, row)) {
        return err(databaseError('company access recheck is malformed'));
      }
      return ok(row.private_cuis);
    } catch (error) {
      return err(
        isCapabilityError(error)
          ? serviceUnavailable(COMPANY_ACCESS_UNREADABLE_MESSAGE)
          : databaseError('company access recheck failed', error)
      );
    }
  };
  const withoutPublication = async (): Promise<Result<CompanyRegistryRecheck, ApiError>> =>
    (await readPrivateCuis()).map((p) => ({ current: null, privateCuis: p }));

  if (scope.state === 'unavailable') return withoutPublication();
  try {
    const result = await sql<Record<string, unknown>>`
      select c.publication_state,
             c.edition_id::text as edition_id,
             c.publication_epoch::text as publication_epoch,
             ${accessEpochSql} as access_epoch,
             ${privateCuis} as private_cuis
      from companies_v2.onrc_current_publication c
      where ${registryFootprint}`.execute(db);
    const row = result.rows[0];
    if (result.rows.length !== 1 || !Value.Check(RecheckRowSchema, row)) {
      return err(databaseError('ONRC publication recheck is malformed'));
    }
    const state = stateFromView(row.publication_state, row.edition_id);
    return ok({
      current:
        state === null
          ? null
          : {
              state,
              editionId: state === 'published' ? row.edition_id : null,
              publicationEpoch: row.publication_epoch,
              accessEpoch: row.access_epoch,
            },
      privateCuis: row.private_cuis,
    });
  } catch (error) {
    if (!isCapabilityError(error)) return err(databaseError('ONRC registry recheck failed', error));
    // The registry (publication, epoch or footprint) or the organizations
    // became unreadable after the pin: the scope no longer holds, and the
    // mandatory privacy half is read on its own (refused if unreadable).
    return withoutPublication();
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Row → evidence mapping (defensive: an unknown vocabulary value fails closed)
// ─────────────────────────────────────────────────────────────────────────────

const asBasis = (value: string): CompanyRegistryBasis =>
  (COMPANY_REGISTRY_BASES as readonly string[]).includes(value)
    ? (value as CompanyRegistryBasis)
    : 'unresolved';

const asCoverage = (value: string): CompanyRegistryCoverage =>
  (COMPANY_REGISTRY_COVERAGES as readonly string[]).includes(value)
    ? (value as CompanyRegistryCoverage)
    : 'unresolved';

/** A value with its basis; a basis that admits no value never carries one. */
export const basisValue = (value: string | null, basis: string): CompanyRegistryValue => {
  const b = asBasis(basis);
  const admits =
    b === 'single_observation' || b === 'consistent_observations' || b === 'partial_observations';
  return { value: admits ? value : null, basis: b };
};

/** The profile columns every registry-bearing statement selects (alias `p`, territory names included). */
export const profileColumns = sql`
  p.cui as p_cui,
  p.identity_observations as p_identity_observations,
  p.identifier_count as p_identifier_count,
  p.unresolved_identifier_count as p_unresolved_identifier_count,
  p.unidentified_observations as p_unidentified_observations,
  p.name as p_name, p.name_basis as p_name_basis,
  p.legal_form as p_legal_form, p.legal_form_basis as p_legal_form_basis,
  p.recorded_date::text as p_recorded_date, p.recorded_date_basis as p_recorded_date_basis,
  p.county_code as p_county_code, p.county_basis as p_county_basis,
  ${countyNameOf(sql`p.county_code`)} as p_county_name,
  p.uat_siruta_code as p_uat_siruta_code, p.uat_basis as p_uat_basis,
  ${uatNameOf(sql`p.uat_siruta_code`)} as p_uat_name,
  p.status_code as p_status_code, p.status_basis as p_status_basis,
  p.caen_coverage as p_caen_coverage, p.status_coverage as p_status_coverage,
  p.legal_person_eligibility as p_legal_person_eligibility,
  p.eligibility_reason as p_eligibility_reason,
  p.eligibility_policy_version as p_eligibility_policy_version`;

/** The same column names, all NULL, for statements without a published edition. */
export const noProfileColumns = sql`
  null::text as p_cui, null::int as p_identity_observations, null::int as p_identifier_count,
  null::int as p_unresolved_identifier_count, null::int as p_unidentified_observations,
  null::text as p_name, null::text as p_name_basis, null::text as p_legal_form,
  null::text as p_legal_form_basis, null::text as p_recorded_date, null::text as p_recorded_date_basis,
  null::text as p_county_code, null::text as p_county_basis, null::text as p_county_name,
  null::text as p_uat_siruta_code, null::text as p_uat_basis, null::text as p_uat_name,
  null::text as p_status_code, null::text as p_status_basis, null::text as p_caen_coverage,
  null::text as p_status_coverage, null::text as p_legal_person_eligibility,
  null::text as p_eligibility_reason, null::text as p_eligibility_policy_version`;

/** `left join` of the pinned edition's profile (alias `p`) onto the spine `o`. */
export const profileJoin = (editionId: string): RawBuilder<unknown> =>
  sql`left join companies_v2.onrc_published_profiles p
        on p.edition_id = ${editionParam(editionId)} and p.cui = o.cui`;

export interface ProfileColumnsRow {
  p_cui: string | null;
  p_identity_observations: number | null;
  p_identifier_count: number | null;
  p_unresolved_identifier_count: number | null;
  p_unidentified_observations: number | null;
  p_name: string | null;
  p_name_basis: string | null;
  p_legal_form: string | null;
  p_legal_form_basis: string | null;
  p_recorded_date: string | null;
  p_recorded_date_basis: string | null;
  p_county_code: string | null;
  p_county_basis: string | null;
  p_county_name: string | null;
  p_uat_siruta_code: string | null;
  p_uat_basis: string | null;
  p_uat_name: string | null;
  p_status_code: string | null;
  p_status_basis: string | null;
  p_caen_coverage: string | null;
  p_status_coverage: string | null;
  p_legal_person_eligibility: string | null;
  p_eligibility_reason: string | null;
  p_eligibility_policy_version: string | null;
}

/** The qualified profile carried by a row, or null when the CUI has none in the edition. */
export const profileFromRow = (row: ProfileColumnsRow): CompanyRegistryCuiProfile | null => {
  // No profile column at all reads as no profile (fail closed).
  if ((row.p_cui ?? null) === null) return null;
  const eligibility = row.p_legal_person_eligibility;
  const county = basisValue(row.p_county_code, row.p_county_basis ?? 'unresolved');
  const uat = basisValue(row.p_uat_siruta_code, row.p_uat_basis ?? 'unresolved');
  return {
    identityObservations: row.p_identity_observations ?? 0,
    identifierCount: row.p_identifier_count ?? 0,
    unresolvedIdentifierCount: row.p_unresolved_identifier_count ?? 0,
    unidentifiedObservations: row.p_unidentified_observations ?? 0,
    name: basisValue(row.p_name, row.p_name_basis ?? 'unresolved'),
    legalForm: basisValue(row.p_legal_form, row.p_legal_form_basis ?? 'unresolved'),
    recordedDate: basisValue(row.p_recorded_date, row.p_recorded_date_basis ?? 'unresolved'),
    countyCode: county,
    countyName: county.value === null ? null : row.p_county_name,
    uatSirutaCode: uat,
    uatName: uat.value === null ? null : row.p_uat_name,
    statusCode: basisValue(row.p_status_code, row.p_status_basis ?? 'unresolved'),
    caenCoverage: asCoverage(row.p_caen_coverage ?? 'unresolved'),
    statusCoverage: asCoverage(row.p_status_coverage ?? 'unresolved'),
    legalPersonEligibility:
      eligibility === 'eligible' || eligibility === 'excluded' ? eligibility : 'unresolved',
    eligibilityReason: row.p_eligibility_reason,
    eligibilityPolicyVersion: row.p_eligibility_policy_version ?? '',
  };
};

interface ProvenanceRow {
  source_row_number: number;
  resource_key: string;
  source_row_sha256: string;
  source_url: string | null;
  source_file_sha256: string | null;
  source_published_at: string | null;
}

const provenanceOf = (row: ProvenanceRow): CompanyRegistryProvenance => ({
  resourceKey: row.resource_key,
  sourceRowNumber: row.source_row_number,
  sourceRowSha256: row.source_row_sha256,
  sourceUrl: row.source_url,
  sourceFileSha256: row.source_file_sha256,
  sourcePublishedAt: row.source_published_at,
});

const observationId = (editionId: string, row: ProvenanceRow): string =>
  `${editionId}:${row.resource_key}:${String(row.source_row_number)}`;

const provenanceColumns = (alias: string) => sql`
  ${sql.ref(`${alias}.source_row_number`)} as source_row_number,
  ${sql.ref(`${alias}.resource_key`)} as resource_key,
  ${sql.ref(`${alias}.source_row_sha256`)} as source_row_sha256,
  ${sql.ref(`${alias}.source_url`)} as source_url,
  ${sql.ref(`${alias}.source_file_sha256`)} as source_file_sha256,
  ${sql.ref(`${alias}.source_published_at`)}::text as source_published_at`;

interface IdentifierRow {
  identifier_key: string;
  identity_row_count: number;
  status_codes: string[];
  has_active_observation: boolean;
  status_summary_code: string | null;
  status_summary_basis: string;
  status_observations: number;
  unparsed_status_observations: number;
  county_codes: string[];
  county_basis: string;
  caen_observations: number;
  unparsed_caen_observations: number;
  unknown_revision_caen_observations: number;
}

interface IdentityRow extends ProvenanceRow {
  identifier_key: string | null;
  name: string | null;
  euid: string | null;
  legal_form: string | null;
  recorded_date: string | null;
  recorded_date_state: string;
  county_code: string | null;
  uat_siruta_code: string | null;
}

interface CaenRow extends ProvenanceRow {
  identifier_key: string;
  caen_parse_state: string;
  caen_code: string | null;
  caen_revision_state: string;
  caen_revision: string | null;
  catalog_label: string | null;
  catalog_system: string | null;
}

interface StatusRow extends ProvenanceRow {
  identifier_key: string;
  status_parse_state: string;
  status_code: string | null;
  status_label: string | null;
  status_label_source: string | null;
}

/** The columns each per-CUI evidence statement selects (one definition: read and footprint). */
const identifierColumns = sql`
  i.identifier_key, i.identity_row_count, i.status_codes, i.has_active_observation,
  i.status_summary_code, i.status_summary_basis, i.status_observations,
  i.unparsed_status_observations, i.county_codes, i.county_basis, i.caen_observations,
  i.unparsed_caen_observations, i.unknown_revision_caen_observations`;
const identityColumns = sql`
  o.identifier_key, o.name, o.euid, o.legal_form, o.recorded_date::text as recorded_date,
  o.recorded_date_state, o.county_code, o.uat_siruta_code, ${provenanceColumns('o')}`;
const caenColumns = sql`
  c.identifier_key, c.caen_parse_state, c.caen_code, c.caen_revision_state, c.caen_revision,
  ${provenanceColumns('c')}`;
const statusColumns = sql`
  s.identifier_key, s.status_parse_state, s.status_code, s.status_label,
  s.status_label_source, ${provenanceColumns('s')}`;

/**
 * The registry read footprint as one predicate that reads no row: every
 * published view the reads select from, with the columns they select (the
 * profile's territory names and the CAEN catalog join included), each under
 * `where false`. Parsing resolves every relation and column, and the
 * executor checks the privilege of every relation of the statement, also in
 * a subquery the planner proves empty. The capture and the recheck carry it:
 * a missing view, column or grant anywhere in the footprint pins
 * `unavailable` (or moves a pinned scope) instead of a published pin whose
 * reads then fail half-way.
 */
const registryFootprint = sql<boolean>`
  not exists (select ${profileColumns} from companies_v2.onrc_published_profiles p where false)
  and not exists (select ${identifierColumns}
    from companies_v2.onrc_published_identifier_profiles i where false)
  and not exists (select ${identityColumns}
    from companies_v2.onrc_published_identity_observations o where false)
  and not exists (select ${caenColumns}, cc.label, cc.system
    from companies_v2.onrc_published_caen_observations c
    cross join core.classification_codes cc where false)
  and not exists (select ${statusColumns}
    from companies_v2.onrc_published_status_observations s where false)
  and not exists (select e.edition_id, e.source_snapshot_id, e.source_published_at,
      e.interpretation_version, e.dimension_policy_version
    from companies_v2.onrc_published_editions e where false)`;

/**
 * The CAEN observations of one CUI in the pinned edition, each with the
 * current database catalog label of its OWN known revision (none for an
 * unknown revision; never a cross-revision fallback).
 */
export const readCaenObservations = async (
  db: Db,
  editionId: string,
  cui: string
): Promise<{ rows: CompanyRegistryCaenObservation[]; truncated: boolean }> => {
  const result = await sql<CaenRow>`
    select ${caenColumns},
           cat.label as catalog_label, cat.system as catalog_system
    from companies_v2.onrc_published_caen_observations c
    left join lateral (
      select cc.label, cc.system from core.classification_codes cc
      where c.caen_revision is not null and cc.system = 'caen_' || c.caen_revision and cc.code = c.caen_code
      limit 1
    ) cat on true
    where c.edition_id = ${editionParam(editionId)} and c.cui = ${cui}
    order by c.source_row_number
    limit ${OBSERVATION_LIST_BOUND + 1}`.execute(db);
  const truncated = result.rows.length > OBSERVATION_LIST_BOUND;
  return {
    truncated,
    rows: result.rows.slice(0, OBSERVATION_LIST_BOUND).map((row) => ({
      id: observationId(editionId, row),
      identifierKey: row.identifier_key,
      parseState: row.caen_parse_state,
      code: row.caen_code,
      revisionState: row.caen_revision_state,
      revision: row.caen_revision,
      catalogLabel:
        row.catalog_label !== null && row.catalog_system !== null && row.caen_revision !== null
          ? { label: row.catalog_label, system: row.catalog_system, source: CAEN_CATALOG_SOURCE }
          : null,
      provenance: provenanceOf(row),
    })),
  };
};

/**
 * Registry evidence of one CUI in the pinned edition: profile (with
 * territory names), identifiers and the three bounded observation lists.
 * Not published → the envelope state only, no view touched. Any failed
 * statement rejects the whole evidence (never a partial set); the caller
 * maps a capability failure to a moved scope.
 */
export const readRegistryEvidence = async (
  db: Db,
  scope: CompanyRegistryEnvelope,
  cui: string,
  isQualifiedCui: boolean
): Promise<CompanyRegistryEvidence> => {
  if (!isPublished(scope)) {
    return {
      registry: scope,
      cuiState: scope.state === 'published' ? 'not_in_edition' : scope.state,
      profile: null,
      identifiers: [],
      identityObservations: [],
      caenObservations: [],
      statusObservations: [],
      observationsTruncated: false,
    };
  }
  const editionId = scope.editionId;
  // A CUI outside the edition's qualified namespace is never linked to edition evidence.
  if (!isQualifiedCui) {
    return {
      registry: scope,
      cuiState: 'not_in_edition',
      profile: null,
      identifiers: [],
      identityObservations: [],
      caenObservations: [],
      statusObservations: [],
      observationsTruncated: false,
    };
  }
  const edition = editionParam(editionId);
  const [profileRes, identifierRes, identityRes, caen, statusRes] = await Promise.all([
    sql<ProfileColumnsRow>`
      select ${profileColumns}
      from companies_v2.onrc_published_profiles p
      where p.edition_id = ${edition} and p.cui = ${cui}`.execute(db),
    sql<IdentifierRow>`
      select ${identifierColumns}
      from companies_v2.onrc_published_identifier_profiles i
      where i.edition_id = ${edition} and i.cui = ${cui}
      order by i.identifier_key collate "C"
      limit ${IDENTIFIER_LIST_BOUND + 1}`.execute(db),
    sql<IdentityRow>`
      select ${identityColumns}
      from companies_v2.onrc_published_identity_observations o
      where o.edition_id = ${edition} and o.cui = ${cui}
      order by o.source_row_number
      limit ${OBSERVATION_LIST_BOUND + 1}`.execute(db),
    readCaenObservations(db, editionId, cui),
    sql<StatusRow>`
      select ${statusColumns}
      from companies_v2.onrc_published_status_observations s
      where s.edition_id = ${edition} and s.cui = ${cui}
      order by s.source_row_number
      limit ${OBSERVATION_LIST_BOUND + 1}`.execute(db),
  ]);
  const profileRow = profileRes.rows[0];
  const profile = profileRow === undefined ? null : profileFromRow(profileRow);
  const identifiers: CompanyRegistryIdentifier[] = identifierRes.rows
    .slice(0, IDENTIFIER_LIST_BOUND)
    .map((row) => ({
      id: `${editionId}:${row.identifier_key}`,
      identifierKey: row.identifier_key,
      identityRowCount: row.identity_row_count,
      statusCodes: [...row.status_codes].sort(),
      hasActiveObservation: row.has_active_observation,
      statusSummaryCode: row.status_summary_code,
      statusSummaryBasis: row.status_summary_basis,
      statusObservations: row.status_observations,
      unparsedStatusObservations: row.unparsed_status_observations,
      countyCodes: [...row.county_codes].sort(),
      countyBasis: row.county_basis,
      caenObservations: row.caen_observations,
      unparsedCaenObservations: row.unparsed_caen_observations,
      unknownRevisionCaenObservations: row.unknown_revision_caen_observations,
    }));
  const identityObservations: CompanyRegistryIdentityObservation[] = identityRes.rows
    .slice(0, OBSERVATION_LIST_BOUND)
    .map((row) => ({
      id: observationId(editionId, row),
      identifierKey: row.identifier_key,
      name: row.name,
      euid: row.euid,
      legalForm: row.legal_form,
      recordedDate: row.recorded_date,
      recordedDateState: row.recorded_date_state,
      countyCode: row.county_code,
      uatSirutaCode: row.uat_siruta_code,
      provenance: provenanceOf(row),
    }));
  const statusObservations: CompanyRegistryStatusObservation[] = statusRes.rows
    .slice(0, OBSERVATION_LIST_BOUND)
    .map((row) => ({
      id: observationId(editionId, row),
      identifierKey: row.identifier_key,
      parseState: row.status_parse_state,
      code: row.status_code,
      label: row.status_label,
      labelSource: row.status_label_source,
      provenance: provenanceOf(row),
    }));
  return {
    registry: scope,
    cuiState: profile === null ? 'not_in_edition' : 'in_edition',
    profile,
    identifiers,
    identityObservations,
    caenObservations: caen.rows,
    statusObservations,
    observationsTruncated:
      identifierRes.rows.length > IDENTIFIER_LIST_BOUND ||
      identityRes.rows.length > OBSERVATION_LIST_BOUND ||
      caen.truncated ||
      statusRes.rows.length > OBSERVATION_LIST_BOUND,
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// Filter compilation (edition-bound, same-identifier)
// ─────────────────────────────────────────────────────────────────────────────

const fieldOfRecord = (
  record: Readonly<Record<string, unknown>>,
  name: string
): FieldFilter | undefined => {
  const value = record[name];
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as FieldFilter)
    : undefined;
};

const valuesOf = (f: FieldFilter | undefined): readonly string[] => {
  const { eq, in: inV } = stringValues(f);
  return [...(eq !== undefined ? [eq] : []), ...(inV ?? [])];
};

/**
 * County codes for a county filter value list: an exact county code or a
 * diacritic-folded county name of a PUBLIC county territory.
 */
const countyCodesFor = (values: readonly string[]): RawBuilder<string[]> => {
  const codes = values.map((v) => v.trim().toUpperCase());
  const names = values.map((v) => normalizeCountyNeedle(v));
  return sql<string[]>`array(
    select distinct t.county_code from core.territories t
    where t.privacy_class = 'public' and t.county_code is not null and ${isCountyTerritory('t')}
      and (${inTextList(sql`t.county_code`, codes)}
        or ${inTextList(
          sql`regexp_replace(lower(translate(t.county_name, ${FOLD_FROM}, ${FOLD_TO})), '^(judetul|municipiul) ', '')`,
          names
        )}))`;
};

/** CAEN code predicates (eq / in / prefix) on a caen observation alias. */
const caenCodePredicate = (
  alias: string,
  f: FieldFilter | undefined
): RawBuilder<boolean> | null => {
  if (f === undefined) return null;
  const { eq, in: inV, prefix } = stringValues(f);
  const column = sql.ref(`${alias}.caen_code`);
  const preds: RawBuilder<unknown>[] = [];
  const exact = [...(eq !== undefined ? [eq] : []), ...(inV ?? [])];
  if (exact.length > 0) preds.push(inTextList(column, exact));
  if (prefix !== undefined) {
    const esc = prefix.replace(/[\\%_]/gu, (m) => `\\${m}`);
    preds.push(sql`${column} like ${esc + '%'} escape '\\'`);
  }
  return preds.length === 0 ? null : sql<boolean>`(${sql.join(preds, sql` or `)})`;
};

/** Exact (revision, code) predicates on a caen observation alias. */
const onrcCaenPredicate = (
  alias: string,
  selectors: readonly OnrcCaenSelector[]
): RawBuilder<boolean> | null => {
  if (selectors.length === 0) return null;
  const pairs = JSON.stringify(selectors.map((s) => ({ revision: s.revision, code: s.code })));
  return sql<boolean>`exists (select 1 from jsonb_to_recordset(${pairs}::jsonb) as k(revision text, code text)
    where k.revision = ${sql.ref(`${alias}.caen_revision`)} and k.code = ${sql.ref(`${alias}.caen_code`)})`;
};

const parseSelectors = (
  f: FieldFilter | undefined,
  field: string
): Result<readonly OnrcCaenSelector[], ApiError> => {
  const out: OnrcCaenSelector[] = [];
  for (const raw of valuesOf(f)) {
    const parsed = parseOnrcCaenSelector(raw);
    if (parsed === null) {
      return err(
        invalidInput(
          `${field} must be '<revision>:<code>' with revision rev0..rev3 and a 4-digit code (e.g. rev2:6201)`,
          field
        )
      );
    }
    out.push(parsed);
  }
  return ok(out);
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/u;

const COMPLETE_COVERAGE = sql`('complete', 'complete_empty')`;
const COMPLETE_BASES = sql`('single_observation', 'consistent_observations')`;

export interface RegistryConditions {
  /** WHERE conditions over the spine `o` and the pinned profile `p`. */
  readonly conds: readonly RawBuilder<unknown>[];
  /**
   * The positive same-identifier predicate over alias `i` (and its CAEN
   * observations), reused by the CAEN facet; null when no identifier criterion.
   */
  readonly identifierPredicate: RawBuilder<boolean> | null;
}

/**
 * Compile the edition-bound filter fields. Positive status/county/caenCode/
 * onrcCaen become ONE semijoin over the identifier profiles: all must hold on
 * the same resolved identifier. Profile scalars use `p`. Every negative or
 * absence form requires complete evidence.
 */
export const registryConditions = (
  input: FilterInput,
  editionId: string
): Result<RegistryConditions, ApiError> => {
  const edition = editionParam(editionId);
  const conds: RawBuilder<unknown>[] = [];
  const idPreds: RawBuilder<unknown>[] = [];

  const status = valuesOf(fieldOfRecord(input, 'status'));
  if (status.length > 0) idPreds.push(sql`i.status_codes && ${textArray(status)}`);

  const county = valuesOf(fieldOfRecord(input, 'county'));
  if (county.length > 0) idPreds.push(sql`i.county_codes && ${countyCodesFor(county)}`);

  const caen = caenCodePredicate('c', fieldOfRecord(input, 'caenCode'));
  const selectors = parseSelectors(fieldOfRecord(input, 'onrcCaen'), 'onrcCaen');
  if (selectors.isErr()) return err(selectors.error);
  const exact = onrcCaenPredicate('c', selectors.value);
  for (const pred of [caen, exact]) {
    if (pred === null) continue;
    idPreds.push(sql`exists (select 1 from companies_v2.onrc_published_caen_observations c
      where c.edition_id = i.edition_id and c.identifier_key = i.identifier_key
        and c.cui = i.cui and ${pred})`);
  }

  const identifierPredicate =
    idPreds.length === 0 ? null : sql<boolean>`(${sql.join(idPreds, sql` and `)})`;
  if (identifierPredicate !== null) {
    conds.push(sql`o.cui in (select i.cui from companies_v2.onrc_published_identifier_profiles i
      where i.edition_id = ${edition} and ${identifierPredicate})`);
  }

  const legalForms = valuesOf(fieldOfRecord(input, 'legalForm'));
  if (legalForms.length > 0) conds.push(inTextList(sql`p.legal_form`, legalForms));

  const between = fieldOfRecord(input, 'registrationDate')?.['between'];
  if (between !== undefined) {
    const range = between as { from?: unknown; to?: unknown };
    for (const [bound, op] of [
      [range.from, sql`>=`],
      [range.to, sql`<=`],
    ] as const) {
      if (bound === undefined || bound === null) continue;
      if (typeof bound !== 'string' || !ISO_DATE.test(bound)) {
        return err(invalidInput('registrationDate bounds must be YYYY-MM-DD', 'registrationDate'));
      }
      conds.push(sql`p.recorded_date ${op} ${bound}::date`);
    }
  }

  const present = isNullValue(fieldOfRecord(input, 'registrationDatePresent'));
  if (present !== undefined) {
    // isNull:true = the absence is complete evidence (basis missing); a
    // conflicting or unresolved date answers neither.
    conds.push(present ? sql`p.recorded_date_basis = 'missing'` : sql`p.recorded_date is not null`);
  }

  // ── negatives: complete evidence only ──
  const exclude = (input.exclude ?? {}) as Readonly<Record<string, unknown>>;
  const exStatus = valuesOf(fieldOfRecord(exclude, 'status'));
  if (exStatus.length > 0) {
    conds.push(sql`p.status_coverage in ${COMPLETE_COVERAGE} and not exists (
      select 1 from companies_v2.onrc_published_identifier_profiles ix
      where ix.edition_id = ${edition} and ix.cui = o.cui and ix.status_codes && ${textArray(exStatus)})`);
  }
  const exCounty = valuesOf(fieldOfRecord(exclude, 'county'));
  if (exCounty.length > 0) {
    conds.push(
      sql`p.county_code is not null and p.county_basis in ${COMPLETE_BASES}
        and not (p.county_code = any(${countyCodesFor(exCounty)}))`
    );
  }
  const exCaen = caenCodePredicate('cx', fieldOfRecord(exclude, 'caenCode'));
  const exSelectors = parseSelectors(fieldOfRecord(exclude, 'onrcCaen'), 'exclude.onrcCaen');
  if (exSelectors.isErr()) return err(exSelectors.error);
  const exExact = onrcCaenPredicate('cx', exSelectors.value);
  for (const pred of [exCaen, exExact]) {
    if (pred === null) continue;
    conds.push(sql`p.caen_coverage in ${COMPLETE_COVERAGE} and not exists (
      select 1 from companies_v2.onrc_published_caen_observations cx
      where cx.edition_id = ${edition} and cx.cui = o.cui and ${pred})`);
  }
  const exLegal = valuesOf(fieldOfRecord(exclude, 'legalForm'));
  if (exLegal.length > 0) {
    conds.push(
      sql`p.legal_form is not null and p.legal_form_basis in ${COMPLETE_BASES}
        and not (${inTextList(sql`p.legal_form`, exLegal)})`
    );
  }
  return ok({ conds, identifierPredicate });
};

/** CUIs of the page with ANY public original 1048 on a resolved identifier of the edition. */
export const readActiveCuis = async (
  db: Db,
  editionId: string,
  cuis: readonly string[]
): Promise<ReadonlySet<string>> => {
  if (cuis.length === 0) return new Set();
  const result = await sql<{ cui: string }>`
    select distinct i.cui from companies_v2.onrc_published_identifier_profiles i
    where i.edition_id = ${editionParam(editionId)} and i.has_active_observation
      and ${inTextList(sql`i.cui`, cuis)}`.execute(db);
  return new Set(result.rows.map((r) => r.cui));
};

/** Qualified edition names of spine CUIs (for name-resolution labels). */
export const readQualifiedNames = async (
  db: Db,
  editionId: string,
  cuis: readonly string[]
): Promise<ReadonlyMap<string, string>> => {
  if (cuis.length === 0) return new Map();
  const result = await sql<{ cui: string; name: string }>`
    select p.cui, p.name from companies_v2.onrc_published_profiles p
    where p.edition_id = ${editionParam(editionId)} and p.name is not null
      and ${inTextList(sql`p.cui`, cuis)}`.execute(db);
  return new Map(result.rows.map((r) => [r.cui, r.name]));
};

// ─────────────────────────────────────────────────────────────────────────────
// Editions (capabilities, diff)
// ─────────────────────────────────────────────────────────────────────────────

const EDITION_LIST_BOUND = 50;

export const readPublishedEditions = async (
  db: Db,
  scope: CompanyRegistryEnvelope
): Promise<readonly CompanyRegistryEdition[]> => {
  if (!isPublished(scope)) return [];
  const result = await sql<{
    edition_id: string;
    source_snapshot_id: string;
    source_published_at: string | null;
    interpretation_version: string;
    dimension_policy_version: string;
  }>`
    select e.edition_id::text as edition_id, e.source_snapshot_id,
           e.source_published_at::text as source_published_at,
           e.interpretation_version, e.dimension_policy_version
    from companies_v2.onrc_published_editions e
    order by e.source_published_at desc nulls last, e.edition_id desc
    limit ${EDITION_LIST_BOUND}`.execute(db);
  return result.rows.map((row) => ({
    editionId: row.edition_id,
    sourceSnapshotId: row.source_snapshot_id,
    sourcePublishedAt: row.source_published_at,
    interpretationVersion: row.interpretation_version,
    dimensionPolicyVersion: row.dimension_policy_version,
    current: row.edition_id === scope.editionId,
  }));
};

/**
 * Bound of the distinct public (edition, field, value) triples one diff reads
 * across its two editions. Duplicate observations never consume it (DISTINCT
 * in SQL); past it the sides are incomplete and never compared.
 */
export const DIFF_VALUE_BOUND = 1000;

const DIFF_FIELDS: readonly CompanyRegistrationField[] = [
  'legalName',
  'legalForm',
  'county',
  'locality',
];

const isDiffField = (field: string): field is CompanyRegistrationField =>
  (DIFF_FIELDS as readonly string[]).includes(field);

const emptyValues = (): Record<CompanyRegistrationField, CompanyRegistrationValue[]> => ({
  legalName: [],
  legalForm: [],
  county: [],
  locality: [],
});

const pushDistinct = (
  list: CompanyRegistrationValue[],
  key: string | null,
  display: string | null
) => {
  if (key === null) return;
  if (list.some((v) => v.key === key)) return;
  list.push({ key, display: display ?? key });
};

/**
 * The pinned edition and the newest accessible published edition with an
 * EARLIER source date, each with the CUI's distinct public identity values.
 * `earlier` is null for the first (or an undated) edition: no comparison,
 * never a disappearance.
 *
 * The values are COMPLETE distinct sets per edition and field, deduplicated
 * in SQL, so duplicate observations of one edition never crowd out the other
 * edition or a later conflicting value. Past `DIFF_VALUE_BOUND` distinct
 * values (sentinel row) both sides carry no values and `valuesComplete:
 * false`: an unread value is never a missing one. Geography is compared by
 * code and displayed with the territory hub's canonical name.
 */
export const readDiffSides = async (
  db: Db,
  scope: CompanyRegistryEnvelope & { readonly editionId: string },
  cui: string
): Promise<{
  later: CompanyRegistrationEditionSide;
  earlier: CompanyRegistrationEditionSide | null;
}> => {
  const edition = editionParam(scope.editionId);
  const prev = await sql<{ edition_id: string; source_published_at: string | null }>`
    select e.edition_id::text as edition_id, e.source_published_at::text as source_published_at
    from companies_v2.onrc_published_editions e
    where e.edition_id <> ${edition}
      and e.source_published_at < (
        select x.source_published_at from companies_v2.onrc_published_editions x
        where x.edition_id = ${edition})
    order by e.source_published_at desc, e.edition_id desc
    limit 1`.execute(db);
  const earlierMeta = prev.rows[0];
  const editions = [
    scope.editionId,
    ...(earlierMeta === undefined ? [] : [earlierMeta.edition_id]),
  ];
  const editionList = sql.join(editions.map(editionParam));
  const [presence, distinctValues] = await Promise.all([
    sql<{ edition_id: string }>`
      select p.edition_id::text as edition_id from companies_v2.onrc_published_profiles p
      where p.edition_id in (${editionList}) and p.cui = ${cui}`.execute(db),
    sql<{ edition_id: string; field: string; key: string; display: string | null }>`
      select v.edition_id::text as edition_id, v.field, v.key,
             case v.field
               when 'county' then ${countyNameOf(sql`v.key`)}
               when 'locality' then ${uatNameOf(sql`v.key`)}
             end as display
      from (
        select distinct o.edition_id, x.field, x.key
        from companies_v2.onrc_published_identity_observations o
        cross join lateral (values
          ('legalName', o.name), ('legalForm', o.legal_form),
          ('county', o.county_code), ('locality', o.uat_siruta_code)) as x(field, key)
        where o.edition_id in (${editionList}) and o.cui = ${cui} and x.key is not null
      ) v
      order by v.edition_id, v.field, v.key
      limit ${DIFF_VALUE_BOUND + 1}`.execute(db),
  ]);
  const present = new Set(presence.rows.map((r) => r.edition_id));
  const valuesComplete = distinctValues.rows.length <= DIFF_VALUE_BOUND;
  const side = (
    editionId: string,
    sourcePublishedAt: string | null
  ): CompanyRegistrationEditionSide => {
    const values = emptyValues();
    // An incomplete read carries no values at all: never a partial set.
    for (const row of valuesComplete ? distinctValues.rows : []) {
      if (row.edition_id !== editionId || !isDiffField(row.field)) continue;
      pushDistinct(values[row.field], row.key, row.display);
    }
    for (const list of Object.values(values)) list.sort((a, b) => a.key.localeCompare(b.key));
    return {
      editionId,
      sourcePublishedAt,
      inEdition: present.has(editionId),
      values,
      valuesComplete,
    };
  };
  return {
    later: side(scope.editionId, scope.sourcePublishedAt),
    earlier:
      earlierMeta === undefined
        ? null
        : side(earlierMeta.edition_id, earlierMeta.source_published_at),
  };
};
