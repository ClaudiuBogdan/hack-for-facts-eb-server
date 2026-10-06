import { sql, type Kysely, type RawBuilder, type SqlBool } from 'kysely';
import { err, ok, type Result } from 'neverthrow';

import {
  buildNextCursor,
  databaseError,
  decodeCursor,
  fhashFor,
  filterHash,
  invalidInput,
  serviceUnavailable,
  toConditionBuilders,
  type ApiError,
  type FilterInput,
  type ProdDatabase,
} from '@/modules/shared/index.js';

import {
  parseVirtualFilters,
  publicEnterpriseIndicatorFilterSpec,
  publicEnterpriseListFilterSpec,
} from '../../core/filters.js';
import {
  PUBLIC_ENTERPRISE_EDGE_FAMILIES,
  PUBLIC_ENTERPRISE_FAMILIES,
  PUBLIC_ENTERPRISE_SOURCE_FAMILIES,
  PUBLIC_ENTERPRISE_VALUE_KINDS,
  type PublicEnterpriseAuthorityEdge,
  type PublicEnterpriseIndicator,
  type PublicEnterpriseMembership,
  type PublicEnterpriseRegistryObservation,
  type PublicEnterpriseSource,
} from '../../core/types.js';

import type { PublicEnterpriseRepository } from '../../core/ports.js';
import type {
  PublicAmepipIndicatorRow,
  PublicAuthorityEdgeRow,
  PublicEnterpriseMembershipRow,
  PublicRegistryObservationRow,
  PublicSourceSnapshotRow,
} from '../db/schema.js';

/** Keyset order of the indicators: (year, source_sheet, version, indicator_key). */
export const INDICATOR_SORT = 'yearSheetVersionKey';

/**
 * The indicator cursor `fhash` pins the enterprise, the canonical filters and
 * the current AMEPIP snapshot: a cursor from another CUI, filter set or source
 * revision fails with the kernel's "restart pagination" InvalidInput.
 */
export const indicatorFilterHash = (
  cui: string,
  snapshotId: string | null,
  filter: FilterInput
): string =>
  filterHash(`${cui}|${snapshotId ?? ''}|${fhashFor(publicEnterpriseIndicatorFilterSpec, filter)}`);

export const indicatorCursorKeys = (
  indicator: Pick<PublicEnterpriseIndicator, 'year' | 'sourceSheet' | 'version' | 'indicatorKey'>
): readonly (string | number)[] => [
  indicator.year,
  indicator.sourceSheet,
  indicator.version,
  indicator.indicatorKey,
];

const oneOf = <T extends string>(values: readonly T[], value: string, what: string): T => {
  if ((values as readonly string[]).includes(value)) return value as T;
  throw new Error(`Unexpected public-enterprise ${what}`);
};

/** `public_source_snapshots` rows with their timestamps already ISO text. */
export const mapSource = (row: PublicSourceSnapshotRow): PublicEnterpriseSource => ({
  family: oneOf(PUBLIC_ENTERPRISE_SOURCE_FAMILIES, row.source_family, 'source family'),
  scope: row.source_scope,
  laneStatus: row.raw_status === 'partial' ? 'partial' : 'available',
  snapshotId: row.snapshot_id,
  rawStatus: row.raw_status,
  sourceUrl: row.source_url,
  contentSha256: row.content_sha256,
  observedAt: row.observed_at,
  sourceLastModifiedAt: row.source_last_modified_at,
  acceptedAt: row.accepted_at,
  loadedAt: row.loaded_at,
});

/** Every family in fixed order; a family without a current public snapshot is unavailable. */
export const sourcesInFamilyOrder = (
  rows: readonly PublicSourceSnapshotRow[]
): PublicEnterpriseSource[] =>
  PUBLIC_ENTERPRISE_SOURCE_FAMILIES.flatMap((family) => {
    const loaded = rows.filter((row) => row.source_family === family).map(mapSource);
    if (loaded.length > 0) return loaded;
    return [
      {
        family,
        scope: null,
        laneStatus: 'unavailable' as const,
        snapshotId: null,
        rawStatus: null,
        sourceUrl: null,
        contentSha256: null,
        observedAt: null,
        sourceLastModifiedAt: null,
        acceptedAt: null,
        loadedAt: null,
      },
    ];
  });

