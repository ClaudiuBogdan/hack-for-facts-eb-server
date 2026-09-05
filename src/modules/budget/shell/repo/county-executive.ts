import { sql, type RawBuilder } from 'kysely';

import { BUCHAREST_COUNTY_CODE, BUCHAREST_SIRUTA_CODE } from '../../core/constants.js';

/** Fiscal navigation representative, not geographic identity or creditor parent.
 * PMB represents B on this surface even after geographic county403 exists.
 * Ambiguous executive anchors return null, never an arbitrary first CUI.
 */
export const countyExecutiveCuiSql = (
  countyCode: RawBuilder<unknown>
): RawBuilder<string | null> => sql`(
  select case when count(*) = 1 then min(executive.cui) else null end
  from core.territories candidate
  join core.public_entities executive on executive.territory_id = candidate.id
    and executive.is_territorial_executive
  where candidate.county_code = ${countyCode}
    and (
      (candidate.county_code = ${BUCHAREST_COUNTY_CODE}
        and candidate.level = 'uat'
        and candidate.territorial_siruta_code = ${BUCHAREST_SIRUTA_CODE})
      or (candidate.county_code <> ${BUCHAREST_COUNTY_CODE} and candidate.level = 'county')
    )
)`;
