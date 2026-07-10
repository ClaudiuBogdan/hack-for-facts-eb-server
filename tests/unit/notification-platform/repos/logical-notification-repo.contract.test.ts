import { logicalNotificationRepoContractCases } from '../../../contracts/notification-platform/logical-notification-repo.contract.js';
import { makeFakeLogicalNotificationRepo } from '../../../fixtures/notification-platform/fakes.js';
import { describePortContract } from '../../../support/index.js';

describePortContract('LogicalNotificationRepo', logicalNotificationRepoContractCases, {
  fake: () => {
    const fake = makeFakeLogicalNotificationRepo();
    return {
      port: fake,
      reset: () => {
        fake.store.clear();
      },
    };
  },
});
