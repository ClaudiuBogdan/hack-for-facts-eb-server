import pool from "../connection";
import { AnalyticsFilter } from "../../types";

// Centralized population computations used by per-capita normalizations.

async function getCountryPopulation(): Promise<number> {
  const query = `
    SELECT SUM(pop_val) AS population FROM (
      SELECT MAX(CASE
        WHEN u2.county_code = 'B' AND u2.siruta_code = '179132' THEN u2.population
        WHEN u2.siruta_code = u2.county_code THEN u2.population
        ELSE 0
      END) AS pop_val
      FROM UATs u2
      GROUP BY u2.county_code
    ) cp
  `;
  const res = await pool.query(query);
  return parseInt(res.rows[0]?.population ?? 0, 10) || 0;
}

/**
 * Computes the denominator population implied by the filter by:
 *  - building the set of matching UATs (via uat_ids, entity filters, county_codes)
 *  - summing their populations (deduplicated)
 *  - if no entity-like filter exists, falls back to country population
 */
export async function computeDenominatorPopulation(filter: AnalyticsFilter): Promise<number> {
  const hasEntityLikeFilter = Boolean(
    (filter.entity_cuis && filter.entity_cuis.length) ||
    (filter.uat_ids && filter.uat_ids.length) ||
    (filter.county_codes && filter.county_codes.length) ||
    typeof filter.is_uat === 'boolean' ||
    (filter.entity_types && filter.entity_types.length)
  );

  if (!hasEntityLikeFilter) {
    return getCountryPopulation();
  }

  const selectedUatIds = new Set<number>();
  const selectedCountyCodes = new Set<string>();

  if (filter.uat_ids?.length) {
    for (const id of filter.uat_ids) selectedUatIds.add(Number(id));
  }
  if (filter.county_codes?.length) {
    for (const code of filter.county_codes) selectedCountyCodes.add(String(code));
  }

  // Pull UAT membership from Entities when entity filters are present
  if ((filter.entity_cuis && filter.entity_cuis.length) ||
      (filter.entity_types && filter.entity_types.length) ||
      typeof filter.is_uat === 'boolean') {
    let idx = 1;
    const conds: string[] = [];
    const vals: any[] = [];

    if (filter.entity_cuis?.length) {
      conds.push(`e.cui = ANY($${idx++}::text[])`);
      vals.push(filter.entity_cuis);
    }
    if (filter.entity_types?.length) {
      conds.push(`e.entity_type = ANY($${idx++}::text[])`);
      vals.push(filter.entity_types);
    }
    if (typeof filter.is_uat === 'boolean') {
      conds.push(`e.is_uat = $${idx++}`);
      vals.push(filter.is_uat);
    }
    if (filter.uat_ids?.length) {
      conds.push(`e.uat_id = ANY($${idx++}::int[])`);
      vals.push(filter.uat_ids);
    }
    if (filter.county_codes?.length) {
      conds.push(`u.county_code = ANY($${idx++}::text[])`);
      vals.push(filter.county_codes);
    }

    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const query = `
      SELECT DISTINCT ON (e.cui)
        e.cui,
        e.is_uat,
        e.entity_type,
        u.id AS uat_id,
        u.county_code
      FROM Entities e
      LEFT JOIN UATs u ON (u.id = e.uat_id) OR (u.uat_code = e.cui)
      ${where}
    `;
    const res = await pool.query(query, vals);
    for (const row of res.rows) {
      const isUat = row.is_uat === true || row.is_uat === 't';
      const isCountyCouncil = row.entity_type === 'admin_county_council';
      const uatId = row.uat_id ? Number(row.uat_id) : null;
      const countyCode = row.county_code ? String(row.county_code) : null;

      if (isCountyCouncil && countyCode) {
        selectedCountyCodes.add(countyCode);
        continue;
      }
      if (uatId != null) {
        selectedUatIds.add(uatId);
        continue;
      }
      // Entities without UAT mapping do not contribute to denominator under "matching UATs" semantics.
      if (isUat && uatId != null) {
        selectedUatIds.add(uatId);
      }
    }
  }

  // If after all selectors we still have nothing, default to country population
  if (!selectedUatIds.size && !selectedCountyCodes.size) {
    return getCountryPopulation();
  }

  // Remove UATs that belong to already-selected counties (avoid double counting)
  let uatIds: number[] = Array.from(selectedUatIds);
  if (selectedCountyCodes.size && uatIds.length) {
    const q = `SELECT id, county_code FROM UATs WHERE id = ANY($1::int[])`;
    const rs = await pool.query(q, [uatIds]);
    const countySet = new Set(Array.from(selectedCountyCodes));
    uatIds = rs.rows
      .filter((r: any) => !countySet.has(String(r.county_code)))
      .map((r: any) => Number(r.id));
  }

  let total = 0;

  if (uatIds.length) {
    const q = `SELECT COALESCE(SUM(population), 0) AS pop FROM UATs WHERE id = ANY($1::int[])`;
    const rs = await pool.query(q, [uatIds]);
    total += parseInt(rs.rows[0]?.pop ?? 0, 10) || 0;
  }

  if (selectedCountyCodes.size) {
    const codes = Array.from(selectedCountyCodes);
    const q = `
      SELECT COALESCE(SUM(pop_val), 0) AS pop FROM (
        SELECT
          county_code,
          MAX(CASE
            WHEN county_code = 'B' AND siruta_code = '179132' THEN population
            WHEN siruta_code = county_code THEN population
            ELSE 0
          END) AS pop_val
        FROM UATs
        WHERE county_code = ANY($1::text[])
        GROUP BY county_code
      ) cp
    `;
    const rs = await pool.query(q, [codes]);
    total += parseInt(rs.rows[0]?.pop ?? 0, 10) || 0;
  }

  return total;
}

