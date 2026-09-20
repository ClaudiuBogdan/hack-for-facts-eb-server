import { sql, type Kysely } from 'kysely';
import { err, ok } from 'neverthrow';

import { databaseError, invalidInput, type ProdDatabase } from '@/modules/shared/index.js';

import { mapPublicRegistryRecord, publicRegistryRecords } from './registry-repo.js';

import type { NgoProfileRepository } from '../../core/ports.js';
import type { NgoProfileOverview } from '../../core/types.js';

export const makeNgoProfileRepo = (
  db: Kysely<ProdDatabase>,
  enabled: boolean
): NgoProfileRepository => ({
  async overview(cui) {
    if (!enabled) return err(invalidInput('NGO profiles are not published yet.', 'ngoProfile'));
    try {
      // One statement keeps current registry admission and fiscal data on one DB snapshot.
      const rows = await publicRegistryRecords(db)
        .innerJoin('core.organizations as identity', 'identity.cui', 'r.linked_organization_cui')
        .where('identity.privacy_class', '=', 'public')
        .leftJoin('ngo.public_fiscal_status as f', (join) =>
          join.onRef('f.cui', '=', 'r.linked_organization_cui').on('f.privacy_class', '=', 'public')
        )
        .select([
          'f.cui as fiscal_cui',
          'f.is_vat_payer',
          'f.is_inactive',
          'f.is_split_vat',
          'f.main_caen_code',
          'f.main_caen_rev',
          'f.source_url as fiscal_source_url',
          'f.source_snapshot_id as fiscal_snapshot_id',
          sql<string | null>`f.status_date::text`.as('query_date'),
          sql<string | null>`f.retrieved_at::text`.as('fiscal_captured_at'),
        ])
        .where('r.linked_organization_cui', '=', cui)
        .where('r.is_current', '=', true)
        .orderBy('r.source_row_number', 'asc')
        .execute();
      const first = rows[0];
      if (first === undefined) return ok(null);
      let fiscal: NgoProfileOverview['fiscal'] = { availability: 'unavailable', data: null };
      if (first.fiscal_cui !== null) {
        if (first.fiscal_source_url === null || first.fiscal_snapshot_id === null)
          return err(databaseError('Published NGO fiscal observation has incomplete provenance.'));
        fiscal = {
          availability: 'available',
          data: {
            vatPayer: first.is_vat_payer,
            declaredFiscallyInactive: first.is_inactive,
            splitVat: first.is_split_vat,
            mainCaenCode: first.main_caen_code,
            mainCaenRev: first.main_caen_rev,
            queryDate: first.query_date,
            capturedAt:
              first.fiscal_captured_at === null
                ? null
                : new Date(first.fiscal_captured_at).toISOString(),
            sourceUrl: first.fiscal_source_url,
            sourceSnapshotId: first.fiscal_snapshot_id,
          },
        };
      }
      return ok({
        cui,
        identityBasis: 'accepted_rnong_cui',
        registryRecords: rows.map(mapPublicRegistryRecord),
        fiscal,
        sections: (['financials', 'services', 'accreditations', 'funding'] as const).map((key) => ({
          key,
          availability: 'not_released' as const,
        })),
      });
    } catch (error) {
      return err(databaseError('NGO profile read failed', error));
    }
  },
});
