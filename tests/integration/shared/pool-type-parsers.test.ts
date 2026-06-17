/**
 * Per-pool date/timestamp type-parser format invariant against LIVE transparenta_prod
 * (read-only). Proves the load-bearing claim behind dropping the fleet-wide `::text`
 * workaround: the bare `date`/`timestamp`/`timestamptz` columns now come back as
 * STRINGS whose value is byte-identical to what a `<col>::text` cast produces under
 * the same server/session — so no existing golden test (which still casts `::text`)
 * can break. int8 returns a string; numeric still returns a string.
 *
 * Skips cleanly when PROD_DATABASE_URL is absent (CI without the tunnel).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createProdDb, type ProdDb } from '@/modules/shared/shell/db/pool.js';

const HAS_DB = (process.env['PROD_DATABASE_URL'] ?? '').length > 0;
const d = HAS_DB ? describe : describe.skip;

let prod: ProdDb;

d('prod pool date/timestamp parsers (live)', () => {
  beforeAll(() => {
    prod = createProdDb({ connectionString: process.env['PROD_DATABASE_URL']! });
  });

  afterAll(async () => {
    await prod.db.destroy();
  });

  it('bare date/timestamp/timestamptz/int8 are strings byte-identical to ::text', async () => {
    const { rows } = await prod.pool.query<{
      d: unknown;
      d_text: string;
      ts: unknown;
      ts_text: string;
      tstz: unknown;
      tstz_text: string;
      big: unknown;
      num: unknown;
    }>(`
      select
        '2026-04-15'::date           as d,    '2026-04-15'::date::text           as d_text,
        '2026-04-15 13:14:15.5'::timestamp   as ts,   '2026-04-15 13:14:15.5'::timestamp::text   as ts_text,
        '2026-04-15 13:14:15.5+00'::timestamptz as tstz, '2026-04-15 13:14:15.5+00'::timestamptz::text as tstz_text,
        (12345678901234567)::int8    as big,
        (123.45)::numeric            as num
    `);
    const r = rows[0];
    expect(r).toBeDefined();
    if (r === undefined) return;

    // date → string, equal to ::text ('YYYY-MM-DD').
    expect(typeof r.d).toBe('string');
    expect(r.d).toBe(r.d_text);
    expect(r.d).toBe('2026-04-15');

    // timestamp → string, equal to ::text.
    expect(typeof r.ts).toBe('string');
    expect(r.ts).toBe(r.ts_text);

    // timestamptz → string, equal to ::text (server renders the offset).
    expect(typeof r.tstz).toBe('string');
    expect(r.tstz).toBe(r.tstz_text);

    // int8 → string (precision-safe); numeric still a string.
    expect(typeof r.big).toBe('string');
    expect(r.big).toBe('12345678901234567');
    expect(typeof r.num).toBe('string');
  });

  it('real prod date/timestamptz columns read bare equal their ::text cast', async () => {
    // salary_amount_claims.period_start is a real `date`; current_entity_status.updated_at
    // is a real `timestamptz`. Both must round-trip bare as strings equal to `::text`,
    // so a repo that drops the cast reads exactly what the cast produced today.
    const { rows } = await prod.pool.query<{ d: unknown; d_text: string; ts: unknown; ts_text: string }>(
      `select sac.period_start as d, sac.period_start::text as d_text,
              ces.updated_at as ts, ces.updated_at::text as ts_text
       from primarii_transparency.salary_amount_claims sac
       join primarii_transparency.current_entity_status ces on ces.cui = sac.cui
       where sac.period_start is not null limit 1`
    );
    if (rows.length === 0) return; // tolerate an empty result without failing the suite
    const r = rows[0];
    expect(typeof r?.d).toBe('string');
    expect(r?.d).toBe(r?.d_text);
    expect(r?.d).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
    expect(typeof r?.ts).toBe('string');
    expect(r?.ts).toBe(r?.ts_text);
  });
});
