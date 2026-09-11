/**
 * The kernel's one named territory (review N/K1, codebase plan §WP4): the
 * Bucharest county code, municipality SIRUTA, sector row shape and the six
 * sector SIRUTAs live in `shared/core/territory-constants.ts`. This pins the
 * values, that the budget and INS modules re-export them rather than
 * redeclare, and that the kernel predicates compile the values as literals
 * (so the SQL text every pin suite holds is produced from the reference).
 */

import { sql } from 'kysely';
import { describe, expect, it } from 'vitest';

import {
  BUCHAREST_COUNTY_CODE as BUDGET_COUNTY,
  BUCHAREST_SIRUTA_CODE,
} from '@/modules/budget/core/constants.js';
import { BUCHAREST_SECTOR_SIRUTAS as INS_SECTORS } from '@/modules/ins-native/core/population-admission.js';
import {
  BUCHAREST_COUNTY_CODE,
  BUCHAREST_MUNICIPALITY_SIRUTA,
  BUCHAREST_SECTOR_KIND,
  BUCHAREST_SECTOR_LEVEL,
  BUCHAREST_SECTOR_SIRUTAS,
} from '@/modules/shared/core/territory-constants.js';
import {
  isCountyTerritory,
  isUatPresentationTerritory,
} from '@/modules/shared/shell/repo/territory-predicates.js';

import { makeCapturingDb } from '../../fixtures/capturing-db.js';

const flat = (s: string): string => s.replace(/\s+/gu, ' ').trim();

describe('territory constants: the kernel reference', () => {
  it('names Bucharest exactly once', () => {
    expect(BUCHAREST_COUNTY_CODE).toBe('B');
    expect(BUCHAREST_MUNICIPALITY_SIRUTA).toBe('179132');
    expect(BUCHAREST_SECTOR_LEVEL).toBe('locality');
    expect(BUCHAREST_SECTOR_KIND).toBe('sector');
    expect(BUCHAREST_SECTOR_SIRUTAS).toEqual([
      '179141',
      '179150',
      '179169',
      '179178',
      '179187',
      '179196',
    ]);
    // Six distinct sector codes, none of them the municipality.
    expect(new Set(BUCHAREST_SECTOR_SIRUTAS).size).toBe(6);
    expect(BUCHAREST_SECTOR_SIRUTAS).not.toContain(BUCHAREST_MUNICIPALITY_SIRUTA);
    for (const siruta of BUCHAREST_SECTOR_SIRUTAS) expect(siruta).toMatch(/^[1-9][0-9]*$/u);
  });

  it('matches what the budget and INS modules export (the sector list by identity, the strings by value)', () => {
    expect(BUDGET_COUNTY).toBe(BUCHAREST_COUNTY_CODE);
    expect(BUCHAREST_SIRUTA_CODE).toBe(BUCHAREST_MUNICIPALITY_SIRUTA);
    expect(INS_SECTORS).toBe(BUCHAREST_SECTOR_SIRUTAS);
  });

  it('reaches the kernel predicates as literals, never as parameters', async () => {
    const captured: { sql: string; parameters: readonly unknown[] }[] = [];
    const db = makeCapturingDb(captured);
    await sql`select 1 from core.territories t where ${isUatPresentationTerritory('t')} and ${isCountyTerritory('t')}`.execute(
      db
    );
    expect(captured).toHaveLength(1);
    expect(captured[0]?.parameters).toEqual([]);
    expect(flat(captured[0]?.sql ?? '')).toBe(
      'select 1 from core.territories t where ("t"."level" = \'uat\' or ("t"."level" = \'locality\' and "t"."kind" = \'sector\')) ' +
        'and ("t"."level" = \'county\' or ("t"."county_code" = \'B\' and "t"."level" = \'uat\' and "t"."siruta_code" = \'179132\' ' +
        "and not exists ( select 1 from core.territories as county_node where county_node.level = 'county' and county_node.county_code = 'B' )))"
    );
  });
});
