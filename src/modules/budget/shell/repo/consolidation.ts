import { sql } from 'kysely';

import type { Db } from './budget-repo-shared.js';

const VASLUI = {
  cui: '3394171',
  sector: 2,
  year: 2025,
  principal: 'ccf7135230492b3c23f672204a582583eab1f29c131dc5e24a6a4629cd62e2c9',
  count: 17,
  digest: '30549a7bda75284546d5a554cd3a6327594f13977f3bf37c532bc0eac387dfec',
  income: '818543330.77',
  spending: '814305538.27',
  source: 'https://cjvs.eu/wp-content/downloads/Hotarari/2026/HotarareaNr35_2026.pdf#page=19',
  legs: [
    [
      'f283b30e25d7f2526dda34c4fedb307b2b0c98023548e4804d701d71cb5b6388',
      'ch',
      'A',
      '66.06.01',
      '51.01.46',
      '4439871.44',
    ],
    [
      'db4b7e6fbacbb326aa140fbee3f22f5221ce52a53d9cdaaf637eb9d00f61bbda',
      'vn',
      'F',
      '43.10.00',
      null,
      '4439871.44',
    ],
    [
      'f283b30e25d7f2526dda34c4fedb307b2b0c98023548e4804d701d71cb5b6388',
      'ch',
      'A',
      '66.06.01',
      '51.02.28',
      '22787056.20',
    ],
    [
      'db4b7e6fbacbb326aa140fbee3f22f5221ce52a53d9cdaaf637eb9d00f61bbda',
      'vn',
      'F',
      '43.14.00',
      null,
      '16906056.20',
    ],
    [
      'db4b7e6fbacbb326aa140fbee3f22f5221ce52a53d9cdaaf637eb9d00f61bbda',
      'vn',
      'F',
      '43.17.01',
      null,
      '5881000.00',
    ],
  ],
} as const;

interface ConsolidationRead {
  readonly sectors: number[];
  readonly admitted: boolean;
  readonly reported_income: string | null;
  readonly reported_spending: string | null;
  readonly reported_balance: string | null;
  readonly consolidated_income: string | null;
  readonly consolidated_spending: string | null;
  readonly eliminated: string | null;
}

export const readConsolidation = async (
  db: Db,
  cui: string,
  year: number,
  frequency: 'YEAR' | 'QUARTER' | 'MONTH'
) => {
  const pilot = cui === VASLUI.cui && year === VASLUI.year && frequency === 'YEAR';
  const sectors = sql`
    select coalesce(array_agg(distinct budget_sector_id order by budget_sector_id), '{}') sectors
    from budget_staging.reports
    where stream = 'execution' and report_family = 'main-creditor'
      and reporting_year = ${year} and entity_cui = ${cui}
  `;
  if (!pilot) {
    const result = await sql<{ sectors: number[] }>`${sectors}`.execute(db);
    return { sectors: result.rows[0]?.sectors ?? [], estimate: null };
  }

  const legs = VASLUI.legs.map(
    ([id, side, fund, fc, ec, amount]) =>
      sql`(${id}::text, ${side}::text, ${fund}::text, ${fc}::text, ${ec}::text, ${amount}::numeric)`
  );
  const result = await sql<ConsolidationRead>`
    with source_reports as (
      select report_id, report_type, entity_cui, main_creditor_cui, report_date,
        xml_hash, xml_object_key
      from budget_staging.reports
      where stream = 'execution' and reporting_year = ${year} and reporting_month = 12
        and budget_sector_id = ${VASLUI.sector}
        and ((entity_cui = ${cui} and report_family = 'main-creditor')
          or (main_creditor_cui = ${cui} and report_family = 'detailed'))
    ), inventory as (
      select count(*) n,
        encode(sha256(convert_to(string_agg(
          to_jsonb(array[s.report_id, s.xml_hash])::text, E'\\n' order by s.report_id collate "C"
        ), 'UTF8')), 'hex') digest,
        count(r.report_id) served
      from source_reports s
      left join budget.reports r on r.report_id = s.report_id
        and r.reporting_year = ${year} and r.report_date = s.report_date
        and r.budget_sector_id = ${VASLUI.sector}
        and r.report_type = s.report_type and r.entity_cui = s.entity_cui
        and r.main_creditor_cui is not distinct from s.main_creditor_cui
        and r.file_source = 'anaf-extranet/entitati-publice/' || s.xml_object_key || '.zst'
    ), source_lines as (
      select f.report_id, f.line_key, f.account_category, f.funding_source,
        f.functional_code, f.economic_code, f.program_code, f.ytd_amount
      from source_reports r
      join budget_staging.execution_line_items_ytd f using (report_id)
      where f.reporting_year = ${year} and f.ytd_amount <> 0
    ), served_lines as (
      select f.report_id, f.line_key, f.account_category, f.funding_source,
        f.functional_code, f.economic_code, f.program_code, f.ytd_amount
      from source_reports r
      join budget.execution_line_items f on f.report_id = r.report_id and f.report_type = r.report_type
      where f.reporting_year = ${year} and f.reporting_month = 12
        and f.budget_sector_id = ${VASLUI.sector} and f.ytd_amount <> 0
    ), baseline as (
      select sum(ytd_amount) filter (where account_category = 'vn') income,
        sum(ytd_amount) filter (where account_category = 'ch') spending
      from served_lines
      where report_id = ${VASLUI.principal}
    ), expected(report_id, side, fund, fc, ec, amount) as (
      values ${sql.join(legs)}
    ), matched as (
      select bool_and(actual.amount is not distinct from x.amount) valid,
        sum(x.amount) filter (where x.side = 'vn') revenue,
        sum(x.amount) filter (where x.side = 'ch') spending
      from expected x
      cross join lateral (
        select sum(f.ytd_amount) amount from served_lines f
        where f.report_id = x.report_id and f.account_category = x.side
          and f.funding_source = x.fund and f.functional_code = x.fc
          and f.economic_code is not distinct from x.ec
      ) actual
    )
    select scope.sectors,
      coalesce(i.n = ${VASLUI.count} and i.served = i.n and i.digest = ${VASLUI.digest}
        and b.income = ${VASLUI.income}::numeric and b.spending = ${VASLUI.spending}::numeric
        and m.valid and m.revenue = m.spending
        and not exists (select * from source_lines except all select * from served_lines)
        and not exists (select * from served_lines except all select * from source_lines),
        false) admitted,
      b.income::text reported_income, b.spending::text reported_spending,
      (b.income - b.spending)::text reported_balance,
      (b.income - m.revenue)::text consolidated_income,
      (b.spending - m.spending)::text consolidated_spending,
      m.revenue::text eliminated
    from inventory i cross join baseline b cross join matched m cross join (${sectors}) scope
  `.execute(db);
  const row = result.rows[0];
  if (row?.admitted !== true) return { sectors: row?.sectors ?? [], estimate: null };
  return {
    sectors: row.sectors,
    estimate: {
      sector: VASLUI.sector,
      reportedIncome: row.reported_income,
      reportedSpending: row.reported_spending,
      income: row.consolidated_income,
      spending: row.consolidated_spending,
      balance: row.reported_balance,
      eliminated: row.eliminated,
      source: VASLUI.source,
    },
  };
};
