import { makeChannelDestinationRepo } from '@/modules/notification-platform/shell/repo/channel-destination-repo.js';

import { isDockerAvailable, truncatePlatformTables } from './contract-db.js';
import { channelDestinationRepoContractCases } from '../../contracts/notification-platform/channel-destination-repo.contract.js';
import { setupTestDatabase } from '../../infra/test-db.js';
import { describePortContract } from '../../support/index.js';

describePortContract('ChannelDestinationRepo', channelDestinationRepoContractCases, {
  real: {
    when: isDockerAvailable,
    make: async () => {
      const { userDb } = await setupTestDatabase();
      return {
        port: makeChannelDestinationRepo(userDb),
        reset: () => truncatePlatformTables(userDb),
      };
    },
  },
});
