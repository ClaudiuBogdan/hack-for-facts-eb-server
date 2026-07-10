import { deliveryRepoContractCases } from '../../../contracts/notification-platform/delivery-repo.contract.js';
import { makeFakeDeliveryRepo } from '../../../fixtures/notification-platform/fakes.js';
import { makeTestClock, describePortContract } from '../../../support/index.js';

describePortContract('DeliveryRepo', deliveryRepoContractCases, {
  fake: () => {
    const fake = makeFakeDeliveryRepo({ clock: makeTestClock() });
    return {
      port: fake,
      reset: () => {
        fake.store.clear();
      },
    };
  },
});
