/**
 * PROC-B51G: the D6-gated names of direct-acquisition supplier buckets.
 *
 * A company bucket is named only from `party_public_names`, by code, and only when
 * `supplier_name_public` is true (`supplierNamesByCode`, the gate every DA name passes). The read is
 * its own read-only transaction per answer and is never cached: a registry name can be withdrawn
 * without any publication key moving. Any failure fails the answer, as the release reads do.
 */

import { sql, type Kysely } from 'kysely';
import { err, ok } from 'neverthrow';

import {
  databaseError,
  serviceUnavailable,
  timeoutError,
  type ApiError,
  type ProdDatabase,
} from '@/modules/shared/index.js';

import { supplierNamesByCode } from './da-v3-sql.js';

import type { DaSupplierNamesPort } from '../../core/ports.js';

const STATEMENT_TIMEOUT_MS = 10_000;

const namesError = (error: unknown): ApiError => {
  const code =
    typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
  if (code === '42P01' || code === '42703' || code === '3F000')
    return serviceUnavailable('Direct acquisitions supplier names are not deployed.');
  if (code === '42501')
    return serviceUnavailable('Direct acquisitions supplier names are not readable by this API.');
  if (code === '57014') return timeoutError('Direct acquisitions supplier names read timed out.');
  return databaseError('Direct acquisitions supplier names read failed', error);
};

export const makeDaSupplierNames = (db: Kysely<ProdDatabase>): DaSupplierNamesPort => ({
  namesOf: async (codes) => {
    if (codes.length === 0) return ok(new Map());
    try {
      return ok(
        await db.transaction().execute(async (trx) => {
          await sql`set transaction read only`.execute(trx);
          await sql`set local statement_timeout = ${sql.lit(STATEMENT_TIMEOUT_MS)}`.execute(trx);
          return supplierNamesByCode(trx, codes);
        })
      );
    } catch (error) {
      return err(namesError(error));
    }
  },
});
