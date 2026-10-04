/**
 * Companies module — the bounded batch read behind the global search's
 * company contribution (`core/search-contribution.ts`). At most 50 canonical
 * CUIs (short ones such as `1` included):
 *  1. one statement classifies every CUI's core parent (any kind; a known
 *     non-public or NULL class is private);
 *  2. for public `company` parents of the ONRC company shape (2–10 digits),
 *     when values are asked (published scope only), three statements bound to
 *     the pinned `edition_id` through the public `onrc_published_*` views
 *     (profiles, active CUIs, identifiers) and one through the public
 *     institution/territory hubs: the county of the identity's own public
 *     institution role (`core.public_entities` → a PUBLIC `core.territories`
 *     row), the generic-county fallback when the ONRC company county is null.
 * No legacy registry, status flags, raw tokens, base tables, engine or core
 * organization county is read.
 */

import { sql, type Kysely } from 'kysely';
import { err, ok } from 'neverthrow';

import {
  databaseError,
  organizationRowIsPublic,
  type ProdDatabase,
  type SearchCuiParent,
} from '@/modules/shared/index.js';

import {
  IDENTIFIER_LIST_BOUND,
  editionParam,
  inTextList,
  isCapabilityError,
  profileColumns,
  profileFromRow,
  readActiveCuis,
  type ProfileColumnsRow,
} from './registry-sql.js';
import { isOnrcQualifiedCui, isPublished, registryCapabilityLost } from '../../core/registry.js';
import { companySearchValues, type CompanySearchReadPort } from '../../core/search-contribution.js';

type Db = Kysely<ProdDatabase>;

interface ParentRow {
  cui: string;
  kind: string | null;
  is_public: boolean | null;
  core_name: string;
}

/** Public resolved identifier keys and EUIDs per CUI (sorted, bounded per CUI). */
const readSearchIdentifiers = async (
  db: Db,
  editionId: string,
  cuis: readonly string[]
): Promise<ReadonlyMap<string, readonly string[]>> => {
  const edition = editionParam(editionId);
  const result = await sql<{ cui: string; value: string }>`
    select x.cui, x.value from (
      select u.cui, u.value,
             row_number() over (partition by u.cui order by u.value collate "C") as rn
      from (
        select i.cui, i.identifier_key as value
          from companies_v2.onrc_published_identifier_profiles i
         where i.edition_id = ${edition} and ${inTextList(sql`i.cui`, cuis)}
        union
        select o.cui, o.euid as value
          from companies_v2.onrc_published_identity_observations o
         where o.edition_id = ${edition} and o.euid is not null
           and ${inTextList(sql`o.cui`, cuis)}
      ) u
    ) x
    where x.rn <= ${IDENTIFIER_LIST_BOUND}
    order by x.cui, x.value collate "C"`.execute(db);
  const out = new Map<string, string[]>();
  for (const row of result.rows) out.set(row.cui, [...(out.get(row.cui) ?? []), row.value]);
  return out;
};

/**
 * The county of each CUI's own public institution role: its
 * `core.public_entities` row's territory, only when that territory hub row is
 * public (a private or missing territory gives no county).
 */
const readInstitutionCounties = async (
  db: Db,
  cuis: readonly string[]
): Promise<ReadonlyMap<string, string>> => {
  const result = await sql<{ cui: string; county_name: string | null }>`
    select pe.cui, t.county_name
    from core.public_entities pe
    join core.territories t
      on t.id = pe.territory_id and ${organizationRowIsPublic('t.privacy_class')}
    where ${inTextList(sql`pe.cui`, cuis)}
    order by pe.cui, t.id`.execute(db);
  const out = new Map<string, string>();
  for (const row of result.rows) {
    if (row.county_name !== null && !out.has(row.cui)) out.set(row.cui, row.county_name);
  }
  return out;
};

export const makeCompanySearchReader = (db: Db): CompanySearchReadPort => ({
  readSearchCompanies: async (cuis, scope, withValues) => {
    const requested = [...new Set(cuis)];
    const parents = new Map<string, SearchCuiParent>(
      requested.map((cui) => [cui, { kind: 'none' } as const])
    );
    if (requested.length === 0) return ok(parents);
    try {
      // Every kind: a known non-public parent (a NULL class fails closed)
      // withholds the identity independently of its company contribution.
      const rows = await sql<ParentRow>`
        select o.cui, o.kind, ${organizationRowIsPublic('o.privacy_class')} as is_public,
               o.name as core_name
        from core.organizations o
        where ${inTextList(sql`o.cui`, requested)}`.execute(db);
      const companies = new Map<string, string>();
      for (const row of rows.rows) {
        if (row.is_public !== true) {
          parents.set(row.cui, { kind: 'private' });
          companies.delete(row.cui);
        } else if (
          // The company contribution applies only to the ONRC company shape
          // (2–10 digits); a public company outside it contributes nothing
          // here (its privacy was still classified above).
          row.kind === 'company' &&
          isOnrcQualifiedCui(row.cui) &&
          parents.get(row.cui)?.kind !== 'private'
        ) {
          companies.set(row.cui, row.core_name);
        }
      }
      const companyCuis = [...companies.keys()];
      if (!withValues || !isPublished(scope) || companyCuis.length === 0) {
        for (const cui of companyCuis) parents.set(cui, { kind: 'company', values: null });
        return ok(parents);
      }
      const editionId = scope.editionId;
      const [profiles, active, identifiers, institutionCounties] = await Promise.all([
        sql<ProfileColumnsRow>`
          select ${profileColumns}
          from companies_v2.onrc_published_profiles p
          where p.edition_id = ${editionParam(editionId)}
            and ${inTextList(sql`p.cui`, companyCuis)}`.execute(db),
        readActiveCuis(db, editionId, companyCuis),
        readSearchIdentifiers(db, editionId, companyCuis),
        readInstitutionCounties(db, companyCuis),
      ]);
      const profileByCui = new Map(
        profiles.rows.flatMap((row) => (row.p_cui === null ? [] : [[row.p_cui, row] as const]))
      );
      for (const [cui, coreName] of companies) {
        const row = profileByCui.get(cui);
        parents.set(cui, {
          kind: 'company',
          values: companySearchValues({
            coreName,
            profile: row === undefined ? null : profileFromRow(row),
            hasActiveObservation: active.has(cui),
            identifiers: identifiers.get(cui) ?? [],
          }),
          independentCountyName: institutionCounties.get(cui) ?? null,
        });
      }
      return ok(parents);
    } catch (error) {
      // A view, column or grant lost under the pin moves the scope (re-pinned once).
      if (isCapabilityError(error)) return err(registryCapabilityLost());
      return err(databaseError('company search hydration failed', error));
    }
  },
});
