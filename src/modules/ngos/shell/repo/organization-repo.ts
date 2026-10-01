import { sql, type Kysely, type Transaction } from 'kysely';
import { Result, err, ok } from 'neverthrow';

import {
  databaseError,
  invalidInput,
  timeoutError,
  type ApiError,
  type ProdDatabase,
} from '@/modules/shared/index.js';

import { mapPublicRegistryRecord, publicRegistryRecords } from './registry-repo.js';
import { mapFinancialIndicators } from '../../core/financials.js';
import {
  ANAF_WEB_SERVICE_DOCUMENTATION_URL,
  NGO_IDENTITY_METHODS,
  type NgoAnafRegistration,
  type NgoFinancialStatement,
  type NgoIdentityMethod,
  type NgoLoadedSection,
  type NgoOrganizationFiscal,
  type NgoOrganizationProfile,
  type NgoRegistryProfile,
  type NgoPurpose,
  type NgoRegistryConflictField,
  type NgoSocialService,
  type NgoSourceSection,
} from '../../core/organization-types.js';

import type { NgoOrganizationRepository } from '../../core/organization.js';
import type { NgoRegistryRecord } from '../../core/types.js';
import type {
  NgoOrganizationProfileRow,
  NgoProfileSectionRows,
  NgoPublicFinancialStatementRow,
} from '../db/organization-rows.js';
import type {
  NgoPublicPurposeRow,
  NgoPublicSectionSnapshotRow,
  NgoPublicSocialServiceRow,
} from '../db/schema.js';

/** Foundation §5.5 interactive read class; the 15 s pool default is only a backstop. */
export const NGO_READ_TIMEOUT_MS = 5_000;
const READ_TIMEOUT_SQL = sql`set local statement_timeout = ${sql.lit(NGO_READ_TIMEOUT_MS)}`;

const unpublished = () =>
  invalidInput('NGO organization profiles are not published yet.', 'ngoOrganizationProfile');

const readError = (error: unknown, what: string): ApiError => {
  const code =
    typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';
  // Missing data-layer function/relation: an explicit capability error, never an empty profile.
  if (code === '42883' || code === '42P01') return unpublished();
  if (code === '57014') return timeoutError(`NGO ${what} read timed out`);
  return databaseError(`NGO ${what} read failed`, error);
};

/**
 * One read-only snapshot per repository read with the interactive statement budget. The lazy
 * statements read is a separate snapshot, not part of the profile's transaction.
 */
const readSnapshot = <T>(
  db: Kysely<ProdDatabase>,
  read: (trx: Transaction<ProdDatabase>) => Promise<T>
): Promise<T> =>
  db
    .transaction()
    .setIsolationLevel('repeatable read')
    .execute(async (trx) => {
      await sql`set transaction read only`.execute(trx);
      await READ_TIMEOUT_SQL.execute(trx);
      return read(trx);
    });

const iso = (timestamp: string): string => new Date(timestamp).toISOString();
const isIdentityMethod = (value: string | null): value is NgoIdentityMethod =>
  (NGO_IDENTITY_METHODS as readonly (string | null)[]).includes(value);

const loadedSection = <T>(
  availability: string,
  what: string,
  build: () => Result<T, ApiError>
): Result<NgoLoadedSection<T>, ApiError> => {
  if (availability === 'not_loaded') return ok({ availability: 'not_loaded', data: null });
  if (availability !== 'available')
    return err(databaseError(`Unexpected NGO ${what} availability: ${availability}`));
  return build().map((data) => ({ availability: 'available' as const, data }));
};

/** No current snapshot row: not loaded. A snapshot with no rows for the CUI: listed as empty. */
const sourceSection = <R, T>(
  snapshots: readonly NgoPublicSectionSnapshotRow[],
  sourceId: string,
  rows: readonly R[],
  map: (row: R) => Result<T, ApiError>
): Result<NgoSourceSection<T>, ApiError> => {
  const [snapshot, extra] = snapshots.filter((candidate) => candidate.source_id === sourceId);
  if (extra !== undefined)
    return err(databaseError(`NGO ${sourceId} has more than one current snapshot.`));
  if (snapshot === undefined)
    return rows.length === 0
      ? ok({ availability: 'not_loaded', snapshot: null, data: null })
      : err(databaseError(`NGO ${sourceId} rows have no current snapshot.`));
  return Result.combine(rows.map(map)).map((data) => ({
    availability: 'available' as const,
    snapshot: {
      id: snapshot.source_snapshot_id,
      sourceUrl: snapshot.source_url,
      sourceDeclaredDate: snapshot.source_declared_snapshot_date,
      importedAt: iso(snapshot.loaded_at),
    },
    data,
  }));
};

