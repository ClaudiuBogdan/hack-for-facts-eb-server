/**
 * Companies analytics — PostgreSQL reads: release custody rows and labels.
 *
 * Read-only. `companies_analytics.active_release` is the terminal publication;
 * a pinned historical release is a `verified` row of `releases` that appears
 * in `publications`. Both are micro-cached and single-flighted (errors never
 * cached): the active pointer for a few seconds, historical rows — immutable
 * once verified — for minutes. Each row carries the privacy epoch its facts
 * were captured under.
 *
 * The CURRENT state is never cached: every call is ONE fresh statement
 * reading the privacy epoch and the current ONRC publication envelope (with
 * its published-edition privacy policy), and reporting `pg_is_in_recovery()`
 * and the transaction isolation, so the guard can refuse a replica or a fixed
 * snapshot. The source date is rendered exactly as the exporter writes the
 * pin. A plain SELECT — no lock, no write.
 *
 * Labels are CURRENT presentation data, hydrated after aggregation in one
 * batch per source and never cached (a cached label could outlive its row's
 * publicity): company names under the same publication rule as the profile
 * pages (`core.organizations`, kind company, public, ≤10-digit CUI), county/UAT
 * names from public `core.territories` rows, CAEN labels only for a KNOWN
 * revision (`caen_<revision>`). Status labels are not read here (the API
 * nomenclature, in core): `companies_v2.registrations` is never queried.
 * Nothing here writes.
 */

import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { sql, type Kysely, type SqlBool } from 'kysely';
import { err, ok, type Result } from 'neverthrow';

import {
  MAX_SERVED_CUI_DIGITS,
  databaseError,
  isCountyTerritory,
  isUatPresentationTerritory,
  organizationRowIsPublic,
  type ApiError,
  type Logger,
  type ProdDatabase,
} from '@/modules/shared/index.js';

import type {
  CaenLabelKey,
  CompanyAnalysisLabelSource,
  CompanyAnalysisReleaseSource,
} from '../../core/analytics-ports.js';
import type { CompanyAnalysisReleaseRow } from '../../core/analytics-release.js';

type Db = Kysely<ProdDatabase>;

const ACTIVE_TTL_MS = 5_000;
const HISTORICAL_TTL_MS = 10 * 60_000;

const NullableText = Type.Union([Type.String(), Type.Null()]);
const ReleaseRowSchema = Type.Object({
  release_id: Type.String(),
  publication_id: NullableText,
  published_at: NullableText,
  schema_version: Type.String(),
  population_policy_version: Type.String(),
  admission_policy_version: NullableText,
  admission_policy_sha256: NullableText,
  clickhouse_database: Type.String(),
  company_table: Type.String(),
  company_year_table: Type.String(),
  input_snapshot_at: NullableText,
  companies: NullableText,
  company_years: NullableText,
  privacy_epoch: NullableText,
  coverage: Type.Unknown(),
  inputs: Type.Unknown(),
});

const CurrentStateRowSchema = Type.Object({
  epoch: Type.String(),
  in_recovery: Type.Boolean(),
  isolation: Type.String(),
  publication_state: Type.String(),
  listed: Type.Boolean(),
  edition_id: NullableText,
  publication_epoch: NullableText,
  source_snapshot_id: NullableText,
  source_published_at: NullableText,
  interpretation_version: NullableText,
  dimension_policy_version: NullableText,
  privacy_policy_version: NullableText,
});

/**
 * The exporter's DateStyle-independent rendering of a civil date (source
 * contract §1): an out-of-domain date becomes `out-of-range`, never a pin.
 */
const isoDate = (column: string) => sql<string | null>`case
  when ${sql.ref(column)} is null then null
  when ${sql.ref(column)} between date '0001-01-01' and date '9999-12-31'
    then to_char(${sql.ref(column)}, 'YYYY-MM-DD')
  else 'out-of-range' end`;

const toRow = (raw: unknown, active: boolean): CompanyAnalysisReleaseRow | null => {
  if (!Value.Check(ReleaseRowSchema, raw)) return null;
  return {
    releaseId: raw.release_id,
    publicationId: raw.publication_id,
    publishedAt: raw.published_at,
    active,
    schemaVersion: raw.schema_version,
    populationPolicyVersion: raw.population_policy_version,
    admissionPolicyVersion: raw.admission_policy_version,
    admissionPolicySha256: raw.admission_policy_sha256,
    clickhouseDatabase: raw.clickhouse_database,
    companyTable: raw.company_table,
    companyYearTable: raw.company_year_table,
    inputSnapshotAt: raw.input_snapshot_at,
    companies: raw.companies,
    companyYears: raw.company_years,
    privacyEpoch: raw.privacy_epoch,
    coverage: raw.coverage,
    inputs: raw.inputs,
  };
};

const ISO_UTC = 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"';

type ReleaseResult = Result<CompanyAnalysisReleaseRow | null, ApiError>;

