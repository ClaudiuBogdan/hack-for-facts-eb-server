import { digestBatchRepoContractCases } from '../../../contracts/notification-platform/digest-batch-repo.contract.js';
import { makeFakeDigestBatchRepo } from '../../../fixtures/notification-platform/fakes.js';
import { makeTestClock, describePortContract } from '../../../support/index.js';

describePortContract('DigestBatchRepo', digestBatchRepoContractCases, {
  fake: () => {
    const fake = makeFakeDigestBatchRepo({ clock: makeTestClock() });
    return {
      port: fake,
      reset: () => {
        fake.store.clear();
        fake.members.clear();
      },
    };
  },
});