// The view nulls the place of protective services; refuse a row that still carries one.
const mapSocialService = (row: NgoPublicSocialServiceRow): Result<NgoSocialService, ApiError> =>
  row.county_only && (row.service_name !== null || row.locality !== null)
    ? err(databaseError('NGO county-only social service carries a service name or locality.'))
    : ok({
        serviceType: row.service_type,
        serviceCode: row.service_code,
        serviceName: row.service_name,
        county: row.county,
        locality: row.locality,
        capacity: row.capacity,
        licenseNumber: row.license_number,
        licensedOn: row.licensed_on,
        countyOnly: row.county_only,
      });

const CONFLICT_COLUMNS: readonly [keyof NgoOrganizationProfileRow, NgoRegistryConflictField][] = [
  ['court_differs', 'court'],
  ['name_differs', 'name'],
  ['category_differs', 'category'],
  ['status_differs', 'status'],
  ['county_differs', 'county'],
  ['locality_differs', 'locality'],
  ['source_cui_differs', 'sourceCui'],
  ['identity_differs', 'identity'],
  ['cui_conflict', 'cui'],
];

/** Every observation must have a loaded purpose, and they must agree; like other registry consensus fields. */
const mapPurpose = (
  legalRecordIds: readonly string[],
  rows: readonly NgoPublicPurposeRow[]
): NgoPurpose => {
  const loaded = new Map(rows.map((r) => [r.legal_record_id, r.purpose]));
  if (!legalRecordIds.every((id) => loaded.has(id)))
    return { availability: 'not_loaded', text: null };
  const distinct = new Set(legalRecordIds.map((id) => loaded.get(id) ?? null));
  const [text] = distinct;
  return distinct.size === 1 && text !== undefined
    ? { availability: 'available', text }
    : { availability: 'not_released', text: null };
};