/**
 * A tiny TTL cache of release reads: single-flighted, errors never kept, and
 * an absent row kept only when `keepAbsent` (a release published later must
 * not stay refused).
 */
const makeReleaseLoader = (ttlMs: number, keepAbsent: boolean, now: () => number) => {
  const values = new Map<string, { value: CompanyAnalysisReleaseRow | null; expiresAt: number }>();
  const pending = new Map<string, Promise<ReleaseResult>>();
  return (key: string, load: () => Promise<ReleaseResult>): Promise<ReleaseResult> => {
    const hit = values.get(key);
    if (hit !== undefined && hit.expiresAt > now()) return Promise.resolve(ok(hit.value));
    const flight = pending.get(key);
    if (flight !== undefined) return flight;
    const started = load()
      .then((result) => {
        if (result.isOk() && (keepAbsent || result.value !== null))
          values.set(key, { value: result.value, expiresAt: now() + ttlMs });
        return result;
      })
      .finally(() => {
        pending.delete(key);
      });
    pending.set(key, started);
    return started;
  };
};

export const makeAnalyticsReleaseSource = (
  db: Db,
  logger?: Logger,
  now: () => number = Date.now
): CompanyAnalysisReleaseSource => {
  const activeLoader = makeReleaseLoader(ACTIVE_TTL_MS, true, now);
  const historicalLoader = makeReleaseLoader(HISTORICAL_TTL_MS, false, now);

  const readFailed = (operation: string, cause: unknown): ApiError => {
    logger?.warn({ operation }, 'companies analytics release read failed');
    return databaseError('companies analytics release metadata is unavailable', cause);
  };

  const activeRelease: CompanyAnalysisReleaseSource['activeRelease'] = () =>
    activeLoader('active', async () => {
      try {
        const result = await sql<Record<string, unknown>>`
          select release_id::text as release_id,
                 publication_id::text as publication_id,
                 to_char(published_at at time zone 'UTC', ${ISO_UTC}) as published_at,
                 schema_version, population_policy_version,
                 admission_policy_version, admission_policy_sha256,
                 clickhouse_database, company_table, company_year_table,
                 input_snapshot_at,
                 companies::text as companies, company_years::text as company_years,
                 privacy_epoch, coverage, inputs
          from companies_analytics.active_release
          limit 2`.execute(db);
        if (result.rows.length > 1)
          return err(databaseError('companies analytics has more than one active release'));
        const first = result.rows[0];
        if (first === undefined) return ok(null);
        const row = toRow(first, true);
        return row === null
          ? err(databaseError('companies analytics active release row is malformed'))
          : ok(row);
      } catch (cause) {
        return err(readFailed('activeRelease', cause));
      }
    });

  const publishedRelease: CompanyAnalysisReleaseSource['publishedRelease'] = (releaseNumber) =>
    historicalLoader(String(releaseNumber), async () => {
      try {
        // A historical pin is served only when it was published at some point
        // (rollback appends; publications are append-only) and is verified.
        const result = await sql<Record<string, unknown>>`
          select r.release_id::text as release_id,
                 p.publication_id::text as publication_id,
                 to_char(p.published_at at time zone 'UTC', ${ISO_UTC}) as published_at,
                 r.schema_version, r.population_policy_version,
                 r.admission_policy ->> 'policyVersion' as admission_policy_version,
                 r.admission_policy_sha256,
                 'companies_analytics'::text as clickhouse_database,
                 'company_r' || r.release_id::text as company_table,
                 'company_year_r' || r.release_id::text as company_year_table,
                 r.export_manifest -> 'snapshot' ->> 'snapshot_at' as input_snapshot_at,
                 r.export_manifest -> 'files' -> 'company' ->> 'rows' as companies,
                 r.export_manifest -> 'files' -> 'company_year' ->> 'rows' as company_years,
                 r.export_manifest ->> 'privacyEpoch' as privacy_epoch,
                 r.export_manifest -> 'coverage' as coverage,
                 r.export_manifest -> 'inputs' as inputs
          from companies_analytics.releases r
          join lateral (
            select publication_id, published_at
            from companies_analytics.publications
            where release_id = r.release_id
            order by published_at desc, publication_id desc
            limit 1
          ) p on true
          where r.release_id = ${String(releaseNumber)}::bigint and r.status = 'verified'`.execute(
          db
        );
        const first = result.rows[0];
        if (first === undefined) return ok(null);
        const row = toRow(first, false);
        return row === null
          ? err(databaseError('companies analytics release row is malformed'))
          : ok(row);
      } catch (cause) {
        return err(readFailed('publishedRelease', cause));
      }
    });

  // Deliberately outside every loader: a cached state could hide a withdrawal
  // or a source event. One statement: epoch and envelope are read together.
  const currentState: CompanyAnalysisReleaseSource['currentState'] = async () => {
    try {
      const result = await sql<Record<string, unknown>>`
        select s.epoch::text as epoch,
               pg_is_in_recovery() as in_recovery,
               current_setting('transaction_isolation') as isolation,
               c.publication_state,
               (e.edition_id is not null) as listed,
               c.edition_id::text as edition_id,
               c.publication_epoch::text as publication_epoch,
               c.source_snapshot_id,
               ${isoDate('c.source_published_at')} as source_published_at,
               c.interpretation_version,
               c.dimension_policy_version,
               e.privacy_policy_version
        from companies_analytics.privacy_state s
        cross join companies_v2.onrc_current_publication c
        left join companies_v2.onrc_published_editions e on e.edition_id = c.edition_id
        where s.singleton`.execute(db);
      const first = result.rows[0];
      if (result.rows.length !== 1 || !Value.Check(CurrentStateRowSchema, first))
        return err(databaseError('companies analytics privacy state is unreadable'));
      return ok({
        epoch: first.epoch,
        inRecovery: first.in_recovery,
        isolation: first.isolation,
        onrc: {
          publicationState: first.publication_state,
          listed: first.listed,
          editionId: first.edition_id,
          publicationEpoch: first.publication_epoch,
          sourceSnapshotId: first.source_snapshot_id,
          sourcePublishedAt: first.source_published_at,
          interpretationVersion: first.interpretation_version,
          dimensionPolicyVersion: first.dimension_policy_version,
          privacyPolicyVersion: first.privacy_policy_version,
        },
      });
    } catch (cause) {
      logger?.warn({ operation: 'currentState' }, 'companies analytics privacy read failed');
      return err(databaseError('companies analytics privacy state is unreadable', cause));
    }
  };

  return { activeRelease, publishedRelease, currentState };
};

