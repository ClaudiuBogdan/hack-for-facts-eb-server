import { reconciliationPortContractCases } from '../../../contracts/user-data/reconciliation-port.contract.js';
import { makeFakeUserDataStore } from '../../../fixtures/user-data/index.js';
import { describePortContract, makeSequentialIds, makeTestClock } from '../../../support/index.js';

describePortContract('UserDataReconciliationPort', reconciliationPortContractCases, {
  fake: () => {
    const fake = makeFakeUserDataStore({
      clock: makeTestClock(new Date('2026-01-01T00:00:00.000Z')),
      ids: makeSequentialIds('contract'),
    });
    return {
      port: Object.assign(fake, {
        contractControls: {
          corruptRevision: (recordId: string, revision: number): void => {
            const record = fake.records.find((candidate) => candidate.recordId === recordId);
            if (record === undefined) throw new Error(`Missing fake record ${recordId}`);
            fake.records.put({ ...record, revision });
          },
        },
      }),
      reset: () => {
        fake.reset();
      },
    };
  },
});