/** Maps one function row, the organization's public registry observations and its section rows; fails closed on contract drift. */
export const mapOrganizationProfile = (
  cui: string,
  row: NgoOrganizationProfileRow,
  registryRecords: readonly NgoRegistryRecord[],
  sectionRows: NgoProfileSectionRows
): Result<NgoOrganizationProfile, ApiError> => {
  const method = row.identity_method;
  if (row.organization_cui !== cui || !isIdentityMethod(method))
    return err(
      databaseError('NGO organization profile does not carry the requested admitted identity.')
    );
  if (row.name_withheld)
    return err(databaseError('NGO organization profile exposes a withheld registry name.'));
  const first = registryRecords[0];
  if (
    first === undefined ||
    registryRecords.length !== row.legal_record_ids.length ||
    registryRecords.some((record) => !row.legal_record_ids.includes(record.id))
  )
    return err(databaseError('NGO organization registry observations are incomplete.'));

  const anafRegistration = loadedSection<NgoAnafRegistration>(
    row.anaf_registration_availability,
    'ANAF registration',
    () =>
      row.anaf_reference === null || row.anaf_status_date === null || row.anaf_retrieved_at === null
        ? err(databaseError('Admitted ANAF registration has incomplete provenance.'))
        : ok({
            registrationState: row.anaf_registration_state,
            registrationStateText: row.anaf_registration_state_text,
            registrationStateDate: row.anaf_registration_state_date,
            registrationDate: row.anaf_registration_date,
            legalForm: row.anaf_legal_form,
            organizationForm: row.anaf_organization_form,
            fiscalOffice: row.anaf_fiscal_office,
            declaredFiscallyInactive: row.anaf_is_inactive,
            inactivatedOn: row.anaf_inactivated_on,
            reactivatedOn: row.anaf_reactivated_on,
            inactiveRegisterRemovedOn: row.anaf_inactive_register_removed_on,
            queryDate: row.anaf_status_date,
            capturedAt: iso(row.anaf_retrieved_at),
            sourceSnapshotId: row.anaf_reference,
            documentationUrl: ANAF_WEB_SERVICE_DOCUMENTATION_URL,
          })
  );
  const fiscal = loadedSection<NgoOrganizationFiscal>(row.fiscal_availability, 'fiscal', () =>
    row.fiscal_source_snapshot_id === null
      ? err(databaseError('Admitted fiscal observation has incomplete provenance.'))
      : ok({
          vatPayer: row.fiscal_is_vat_payer,
          declaredFiscallyInactive: row.fiscal_is_inactive,
          mainCaenCode: row.fiscal_main_caen_code,
          queryDate: row.fiscal_status_date,
          capturedAt: row.fiscal_retrieved_at === null ? null : iso(row.fiscal_retrieved_at),
          sourceSnapshotId: row.fiscal_source_snapshot_id,
          documentationUrl: ANAF_WEB_SERVICE_DOCUMENTATION_URL,
        })
  );
  const financialsAvailability = row.financials_availability;
  if (financialsAvailability !== 'available' && financialsAvailability !== 'not_loaded')
    return err(databaseError(`Unexpected NGO financial availability: ${financialsAvailability}`));
  const hasFinancialYears = row.financial_years.length > 0;
  if ((financialsAvailability === 'available') !== hasFinancialYears)
    return err(databaseError('NGO financial availability disagrees with its admitted years.'));

  if (anafRegistration.isErr()) return err(anafRegistration.error);
  if (fiscal.isErr()) return err(fiscal.error);
  const { snapshots } = sectionRows;
  const socialServices = sourceSection(
    snapshots,
    'social_service_licenses',
    sectionRows.socialServices,
    mapSocialService
  );
  const socialServiceAccreditations = sourceSection(
    snapshots,
    'social_service_providers',
    sectionRows.socialServiceAccreditations,
    (r) =>
      ok({
        certificateNumber: r.certificate_number,
        decisionNumber: r.accreditation_decision_number,
      })
  );
  const socialEnterpriseCertificates = sourceSection(
    snapshots,
    'anofm_rueis',
    sectionRows.socialEnterpriseCertificates,
    (r) =>
      ok({
        certificateNumber: r.certificate_number,
        certificateDate: r.certificate_date,
        validUntil: r.valid_until,
        status: r.certificate_status,
      })
  );
  const employmentServiceAccreditations = sourceSection(
    snapshots,
    'anofm_employment_accreditation',
    sectionRows.employmentServiceAccreditations,
    (r) => ok({ certificateNumber: r.certificate_number, issuedOn: r.issued_on })
  );
  if (socialServices.isErr()) return err(socialServices.error);
  if (socialServiceAccreditations.isErr()) return err(socialServiceAccreditations.error);
  if (socialEnterpriseCertificates.isErr()) return err(socialEnterpriseCertificates.error);
  if (employmentServiceAccreditations.isErr()) return err(employmentServiceAccreditations.error);
  const purpose = mapPurpose(row.legal_record_ids, sectionRows.purposes);
  const conflicts: NgoRegistryConflictField[] = CONFLICT_COLUMNS.filter(
    ([column]) => row[column] === true
  ).map(([, field]) => field);
  if (purpose.availability === 'not_released') conflicts.push('purpose');
  return ok({
    cui,
    identity: { cui, method },
    organizationKey: row.organization_key,
    registryNumber: row.registry_number,
    registryNumberValid: row.registry_number_valid,
    name: row.organization_name,
    category: row.entity_kind,
    legalForm: row.legal_form,
    specialRegistryNumber: row.special_registry_number,
    sourceRegistrationDate: row.source_registration_date,
    sourceRegistryStatus: row.source_registry_status,
    county: row.county,
    locality: row.locality,
    isBranch: row.is_branch,
    sourceReportsPublicUtility: row.source_reports_public_utility,
    sourceCui: row.source_cui,
    courts: row.court_names.filter((court): court is string => court !== null),
    observationCount: row.observation_count,
    conflicts,
    snapshot: first.snapshot,
    registryRecords,
    purpose,
    anafRegistration: anafRegistration.value,
    fiscal: fiscal.value,
    financials: {
      availability: financialsAvailability,
      fiscalYears: [...row.financial_years].sort((a, b) => a - b),
    },
    socialServices: socialServices.value,
    socialServiceAccreditations: socialServiceAccreditations.value,
    socialEnterpriseCertificates: socialEnterpriseCertificates.value,
    employmentServiceAccreditations: employmentServiceAccreditations.value,
  });
};

