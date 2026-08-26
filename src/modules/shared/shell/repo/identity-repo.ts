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
import {
  MAX_SERVED_CUI_DIGITS,
  isWithheldOrganizationIdentifier,
  type Cui,
  type OrgIdentifier,
  type OrgNameMatch,
  type Organization,
  type Territory,
} from '../../core/types.js';

import type { IdentityRepo, OrgResolution } from '../../core/ports.js';
import type { ProdDatabase } from '../db/types.js';

type Db = Kysely<ProdDatabase>;

const MAX_NAME_FALLBACK_SCAN = 200;

/**
 * Per-STATEMENT chunk size for `findManyByCui` — a bound on the IN-list handed
 * to the planner, never a bound on the answer (the lookup chunks past it).
 *
 * Sized from the measured consumer need: the procurement leaderboard asks for
 * `PROCUREMENT_RANKINGS_TOP_N` = 100 buyers plus 100 suppliers, so 250 serves
 * every real request in one round trip. Re-validate if a consumer starts asking
 * for thousands.
 */
const MAX_IDENTITY_BATCH = 250;

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

/**
 * Withheld identities never leave this repo (P0 containment, 2026-07-22).
 *
 * The gate lives at the REPO boundary, not in each use case, because
 * `core.organizations` is `privacy_class='public'` on every row — including the
 * 117,688 CNP-shaped ones — so nothing downstream can tell a withheld identity
 * from a servable one by looking at the row. Fail-closed here means a future
 * caller inherits containment instead of having to remember it.
 *
 * Rows are dropped, not errored: this is the OUTPUT side. The typed categorical
 * refusal belongs to the single-identity probes (`entity`,
 * `referenceOrganization`), which reject before they ever reach the repo.
 */
const withheld = (org: Organization | null): Organization | null =>
  org?.cui != null && isWithheldOrganizationIdentifier(org.cui) ? null : org;