const asMap = (rows: readonly { key: string; label: string | null }[]): Map<string, string> => {
  const out = new Map<string, string>();
  for (const row of rows) {
    if (row.label !== null && row.label.trim() !== '') out.set(row.key, row.label);
  }
  return out;
};

/**
 * Labels are read fresh, one bounded batch per source per answer, and never
 * cached: a cache would keep serving a territory or registry label after its
 * row stopped being public (the epoch guard lets a NEW release answer at
 * once), so every read carries its public predicate instead.
 */
export const makeAnalyticsLabelSource = (db: Db, logger?: Logger): CompanyAnalysisLabelSource => {
  const failed = (operation: string, cause: unknown): ApiError => {
    logger?.warn({ operation }, 'companies analytics label read failed');
    return databaseError('companies analytics labels are unavailable', cause);
  };

  const read = async (
    operation: string,
    query: () => Promise<readonly { key: string; label: string | null }[]>
  ): Promise<Result<ReadonlyMap<string, string>, ApiError>> => {
    try {
      return ok(asMap(await query()));
    } catch (cause) {
      return err(failed(operation, cause));
    }
  };

  const textArray = (values: readonly string[]) => sql`${JSON.stringify(values)}::jsonb`;
  const inList = (column: string, values: readonly string[]) =>
    sql<SqlBool>`${sql.ref(column)} in (select jsonb_array_elements_text(${textArray(values)}))`;

  return {
    companyNames: (cuis) =>
      read('companyNames', async () => {
        const rows = await db
          .selectFrom('core.organizations as o')
          .select(['o.cui', 'o.name'])
          .where(inList('o.cui', cuis))
          .where('o.kind', '=', 'company')
          .where(organizationRowIsPublic('o.privacy_class'))
          .where(sql<boolean>`length(o.cui) <= ${sql.lit(MAX_SERVED_CUI_DIGITS)}`)
          .execute();
        return rows.map((row) => ({ key: row.cui ?? '', label: row.name }));
      }),

    countyLabels: (codes) =>
      read('countyLabels', async () => {
        const result = await sql<{ key: string; label: string | null }>`
          select distinct on (t.county_code) t.county_code as key, t.county_name as label
          from core.territories t
          where ${inList('t.county_code', codes)}
            and t.privacy_class = 'public' and ${isCountyTerritory('t')}
          order by t.county_code, t.id`.execute(db);
        return result.rows;
      }),

    uatLabels: (sirutas) =>
      read('uatLabels', async () => {
        const result = await sql<{ key: string; label: string | null }>`
          select distinct on (t.siruta_code) t.siruta_code as key, t.name as label
          from core.territories t
          where ${inList('t.siruta_code', sirutas)}
            and t.privacy_class = 'public'
            and (${isUatPresentationTerritory('t')} or t.level = 'locality')
          order by t.siruta_code, (t.level = 'uat') desc, t.id`.execute(db);
        return result.rows;
      }),

    // The CAEN catalog carries no privacy class; labels only for known revisions.
    caenLabels: (keys: readonly CaenLabelKey[]) =>
      read('caenLabels', async () => {
        const result = await sql<{ key: string; label: string | null }>`
          select k.revision || ':' || k.code as key, cc.label
          from jsonb_to_recordset(${JSON.stringify(keys)}::jsonb) as k(revision text, code text)
          join core.classification_codes cc
            on cc.system = 'caen_' || k.revision and cc.code = k.code`.execute(db);
        return result.rows;
      }),
  };
};
