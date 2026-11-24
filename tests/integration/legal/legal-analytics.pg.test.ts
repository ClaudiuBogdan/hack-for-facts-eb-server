/**
 * Legislation analytics on the REAL DDL: the scrapper's legal_v2 (100000),
 * analytics release (100010) and insights layer (100020) migrations,
 * hash-pinned and run through their `up`, then one release and one layer
 * seeded the way the loader writes them (content rows in the creating
 * transaction, publication in a later one, so the real triggers accept them).
 * Proves: 503 before the tables exist and while no layer is published; every
 * view's counts and denominators on a known layer; firm/uncertain/unplaced
 * classes; stock from the stored column; a restricted act is hidden from the
 * acts list and the most-named targets but still counted; the acts cursor;
 * the head's value lists; the read is pinned to the pointer's layer.
 *
 * TARGET GUARD (the legal-v2.pg.test.ts pattern). Touches ONLY an explicitly
 * provided throwaway database: `LEGAL_ANALYTICS_TEST_PG_URL` +
 * `LEGAL_ANALYTICS_TEST_DB_NAME` (`server_legal_analytics_<run-id>`), a
 * loopback URL whose database path equals that name, holding no `legal_v2`
 * schema before setup. The legal_v2 rows are seeded with triggers off
 * (`session_replication_role = replica`), so the role must be a superuser of
 * that throwaway cluster. `SCRAPPER_REPO_ROOT` names the scrapper checkout
 * holding the pinned migrations: a change to any of them moves its pin.
 * Without the inputs it SKIPS; with `TEST_E2E_REQUIRED=1` it FAILS instead.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  getLegalAnalytics,
  type LegalAnalyticsDeps,
} from '@/modules/legal/core/analytics/usecases.js';
import { makeLegalAnalyticsDeps } from '@/modules/legal/index.js';

import type {
  LegalAnalyticsActs,
  LegalAnalyticsBreakdown,
  LegalAnalyticsGrid,
  LegalAnalyticsHead,
  LegalAnalyticsLinks,
  LegalAnalyticsSeries,
  LegalAnalyticsSummary,
} from '@/modules/legal/core/analytics/types.js';
import type { ProdDatabase } from '@/modules/shared/index.js';

const REQUIRED = process.env['TEST_E2E_REQUIRED'] === '1';
const TARGET_URL = process.env['LEGAL_ANALYTICS_TEST_PG_URL'] ?? '';
const TARGET_DB = process.env['LEGAL_ANALYTICS_TEST_DB_NAME'] ?? '';
const CONFIGURED = TARGET_URL !== '' && TARGET_DB !== '';
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

const assertThrowawayTarget = (targetUrl: string, targetDb: string): void => {
  if (!/^server_legal_analytics_[a-z0-9_]{1,40}$/u.test(targetDb)) {
    throw new Error('LEGAL_ANALYTICS_TEST_DB_NAME must be server_legal_analytics_<run-id>');
  }
  const url = new URL(targetUrl);
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new Error('LEGAL_ANALYTICS_TEST_PG_URL must be a postgres URL');
  }
  if (url.search !== '' || url.hash !== '') {
    throw new Error('LEGAL_ANALYTICS_TEST_PG_URL must carry no query parameters or fragment');
  }
  if (!LOOPBACK.has(url.hostname)) throw new Error('LEGAL_ANALYTICS_TEST_PG_URL must be loopback');
  if (decodeURIComponent(url.pathname.slice(1)) !== targetDb) {
    throw new Error(
      'LEGAL_ANALYTICS_TEST_PG_URL database does not equal LEGAL_ANALYTICS_TEST_DB_NAME'
    );
  }
};

describe('legal analytics pg target guard (pure)', () => {
  it('refuses anything but a loopback throwaway database', () => {
    expect(() => {
      assertThrowawayTarget(
        'postgres://x@10.0.0.1/server_legal_analytics_a',
        'server_legal_analytics_a'
      );
    }).toThrow(/loopback/u);
    expect(() => {
      assertThrowawayTarget('postgres://x@127.0.0.1/transparenta_prod', 'transparenta_prod');
    }).toThrow(/server_legal_analytics_/u);
  });
});

/** The scrapper's migrations, pinned: a review change to any of them moves its pin here. */
const MIGRATIONS: readonly (readonly [string, string])[] = [
  [
    '20261116T100000__legal_v2_schema.ts',
    '6e2a5f738148d2b2638ae715cd36b4a2bed21599aaa1e11bbea1922c739070b7',
  ],
  [
    '20261116T100010__legal_v2_analytics_schema.ts',
    '9b76cc91e55d8b16c7cfb240d03f736fa373a6c536af85f6c37621e92253610e',
  ],
  [
    '20261116T100020__legal_v2_insights_schema.ts',
    '8dc27262f6863a97fa7786a3b95eac947fd01e4a18367539c2c8831f1e2939cd',
  ],
];