/** Keyed by the CUI and observations the profile function has just admitted, in the same snapshot; no second admission. */
const readProfileSections = async (
  trx: Transaction<ProdDatabase>,
  cui: string,
  legalRecordIds: readonly string[]
): Promise<NgoProfileSectionRows> => ({
  purposes:
    legalRecordIds.length === 0
      ? []
      : await trx
          .selectFrom('ngo.rnong_public_purposes as p')
          .select(['p.legal_record_id', 'p.purpose'])
          .where('p.legal_record_id', 'in', legalRecordIds)
          .execute(),
  snapshots: await trx
    .selectFrom('ngo.public_section_snapshots as s')
    .select([
      's.source_id',
      's.source_snapshot_id',
      's.source_url',
      sql<string | null>`s.source_declared_snapshot_date::text`.as('source_declared_snapshot_date'),
      sql<string>`s.loaded_at::text`.as('loaded_at'),
    ])
    .execute(),
  socialServices: await trx
    .selectFrom('ngo.public_social_services as s')
    .select([
      's.cui',
      's.service_type',
      's.service_code',
      's.service_name',
      's.county',
      's.locality',
      's.capacity',
      's.license_number',
      sql<string | null>`s.licensed_on::text`.as('licensed_on'),
      's.county_only',
      's.source_record_key',
    ])
    .where('s.cui', '=', cui)
    .orderBy(sql`s.county, s.service_type, s.locality, s.service_name, s.source_record_key`)
    .execute(),
  socialServiceAccreditations: await trx
    .selectFrom('ngo.public_social_service_providers as p')
    .select([
      'p.cui',
      'p.certificate_number',
      'p.accreditation_decision_number',
      'p.source_record_key',
    ])
    .where('p.cui', '=', cui)
    .orderBy(sql`p.certificate_number, p.source_record_key`)
    .execute(),
  socialEnterpriseCertificates: await trx
    .selectFrom('ngo.public_social_enterprise_certificates as c')
    .select([
      'c.cui',
      'c.certificate_number',
      sql<string | null>`c.certificate_date::text`.as('certificate_date'),
      sql<string | null>`c.valid_until::text`.as('valid_until'),
      'c.certificate_status',
      'c.source_record_key',
    ])
    .where('c.cui', '=', cui)
    .orderBy(sql`c.certificate_date desc nulls last, c.source_record_key`)
    .execute(),
  employmentServiceAccreditations: await trx
    .selectFrom('ngo.public_employment_accreditations as a')
    .select([
      'a.cui',
      'a.certificate_number',
      sql<string | null>`a.issued_on::text`.as('issued_on'),
      'a.source_record_key',
    ])
    .where('a.cui', '=', cui)
    .orderBy(sql`a.issued_on desc nulls last, a.source_record_key`)
    .execute(),
});

export const mapFinancialStatement = (
  row: NgoPublicFinancialStatementRow
): Result<NgoFinancialStatement, ApiError> =>
  mapFinancialIndicators(row.indicator_definitions, row.indicators)
    .mapErr((reason) =>
      databaseError(`NGO FY${String(row.fiscal_year)} financial statement is invalid: ${reason}`)
    )
    .map((indicators) => ({
      fiscalYear: row.fiscal_year,
      sourceUrl: row.source_url,
      dictionaryUrl: row.dictionary_url,
      sourceRowNumber: row.source_row_number,
      capturedAt: iso(row.captured_at),
      indicators,
    }));

