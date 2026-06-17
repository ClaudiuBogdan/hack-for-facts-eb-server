/**
 * Shared Kernel — Identity repo (foundation §4.1, §15.3, §15.7).
 *
 * CUI-keyed organization identity over `core.organizations` +
 * `core.organization_identifiers`, plus the CUI→territory join (§15.3) via
 * `core.public_entities.territorial_siruta_code → core.territories`.
 *
 * Name search is the BOUNDED pg fallback for the Meili-primary path (§15.7):
 * it folds diacritics in TS and matches a capped scan on `normalized_name`
 * (no `unaccent`, no trigram-index assumption).
 */

import { sql, type Kysely } from 'kysely';
import { err, ok, type Result } from 'neverthrow';

import { foldDiacritics } from './fold.js';
import { databaseError, type ApiError } from '../../core/errors.js';


import type { IdentityRepo, OrgResolution } from '../../core/ports.js';
import type { Cui, OrgIdentifier, OrgNameMatch, Organization, Territory } from '../../core/types.js';
import type { ProdDatabase } from '../db/types.js';

type Db = Kysely<ProdDatabase>;

const MAX_NAME_FALLBACK_SCAN = 200;

const mapOrg = (row: {
  org_id: string;
  cui: string | null;
  registration_number: string | null;
  kind: string;
  name: string;
  normalized_name: string | null;
  county_name: string | null;
  locality_name: string | null;
  siruta_code: number | null;
  first_seen_source: string;
  attrs: Record<string, unknown>;
}): Organization => ({
  orgId: row.org_id,
  cui: row.cui,
  registrationNumber: row.registration_number,
  kind: row.kind,
  name: row.name,
  normalizedName: row.normalized_name,
  countyName: row.county_name,
  localityName: row.locality_name,
  sirutaCode: row.siruta_code === null ? null : String(row.siruta_code),
  firstSeenSource: row.first_seen_source,
  attrs: row.attrs,
});

const ORG_COLUMNS = [
  'org_id',
  'cui',
  'registration_number',
  'kind',
  'name',
  'normalized_name',
  'county_name',
  'locality_name',
  'siruta_code',
  'first_seen_source',
  'attrs',
] as const;

export const makeIdentityRepo = (db: Db): IdentityRepo => ({
  async findByCui(cui: Cui): Promise<Result<Organization | null, ApiError>> {
    try {
      const row = await db
        .selectFrom('core.organizations')
        .select([...ORG_COLUMNS])
        .where('cui', '=', cui)
        .limit(1)
        .executeTakeFirst();
      return ok(row === undefined ? null : mapOrg(row));
    } catch (error) {
      return err(databaseError('findByCui failed', error));
    }
  },

  async findByOrgId(orgId: string): Promise<Result<Organization | null, ApiError>> {
    try {
      const row = await db
        .selectFrom('core.organizations')
        .select([...ORG_COLUMNS])
        .where('org_id', '=', orgId)
        .limit(1)
        .executeTakeFirst();
      return ok(row === undefined ? null : mapOrg(row));
    } catch (error) {
      return err(databaseError('findByOrgId failed', error));
    }
  },

  async getIdentifiers(orgId: string): Promise<Result<readonly OrgIdentifier[], ApiError>> {
    try {
      const rows = await db
        .selectFrom('core.organization_identifiers')
        .select(['scheme', 'value', 'source'])
        .where('org_id', '=', orgId)
        .execute();
      return ok(rows.map((r) => ({ scheme: r.scheme, value: r.value, source: r.source })));
    } catch (error) {
      return err(databaseError('getIdentifiers failed', error));
    }
  },

  async searchByName(q: string, limit: number): Promise<Result<readonly OrgNameMatch[], ApiError>> {
    const folded = foldDiacritics(q);
    if (folded === '') return ok([]);
    try {
      // `normalized_name` is loader-folded (diacritics stripped), so a folded
      // needle ILIKE matches diacritic rows correctly. Bounded scan, then
      // TS-side fold rank. No unaccent / no trigram-index reliance (§15.7).
      const rows = await db
        .selectFrom('core.organizations')
        .select(['org_id', 'cui', 'name', 'normalized_name', 'county_name', 'kind'])
        .where(
          sql<boolean>`coalesce(normalized_name, name) ilike ${'%' + folded.replace(/[%_\\]/gu, '\\$&') + '%'} escape '\\'`
        )
        .limit(MAX_NAME_FALLBACK_SCAN)
        .execute();

      const ranked = rows
        .map((r) => {
          const hay = foldDiacritics(r.normalized_name ?? r.name);
          const idx = hay.indexOf(folded);
          // prefix matches rank higher; shorter names rank higher on ties.
          const score = idx < 0 ? 0 : 1 / (1 + idx) + 1 / (1 + hay.length);
          return {
            match: {
              orgId: r.org_id,
              cui: r.cui,
              name: r.name,
              normalizedName: r.normalized_name,
              countyName: r.county_name,
              kind: r.kind,
              score,
            } satisfies OrgNameMatch,
            score,
          };
        })
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
        .map((x) => x.match);

      return ok(ranked);
    } catch (error) {
      return err(databaseError('searchByName failed', error));
    }
  },

  async resolve(cuiOrName: string): Promise<Result<OrgResolution | null, ApiError>> {
    // A pure-digit (after RO strip) input is treated as a CUI; else name search.
    const asCui = cuiOrName.toUpperCase().trim().replace(/^RO/u, '').replace(/[^0-9]/gu, '');
    if (asCui.length > 0 && asCui === cuiOrName.toUpperCase().trim().replace(/^RO/u, '')) {
      const byCui = await this.findByCui(asCui);
      if (byCui.isErr()) return err(byCui.error);
      if (byCui.value !== null) return ok({ org: byCui.value, confidence: 1 });
    }
    const byName = await this.searchByName(cuiOrName, 1);
    if (byName.isErr()) return err(byName.error);
    const top = byName.value[0];
    if (top === undefined) return ok(null);
    const full = await this.findByOrgId(top.orgId);
    if (full.isErr()) return err(full.error);
    if (full.value === null) return ok(null);
    return ok({ org: full.value, confidence: Math.min(0.9, top.score ?? 0.5) });
  },

  async territoryForCui(cui: Cui): Promise<Result<Territory | null, ApiError>> {
    try {
      const row = await db
        .selectFrom('core.public_entities as pe')
        .innerJoin('core.territories as t', 't.territorial_siruta_code', 'pe.territorial_siruta_code')
        .select([
          't.id',
          't.territorial_siruta_code',
          't.siruta_code',
          't.county_siruta_code',
          't.uat_code',
          't.name',
          't.county_code',
          't.county_name',
          't.region',
          't.population',
        ])
        .where('pe.cui', '=', cui)
        .where('pe.territorial_siruta_code', 'is not', null)
        .limit(1)
        .executeTakeFirst();

      if (row === undefined) return ok(null);
      return ok({
        id: row.id,
        territorialSirutaCode: row.territorial_siruta_code,
        sirutaCode: row.siruta_code,
        countySirutaCode: row.county_siruta_code,
        uatCode: row.uat_code,
        name: row.name,
        countyCode: row.county_code,
        countyName: row.county_name,
        region: row.region,
        population: row.population,
      });
    } catch (error) {
      return err(databaseError('territoryForCui failed', error));
    }
  },
});