export const mapMembership = (row: PublicEnterpriseMembershipRow): PublicEnterpriseMembership => ({
  cui: row.cui,
  isCurrentMember: row.is_current_member,
  currentFamilies: row.current_families.map((family) =>
    oneOf(PUBLIC_ENTERPRISE_FAMILIES, family, 'family')
  ),
});

export const mapObservation = (
  row: PublicRegistryObservationRow
): PublicEnterpriseRegistryObservation => ({
  id: row.registry_observation_key,
  snapshotId: row.snapshot_id,
  sourceFamily: oneOf(PUBLIC_ENTERPRISE_FAMILIES, row.source_family, 'family'),
  sourceRecordKey: row.source_record_key,
  cui: row.cui,
  rawCui: row.raw_cui,
  cuiChecksumStatus: row.cui_checksum_status,
  publishStatus: row.publish_status,
  observedName: row.observed_name,
  observedYear: row.observed_year,
  statusRaw: row.status_raw,
  statusNormalized: row.status_normalized,
  rawSubordination: row.raw_subordination,
  derivedAuthorityLevel: row.derived_authority_level,
  sourceEvidenceKey: row.source_evidence_key,
  sourceUrl: row.source_url,
});

export const mapEdge = (row: PublicAuthorityEdgeRow): PublicEnterpriseAuthorityEdge => ({
  id: row.control_edge_key,
  snapshotId: row.snapshot_id,
  sourceFamily: oneOf(PUBLIC_ENTERPRISE_EDGE_FAMILIES, row.source_family, 'edge family'),
  sourceRecordKey: row.source_record_key,
  enterpriseCui: row.enterprise_cui,
  authorityCui: row.authority_cui,
  authorityName: row.authority_name,
  rawSubordination: row.raw_subordination,
  authorityLevel: row.authority_level,
  authorityLevelMethod: row.authority_level_method,
  aptTypeId: row.apt_type_id,
  enterpriseStatusRaw: row.enterprise_status_raw,
  effectiveFrom: row.effective_from,
  effectiveTo: row.effective_to,
  sourceEvidenceKey: row.source_evidence_key,
  sourceUrl: row.source_url,
});

export const mapIndicator = (row: PublicAmepipIndicatorRow): PublicEnterpriseIndicator => ({
  id: [
    row.snapshot_id,
    row.enterprise_cui,
    String(row.year),
    row.source_sheet,
    row.version,
    row.indicator_key,
  ].join('|'),
  snapshotId: row.snapshot_id,
  enterpriseCui: row.enterprise_cui,
  year: row.year,
  sourceSheet: row.source_sheet,
  version: row.version,
  indicatorKey: row.indicator_key,
  kpiCode: row.kpi_code,
  indicatorName: row.indicator_name,
  measureUnit: row.measure_unit,
  valueKind: oneOf(PUBLIC_ENTERPRISE_VALUE_KINDS, row.value_kind, 'value kind'),
  rawValue: row.raw_value,
  numericValue: row.numeric_value,
  booleanValue: row.boolean_value,
  textValue: row.text_value,
  sourceRowNumber: row.source_row_number,
  sourceEvidenceKey: row.source_evidence_key,
  sourceUrl: row.source_url,
});