const readCuiProfile = async (
  trx: Transaction<ProdDatabase>,
  cui: string
): Promise<Result<NgoOrganizationProfile | null, ApiError>> => {
  const { rows } = await sql<NgoOrganizationProfileRow>`
          select p.organization_key, p.source_snapshot_id, p.registry_number, p.registry_number_valid,
            p.observation_count, p.legal_record_ids, p.organization_name, p.name_withheld,
            p.entity_kind, p.legal_form, p.special_registry_number, p.court_names,
            p.source_registration_date::text as source_registration_date,
            p.source_registry_status, p.county, p.locality, p.is_branch,
            p.source_reports_public_utility, p.source_cui, p.organization_cui, p.identity_method,
            p.court_differs, p.name_differs, p.category_differs, p.status_differs,
            p.county_differs, p.locality_differs, p.source_cui_differs, p.identity_differs,
            p.cui_conflict,
            p.anaf_registration_availability, p.anaf_reference,
            p.anaf_status_date::text as anaf_status_date,
            p.anaf_retrieved_at::text as anaf_retrieved_at,
            p.anaf_registration_state_text, p.anaf_registration_state,
            p.anaf_registration_state_date::text as anaf_registration_state_date,
            p.anaf_registration_date::text as anaf_registration_date,
            p.anaf_legal_form, p.anaf_organization_form, p.anaf_fiscal_office, p.anaf_is_inactive,
            p.anaf_inactivated_on::text as anaf_inactivated_on,
            p.anaf_reactivated_on::text as anaf_reactivated_on,
            p.anaf_inactive_register_removed_on::text as anaf_inactive_register_removed_on,
            p.fiscal_availability, p.fiscal_is_inactive, p.fiscal_is_vat_payer,
            p.fiscal_main_caen_code, p.fiscal_status_date::text as fiscal_status_date,
            p.fiscal_retrieved_at::text as fiscal_retrieved_at, p.fiscal_source_snapshot_id,
            p.financials_availability, p.financial_years
          from ngo.public_organization_profile(${cui}::text) p`.execute(trx);
  const [row, extra] = rows;
  if (row === undefined) return ok(null);
  if (extra !== undefined)
    return err(databaseError('NGO organization profile matched more than one organization.'));
  const records =
    row.legal_record_ids.length === 0
      ? []
      : await publicRegistryRecords(trx)
          .where('r.legal_record_id', 'in', row.legal_record_ids)
          .where('r.source_snapshot_id', '=', row.source_snapshot_id)
          .orderBy('r.source_row_number', 'asc')
          .execute();
  const sections = await readProfileSections(trx, cui, row.legal_record_ids);
  return mapOrganizationProfile(
    cui,
    row,
    records.map((r) => ({
      ...mapPublicRegistryRecord(r),
      organizationCui: cui,
      organizationIdentityMethod: isIdentityMethod(row.identity_method)
        ? row.identity_method
        : null,
    })),
    sections
  );
};

type RegistryRow = Pick<
  NgoOrganizationProfileRow,
  | 'organization_key'
  | 'source_snapshot_id'
  | 'registry_number'
  | 'registry_number_valid'
  | 'observation_count'
  | 'legal_record_ids'
  | 'organization_name'
  | 'name_withheld'
  | 'entity_kind'
  | 'legal_form'
  | 'special_registry_number'
  | 'court_names'
  | 'source_registration_date'
  | 'source_registry_status'
  | 'county'
  | 'locality'
  | 'is_branch'
  | 'source_reports_public_utility'
  | 'source_cui'
  | 'organization_cui'
  | 'identity_method'
  | 'court_differs'
  | 'name_differs'
  | 'category_differs'
  | 'status_differs'
  | 'county_differs'
  | 'locality_differs'
  | 'source_cui_differs'
  | 'identity_differs'
  | 'cui_conflict'
>;

const mapRegistryOnlyProfile = (
  row: RegistryRow,
  records: readonly NgoRegistryRecord[],
  purposes: readonly NgoPublicPurposeRow[]
): Result<NgoRegistryProfile, ApiError> => {
  const first = records[0];
  if (
    first === undefined ||
    records.length !== row.legal_record_ids.length ||
    records.some((r) => !row.legal_record_ids.includes(r.id))
  )
    return err(databaseError('NGO registry observations are incomplete.'));
  const purpose = row.name_withheld
    ? { availability: 'not_released' as const, text: null }
    : mapPurpose(row.legal_record_ids, purposes);
  const conflicts: NgoRegistryConflictField[] = CONFLICT_COLUMNS.filter(
    ([column]) => row[column as keyof RegistryRow] === true
  ).map(([, field]) => field);
  if (!row.name_withheld && purpose.availability === 'not_released') conflicts.push('purpose');
  return ok({
    cui: null,
    identity: null,
    nameWithheld: row.name_withheld,
    organizationKey: row.organization_key,
    registryNumber: row.registry_number,
    registryNumberValid: row.registry_number_valid,
    name: row.name_withheld ? null : row.organization_name,
    category: row.entity_kind,
    legalForm: row.legal_form,
    specialRegistryNumber: row.special_registry_number,
    sourceRegistrationDate: row.source_registration_date,
    sourceRegistryStatus: row.source_registry_status,
    county: row.county,
    locality: row.locality,
    isBranch: row.is_branch,
    sourceReportsPublicUtility: row.source_reports_public_utility,
    sourceCui: row.source_cui,
    courts: row.court_names.filter((c): c is string => c !== null),
    observationCount: row.observation_count,
    conflicts,
    snapshot: first.snapshot,
    registryRecords: records,
    purpose,
    anafRegistration: { availability: 'not_loaded', data: null },
    fiscal: { availability: 'not_loaded', data: null },
    financials: { availability: 'not_loaded', fiscalYears: [] },
    socialServices: { availability: 'not_loaded', snapshot: null, data: null },
    socialServiceAccreditations: { availability: 'not_loaded', snapshot: null, data: null },
    socialEnterpriseCertificates: { availability: 'not_loaded', snapshot: null, data: null },
    employmentServiceAccreditations: { availability: 'not_loaded', snapshot: null, data: null },
  });
};

