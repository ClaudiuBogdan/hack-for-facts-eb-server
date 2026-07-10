import type { AuditError } from './errors.js';
import type { AuditEntry, AuditEntryInput } from './types.js';
import type { Page } from '../shared/types.js';
import type { Result } from 'neverthrow';

export interface AuditLedgerPort {
  append(entry: AuditEntryInput): Promise<Result<void, AuditError>>;
  listByEntity(input: {
    eventId?: string;
    deliveryId?: string;
    userId?: string;
    cursor: string | null;
    limit: number;
  }): Promise<Result<Page<AuditEntry>, AuditError>>;
}
