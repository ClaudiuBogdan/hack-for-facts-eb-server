/**
 * Procedure canonicality (P36) on a REAL ClickHouse. Skipped in the default
 * runs; the mocked transport cannot see SQL semantics, and one of them already
 * mattered: ClickHouse resolves a SELECT alias inside WHERE, so an output alias
 * named like its column silently changed the id predicate.
 *
 * Prerequisites (all explicit; nothing is inferred):
 *  - `PROCUREMENT_CH_TEST_URL`: bare http(s) origin of a FRESH, DISPOSABLE
 *    ClickHouse server (`_USER` / `_PASSWORD`, default `default` / empty). The
 *    suite refuses a server holding any non-system table, so a live analytics
 *    server is never written to.
 *  - `PROCUREMENT_CH_TEST_DISPOSABLE=1`: the operator's statement that the
 *    server is disposable.
 *  - `PROCUREMENT_CH_TEST_DDL`: a published build's procedure table DDL, as
 *    `SHOW CREATE TABLE proto.facts_procedures_v2_b<N> FORMAT TSVRaw` prints it.
 *
 * The suite creates an active build's table and a prepared one beside it from
 * that DDL, loads hand-declared rows and runs the REAL repository against them.
 * afterAll drops only the database this run created.
 */

import { readFile } from 'node:fs/promises';

import { ok } from 'neverthrow';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  makeClickhouseAnalysisRepo,
  PROCEDURE_DUPLICATES_CAP,
} from '@/modules/procurement/shell/repo/clickhouse-analysis-repo.js';

const URL_ENV = process.env['PROCUREMENT_CH_TEST_URL'] ?? '';
const DISPOSABLE = process.env['PROCUREMENT_CH_TEST_DISPOSABLE'] === '1';
const DDL_FILE = process.env['PROCUREMENT_CH_TEST_DDL'] ?? '';
const d = URL_ENV.length > 0 && DISPOSABLE && DDL_FILE.length > 0 ? describe : describe.skip;

const DATABASE = `p36_canonicality_${String(Date.now())}`;
const user = process.env['PROCUREMENT_CH_TEST_USER'] ?? 'default';
const password = process.env['PROCUREMENT_CH_TEST_PASSWORD'] ?? '';