export const makeIdentityRepo = (db: Db): IdentityRepo => ({
  async findByCui(cui: Cui): Promise<Result<Organization | null, ApiError>> {
    if (isWithheldOrganizationIdentifier(cui)) return ok(null);
    try {
      const row = await db
        .selectFrom('core.organizations')
        .select([...ORG_COLUMNS])
        .where('cui', '=', cui)
        // PIN the privacy class rather than inferring it from identifier
        // length. A no-op on today's data — every `restricted` organization
        // also carries a >10-digit CUI, so the guard above already excludes all
        // 117,688 of them — which is precisely why it must not be relied on:
        // the two populations are maintained independently and nothing forces
        // them to stay identical. Fails CLOSED on an unexpected value (NULL
        // included); measured 2026-08-26, prod carries only 'public' and
        // 'restricted'.
        .where('privacy_class', '=', 'public')
        .limit(1)
        .executeTakeFirst();
      return ok(row === undefined ? null : mapOrg(row));
    } catch (error) {
      return err(databaseError('findByCui failed', error));
    }
  },

  async findManyByCui(
    cuis: readonly Cui[]
  ): Promise<Result<ReadonlyMap<Cui, Organization>, ApiError>> {
    // Withheld ids are dropped BEFORE the query, not filtered after: they must
    // not appear in the statement at all. De-duped because a leaderboard can ask
    // for the same party twice.
    const servable = [...new Set(cuis.filter((c) => !isWithheldOrganizationIdentifier(c)))];
    if (servable.length === 0) return ok(new Map());
    try {
      const byCui = new Map<Cui, Organization>();
      // CHUNKED, not truncated. `MAX_IDENTITY_BATCH` bounds the IN-list the
      // planner sees, but silently dropping the overflow would answer
      // "unidentified" for real organizations with no way for the caller to
      // know — a silent cap, which this platform forbids. Chunking keeps the
      // statement bounded AND the answer complete; a caller asking for 600 ids
      // pays 3 statements instead of losing 350 names.
      for (let i = 0; i < servable.length; i += MAX_IDENTITY_BATCH) {
        const chunk = servable.slice(i, i + MAX_IDENTITY_BATCH);
        const rows = await db
          .selectFrom('core.organizations')
          .select([...ORG_COLUMNS])
          .where('cui', 'in', chunk)
          // Same pin as `findByCui`, and NOT redundant with it: this is the
          // method the `organizationByCui` DataLoader actually calls, so an
          // invariant enforced only on the single-row lookup would leave the
          // GraphQL batch path unguarded.
          .where('privacy_class', '=', 'public')
          .execute();
        for (const row of rows) {
          const org = mapOrg(row);
          // `cui` is NOT NULL for every row reachable by this predicate, but the
          // column is nullable — key defensively rather than assert.
          if (org.cui !== null) byCui.set(org.cui, org);
        }
      }
      return ok(byCui);
    } catch (error) {
      // Deliberately an error, never an empty map: a DB failure that degrades to
      // "no such organization" would render every party as unidentified and look
      // like a data gap instead of an outage.
      return err(databaseError('findManyByCui failed', error));
    }
  },

  async findByOrgId(orgId: string): Promise<Result<Organization | null, ApiError>> {
    try {
      const row = await db
        .selectFrom('core.organizations')
        .select([...ORG_COLUMNS])
        .where('org_id', '=', orgId)
        // Same pin as the CUI lookups: an opaque surrogate is not a licence to
        // serve a restricted identity.
        .where('privacy_class', '=', 'public')
        .limit(1)
        .executeTakeFirst();
      // org_id is an opaque surrogate, so the caller cannot pre-screen it — the
      // withheld check has to happen on the ROW here.
      return ok(row === undefined ? null : withheld(mapOrg(row)));
    } catch (error) {
      return err(databaseError('findByOrgId failed', error));
    }
  },

  async getIdentifiers(orgId: string): Promise<Result<readonly OrgIdentifier[], ApiError>> {
    try {
      const rows = await db
        .selectFrom('core.organization_identifiers as oi')
        // Joined to the spine on purpose: `org_id` is an opaque surrogate, so a
        // caller holding one from anywhere else could otherwise retrieve exactly
        // the ONRC identifiers this containment exists to withhold. Identifiers
        // ARE identity — gating only the name would be theatre.
        .innerJoin('core.organizations as o', 'o.org_id', 'oi.org_id')
        .select(['oi.scheme', 'oi.value', 'oi.source'])
        .where('oi.org_id', '=', orgId)
        .where(sql<boolean>`(o.cui is null or length(o.cui) <= ${sql.lit(MAX_SERVED_CUI_DIGITS)})`)
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
        // Withheld identities are excluded in SQL rather than filtered after the
        // fact: a free-text name search is the highest-exposure path in this repo
        // (a common surname would otherwise return natural persons), and a
        // post-scan filter would also let them consume the scan cap and silently
        // starve real matches. NULL-cui orgs are servable — the rule is about
        // CNP-SHAPED identifiers, not about missing ones.
        .where(sql<boolean>`(cui is null or length(cui) <= ${sql.lit(MAX_SERVED_CUI_DIGITS)})`)
        // AND the declared class, not only the identifier shape. The two
        // populations coincide today (measured 2026-08-26: every `restricted`
        // organization also has a >10-digit CUI) and are maintained separately,
        // so relying on the shape alone would make privacy an accident.
        .where('privacy_class', '=', 'public')
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
    const asCui = cuiOrName
      .toUpperCase()
      .trim()
      .replace(/^RO/u, '')
      .replace(/[^0-9]/gu, '');
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
    // A withheld identity's locality is personal data in its own right — the
    // home address of a sole trader. Short-circuit rather than rely on the
    // public_entities join happening to miss.
    if (isWithheldOrganizationIdentifier(cui)) return ok(null);
    try {
      const row = await db
        .selectFrom('core.public_entities as pe')
        .innerJoin(
          'core.territories as t',
          't.territorial_siruta_code',
          'pe.territorial_siruta_code'
        )
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
