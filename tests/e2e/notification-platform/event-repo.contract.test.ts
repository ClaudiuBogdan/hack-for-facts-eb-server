import { makeNotificationEventRepo } from '@/modules/notification-platform/shell/repo/notification-event-repo.js';

import { isDockerAvailable, truncatePlatformTables } from './contract-db.js';
import { eventRepoContractCases } from '../../contracts/notification-platform/event-repo.contract.js';
import { setupTestDatabase } from '../../infra/test-db.js';
import { describePortContract } from '../../support/index.js';

describePortContract('NotificationEventRepo', eventRepoContractCases, {
  real: {
    when: isDockerAvailable,
    make: async () => {
      const { userDb } = await setupTestDatabase();
      return {
        port: makeNotificationEventRepo(userDb),
        reset: () => truncatePlatformTables(userDb),
      };
    },
  },
});
