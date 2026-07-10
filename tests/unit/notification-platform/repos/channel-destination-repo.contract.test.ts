import { channelDestinationRepoContractCases } from '../../../contracts/notification-platform/channel-destination-repo.contract.js';
import { makeFakeChannelDestinationRepo } from '../../../fixtures/notification-platform/fakes.js';
import { makeSequentialIds, describePortContract } from '../../../support/index.js';

describePortContract('ChannelDestinationRepo', channelDestinationRepoContractCases, {
  fake: () => {
    const fake = makeFakeChannelDestinationRepo({
      ids: makeSequentialIds('destination'),
    });
    return {
      port: fake,
      reset: () => {
        fake.store.clear();
      },
    };
  },
});
