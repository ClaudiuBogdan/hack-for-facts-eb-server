import { sql } from 'kysely';
import { err, ok } from 'neverthrow';

import { createDatabaseError } from '../../core/errors.js';
import { normalizeEmailAddress } from '../../core/usecases/helpers.js';

import type { InstitutionOfficialEmailLookup } from '../../core/ports.js';
import type { BudgetDbClient } from '@/infra/database/client.js';
import type { Logger } from 'pino';

export interface OfficialEmailLookupConfig {
  db: BudgetDbClient;
  logger: Logger;
}

export const makeOfficialEmailLookup = (
  config: OfficialEmailLookupConfig
): InstitutionOfficialEmailLookup => {
  const { db, logger } = config;
  const log = logger.child({ repo: 'OfficialEmailLookup' });

  return {
    async findEntitiesByOfficialEmails(emails) {
      const normalized = [
        ...new Set(emails.map(normalizeEmailAddress).filter((email) => email !== '')),
      ];
      if (normalized.length === 0) {
        return ok([]);
      }

      try {
        const rows = await db
          .selectFrom('entityprofiles')
          .select(['cui', 'official_email'])
          .where(
            sql<boolean>`lower(official_email) in (${sql.join(
              normalized.map((email) => sql`${email}`),
              sql`, `
            )})`
          )
          .execute();

        const matching = rows.flatMap((row) => {
          if (row.official_email === null) {
            return [];
          }

          return normalized.includes(normalizeEmailAddress(row.official_email))
            ? [{ entityCui: row.cui, officialEmail: row.official_email }]
            : [];
        });

        return ok(
          matching.filter(
            (row, index, all) =>
              all.findIndex(
                (candidate) =>
                  candidate.entityCui === row.entityCui &&
                  candidate.officialEmail === row.officialEmail
              ) === index
          )
        );
      } catch (error) {
        log.error({ error, emails }, 'Failed to find entity CUIs by official email');
        return err(createDatabaseError('Failed to find entity CUIs by official email', error));
      }
    },
  };
};
