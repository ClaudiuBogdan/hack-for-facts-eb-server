/**
 * P33 — batched e-licitatie page resolution (DataLoader-backed at the resolver).
 *
 * The rule (user decision 2026-10-14): a data.gov.ro award row links to an
 * e-licitatie award notice only when its public number and buyer CUI equal
 * EXACTLY ONE captured native notice (`procedures.source_system = 'elicitatie'`).
 * Raw text equality on both sides, no normalization; several or none → no link.
 * Never through a dedup group, a value or a title. Initiation and SAD notices
 * use another number space, so only award-kind data.gov.ro notices take part.
 *
 * Old digits-only notice numbers repeat across years: the 2026-10-14 audit found
 * 595 of 26,126 digits-only contract matches naming another supplier. A number
 * that is not a prefixed e-licitatie award number (CAN…, SCNA…, PCA…) therefore
 * needs corroboration: for a contract, a captured e-licitatie award on that
 * notice for the same supplier within ±31 days of the contract date
 * (DIGITS_ONLY_AWARD_WINDOW_DAYS, measured, re-validate at full scale);
 * modifications and notices carry no supplier evidence and never link on such
 * a number.
 *
 * Privacy: a link is served only for a public requesting row and a public sole
 * candidate, and only public awards corroborate. A restricted candidate still
 * counts toward ambiguity (it is returned as a null ref), so filtering it can
 * never turn two candidates into one.
 *
 * Cost: one statement per batch. Each row is a primary-key probe plus, for
 * data.gov.ro rows, one `procedures_notice_no_idx` probe bounded by `limit 2`
 * (two candidates already mean "ambiguous") and, for a non-prefixed contract
 * number, one `contracts_procedure_id_idx` probe. The 2026-10-14 census measured
 * about 2 ms for a contract lookup and 5–8 ms for the corroboration probe;
 * re-measure if list pages ask for this field at volume.
 *
 * Direct purchases: only e-licitatie rows carry a portal id (their `da_key`).
 * The data.gov.ro purchases and notifications served on 2026-10-14 had no
 * captured counterpart at all (census: 0 of 17,976,884).
 */

import { sql, type Kysely, type RawBuilder } from 'kysely';
import { err, ok, type Result } from 'neverthrow';

import { databaseError, type ApiError, type ProdDatabase } from '@/modules/shared/index.js';

import {
  NATIVE_DA_KEY_PREFIX,
  NATIVE_NOTICE_REF_PREFIX,
  elicitatiePageOf,
  portalIdFromRef,
  soleCandidate,
  type ElicitatiePage,
  type ElicitatiePageKind,
} from '../../core/elicitatie-page.js';

type Db = Kysely<ProdDatabase>;
type Pages = ReadonlyMap<string, ElicitatiePage>;

const isBigint = (id: string): boolean => /^\d+$/u.test(id);

/** data.gov.ro notice kinds in the award-notice number space. */
const AWARD_NOTICE_KINDS = ['award', 'award_no_init'] as const;

/** A prefixed e-licitatie award number (CAN…, SCNA…, PCA…), unique by itself. */
const PREFIXED_AWARD_NUMBER = '^[A-Z]{2,5}[0-9]+$';

/** Same-supplier award date tolerance for a non-prefixed number (2026-10-14 audit). */
const DIGITS_ONLY_AWARD_WINDOW_DAYS = 31;

interface PageRow {
  readonly id: string;
  /** A public native record's own portal id (or its native ref). */
  readonly own_ref: string | null;
  /** At most two native candidates; a restricted one is a null ref. */
  readonly candidate_refs: readonly (string | null)[] | null;
  /**
   * Null when the number links by itself (prefixed); otherwise whether the sole
   * candidate is corroborated. False never links.
   */
  readonly corroborated: boolean | null;
}

/**
 * The bounded candidate probe for one public data.gov.ro row: native award
 * notices with the identical public number and buyer CUI. Blank values never
 * match; a restricted candidate is returned as null so it still counts.
 */