/** The old corpus: only what the act repo and the bridged title read. */
const LEGACY_STUB = `
  create schema legal;
  create table legal.acts (act_id bigint primary key, act_natural_key text, act_type text,
    act_number text, act_year smallint, issuer_slug text, canonical_document_id text,
    display_citation text, status text, status_evidence jsonb, entry_into_force date,
    in_degree integer);
  create table legal.act_documents (document_id text primary key, act_id bigint,
    version_kind text, version_date date, is_canonical boolean, den text, title text,
    issuer_raw text, publication_raw text, entry_into_force date, first_publication_date date,
    status_markers text[], extraction_status text, compatibility_tier text, mo_part smallint,
    mo_number text, mo_date date, source_url text);
  create table legal.document_summaries (document_id text primary key, description text,
    summary text, plain_language_summary text, document_category text, domains text[],
    affected_audiences text[], keywords text[], key_dates jsonb, penalties_mentioned boolean,
    fiscal_impact text, confidence real, source_extraction_status text);
  create table legal.document_render (document_id text, run_id bigint, chunk_index int,
    privacy_class text);
`;

const VALUES = {
  felul_groups: [
    'rule-making',
    'individual',
    'budget-property-organisation',
    'procedure',
    'court',
    'reports-notices',
    'unplaced',
  ],
  felul_kinds: {
    new_rules: 'rule-making',
    amendment: 'rule-making',
    appointments: 'individual',
    court: 'court',
    unplaced: 'unplaced',
  },
  stock_kinds: ['new_rules'],
  weak_bases: ['fallback', 'instrument_default'],
  firm_bases: ['opening_action', 'type_or_issuer_fact', 'instrument'],
  felul_bases: [
    'opening_action',
    'type_or_issuer_fact',
    'instrument',
    'instrument_default',
    'fallback',
    'unplaced',
  ],
  issuer_families: ['guvern', 'parlament', 'instante', 'fara_emitent'],
  link_kinds: ['amends', 'approves_ordinance', 'rejects_ordinance', 'promulgates', 'court_names'],
  link_notes: ['resolved', 'code', 'outside_corpus', 'ambiguous', 'no_target_in_title'],
};

/**
 * Six acts. 1 the amended law (firm new rules, in stock); 2 a decision amending 1
 * (firm amendment); 3 a decision on a WEAK basis (uncertain; its guess new rules,
 * not in stock); 4 a court decision naming 1; 5 restricted in legal_v2 after the
 * layer was built (an order, firm new rules, in stock); 6 unplaced, year unknown.
 */
