import { type Result } from 'neverthrow';

import { type UserDataError } from '../errors.js';
import { type UserDataReconciliationPort } from '../ports.js';
import { type ReconciliationReport } from '../types.js';
import { type LoggerPort } from './shared.js';

export interface ReconcileStoreDeps {
  reconciliationPort: UserDataReconciliationPort;
  logger: LoggerPort;
}

export const reconcileStore = async (
  deps: ReconcileStoreDeps,
  input: { limit: number }
): Promise<Result<ReconciliationReport, UserDataError>> => {
  const result = await deps.reconciliationPort.findViolations(input);
  if (result.isOk()) {
    deps.logger.info('User Data Store reconciliation completed', {
      checkedRecords: result.value.checkedRecords,
      violationCount: result.value.violations.length,
    });
  }
  return result;
};
