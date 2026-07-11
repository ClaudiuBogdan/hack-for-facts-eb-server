import { expect, it } from 'vitest';

import {
  type UserDataMutationPort,
  type UserDataReconciliationPort,
} from '@/modules/user-data/core/ports.js';

import { makePlannedMutation, userDataRecordId } from '../../fixtures/user-data/index.js';
import { expectOk, type PortContractCases } from '../../support/index.js';

export interface ReconciliationContractControls {
  corruptRevision(recordId: string, revision: number): Promise<void> | void;
}

export type ReconciliationContractPort = UserDataMutationPort &
  UserDataReconciliationPort & { contractControls: ReconciliationContractControls };

export const reconciliationPortContractCases: PortContractCases<ReconciliationContractPort> = ({
  getPort,
}) => {
  it('row 14: clean store has no violations and a corrupt revision reports exactly one revision mismatch', async () => {
    const port = getPort();
    expectOk(await port.commit(makePlannedMutation()));

    expect(expectOk(await port.findViolations({ limit: 100 }))).toEqual({
      checkedRecords: 1,
      violations: [],
    });

    await port.contractControls.corruptRevision(userDataRecordId(1), 2);
    const corrupt = expectOk(await port.findViolations({ limit: 100 }));
    expect(corrupt.checkedRecords).toBe(1);
    expect(corrupt.violations).toHaveLength(1);
    expect(corrupt.violations[0]).toMatchObject({
      recordId: userDataRecordId(1),
      kind: 'revisionMismatch',
    });
    expect(corrupt.violations[0]?.detail).not.toContain('revision-1');
  });
};
