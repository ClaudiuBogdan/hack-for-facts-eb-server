/**
 * Procurement module — the served contract → procedure edge (P26).
 *
 * `procurement.contracts.procedure_id` was filled for years by a notice-number
 * match alone, so a stored link may name another buyer's notice, a call
 * (initiation) row whose number merely equals an award number, or one of
 * several candidate rows. A stored link is SERVED only when the source supports
 * it, by the same rule the loader writes (scrapper `buildContractsUpsert`):
 *
 *   - e-licitatie award: the parent is the award's own CA notice
 *     (`elicitatie:<attrs.ca_notice_id>`), whatever its generic notice_kind.
 *     The award's buyer is read from that same raw notice, so it only vetoes a
 *     conflict; an absent buyer keeps the native edge.
 *   - SEAP export row: it carries only an award-notice number and a buyer, and
 *     initiation numbers are a different number space. The parent is the ONE
 *     native CA notice or SEAP award notice with that number and buyer CUI;
 *     none or several leave the row unlinked.
 *
 * Anything else reads as unlinked everywhere — id projections, the procedure's
 * contract list, the `procedureId` filter, the inherited TED and the title
 * fallback — so a stored bad edge cannot leak through another reader. The
 * persisted edge is corrected by the loader; this only stops serving it.
 */

import { sql, type RawBuilder } from 'kysely';
import { err, ok, type Result } from 'neverthrow';

import { invalidInput, type ApiError, type FilterInput } from '@/modules/shared/index.js';

import { fieldOf } from './filter-helpers.js';
import { contractFilterSpec } from '../../core/filters.js';

/** A procedures row in the award-notice number space (native CA or SEAP award). */
const awardNoticeRow = (alias: string): RawBuilder<unknown> => sql`(
  ${sql.ref(`${alias}.source_system`)} = 'elicitatie'
  or (${sql.ref(`${alias}.source_system`)} = 'seap_notice'
      and ${sql.ref(`${alias}.notice_kind`)} in ('award', 'award_no_init'))
)`;

/**
 * The contract's stored `procedure_id` when the source supports it, else NULL.
 * One primary-key probe of the parent plus, for SEAP rows, one
 * `procedures_notice_no_idx` probe proving no second compatible candidate.
 */
export const supportedProcedureIdSql = (contractAlias: string): RawBuilder<string | null> => {
  const c = (column: string) => sql.ref(`${contractAlias}.${column}`);
  return sql<string | null>`(
    select parent.procedure_id
      from procurement.procedures parent
     where parent.procedure_id = ${c('procedure_id')}
       and (
         (${c('source_system')} = 'elicitatie_ca_award'
          and parent.source_system = 'elicitatie'
          and parent.source_ref = 'elicitatie:' || (${c('attrs')} ->> 'ca_notice_id')
          and (nullif(parent.authority_cui, '') = nullif(${c('authority_cui')}, '')) is not false)
         or
         (${c('source_system')} = 'seap_contracts'
          and nullif(${c('authority_cui')}, '') is not null
          and parent.notice_no = ${c('notice_no')}
          and parent.authority_cui = ${c('authority_cui')}
          and ${awardNoticeRow('parent')}
          and not exists (
            select 1
              from procurement.procedures other
             where other.notice_no = ${c('notice_no')}
               and other.authority_cui = ${c('authority_cui')}
               and other.procedure_id <> parent.procedure_id
               and ${awardNoticeRow('other')}))
       )
  )`;
};

const PROCEDURE_ID_OPS: ReadonlySet<string> = new Set(['eq', 'isNull']);

/**
 * The indexed scopes (contracts_{authority,supplier}_cui_idx, contracts_notice_no_idx)
 * that bound an unlinked-contract scan to one buyer, supplier or notice. A query
 * SHAPE bound, not a latency guarantee.
 */
const UNLINKED_SCOPE_FIELDS = ['authorityCui', 'supplierCui', 'noticeNo'] as const;

const UNSCOPED_IS_NULL =
  'procedureId isNull needs procedureId eq or a nonempty authorityCui, supplierCui or ' +
  'noticeNo (eq or in) scope: it is checked per contract and cannot scan all of them';

const nonEmpty = (value: unknown): boolean =>
  (typeof value === 'string' && value.trim() !== '') ||
  (typeof value === 'number' && Number.isFinite(value));

/** An eq / nonempty in on a scope field, using only the operators the spec allows. */
const hasIndexedScope = (input: FilterInput): boolean =>
  UNLINKED_SCOPE_FIELDS.some((name) => {
    const ff = fieldOf(input, name);
    if (ff === undefined) return false;
    const ops = contractFilterSpec.fields.find((field) => field.name === name)?.ops ?? [];
    if (ops.includes('eq') && nonEmpty(ff['eq'])) return true;
    const list = ff['in'];
    return ops.includes('in') && Array.isArray(list) && list.some(nonEmpty);
  });

/**
 * The repo-intercepted `procedureId` contract filter: `eq` matches only a
 * supported link to that procedure; `isNull` means "no supported link". The
 * guard is a correlated check per contract, so `isNull` (true or false) without
 * `eq` must be scoped by an indexed buyer, supplier or notice; a bare request is
 * rejected rather than silently narrowed. Pass the CUI-normalized input the
 * kernel compiles, so a scope that normalizes away does not count.
 */
export const procedureIdPredicate = (
  input: FilterInput,
  contractAlias: string
): Result<RawBuilder<unknown> | undefined, ApiError> => {
  // The kernel skips virtual fields in `exclude` too; keep refusing it, as before.
  if (input.exclude?.['procedureId'] !== undefined) {
    return err(invalidInput("field 'procedureId' is not negatable", 'procedureId'));
  }
  const ff = fieldOf(input, 'procedureId');
  if (ff === undefined) return ok(undefined);
  for (const op of Object.keys(ff)) {
    if (ff[op] !== undefined && !PROCEDURE_ID_OPS.has(op)) {
      return err(invalidInput(`operator '${op}' not allowed on 'procedureId'`, 'procedureId'));
    }
  }
  const supported = supportedProcedureIdSql(contractAlias);
  const conds: RawBuilder<unknown>[] = [];
  const eq = ff['eq'];
  if (eq !== undefined) {
    const id = typeof eq === 'string' || typeof eq === 'number' ? String(eq) : '';
    if (!/^\d+$/u.test(id)) return err(invalidInput('procedureId must be a bigint', 'procedureId'));
    conds.push(
      sql`(${sql.ref(`${contractAlias}.procedure_id`)} = ${id}::bigint and ${supported} is not null)`
    );
  }
  if (ff['isNull'] !== undefined) {
    if (eq === undefined && !hasIndexedScope(input)) {
      return err(invalidInput(UNSCOPED_IS_NULL, 'procedureId'));
    }
    const wantNull = ff['isNull'] === true || ff['isNull'] === 'true';
    conds.push(wantNull ? sql`${supported} is null` : sql`${supported} is not null`);
  }
  if (conds.length === 0) return ok(undefined);
  return ok(sql`(${sql.join(conds, sql` and `)})`);
};