const ACTS = `
  (1, 2001, 'lege', 'legi_ordonante', 'parlamentul', 'Parlamentul', 'Parlamentul', 'parlament', 'alias',
   'rule-making', 'new_rules', 'opening_action', true, 5, 3, 2, '2001-02-01', '2020-01-01', 2, 0, true),
  (2, 2010, 'hotarare', 'hotarari', 'guvernul', 'Guvernul', 'Guvernul', 'guvern', 'alias',
   'rule-making', 'amendment', 'opening_action', false, 1, 0, 0, '2010-03-01', null, 0, 1, true),
  (3, 2010, 'hotarare', 'hotarari', 'guvernul', 'Guvernul', 'Guvernul', 'guvern', 'alias',
   'rule-making', 'new_rules', 'instrument_default', false, 1, 0, 0, '2010-05-01', null, 0, 0, false),
  (4, 2015, 'decizie', 'decizii', 'ccr', 'Curtea Constituțională', 'Curtea Constituțională', 'instante', 'alias',
   'court', 'court', 'type_or_issuer_fact', false, 1, 0, 0, '2015-01-01', null, 0, 1, true),
  (5, 2012, 'ordin', 'ordine', 'guvernul', 'Guvernul', 'Guvernul', 'guvern', 'alias',
   'rule-making', 'new_rules', 'instrument', true, 1, 0, 0, '2012-01-01', null, 0, 0, true),
  (6, null, 'unknown', 'altele', null, null, null, 'fara_emitent', 'none',
   'unplaced', 'unplaced', 'unplaced', false, 0, 0, 0, null, null, 0, 0, false)`;

const run = CONFIGURED || REQUIRED ? describe : describe.skip;

