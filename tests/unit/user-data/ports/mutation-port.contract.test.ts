import {
  mutationPortContractCases,
  type MutationContractPort,
} from '../../../contracts/user-data/mutation-port.contract.js';
import { makeFakeUserDataStore } from '../../../fixtures/user-data/index.js';
import { describePortContract, makeSequentialIds, makeTestClock } from '../../../support/index.js';

const START = new Date('2026-01-01T00:00:00.000Z');

describePortContract('UserDataMutationPort', mutationPortContractCases, {
  fake: () => {
    const clock = makeTestClock(START);
    const ids = makeSequentialIds('contract');
    const fake = makeFakeUserDataStore({ clock, ids });
    const port = Object.assign(fake, {
      contractControls: {
        advanceDays: (days: number): void => {
          clock.advance(days * 24 * 60 * 60 * 1000);
        },
        failNextCommit: (error: Parameters<typeof fake.faults.fail>[1]['error']): void => {
          fake.faults.fail('commit', { error });
        },
        stateCounts: () => ({
          records: fake.records.size(),
          events: fake.events.size(),
          receipts: fake.receipts.size(),
        }),
      },
    }) satisfies MutationContractPort;
    return {
      port,
      reset: () => {
        fake.reset();
        ids.reset();
        clock.set(START);
      },
    };
  },
});
