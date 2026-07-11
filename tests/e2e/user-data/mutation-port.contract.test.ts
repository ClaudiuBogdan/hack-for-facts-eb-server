import { type UserDataError } from '@/modules/user-data/core/errors.js';
import {
  makeUserDataMutationRepo,
  UserDataErrorSignal,
} from '@/modules/user-data/shell/repo/kysely-user-data-mutation-repo.js';
import { makeUserDataReadRepo } from '@/modules/user-data/shell/repo/kysely-user-data-read-repo.js';

import { isDockerAvailable, truncateUserDataTables, userDataStateCounts } from './contract-db.js';
import { mutationPortContractCases } from '../../contracts/user-data/mutation-port.contract.js';
import { setupTestDatabase } from '../../infra/test-db.js';
import { describePortContract, makeTestClock } from '../../support/index.js';

const START = new Date('2026-01-01T00:00:00.000Z');

describePortContract('UserDataMutationPort', mutationPortContractCases, {
  real: {
    when: isDockerAvailable,
    make: async () => {
      const { userDb } = await setupTestDatabase();
      const clock = makeTestClock(START);
      let nextFailure: UserDataError | undefined;
      const mutation = makeUserDataMutationRepo({
        db: userDb,
        clock,
        testHooks: {
          beforePhase: async (phase) => {
            if (phase !== 'receipt' || nextFailure === undefined) return;
            const failure = nextFailure;
            nextFailure = undefined;
            throw new UserDataErrorSignal(failure);
          },
        },
      });
      const port = Object.assign(mutation, makeUserDataReadRepo({ db: userDb }), {
        contractControls: {
          advanceDays: (days: number): void => {
            clock.advance(days * 24 * 60 * 60 * 1000);
          },
          failNextCommit: (error: UserDataError): void => {
            nextFailure = error;
          },
          stateCounts: () => userDataStateCounts(userDb),
        },
      });
      return {
        port,
        reset: async () => {
          await truncateUserDataTables(userDb);
          clock.set(START);
          nextFailure = undefined;
        },
      };
    },
  },
});
