/**
 * Entity Profile Repository Implementation
 *
 * Kysely-based implementation for curated entity website profile reads.
 */

import { ok, err, type Result } from 'neverthrow';

import { setStatementTimeout } from '@/infra/database/query-builders/index.js';

import {
  createDatabaseError,
  createTimeoutError,
  isTimeoutError,
  type EntityError,
} from '../../core/errors.js';

import type { EntityProfileRepository } from '../../core/ports.js';
import type { EntityProfile } from '../../core/types.js';
import type { BudgetDbClient } from '@/infra/database/client.js';

const QUERY_TIMEOUT_MS = 30_000;

interface EntityProfileRow {
  cui: string;
  institution_type: string | null;
  website_url: string | null;
  official_email: string | null;
  phone_primary: string | null;
  address_raw: string | null;
  address_locality: string | null;
  county_code: string | null;
  county_name: string | null;
  leader_name: string | null;
  leader_title: string | null;
  leader_party: string | null;
  scraped_at: unknown;
  extraction_confidence: string | number | null;
}

class KyselyEntityProfileRepo implements EntityProfileRepository {
  constructor(private readonly db: BudgetDbClient) {}

  async getByEntityCui(cui: string): Promise<Result<EntityProfile | null, EntityError>> {
    try {
      await setStatementTimeout(this.db, QUERY_TIMEOUT_MS);

      const row = await this.db
        .selectFrom('entityprofiles')
        .select([
          'cui',
          'institution_type',
          'website_url',
          'official_email',
          'phone_primary',
          'address_raw',
          'address_locality',
          'county_code',
          'county_name',
          'leader_name',
          'leader_title',
          'leader_party',
          'scraped_at',
          'extraction_confidence',
        ])
        .where('cui', '=', cui)
        .executeTakeFirst();

      if (row === undefined) {
        return ok(null);
      }

      return ok(this.mapRowToEntityProfile(row as unknown as EntityProfileRow));
    } catch (error) {
      return this.handleQueryError(error, 'getByEntityCui');
    }
  }

  async getByEntityCuis(cuis: string[]): Promise<Result<Map<string, EntityProfile>, EntityError>> {
    if (cuis.length === 0) {
      return ok(new Map());
    }

    try {
      await setStatementTimeout(this.db, QUERY_TIMEOUT_MS);

      const rows = await this.db
        .selectFrom('entityprofiles')
        .select([
          'cui',
          'institution_type',
          'website_url',
          'official_email',
          'phone_primary',
          'address_raw',
          'address_locality',
          'county_code',
          'county_name',
          'leader_name',
          'leader_title',
          'leader_party',
          'scraped_at',
          'extraction_confidence',
        ])
        .where('cui', 'in', [...new Set(cuis)])
        .execute();

      const map = new Map<string, EntityProfile>();
      for (const row of rows) {
        map.set(row.cui, this.mapRowToEntityProfile(row as unknown as EntityProfileRow));
      }

      return ok(map);
    } catch (error) {
      return this.handleQueryError(error, 'getByEntityCuis');
    }
  }

  private mapRowToEntityProfile(row: EntityProfileRow): EntityProfile {
    return {
      institution_type: row.institution_type,
      website_url: row.website_url,
      official_email: row.official_email,
      phone_primary: row.phone_primary,
      address_raw: row.address_raw,
      address_locality: row.address_locality,
      county_code: row.county_code,
      county_name: row.county_name,
      leader_name: row.leader_name,
      leader_title: row.leader_title,
      leader_party: row.leader_party,
      scraped_at: this.toIsoString(row.scraped_at),
      extraction_confidence:
        row.extraction_confidence === null
          ? null
          : Number.parseFloat(String(row.extraction_confidence)),
    };
  }

  private toIsoString(value: unknown): string {
    if (value instanceof Date) {
      return value.toISOString();
    }

    if (typeof value === 'string') {
      return value;
    }

    if (typeof value === 'object' && value !== null && 'toISOString' in value) {
      return (value as { toISOString: () => string }).toISOString();
    }

    return String(value);
  }

  private handleQueryError(error: unknown, operation: string): Result<never, EntityError> {
    if (isTimeoutError(error)) {
      return err(createTimeoutError(`Entity profile ${operation} query timed out`, error));
    }

    return err(createDatabaseError(`Entity profile ${operation} failed`, error));
  }
}

export const makeEntityProfileRepo = (db: BudgetDbClient): EntityProfileRepository => {
  return new KyselyEntityProfileRepo(db);
};
