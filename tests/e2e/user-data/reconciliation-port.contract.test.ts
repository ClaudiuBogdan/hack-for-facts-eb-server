import { sql } from 'kysely';

import { makeUserDataMutationRepo } from '@/modules/user-data/shell/repo/kysely-user-data-mutation-repo.js';
import { makeUserDataReconciliationRepo } from '@/modules/user-data/shell/repo/kysely-user-data-reconciliation-repo.js';

import { isDockerAvailable, truncateUserDataTables } from './contract-db.js';
import { reconciliationPortContractCases } from '../../contracts/user-data/reconciliation-port.contract.js';
import { setupTestDatabase } from '../../infra/test-db.js';
import { describePortContract, makeTestClock } from '../../support/index.js';

const START = new Date('2026-01-01T00:00:00.000Z');

describePortContract('UserDataReconciliationPort', reconciliationPortContractCases, {
  real: {
    when: isDockerAvailable,
    make: async () => {
      const { userDb } = await setupTestDatabase();
      const clock = makeTestClock(START);
      const port = Object.assign(
        makeUserDataMutationRepo({ db: userDb, clock }),
        makeUserDataReconciliationRepo({ db: userDb, clock }),
        {
          contractControls: {
            corruptRevision: async (recordId: string, revision: number): Promise<void> => {
              await sql`UPDATE user_data_records SET revision = ${revision} WHERE record_id = ${recordId}::uuid`.execute(
                userDb
              );
            },
          },
        }
      );
      return {
        port,
        reset: async () => {
          await truncateUserDataTables(userDb);
          clock.set(START);
        },
      };
    },
  },
});
