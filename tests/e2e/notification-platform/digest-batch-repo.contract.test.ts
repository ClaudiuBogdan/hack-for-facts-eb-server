import { makeDigestBatchRepo } from '@/modules/notification-platform/shell/repo/digest-batch-repo.js';

import {
  isDockerAvailable,
  seedContractEvent,
  seedContractLogical,
  truncatePlatformTables,
} from './contract-db.js';
import { digestBatchRepoContractCases } from '../../contracts/notification-platform/digest-batch-repo.contract.js';
import { CONTRACT_EVENT_ID } from '../../contracts/notification-platform/event-repo.contract.js';
import { CONTRACT_LOGICAL_ID } from '../../contracts/notification-platform/logical-notification-repo.contract.js';
import { setupTestDatabase } from '../../infra/test-db.js';
import { describePortContract } from '../../support/index.js';

describePortContract('DigestBatchRepo', digestBatchRepoContractCases, {
  real: {
    when: isDockerAvailable,
    make: async () => {
      const { userDb } = await setupTestDatabase();
      return {
        port: makeDigestBatchRepo(userDb),
        reset: async () => {
          await truncatePlatformTables(userDb);
          await seedContractEvent(userDb, CONTRACT_EVENT_ID);
          await seedContractLogical(userDb, {
            id: CONTRACT_LOGICAL_ID,
            eventId: CONTRACT_EVENT_ID,
            kindId: 'digest-contract-member',
            userId: 'digest-user',
          });
        },
      };
    },
  },
});
