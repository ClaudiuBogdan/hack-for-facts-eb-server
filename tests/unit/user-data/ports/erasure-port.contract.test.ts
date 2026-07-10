import { erasurePortContractCases } from '../../../contracts/user-data/erasure-port.contract.js';
import { makeFakeUserDataStore } from '../../../fixtures/user-data/index.js';
import { describePortContract, makeSequentialIds, makeTestClock } from '../../../support/index.js';

describePortContract('UserDataErasurePort', erasurePortContractCases, {
  fake: () => {
    const fake = makeFakeUserDataStore({
      clock: makeTestClock(new Date('2026-01-01T00:00:00.000Z')),
      ids: makeSequentialIds('contract'),
    });
    return {
      port: fake,
      reset: () => {
        fake.reset();
      },
    };
  },
});