/** Exact UTC instant as ISO text, computed in SQL (no JS date parsing). */
const isoUtc = (column: string) =>
  sql<
    string | null
  >`to_char(${sql.ref(column)} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

const disabled = (): ApiError =>
  serviceUnavailable('Public enterprises are not enabled on this server.');

const readError = (error: unknown): ApiError => {
  if (typeof error === 'object' && error !== null && 'code' in error && error.code === '42P01')
    return serviceUnavailable('Public-enterprise read views are not deployed.');
  return databaseError('Public-enterprise read failed', error);
};

/** One read-only, repeatable-read transaction per request (one consistent snapshot). */
const readOnly = async <T>(
  db: Kysely<ProdDatabase>,
  read: (trx: Kysely<ProdDatabase>) => Promise<Result<T, ApiError>>
): Promise<Result<T, ApiError>> => {
  try {
    return await db
      .transaction()
      .setIsolationLevel('repeatable read')
      .execute(async (trx) => {
        await sql`set transaction read only`.execute(trx);
        await sql`set local statement_timeout = 5000`.execute(trx);
        return read(trx);
      });
  } catch (error) {
    return err(readError(error));
  }
};

const readSources = async (trx: Kysely<ProdDatabase>): Promise<PublicEnterpriseSource[]> => {
  const rows = await trx
    .selectFrom('public_enterprises.public_source_snapshots as s')
    .select([
      's.snapshot_id',
      's.source_family',
      's.source_scope',
      's.source_url',
      's.content_sha256',
      's.raw_status',
      isoUtc('s.observed_at').as('observed_at'),
      isoUtc('s.source_last_modified_at').as('source_last_modified_at'),
      isoUtc('s.accepted_at').as('accepted_at'),
      sql<string>`to_char(s.loaded_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`.as(
        'loaded_at'
      ),
    ])
    .orderBy(sql`s.source_family collate "C"`)
    .orderBy(sql`s.source_scope collate "C"`)
    .execute();
  return sourcesInFamilyOrder(rows);
};

const parseIndicatorAfter = (
  raw: string,
  fhash: string
): Result<{ year: number; sheet: string; version: string; key: string }, ApiError> => {
  const decoded = decodeCursor(raw, { sort: INDICATOR_SORT, dir: 'asc', fhash });
  if (decoded.isErr()) return err(decoded.error);
  const [year, sheet, version, key] = decoded.value.keys;
  const parsedYear = Number(year);
  if (
    decoded.value.keys.length !== 4 ||
    !Number.isSafeInteger(parsedYear) ||
    parsedYear < 2000 ||
    parsedYear > 2100 ||
    sheet === undefined ||
    version === undefined ||
    key === undefined
  )
    return err(invalidInput('invalid indicator cursor; restart pagination', 'after'));
  return ok({ year: parsedYear, sheet, version, key });
};

export const makePublicEnterpriseRepo = (
  db: Kysely<ProdDatabase>,
  enabled: boolean
): PublicEnterpriseRepository => ({
  sources() {
    if (!enabled) return Promise.resolve(err(disabled()));
    return readOnly(db, async (trx) => ok(await readSources(trx)));
  },

  profile(cui) {
    if (!enabled) return Promise.resolve(err(disabled()));
    return readOnly(db, async (trx) => {
      const member = await trx
        .selectFrom('public_enterprises.public_enterprise_memberships as m')
        .select(['m.cui', 'm.organization_cui', 'm.current_families', 'm.is_current_member'])
        .where('m.cui', '=', cui)
        .executeTakeFirst();
      if (member === undefined) return ok(null);
      const observations = await trx
        .selectFrom('public_enterprises.public_registry_observations as o')
        .selectAll('o')
        .where('o.cui', '=', cui)
        .orderBy(sql`o.registry_observation_key collate "C"`)
        .execute();
      const edges = await trx
        .selectFrom('public_enterprises.public_authority_edges as e')
        .select([
          'e.control_edge_key',
          'e.snapshot_id',
          'e.source_family',
          'e.source_record_key',
          'e.enterprise_cui',
          'e.authority_cui',
          'e.authority_name',
          'e.raw_subordination',
          'e.authority_level',
          'e.authority_level_method',
          'e.apt_type_id',
          'e.enterprise_status_raw',
          sql<string | null>`e.effective_from::text`.as('effective_from'),
          sql<string | null>`e.effective_to::text`.as('effective_to'),
          'e.source_evidence_key',
          'e.source_url',
        ])
        .where('e.enterprise_cui', '=', cui)
        .orderBy(sql`e.control_edge_key collate "C"`)
        .execute();
      return ok({
        ...mapMembership(member),
        registryObservations: observations.map(mapObservation),
        authorityEdges: edges.map(mapEdge),
        sources: await readSources(trx),
      });
    });
  },

  list(request) {
    if (!enabled) return Promise.resolve(err(disabled()));
    const conditions = toConditionBuilders(publicEnterpriseListFilterSpec, request.filter);
    if (conditions.isErr()) return Promise.resolve(err(conditions.error));
    const virtual = parseVirtualFilters(request.filter);
    if (virtual.isErr()) return Promise.resolve(err(virtual.error));
    const predicates: RawBuilder<SqlBool>[] = conditions.value.map(
      (condition) => condition as RawBuilder<SqlBool>
    );
    if (virtual.value.currentOnly) predicates.push(sql<SqlBool>`m.is_current_member`);
    const edgePredicates: RawBuilder<SqlBool>[] = [];
    const { authorityCuis, authorityLevels } = virtual.value;
    if (authorityCuis !== undefined)
      edgePredicates.push(sql<SqlBool>`e.authority_cui = any(${[...authorityCuis]}::text[])`);
    if (authorityLevels !== undefined)
      edgePredicates.push(sql<SqlBool>`e.authority_level = any(${[...authorityLevels]}::text[])`);
    // Both authority predicates apply to the same current public edge.
    if (edgePredicates.length > 0)
      predicates.push(
        sql<SqlBool>`exists (select 1 from public_enterprises.public_authority_edges e
          where e.enterprise_cui = m.cui and ${sql.join(edgePredicates, sql` and `)})`
      );
    const where = predicates.length === 0 ? sql<SqlBool>`true` : sql.join(predicates, sql` and `);
    return readOnly(db, async (trx) => {
      const counted = await trx
        .selectFrom('public_enterprises.public_enterprise_memberships as m')
        .select(sql<string>`count(*)::text`.as('total'))
        .where(sql<SqlBool>`${where}`)
        .executeTakeFirst();
      const rows = await trx
        .selectFrom('public_enterprises.public_enterprise_memberships as m')
        .select(['m.cui', 'm.organization_cui', 'm.current_families', 'm.is_current_member'])
        .where(sql<SqlBool>`${where}`)
        // Numeric CUI order for digit strings: shorter first, then C collation.
        .orderBy(sql`length(m.cui)`)
        .orderBy(sql`m.cui collate "C"`)
        .limit(request.pageSize)
        .offset((request.page - 1) * request.pageSize)
        .execute();
      return ok({
        items: rows.map(mapMembership),
        page: request.page,
        pageSize: request.pageSize,
        total: Number(counted?.total ?? '0'),
      });
    });
  },

  indicators(request) {
    if (!enabled) return Promise.resolve(err(disabled()));
    const conditions = toConditionBuilders(publicEnterpriseIndicatorFilterSpec, request.filter);
    if (conditions.isErr()) return Promise.resolve(err(conditions.error));
    return readOnly(db, async (trx) => {
      const current = await trx
        .selectFrom('public_enterprises.public_source_snapshots as s')
        .select('s.snapshot_id')
        .where('s.source_family', '=', 'amepip')
        .execute();
      if (current.length > 1)
        return err(databaseError('More than one current public AMEPIP snapshot.'));
      const snapshotId = current[0]?.snapshot_id ?? null;
      const fhash = indicatorFilterHash(request.cui, snapshotId, request.filter);
      let after: { year: number; sheet: string; version: string; key: string } | undefined;
      if (request.after !== undefined) {
        const parsed = parseIndicatorAfter(request.after, fhash);
        if (parsed.isErr()) return err(parsed.error);
        after = parsed.value;
      }
      if (snapshotId === null) return ok({ items: [], next: null, snapshotId: null });
      let query = trx
        .selectFrom('public_enterprises.public_amepip_indicators as v')
        .selectAll('v')
        .where('v.enterprise_cui', '=', request.cui)
        .where('v.snapshot_id', '=', snapshotId);
      for (const condition of conditions.value)
        query = query.where(condition as RawBuilder<SqlBool>);
      if (after !== undefined) {
        const k = after;
        query = query.where(
          sql<SqlBool>`(v.year, v.source_sheet collate "C", v.version collate "C", v.indicator_key collate "C")
            > (${k.year}::int, ${k.sheet}::text collate "C", ${k.version}::text collate "C", ${k.key}::text collate "C")`
        );
      }
      const rows = await query
        .orderBy('v.year')
        .orderBy(sql`v.source_sheet collate "C"`)
        .orderBy(sql`v.version collate "C"`)
        .orderBy(sql`v.indicator_key collate "C"`)
        .limit(request.first + 1)
        .execute();
      const items = rows.slice(0, request.first).map(mapIndicator);
      const last = items.at(-1);
      const next =
        rows.length > request.first && last !== undefined
          ? buildNextCursor({
              sort: INDICATOR_SORT,
              dir: 'asc',
              fhash,
              lastKeys: indicatorCursorKeys(last),
            })
          : null;
      return ok({ items, next, snapshotId });
    });
  },
});
