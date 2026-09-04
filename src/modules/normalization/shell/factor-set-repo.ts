import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { Decimal } from 'decimal.js';
import { sql, type Kysely } from 'kysely';
import { err, ok, type Result } from 'neverthrow';

import type { FactorReadError, FactorSetReader, FactorTable } from '../core/factor-set-reader.js';
import type { ProdDatabase } from '@/modules/shared/index.js';

const FactorRowSchema = Type.Object({
  kind: Type.Union([
    Type.Literal('cpi_index'),
    Type.Literal('cpi_yoy_index'),
    Type.Literal('inflation_rate'),
    Type.Literal('ron_per_eur'),
    Type.Literal('ron_per_usd'),
    Type.Literal('gdp_ron'),
    Type.Literal('population_ro'),
  ]),
  frequency: Type.Union([Type.Literal('YEAR'), Type.Literal('QUARTER'), Type.Literal('MONTH')]),
  periodKey: Type.String(),
  value: Type.String({ pattern: '^-?[0-9]+(?:\\.[0-9]+)?$' }),
});

const PERIOD_PATTERNS = {
  YEAR: /^\d{4}$/u,
  QUARTER: /^\d{4}-Q[1-4]$/u,
  MONTH: /^\d{4}-(0[1-9]|1[0-2])$/u,
};
const validSetId = (id: string): boolean => /^[1-9]\d*$/u.test(id);

/** Successful immutable snapshots only; the mutable current pointer is never cached. */
export const makeFactorSetReader = (db: Kysely<ProdDatabase>): FactorSetReader => {
  const snapshots = new Map<string, Promise<Result<FactorTable, FactorReadError>>>();

  const read = async (setId: string): Promise<Result<FactorTable, FactorReadError>> => {
    try {
      // One statement binds set existence and its rows to the same MVCC snapshot.
      const result = await sql<{ digest: string; row: unknown }>`
        select s.source_manifest_digest as digest, jsonb_build_object(
          'kind', f.factor_kind, 'frequency', f.frequency,
          'periodKey', f.period_key, 'value', f.value::text
        ) as row
        from core.factor_sets s
        join core.normalization_factors f on f.factor_set_id = s.factor_set_id
        where s.factor_set_id = ${setId}::bigint
        order by f.factor_kind, f.frequency, f.period_key
      `.execute(db);
      if (result.rows.length === 0) {
        return err({
          type: 'ServiceUnavailable',
          message: `Factor set ${setId} is missing or empty`,
        });
      }
      const digest = result.rows[0]?.digest;
      if (digest === undefined || !/^[a-f0-9]{64}$/u.test(digest)) {
        return err({
          type: 'ServiceUnavailable',
          message: `Factor set ${setId} has an invalid digest`,
        });
      }
      const rows = [];
      const keys = new Set<string>();
      for (const { row } of result.rows) {
        if (!Value.Check(FactorRowSchema, row)) {
          return err({
            type: 'ServiceUnavailable',
            message: `Factor set ${setId} has invalid rows`,
          });
        }
        const key = `${row.kind}:${row.frequency}:${row.periodKey}`;
        if (
          !PERIOD_PATTERNS[row.frequency].test(row.periodKey) ||
          (row.kind !== 'inflation_rate' && !new Decimal(row.value).greaterThan(0)) ||
          keys.has(key)
        ) {
          return err({
            type: 'ServiceUnavailable',
            message: `Factor set ${setId} has invalid values or keys`,
          });
        }
        keys.add(key);
        rows.push(Object.freeze(row));
      }
      return ok(
        Object.freeze({ factorSetId: setId, manifestDigest: digest, rows: Object.freeze(rows) })
      );
    } catch {
      return err({ type: 'Database', message: `Could not read factor set ${setId}` });
    }
  };

  return {
    async current() {
      try {
        const result = await sql<{ id: string }>`
          select factor_set_id::text as id from core.v_current_factor_set
        `.execute(db);
        if (result.rows.length === 0) return ok(null);
        const id = result.rows[0]?.id;
        if (result.rows.length !== 1 || id === undefined || !validSetId(id)) {
          return err({ type: 'ServiceUnavailable', message: 'Invalid current factor set pointer' });
        }
        return ok(id);
      } catch {
        return err({ type: 'Database', message: 'Could not read current factor set' });
      }
    },
    async load(setId) {
      if (!validSetId(setId))
        return err({ type: 'InvalidInput', message: 'Invalid factor set id' });
      let pending = snapshots.get(setId);
      if (pending === undefined) {
        pending = read(setId);
        snapshots.set(setId, pending);
      }
      const result = await pending;
      if (result.isErr() && snapshots.get(setId) === pending) snapshots.delete(setId);
      return result;
    },
  };
};
