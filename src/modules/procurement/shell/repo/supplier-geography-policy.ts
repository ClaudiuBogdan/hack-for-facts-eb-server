/**
 * Procurement — may a supplier's registered-office geography be served?
 *
 * The policy is the organization registry's: a supplier's place is public
 * only for a PUBLIC organization (the companies profile pins
 * `core.organizations.privacy_class = 'public'` before serving the same
 * registered-office territory). The analysis build carries supplier places
 * but no organization class, so ClickHouse filters on the identifier rule
 * the registry classifier stamps the class FROM (scrapper
 * `registryRowPrivacyClass`: restricted ⟺ an identifier longer than 10
 * digits).
 *
 * What this reader checks, and what it does not:
 *  - it checks the CLASS side on the live registry, with the kernel's own
 *    predicates: no servable identifier may belong to a non-public (or
 *    unclassified) organization. A verified answer is kept ten minutes, so a
 *    registry reclassification is caught within that window, not instantly.
 *    A failed read withholds supplier geography (fail closed) and is never
 *    kept;
 *  - it does NOT check COVERAGE — that every supplier identity carrying a
 *    place in the published build has an organization row at all. That is
 *    proven for build 13 only (all 210,609 such identities are public
 *    organizations). Every later publication needs the same proof, or the
 *    organization class carried into the build.
 */

import { sql, type Kysely, type SqlBool } from 'kysely';
import { err, ok, type Result } from 'neverthrow';

import {
  databaseError,
  organizationIdentifierIsServable,
  organizationRowIsPublic,
  type ApiError,
  type Logger,
  type ProdDatabase,
} from '@/modules/shared/index.js';

/** How long a verified registry invariant is trusted (registry loads are rare). */
export const SUPPLIER_GEOGRAPHY_POLICY_TTL_MS = 10 * 60 * 1000;

export interface SupplierGeographyPolicy {
  /** True when every servable organization identifier is public. */
  supplierGeographyPublic(): Promise<Result<boolean, ApiError>>;
}

export const makeSupplierGeographyPolicy = (
  db: Kysely<ProdDatabase>,
  now: () => number = Date.now,
  logger?: Logger
): SupplierGeographyPolicy => {
  let cache: { readonly value: boolean; readonly expiresAt: number } | null = null;
  let inFlight: Promise<Result<boolean, ApiError>> | null = null;

  const read = async (): Promise<Result<boolean, ApiError>> => {
    try {
      // A NULL class is not public (`organizationRowIsPublic` is NULL there,
      // so the `is not true` keeps it a violation rather than dropping it).
      const row = await db
        .selectFrom('core.organizations as o')
        .select(sql<boolean>`true`.as('violation'))
        .where(organizationIdentifierIsServable('o.cui'))
        .where(sql<SqlBool>`(${organizationRowIsPublic('o.privacy_class')}) is not true`)
        .limit(1)
        .executeTakeFirst();
      const value = row === undefined;
      if (!value) {
        logger?.warn(
          { operation: 'supplierGeographyPublic' },
          'organization registry has a servable non-public identifier; supplier geography withheld'
        );
      }
      cache = { value, expiresAt: now() + SUPPLIER_GEOGRAPHY_POLICY_TTL_MS };
      return ok(value);
    } catch (error) {
      return err(databaseError('supplier geography policy read failed', error));
    }
  };

  return {
    supplierGeographyPublic: () => {
      if (cache !== null && cache.expiresAt > now()) return Promise.resolve(ok(cache.value));
      if (inFlight !== null) return inFlight;
      inFlight = read().finally(() => {
        inFlight = null;
      });
      return inFlight;
    },
  };
};