run('legal analytics on the real DDL', () => {
  let setup: pg.Client;
  let db: Kysely<ProdDatabase>;
  let deps: LegalAnalyticsDeps;
  const q = (text: string, params: unknown[] = []): Promise<pg.QueryResult> =>
    setup.query(text, params);
  const fresh = (): LegalAnalyticsDeps => makeLegalAnalyticsDeps(db);
  const view = async <T>(name: string, args: Record<string, unknown> = {}): Promise<T> => {
    const r = await getLegalAnalytics(deps, name, args);
    if (r.isErr()) throw new Error(`${name}: ${r.error.type} ${r.error.message}`);
    return r.value.data as T;
  };

  beforeAll(async () => {
    assertThrowawayTarget(TARGET_URL, TARGET_DB);
    setup = new pg.Client({ connectionString: TARGET_URL });
    await setup.connect();
    const before = await q(
      `select count(*)::int as n from pg_namespace where nspname in ('legal', 'legal_v2', 'legal_v2_analytics')`
    );
    if ((before.rows[0] as { n: number }).n !== 0) throw new Error('target is not empty');
    db = new Kysely<ProdDatabase>({
      dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: TARGET_URL, max: 2 }) }),
    });
    const root = process.env['SCRAPPER_REPO_ROOT'] ?? '';
    if (root === '') throw new Error('SCRAPPER_REPO_ROOT is required for the pinned migrations');
    await q(LEGACY_STUB);
    for (const [name, pin] of MIGRATIONS) {
      const full = path.join(root, 'src', 'db', 'prod-migrations', name);
      const actual = createHash('sha256').update(fs.readFileSync(full)).digest('hex');
      if (actual !== pin) throw new Error(`migration drift: ${name} ${actual}`);
      // The insights tables come later: the first assertion reads before they exist.
      if (name.includes('insights')) continue;
      const mod = (await import(pathToFileURL(full).href)) as {
        up: (d: Kysely<unknown>) => Promise<void>;
      };
      await mod.up(db as unknown as Kysely<unknown>);
    }
    deps = fresh();
  }, 120_000);

  afterAll(async () => {
    await db?.destroy();
    await setup?.end();
  });

  it('answers 503 before the insights tables exist and while no layer is published', async () => {
    const missing = await getLegalAnalytics(fresh(), 'head', {});
    expect(missing._unsafeUnwrapErr()).toMatchObject({ type: 'ServiceUnavailable' });
    const root = process.env['SCRAPPER_REPO_ROOT'] ?? '';
    const full = path.join(root, 'src', 'db', 'prod-migrations', MIGRATIONS[2]?.[0] ?? '');
    const mod = (await import(pathToFileURL(full).href)) as {
      up: (d: Kysely<unknown>) => Promise<void>;
    };
    await mod.up(db as unknown as Kysely<unknown>);
    const empty = await getLegalAnalytics(fresh(), 'summary', {});
    expect(empty._unsafeUnwrapErr()).toMatchObject({
      type: 'ServiceUnavailable',
      message: 'No legislation analytics layer is published.',
    });
  });

  it('seeds one release and one layer through the real triggers', async () => {
    await q('set session_replication_role = replica');
    await q(`insert into legal_v2.acts (act_id, act_natural_key, act_type, act_number, act_year,
               issuer_slug, display_citation, identity_generation_seq, privacy_class) values
             (1, 'lege:1:2001:', 'lege', '1', 2001, 'parlamentul', 'Legea nr. 1/2001', 1, 'public'),
             (2, 'hotarare:2:2010:guvernul', 'hotarare', '2', 2010, 'guvernul', 'HG nr. 2/2010', 1, 'public'),
             (3, 'hotarare:3:2010:guvernul', 'hotarare', '3', 2010, 'guvernul', 'HG nr. 3/2010', 1, 'public'),
             (4, 'decizie:4:2015:ccr', 'decizie', '4', 2015, 'ccr', 'Decizia nr. 4/2015', 1, 'public'),
             (5, 'ordin:5:2012:guvernul', 'ordin', '5', 2012, 'guvernul', 'Ordinul nr. 5/2012', 1, 'restricted'),
             (6, 'necunoscut::', 'necunoscut', null, null, null, 'act 6', 1, 'public')`);
    await q(`insert into legal.acts (act_id, canonical_document_id) values (1, 'd1')`);
    await q(`insert into legal.act_documents (document_id, act_id, is_canonical, title)
             values ('d1', 1, true, 'LEGE nr. 1 din 2001 privind ceva')`);
    await q('set session_replication_role = origin');

    await q('begin');
    await q(`insert into legal_v2_analytics.release (generation_seq, selection_seq, identity_published_at,
               identity_digest, package_digest, method, code_dirty)
             values (1, 1, '2026-11-20T00:00:00Z', 'i', '${'a'.repeat(64)}', 'test', false)`);
    await q(`insert into legal_v2_analytics.act_scope (release_id, act_id, act_natural_key, act_type, act_year,
               issuer_slug, type_band, era)
             select 1, a, 'k' || a, 't', null, null, 'b', 'e' from generate_series(1, 6) a`);
    await q('commit');
    await q('update legal_v2_analytics.release set published_at = now() where release_id = 1');
    await q(
      'insert into legal_v2_analytics.current_release (singleton, release_id) values (true, 1)'
    );

    await q('begin');
    await q(
      `insert into legal_v2_analytics.insights_layer (release_id, bundle_digest, method, counts, code_dirty)
       values (1, $1, $2, '{}', false)`,
      ['b'.repeat(64), JSON.stringify({ rules: { felul: 'felul-test' }, values: VALUES })]
    );
    await q(`insert into legal_v2_analytics.insight_act (layer_id, act_id, year, type_normal, type_band,
               issuer_slug, issuer_named, issuer_lineage, issuer_family, issuer_basis, felul_group, felul_kind,
               felul_basis, in_stock, forms, consolidations, version_band, first_publication, last_version,
               cited_by, cites, has_text, object_tag)
             select 1, x.act_id, x.year::smallint, x.type_normal, x.type_band, x.issuer_slug, x.issuer_named,
                    x.issuer_lineage, x.issuer_family, x.issuer_basis, x.felul_group, x.felul_kind, x.felul_basis,
                    x.in_stock, x.forms, x.consolidations, x.version_band::smallint, x.first_publication::date,
                    x.last_version::date, x.cited_by, x.cites, x.has_text, 'other'
               from (values ${ACTS}) as x(act_id, year, type_normal, type_band, issuer_slug, issuer_named,
                    issuer_lineage, issuer_family, issuer_basis, felul_group, felul_kind, felul_basis, in_stock,
                    forms, consolidations, version_band, first_publication, last_version, cited_by, cites,
                    has_text)`);
    await q(`insert into legal_v2_analytics.insight_link (layer_id, source_act, kind, target_act, target_note,
               target_code) values
             (1, 2, 'amends', 1, 'resolved', null),
             (1, 4, 'court_names', 1, 'resolved', null),
             (1, 3, 'amends', null, 'code', 'Codul civil'),
             (1, 5, 'amends', 1, 'resolved', null),
             (1, 6, 'amends', 5, 'resolved', null),
             (1, 1, 'promulgates', 4, 'resolved', null)`);
    await q('commit');
    await q(
      `update legal_v2_analytics.insights_layer set published_at = now(), checks = '[]' where layer_id = 1`
    );
    await q(
      'insert into legal_v2_analytics.current_insights_layer (singleton, layer_id) values (true, 1)'
    );
    deps = fresh();
  });

  it('serves the head with the layer, its value lists and totals', async () => {
    const head = await view<LegalAnalyticsHead>('head');
    expect(head.layer).toMatchObject({ layerId: '1', releaseId: '1' });
    expect(head.layer.publishedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u);
    expect(head.values.weakBases).toEqual(['fallback', 'instrument_default']);
    expect(head.totals).toEqual({
      acts: 6,
      actsWithText: 4,
      inStock: 2,
      uncertain: 1,
      unplaced: 1,
    });
    expect(head.types[0]).toEqual({ key: 'hotarare', acts: 2 });
    expect(head).toMatchObject({ total: 6, population: 6 });
    expect(head.issuers).toContainEqual({ lineage: 'Guvernul', families: ['guvern'], acts: 3 });
    expect(head.issuerCount).toBe(3);
    expect(head.years).toEqual({ min: 2001, max: 2015 });
  });

  it('counts firm, uncertain and unplaced apart, over flow and stock', async () => {
    const all = await view<LegalAnalyticsSummary>('summary');
    expect(all).toMatchObject({
      total: 6,
      population: 6,
      uncertain: 1,
      unplaced: 1,
      withText: 4,
      withVersions: 1,
    });
    expect(all.felul).toEqual([
      { key: 'rule-making', acts: 3 },
      { key: 'court', acts: 1 },
      { key: 'uncertain', acts: 1 },
      { key: 'unplaced', acts: 1 },
    ]);
    const stock = await view<LegalAnalyticsSummary>('summary', { population: 'stock' });
    expect(stock).toMatchObject({ total: 2, population: 2, uncertain: 0 });
    // a group or a kind counts firm placements only; uncertain counts the weak ones
    expect((await view<LegalAnalyticsSummary>('summary', { felul: 'new_rules' })).total).toBe(2);
    expect((await view<LegalAnalyticsSummary>('summary', { felul: 'uncertain' })).total).toBe(1);
    expect(
      (await view<LegalAnalyticsSummary>('summary', { felul: 'rule-making', type: ['hotarare'] }))
        .total
    ).toBe(1);
    expect((await view<LegalAnalyticsSummary>('summary', { from: 2010, to: 2012 })).total).toBe(3);
    expect(
      (await view<LegalAnalyticsSummary>('summary', { issuer: 'Guvernul', versions: 0 })).total
    ).toBe(3);
  });

  it('breaks down, by year and on a grid', async () => {
    const kinds = await view<LegalAnalyticsBreakdown>('breakdown', { lens: 'kind', limit: 2 });
    expect(kinds.rows).toEqual([
      { key: 'new_rules', acts: 2 },
      { key: 'amendment', acts: 1 },
    ]);
    expect(kinds).toMatchObject({ total: 6, rest: 3, truncated: true });
    const issuers = await view<LegalAnalyticsBreakdown>('breakdown', { lens: 'issuer' });
    expect(issuers.rows).toContainEqual({ key: null, acts: 1 });
    const series = await view<LegalAnalyticsSeries>('series', { lens: 'type', top: 1 });
    expect(series.keys).toEqual(['hotarare']);
    expect(series.years).toContainEqual({ year: 2010, acts: [2, 0] });
    expect(series.years).toContainEqual({ year: 2001, acts: [0, 1] });
    expect(series.unknownYear).toBe(1);
    const grid = await view<LegalAnalyticsGrid>('grid', { lens: 'felul', by: 'family' });
    const rm = grid.rows.findIndex((r) => r.key === 'rule-making');
    const guvern = grid.cols.findIndex((c) => c.key === 'guvern');
    expect(grid.cells[rm]?.[guvern]).toBe(2);
  });

  it('names link targets and lists acts only with a public identity, decided in SQL', async () => {
    const links = await view<LegalAnalyticsLinks>('links');
    expect(links.byKind).toEqual([
      { kind: 'amends', note: 'code', links: 1 },
      { kind: 'amends', note: 'resolved', links: 3 },
      { kind: 'court_names', note: 'resolved', links: 1 },
      { kind: 'promulgates', note: 'resolved', links: 1 },
    ]);
    expect(links.topTargets).toContainEqual({
      kind: 'amends',
      target: {
        actId: '1',
        citation: 'Legea nr. 1/2001',
        title: 'LEGE nr. 1 din 2001 privind ceva',
      },
      links: 2,
    });
    // act 5 is a link TARGET but restricted: counted in byKind, never named
    expect(links.topTargets.map((t) => t.target.actId)).not.toContain('5');
    expect(links.days.find((d) => d.kind === 'amends')).toMatchObject({ links: 2 });
    expect(links.days.find((d) => d.kind === 'promulgates')).toBeUndefined();
    expect(links.daysMeasure).toContain('Gazette');
    // act 5 is new rules too, restricted since the build: counted in hidden, never a row or a cursor
    const acts = await view<LegalAnalyticsActs>('acts', { felul: 'new_rules', limit: 1 });
    expect(acts.rows.map((r) => r.actId)).toEqual(['1']);
    expect(acts.rows[0]).toMatchObject({
      amended: 2,
      court: 1,
      versions: 3,
      cited: 2,
      guess: null,
    });
    expect(acts).toMatchObject({ hidden: 1, next: null });
    const weak = await view<LegalAnalyticsActs>('acts', { felul: 'uncertain' });
    expect(weak.rows[0]).toMatchObject({
      actId: '3',
      felul: 'uncertain',
      guess: { group: 'rule-making', kind: 'new_rules' },
    });
  });

  it('traverses tied pages with the cursor-free page key', async () => {
    const seen: string[] = [];
    const hidden: number[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 6; page += 1) {
      const args: Record<string, unknown> = { order: 'cited', limit: 1 };
      if (cursor !== null) args['cursor'] = cursor;
      const r: LegalAnalyticsActs = await view<LegalAnalyticsActs>('acts', args);
      seen.push(...r.rows.map((x) => x.actId));
      hidden.push(r.hidden);
      cursor = r.next;
      if (cursor === null) break;
    }
    // act 1 is cited twice; the rest tie at zero, by act id descending; act 5 is hidden
    expect(seen).toEqual(['1', '6', '4', '3', '2']);
    // `hidden` is the selection's total, the same on every page
    expect(new Set(hidden)).toEqual(new Set([1]));
  });

  it('stops naming an act restricted after a warm read, without a new layer', async () => {
    const before = await view<LegalAnalyticsActs>('acts', { felul: 'rule-making' });
    expect(before.rows.map((r) => r.actId)).toEqual(['1', '2']);
    await q('set session_replication_role = replica');
    await q(`update legal_v2.acts set privacy_class = 'restricted' where act_id = 2`);
    try {
      const after = await view<LegalAnalyticsActs>('acts', { felul: 'rule-making' });
      expect(after.rows.map((r) => r.actId)).toEqual(['1']);
      expect(after.hidden).toBe(2);
      // the counts, which name no act, are unchanged
      expect(after.total).toBe(before.total);
    } finally {
      await q(`update legal_v2.acts set privacy_class = 'public' where act_id = 2`);
      await q('set session_replication_role = origin');
    }
  });
});