export const makeNgoOrganizationRepo = (
  db: Kysely<ProdDatabase>,
  enabled: boolean
): NgoOrganizationRepository => ({
  async registryProfile(registryNumber) {
    if (!enabled) return err(unpublished());
    try {
      return await readSnapshot(db, async (trx) => {
        const { rows } =
          await sql<RegistryRow>`select p.organization_key,p.source_snapshot_id,p.registry_number,p.registry_number_valid,
          p.observation_count,p.legal_record_ids,p.organization_name,p.name_withheld,p.entity_kind,p.legal_form,
          p.special_registry_number,p.court_names,p.source_registration_date::text as source_registration_date,
          p.source_registry_status,p.county,p.locality,p.is_branch,p.source_reports_public_utility,p.source_cui,
          p.organization_cui,p.identity_method,p.court_differs,p.name_differs,p.category_differs,p.status_differs,
          p.county_differs,p.locality_differs,p.source_cui_differs,p.identity_differs,p.cui_conflict
          from ngo.public_registry_profile(${registryNumber}::text) p order by p.organization_key`.execute(
            trx
          );
        if (rows.length === 0) return ok(null);
        const profiles: NgoRegistryProfile[] = [];
        for (const row of rows) {
          if (row.organization_cui !== null) {
            const admitted = await readCuiProfile(trx, row.organization_cui);
            if (admitted.isErr()) return err(admitted.error);
            if (
              admitted.value?.organizationKey !== row.organization_key ||
              admitted.value.snapshot.id !== row.source_snapshot_id
            )
              return err(databaseError('NGO registry and CUI profile identity disagree.'));
            profiles.push({ ...admitted.value, nameWithheld: false });
          } else {
            const records = await publicRegistryRecords(trx)
              .where('r.source_snapshot_id', '=', row.source_snapshot_id)
              .where('r.legal_record_id', 'in', row.legal_record_ids)
              .orderBy('r.source_row_number', 'asc')
              .execute();
            const purposes = row.name_withheld
              ? []
              : await trx
                  .selectFrom('ngo.rnong_public_purposes as p')
                  .select(['p.legal_record_id', 'p.purpose'])
                  .where('p.legal_record_id', 'in', row.legal_record_ids)
                  .execute();
            const mapped = mapRegistryOnlyProfile(
              row,
              records.map((r) => ({
                ...mapPublicRegistryRecord(r),
                organizationCui: null,
                organizationIdentityMethod: null,
              })),
              purposes
            );
            if (mapped.isErr()) return err(mapped.error);
            profiles.push(mapped.value);
          }
        }
        return ok({
          status: profiles.length === 1 ? ('resolved' as const) : ('ambiguous' as const),
          profiles,
        });
      });
    } catch (error) {
      return err(readError(error, 'registry profile'));
    }
  },
  async profile(cui) {
    if (!enabled) return err(unpublished());
    try {
      return await readSnapshot(db, async (trx) => {
        return readCuiProfile(trx, cui);
      });
    } catch (error) {
      return err(readError(error, 'organization profile'));
    }
  },
  async financialStatements(cui, fiscalYears) {
    if (!enabled) return err(unpublished());
    try {
      return await readSnapshot(db, async (trx) => {
        const { rows } = await sql<NgoPublicFinancialStatementRow>`
          select s.fiscal_year, s.source_row_number, s.source_url, s.dictionary_url,
            s.captured_at::text as captured_at, s.indicator_definitions, s.indicators
          from ngo.public_financial_statements(${cui}::text, ${fiscalYears}::integer[]) s
          order by s.fiscal_year desc, s.source_url, s.source_row_number`.execute(trx);
        return Result.combine(rows.map(mapFinancialStatement));
      });
    } catch (error) {
      return err(readError(error, 'financial statements'));
    }
  },
});
