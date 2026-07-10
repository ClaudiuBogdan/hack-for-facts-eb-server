import { makeLogicalNotificationRepo } from '@/modules/notification-platform/shell/repo/logical-notification-repo.js';

import { isDockerAvailable, seedContractEvent, truncatePlatformTables } from './contract-db.js';
import { CONTRACT_EVENT_ID } from '../../contracts/notification-platform/event-repo.contract.js';
import { logicalNotificationRepoContractCases } from '../../contracts/notification-platform/logical-notification-repo.contract.js';
import { setupTestDatabase } from '../../infra/test-db.js';
import { describePortContract } from '../../support/index.js';

describePortContract('LogicalNotificationRepo', logicalNotificationRepoContractCases, {
  real: {
    when: isDockerAvailable,
    make: async () => {
      const { userDb } = await setupTestDatabase();
      return {
        port: makeLogicalNotificationRepo(userDb),
        reset: async () => {
          await truncatePlatformTables(userDb);
          await seedContractEvent(userDb, CONTRACT_EVENT_ID);
        },
      };
    },
  },
});
