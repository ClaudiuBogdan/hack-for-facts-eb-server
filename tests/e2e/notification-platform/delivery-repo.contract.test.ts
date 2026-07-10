import { makeDeliveryRepo } from '@/modules/notification-platform/shell/repo/delivery-repo.js';

import {
  isDockerAvailable,
  seedContractEvent,
  seedContractLogical,
  truncatePlatformTables,
} from './contract-db.js';
import {
  DELIVERY_LOGICAL_PARENT_ID,
  deliveryRepoContractCases,
} from '../../contracts/notification-platform/delivery-repo.contract.js';
import { CONTRACT_EVENT_ID } from '../../contracts/notification-platform/event-repo.contract.js';
import { setupTestDatabase } from '../../infra/test-db.js';
import { describePortContract } from '../../support/index.js';

describePortContract('DeliveryRepo', deliveryRepoContractCases, {
  real: {
    when: isDockerAvailable,
    make: async () => {
      const { userDb } = await setupTestDatabase();
      return {
        port: makeDeliveryRepo(userDb),
        reset: async () => {
          await truncatePlatformTables(userDb);
          await seedContractEvent(userDb, CONTRACT_EVENT_ID);
          await seedContractLogical(userDb, {
            id: DELIVERY_LOGICAL_PARENT_ID,
            eventId: CONTRACT_EVENT_ID,
            kindId: 'delivery-contract-parent',
            userId: 'contract-user',
          });
        },
      };
    },
  },
});