const nativeNoticeCandidates = (alias: string): RawBuilder<readonly (string | null)[] | null> => {
  const notice = sql.ref(`${alias}.notice_no`);
  const buyer = sql.ref(`${alias}.authority_cui`);
  const privacy = sql.ref(`${alias}.privacy_class`);
  return sql<readonly (string | null)[] | null>`case
    when ${privacy} = 'public'
     and nullif(btrim(${notice}), '') is not null
     and nullif(btrim(${buyer}), '') is not null
    then array(
      select case when native.privacy_class = 'public' then native.source_ref end
        from procurement.procedures native
       where native.source_system = 'elicitatie'
         and native.notice_no = ${notice}
         and native.authority_cui = ${buyer}
       limit 2
    )
  end`;
};

/** Notices and modifications have no supplier evidence: a non-prefixed number never links. */
const prefixedOnly = (alias: string): RawBuilder<boolean | null> => {
  const notice = sql.ref(`${alias}.notice_no`);
  return sql<
    boolean | null
  >`case when ${notice} ~ ${PREFIXED_AWARD_NUMBER} then null else false end`;
};

const pagesOf = (
  rows: readonly PageRow[],
  kind: ElicitatiePageKind,
  ownIdOf: (ref: string | null) => string | null
): Pages => {
  const pages = new Map<string, ElicitatiePage>();
  for (const row of rows) {
    const own = elicitatiePageOf(kind, ownIdOf(row.own_ref), 'own_record');
    const matched =
      own === null && row.corroborated !== false
        ? elicitatiePageOf(
            'award_notice',
            soleCandidate(
              (row.candidate_refs ?? []).map((ref) =>
                portalIdFromRef(ref, NATIVE_NOTICE_REF_PREFIX)
              )
            ),
            'number_and_buyer'
          )
        : null;
    const page = own ?? matched;
    if (page !== null) pages.set(row.id, page);
  }
  return pages;
};

export interface ElicitatiePageRepo {
  forContracts(ids: readonly string[]): Promise<Result<Pages, ApiError>>;
  forModifications(ids: readonly string[]): Promise<Result<Pages, ApiError>>;
  forProcedures(ids: readonly string[]): Promise<Result<Pages, ApiError>>;
  forDirectAcquisitions(ids: readonly string[]): Promise<Result<Pages, ApiError>>;
}

