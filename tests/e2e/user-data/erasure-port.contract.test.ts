import { makeUserDataErasureRepo } from '@/modules/user-data/shell/repo/kysely-user-data-erasure-repo.js';
import { makeUserDataMutationRepo } from '@/modules/user-data/shell/repo/kysely-user-data-mutation-repo.js';
import { makeUserDataReadRepo } from '@/modules/user-data/shell/repo/kysely-user-data-read-repo.js';

import { isDockerAvailable, truncateUserDataTables } from './contract-db.js';
import { erasurePortContractCases } from '../../contracts/user-data/erasure-port.contract.js';
import { setupTestDatabase } from '../../infra/test-db.js';
import { describePortContract, makeTestClock } from '../../support/index.js';

const START = new Date('2026-01-01T00:00:00.000Z');

describePortContract('UserDataErasurePort', erasurePortContractCases, {
  real: {
    when: isDockerAvailable,
    make: async () => {
      const { userDb } = await setupTestDatabase();
      const clock = makeTestClock(START);
      const port = Object.assign(
        makeUserDataMutationRepo({ db: userDb, clock }),
        makeUserDataReadRepo({ db: userDb }),
        makeUserDataErasureRepo({ db: userDb })
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
