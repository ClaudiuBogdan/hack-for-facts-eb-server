import { makeSubscriptionRepo } from '@/modules/notification-platform/shell/repo/subscription-repo.js';

import { isDockerAvailable, truncatePlatformTables } from './contract-db.js';
import { subscriptionRepoContractCases } from '../../contracts/notification-platform/subscription-repo.contract.js';
import { setupTestDatabase } from '../../infra/test-db.js';
import { describePortContract } from '../../support/index.js';

describePortContract('SubscriptionRepo', subscriptionRepoContractCases, {
  real: {
    when: isDockerAvailable,
    make: async () => {
      const { userDb } = await setupTestDatabase();
      return { port: makeSubscriptionRepo(userDb), reset: () => truncatePlatformTables(userDb) };
    },
  },
});
