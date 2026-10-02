import { sql } from 'kysely';

import { supportedProcedureIdSql } from './procedure-link-policy.js';

import type { ContractDisplayTitleCandidates } from '../../core/contract-display-title.js';

/**
 * Additive display evidence only. The contract row's source-owned `title`
 * remains untouched. The identity-key lookup uses
 * contracts_canonical_contract_key_idx; procedure_id uses the procedure PK.
 * Neither path may cross institutions. The identity key carries no buyer and
 * no source-native edge, so a matched award lends its title only when BOTH
 * buyers are present and equal; the procedure is read only through a
 * source-supported link (procedure-link-policy).
 * `cross_source_suppressed` is the explicit high-confidence duplicate path,
 * not a general hiding mechanism: production validates every such row as a
 * non-canonical e-licitatie award with confidence 1. Public classification is
 * still enforced here so restricted evidence cannot reach this projection.
 *
 * We intentionally aggregate every matching award instead of applying a silent
 * cap. The 2026-07-26 production measurement found max 84 rows per identity
 * group (p99=2); re-measure if that distribution changes materially.
 */
export const contractDisplayTitleCandidatesSelect = () =>
  sql<ContractDisplayTitleCandidates>`
    case
      when nullif(btrim(c.title), '') is not null then
        jsonb_build_object('matchedAwards', '[]'::jsonb, 'procedure', null)
      else
        jsonb_build_object(
          'matchedAwards',
          coalesce(
            (
              select jsonb_agg(
                jsonb_build_object(
                  'title', award.title,
                  'sourceUrl', award.source_url
                )
                order by award.contract_date desc nulls last, award.contract_id desc
              )
              from procurement.contracts award
              where c.canonical_contract_key is not null
                and award.canonical_contract_key = c.canonical_contract_key
                and award.source_system = 'elicitatie_ca_award'
                and award.dup_method = 'cross_source_suppressed'
                and not award.is_canonical
                and award.dup_confidence = 1
                and award.privacy_class = 'public'
                and nullif(award.authority_cui, '') = nullif(c.authority_cui, '')
                and nullif(btrim(award.title), '') is not null
            ),
            '[]'::jsonb
          ),
          'procedure',
          (
            select jsonb_build_object(
              'title', procedure.title,
              'sourceUrl', procedure.source_url
            )
            from procurement.procedures procedure
            where procedure.procedure_id = ${supportedProcedureIdSql('c')}
              and procedure.privacy_class = 'public'
          )
        )
    end
  `.as('display_title_candidates');