export const makeElicitatiePageRepo = (db: Db): ElicitatiePageRepo => {
  const run = async (
    label: string,
    ids: readonly string[],
    query: (ids: readonly string[]) => Promise<readonly PageRow[]>,
    kind: ElicitatiePageKind,
    ownIdOf: (ref: string | null) => string | null
  ): Promise<Result<Pages, ApiError>> => {
    const valid = ids.filter(isBigint);
    if (valid.length === 0) return ok(new Map());
    try {
      return ok(pagesOf(await query(valid), kind, ownIdOf));
    } catch (error) {
      return err(databaseError(`${label} failed`, error));
    }
  };

  /** The own id is stored bare (`attrs.ca_notice_id`). */
  const bareId = (id: string | null): string | null => id;
  /** The own id is the suffix of the native ref (`elicitatie:<id>`). */
  const fromNativeRef = (ref: string | null): string | null =>
    portalIdFromRef(ref, NATIVE_NOTICE_REF_PREFIX);
  /** The own id is the suffix of the native DA key (`elicitatie_da:<id>`). */
  const fromNativeDaKey = (key: string | null): string | null =>
    portalIdFromRef(key, NATIVE_DA_KEY_PREFIX);

  return {
    forContracts: (ids) =>
      run(
        'elicitatiePagesForContracts',
        ids,
        async (valid) =>
          (
            await sql<PageRow>`
              select c.contract_id::text as id,
                     case when c.source_system = 'elicitatie_ca_award'
                           and c.privacy_class = 'public'
                          then c.attrs ->> 'ca_notice_id' end as own_ref,
                     cand.refs as candidate_refs,
                     case
                       when cand.refs is null or c.notice_no ~ ${PREFIXED_AWARD_NUMBER} then null
                       else cardinality(cand.refs) = 1
                         and nullif(btrim(c.supplier_cui), '') is not null
                         and c.contract_date is not null
                         and exists (
                           -- contracts_procedure_id_idx: a native award's stored
                           -- procedure_id is its own notice (verified for all
                           -- 1,154,461 awards on 2026-10-14); the portal id is
                           -- still checked, so a stale edge cannot corroborate.
                           select 1
                             from procurement.contracts award
                            where award.procedure_id = cand.procedure_ids[1]
                              and award.source_system = 'elicitatie_ca_award'
                              and award.privacy_class = 'public'
                              and award.attrs ->> 'ca_notice_id'
                                  = substr(cand.refs[1], ${sql.lit(NATIVE_NOTICE_REF_PREFIX.length + 1)})
                              and award.supplier_cui = c.supplier_cui
                              and award.contract_date
                                  between c.contract_date - ${sql.lit(DIGITS_ONLY_AWARD_WINDOW_DAYS)}
                                      and c.contract_date + ${sql.lit(DIGITS_ONLY_AWARD_WINDOW_DAYS)}
                         )
                     end as corroborated
                from procurement.contracts c
               cross join lateral (
                 select array_agg(
                          case when native.privacy_class = 'public' then native.source_ref end
                          order by native.procedure_id
                        ) as refs,
                        array_agg(native.procedure_id order by native.procedure_id) as procedure_ids
                   from (
                     select native.source_ref, native.procedure_id, native.privacy_class
                       from procurement.procedures native
                      where c.source_system = 'seap_contracts'
                        and c.privacy_class = 'public'
                        and nullif(btrim(c.notice_no), '') is not null
                        and nullif(btrim(c.authority_cui), '') is not null
                        and native.source_system = 'elicitatie'
                        and native.notice_no = c.notice_no
                        and native.authority_cui = c.authority_cui
                      limit 2
                   ) native
               ) cand
               where c.contract_id = any(${valid}::bigint[])
            `.execute(db)
          ).rows,
        'award_notice',
        bareId
      ),

    forModifications: (ids) =>
      run(
        'elicitatiePagesForModifications',
        ids,
        async (valid) =>
          (
            await sql<PageRow>`
              select m.modification_id::text as id,
                     null::text as own_ref,
                     ${nativeNoticeCandidates('m')} as candidate_refs,
                     ${prefixedOnly('m')} as corroborated
                from procurement.contract_modifications m
               where m.modification_id = any(${valid}::bigint[])
            `.execute(db)
          ).rows,
        'award_notice',
        bareId
      ),

    forProcedures: (ids) =>
      run(
        'elicitatiePagesForProcedures',
        ids,
        async (valid) =>
          (
            await sql<PageRow>`
              select p.procedure_id::text as id,
                     case when p.source_system = 'elicitatie' and p.privacy_class = 'public'
                          then p.source_ref end as own_ref,
                     case when p.source_system = 'seap_notice'
                           and p.notice_kind in (${sql.join([...AWARD_NOTICE_KINDS])})
                          then ${nativeNoticeCandidates('p')} end as candidate_refs,
                     ${prefixedOnly('p')} as corroborated
                from procurement.procedures p
               where p.procedure_id = any(${valid}::bigint[])
            `.execute(db)
          ).rows,
        'award_notice',
        fromNativeRef
      ),

    forDirectAcquisitions: (ids) =>
      run(
        'elicitatiePagesForDirectAcquisitions',
        ids,
        async (valid) =>
          (
            await sql<PageRow>`
              select d.da_id::text as id,
                     case when d.source_system = 'elicitatie_da' and d.privacy_class = 'public'
                          then d.da_key end as own_ref,
                     null::text[] as candidate_refs,
                     null::boolean as corroborated
                from procurement.direct_acquisitions d
               where d.da_id = any(${valid}::bigint[])
            `.execute(db)
          ).rows,
        'direct_acquisition',
        fromNativeDaKey
      ),
  };
};