const run = async (sql: string): Promise<string> => {
  const res = await fetch(URL_ENV, {
    method: 'POST',
    headers: { 'X-ClickHouse-User': user, 'X-ClickHouse-Key': password },
    body: sql,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${sql.slice(0, 80)}: ${text.slice(0, 300)}`);
  return text;
};

interface Row {
  readonly id: number;
  readonly source: string;
  readonly canonical: boolean;
  readonly group: number | null;
  readonly privacy?: 'public' | 'restricted';
  readonly status?: string;
}

const r = (
  id: number,
  source: string,
  canonical: boolean,
  group: number | null,
  extra: Partial<Row> = {}
): Row => ({ id, source, canonical, group, ...extra });

const insert = (table: string, rows: readonly Row[]): Promise<string> =>
  run(
    `INSERT INTO ${DATABASE}.${table} (procedure_id, build_id, is_canonical, dup_group_id, source_system, privacy_class, status) VALUES ${rows
      .map(
        (x) =>
          `(${String(x.id)}, '16', ${String(x.canonical)}, ${x.group === null ? 'NULL' : String(x.group)}, '${x.source}', '${x.privacy ?? 'public'}', ${x.status === undefined ? 'NULL' : `'${x.status}'`})`
      )
      .join(', ')}`
  );

const repo = () =>
  makeClickhouseAnalysisRepo({ url: URL_ENV, database: DATABASE, user, password }, () =>
    Promise.resolve(ok({ buildId: '16', publishedAt: 'now', quality: {}, matrixHash: null }))
  );

d('procedure canonicality on a real ClickHouse', () => {
  beforeAll(async () => {
    const tables = await run(
      `SELECT count() FROM system.tables WHERE database NOT IN ('system', 'INFORMATION_SCHEMA', 'information_schema')`
    );
    if (tables.trim() !== '0') throw new Error('refusing a ClickHouse server that holds tables');
    const ddl = await readFile(DDL_FILE, 'utf8');
    const head = /^CREATE TABLE [A-Za-z0-9_]+\.facts_procedures_v2_b[0-9]+\b/u;
    if (!head.test(ddl)) throw new Error('PROCUREMENT_CH_TEST_DDL is not a procedure table DDL');
    await run(`CREATE DATABASE ${DATABASE}`);
    for (const build of ['16', '17']) {
      await run(ddl.replace(head, `CREATE TABLE ${DATABASE}.facts_procedures_v2_b${build}`));
    }
    const big: Row[] = [r(1000, 'elicitatie', true, 1000)];
    for (let i = 0; i < PROCEDURE_DUPLICATES_CAP + 5; i++) {
      big.push(r(2000 + i, 'seap_notice', false, 1000));
    }
    await insert('facts_procedures_v2_b16', [
      // A rule-A group: the native head and two linked SEAP awards.
      r(347436, 'elicitatie', true, 347436),
      r(573731, 'seap_notice', false, 347436),
      r(573732, 'seap_notice', false, 347436, { status: 'cancelled' }),
      // Ungrouped native; ambiguous SEAP (two natives share its number).
      r(900001, 'elicitatie', true, null),
      r(900002, 'seap_notice', true, null),
      // An older SEAP sibling group.
      r(800001, 'seap_notice', true, 800001),
      r(800002, 'seap_notice', false, 800001),
      // A group whose canonical head is restricted, with one restricted member.
      r(700001, 'elicitatie', true, 700001, { privacy: 'restricted' }),
      r(700002, 'seap_notice', false, 700001),
      r(700003, 'seap_notice', false, 700001),
      r(700004, 'seap_notice', false, 700001, { privacy: 'restricted' }),
      ...big,
    ]);
    await insert('facts_procedures_v2_b17', [
      r(347436, 'elicitatie', true, null),
      r(573731, 'seap_notice', true, null),
    ]);
  });

  afterAll(async () => {
    await run(`DROP DATABASE IF EXISTS ${DATABASE}`);
  });

  it('reads the pinned build table and leaves unknowns out', async () => {
    const read = await repo().procedureCanonicality('16', [
      '573731',
      '573732',
      '347436',
      '900001',
      '900002',
      '800002',
      '999999',
      '1) OR (1',
    ]);
    expect(Object.fromEntries(read._unsafeUnwrap())).toEqual({
      '347436': { isCanonical: true, dupGroupId: '347436' },
      '573731': { isCanonical: false, dupGroupId: '347436' },
      // Cancelled procedures still carry their group: canonicality is metadata.
      '573732': { isCanonical: false, dupGroupId: '347436' },
      '900001': { isCanonical: true, dupGroupId: null },
      '900002': { isCanonical: true, dupGroupId: null },
      '800002': { isCanonical: false, dupGroupId: '800001' },
    });
    const prepared = await repo().procedureCanonicality('17', ['573731']);
    expect(Object.fromEntries(prepared._unsafeUnwrap())).toEqual({
      '573731': { isCanonical: true, dupGroupId: null },
    });
    expect((await repo().procedureCanonicality('18', ['573731'])).isErr()).toBe(true);
  });

  it('never answers or references a procedure that is not public', async () => {
    const read = await repo().procedureCanonicality('16', ['700001', '700002', '700004']);
    // The restricted head is not answered, and its id is not reported as the
    // group of the public member.
    expect(Object.fromEntries(read._unsafeUnwrap())).toEqual({
      '700002': { isCanonical: false, dupGroupId: null },
    });
    expect((await repo().procedureDuplicates('16', '700002'))._unsafeUnwrap()).toEqual([
      { sourceSystem: 'seap_notice', id: '700003' },
    ]);
    expect((await repo().procedureDuplicates('16', '700001'))._unsafeUnwrap()).toBeNull();
  });

  it('lists a group from one build, capped, the procedure excluded', async () => {
    const dups = async (id: string, build = '16') =>
      (await repo().procedureDuplicates(build, id))._unsafeUnwrap();
    expect(await dups('573731')).toEqual([
      { sourceSystem: 'elicitatie', id: '347436' },
      { sourceSystem: 'seap_notice', id: '573732' },
    ]);
    expect(await dups('347436')).toEqual([
      { sourceSystem: 'seap_notice', id: '573731' },
      { sourceSystem: 'seap_notice', id: '573732' },
    ]);
    expect(await dups('800001')).toEqual([{ sourceSystem: 'seap_notice', id: '800002' }]);
    expect(await dups('900002')).toEqual([]);
    expect(await dups('999999')).toBeNull();
    expect(await dups('573731', '17')).toEqual([]);
    const head = await dups('1000');
    expect(head).toHaveLength(PROCEDURE_DUPLICATES_CAP);
    expect(head?.[0]).toEqual({ sourceSystem: 'seap_notice', id: '2000' });
    const member = await dups('2003');
    expect(member).toHaveLength(PROCEDURE_DUPLICATES_CAP);
    expect(member?.slice(0, 3).map((x) => x.id)).toEqual(['1000', '2000', '2001']);
    expect(member?.some((x) => x.id === '2003')).toBe(false);
  });
});
