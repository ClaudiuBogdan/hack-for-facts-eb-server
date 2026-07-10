import { subscriptionRepoContractCases } from '../../../contracts/notification-platform/subscription-repo.contract.js';
import { makeFakeSubscriptionRepo } from '../../../fixtures/notification-platform/fakes.js';
import { describePortContract } from '../../../support/index.js';

describePortContract('SubscriptionRepo', subscriptionRepoContractCases, {
  fake: () => {
    const fake = makeFakeSubscriptionRepo();
    return {
      port: fake,
      reset: () => {
        fake.store.clear();
      },
    };
  },
});
