/**
 * E2E — the Monitorul Oficial privacy gate (LEGAL_CONTRACT §2) against a REAL
 * Postgres. The scrapper stores every gazette publication and classifies person
 * decrees `privacy_class = 'restricted'` (27,450 of 212,963 rows on Chronos,
 * 2026-10-16); the API must withhold them. Before this gate an unauthenticated
 * `moPublication(moActKey:)` returned a restricted row's identifiers.
 *
 * Only real rows through the real queries prove the predicate filters (a SQL
 * string assertion proves only that it was typed). Each read is checked for
 * rows AND for counts/discovery, so a total never reports a row the page will
 * not show. A lifecycle edge carries its endpoint publications' identifiers, and
 * a Monitorul status event its source publication's key (`evidence`), so both
 * are withheld when they name a restricted publication — on the MO paths AND on
 * the shared legal timeline / recent-changes feed.
 *
 * The schema below is a MINIMAL SHAPE — the columns these reads touch, typed as
 * `src/modules/legal/mo/db-schema.ts` declares them. It is not a replica of the
 * scrapper's migrations (another repo), so it proves the QUERY's behaviour, not
 * DDL fidelity.
 *
 * Docker-guarded: skips cleanly when no container runtime is reachable, the same
 * contract `parliament-committee-documents-privacy.test.ts` follows.
 */

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it as vitestIt } from 'vitest';

import { makeMonitorulRepo } from '@/modules/legal/mo/repo.js';
import { makeLegalActsRepo } from '@/modules/legal/shell/repo/acts-repo.js';

import { dockerCliUp } from './disposable-postgres.js';

import type { LegalActsRepo } from '@/modules/legal/core/ports.js';
import type { MonitorulRepo } from '@/modules/legal/mo/ports.js';
import type { ProdDatabase } from '@/modules/shared/index.js';
import type { Result } from 'neverthrow';

let container: StartedPostgreSqlContainer | undefined;
let db: Kysely<ProdDatabase> | undefined;
let repo: MonitorulRepo | undefined;
let acts: LegalActsRepo | undefined;
let dockerAvailable = false;

/** Report a missing runtime as SKIPPED rather than PASSED. */
const it = (name: string, test: () => unknown): void => {
  vitestIt(name, async ({ skip }) => {
    if (!dockerAvailable) skip();
    await test();
  });
};

const DDL = `
  drop schema if exists legal cascade;
  create schema legal;
  create table legal.mo_issues (
    mo_issue_id bigint primary key,
    part_code text not null,
    mo_part smallint,
    issue_label text not null,
    issue_number integer,
    issue_suffix text not null default '',
    issue_year smallint not null,
    issue_date date,
    pdf_url text,
    pdf_bytes bigint,
    has_archive_index boolean not null default false,
    has_emonitor_link boolean not null default false,
    first_seen_at timestamptz not null default now(),
    last_seen_at timestamptz not null default now(),
    privacy_class text not null default 'public'
      check (privacy_class in ('public','restricted'))
  );
  create table legal.mo_act_publications (
    mo_act_key text primary key,
    mo_issue_id bigint references legal.mo_issues,
    act_type text,
    act_number_norm text,
    act_year smallint,
    issue_year smallint,
    issuer_slug text,
    title text,
    act_date date,
    act_id bigint,
    resolution text not null,
    matched_via text,
    source_pdf_url text,
    first_seen_at timestamptz not null default now(),
    last_seen_at timestamptz not null default now(),
    privacy_class text not null default 'public'
      check (privacy_class in ('public','restricted'))
  );
  create table legal.mo_lifecycle_edges (
    edge_id bigint primary key,
    source_mo_act_key text not null references legal.mo_act_publications,
    relation text not null,
    target_raw text not null,
    target_index smallint not null default 0,
    target_act_type text,
    target_act_number text,
    target_act_year smallint,
    target_issuer_slug text not null default '',
    target_act_id bigint,
    target_mo_act_key text,
    resolution text not null,
    matched_via text,
    method text not null,
    confidence real,
    privacy_class text not null default 'public'
      check (privacy_class in ('public','restricted'))
  );
  create table legal.act_status_events (
    event_id bigint primary key,
    act_id bigint not null,
    event_kind text not null,
    effective_date date,
    source_act_id bigint,
    evidence jsonb not null default '{}'::jsonb,
    event_source text not null,
    privacy_class text not null default 'public'
      check (privacy_class in ('public','restricted'))
  );
  create table legal.acts (
    act_id bigint primary key,
    act_natural_key text not null,
    display_citation text not null,
    status text not null
  );
`;

const SEED = `
  insert into legal.mo_issues
    (mo_issue_id, part_code, mo_part, issue_label, issue_number, issue_year, issue_date, privacy_class)
  values
    (1, 'PI', 1, '100', 100, 2020, '2020-02-01', 'public'),
    -- RESTRICTED issue: no such row exists live today; the gate must still hold.
    (2, 'PI', 1, '7', 7, 1999, '1999-01-05', 'restricted');

  insert into legal.mo_act_publications
    (mo_act_key, mo_issue_id, act_type, act_number_norm, act_year, issue_year,
     issuer_slug, title, act_id, resolution, privacy_class)
  values
    ('pub-a', 1, 'hotarare', '1', 2020, 2020, 'guvernul-romaniei', 'Hotărâre publică', 10, 'unique', 'public'),
    ('pub-b', 1, 'ordin', '2', 2021, 2020, 'guvernul-romaniei', 'Ordin public', 11, 'unique', 'public'),
    -- Undated public publication: the keyset's trailing NULL section.
    ('pub-null', 1, 'ordin', '9', null, 2020, 'guvernul-romaniei', 'Ordin nedatat', null, 'unmatched', 'public'),
    -- RESTRICTED in that NULL section: the continuation must withhold it too.
    ('restricted-null', 1, 'decret', '8', null, 2020, 'guvernul-romaniei', 'Titlu restricționat', null, 'unmatched', 'restricted'),
    -- RESTRICTED, same act and issuer as pub-a: withheld from the act's
    -- publications, the issue contents, the issuer counts and the act types.
    ('restricted-a', 1, 'decret', '3', 2020, 2020, 'guvernul-romaniei', 'Titlu restricționat', 10, 'unique', 'restricted'),
    -- RESTRICTED, the ONLY row of its issuer: discovery must not surface the issuer.
    ('restricted-b', 1, 'decizie', '4', 2020, 2020, 'presedintele-romaniei', 'Titlu restricționat', 12, 'unique', 'restricted');

  insert into legal.mo_lifecycle_edges
    (edge_id, source_mo_act_key, relation, target_raw, target_act_type, target_act_number,
     target_act_year, target_act_id, target_mo_act_key, resolution, method, privacy_class)
  values
    (1, 'pub-a', 'rectifica', 'Ordinul nr. 2/2021', 'ordin', '2', 2021, 11, 'pub-b', 'unique', 'test', 'public'),
    (2, 'pub-a', 'promulga', 'Legea nr. 5/2020', 'lege', '5', 2020, 20, null, 'unique', 'test', 'public'),
    -- Restricted SOURCE publication: its key is a restricted identifier.
    (3, 'restricted-a', 'rectifica', 'Ordinul nr. 2/2021', 'ordin', '2', 2021, 11, 'pub-b', 'unique', 'test', 'public'),
    -- Restricted TARGET publication: the target fields are its identifiers.
    (4, 'pub-b', 'republica', 'Decizia nr. 4/2020', 'decizie', '4', 2020, 12, 'restricted-b', 'unique', 'test', 'public'),
    -- A restricted edge between public publications.
    (5, 'pub-a', 'promulga', 'Legea nr. 6/2020', 'lege', '6', 2020, 21, null, 'unique', 'test', 'restricted');

  insert into legal.acts (act_id, act_natural_key, display_citation, status) values
    (10, 'hotarare:gov:1:2020', 'HG 1/2020', 'in-vigoare'),
    (11, 'ordin:other:2:2021', 'Ordin 2/2021', 'in-vigoare');

  insert into legal.act_status_events
    (event_id, act_id, event_kind, effective_date, source_act_id, evidence, event_source, privacy_class)
  values
    (1, 10, 'rectificare', '2020-03-01', 11, '{"mo_act_key":"pub-a"}', 'monitorul-oficial', 'public'),
    (2, 10, 'republicare', '2020-04-01', 12, '{"mo_act_key":"pub-a"}', 'monitorul-oficial', 'restricted'),
    (3, 11, 'rectificare', '2020-05-01', 10, '{"mo_act_key":"pub-b"}', 'monitorul-oficial', 'restricted'),
    -- PUBLIC event whose evidence names a RESTRICTED publication (46 live rows):
    -- serving it would disclose that publication's key and coordinates.
    (4, 10, 'republicare', '2020-06-01', null, '{"mo_act_key":"restricted-a"}', 'monitorul-oficial', 'public'),
    -- A Portal event (no publication key): the shared timeline keeps it.
    (5, 10, 'modificare', '2020-07-01', 11, '{}', 'portal', 'public');
`;

beforeAll(async () => {
  if (!dockerCliUp()) {
    console.warn('Docker CLI unavailable — MO privacy e2e SKIPPED.');
    return;
  }
  try {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
  } catch (error) {
    console.warn(
      `Testcontainers runtime unavailable — MO privacy e2e SKIPPED: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return;
  }
  const connectionString = container.getConnectionUri();
  const client = new pg.Client({ connectionString });
  await client.connect();
  await client.query(DDL);
  await client.query(SEED);
  await client.end();

  db = new Kysely<ProdDatabase>({
    dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString }) }),
  });
  repo = makeMonitorulRepo(db);
  acts = makeLegalActsRepo(db);
  dockerAvailable = true;
}, 120_000);

afterAll(async () => {
  await db?.destroy();
  await container?.stop();
});

const value = <T, E>(res: Result<T, E>): T => {
  expect(res.isOk()).toBe(true);
  return res._unsafeUnwrap();
};

describe('Monitorul publications — restricted rows are never served', () => {
  it('direct lookup returns nothing for a restricted key', async () => {
    expect(value(await repo!.getPublicationByKey('restricted-a'))).toBeNull();
    expect(value(await repo!.getPublicationByKey('pub-a'))?.moActKey).toBe('pub-a');
  });

  it('issue contents list only public publications', async () => {
    const seen: string[] = [];
    let after: string | undefined;
    for (let draw = 0; draw < 10; draw += 1) {
      const page = value(
        await repo!.getIssueContents('1', { first: 1, ...(after !== undefined && { after }) })
      );
      seen.push(...page.items.map((p) => p.moActKey));
      if (page.next === null) break;
      after = page.next;
    }
    expect(seen).toEqual(['pub-a', 'pub-b', 'pub-null']);
  });

  const walkPublications = async (sort: string): Promise<string[]> => {
    const seen: string[] = [];
    let after: string | undefined;
    for (let draw = 0; draw < 10; draw += 1) {
      const page = value(
        await repo!.listPublications(
          { issuerSlug: { in: ['guvernul-romaniei', 'presedintele-romaniei'] } },
          { first: 1, ...(after !== undefined && { after }) },
          sort
        )
      );
      seen.push(...page.items.map((p) => p.moActKey));
      if (page.next === null) break;
      after = page.next;
    }
    return seen;
  };

  it('the filtered list pages only public rows, through the NULL-year section', async () => {
    expect(await walkPublications('act_year_desc')).toEqual(['pub-b', 'pub-a', 'pub-null']);
    expect(await walkPublications('act_year_asc')).toEqual(['pub-a', 'pub-b', 'pub-null']);
  });

  it("an act's publications exclude its restricted publication", async () => {
    const one = value(await repo!.getPublicationsForAct('10'));
    expect(one.map((p) => p.moActKey)).toEqual(['pub-a']);
    expect(value(await repo!.getPublicationsForAct('12'))).toEqual([]);
    const many = value(await repo!.getPublicationsForActs(['10', '11', '12']));
    expect([...many.keys()].sort()).toEqual(['10', '11']);
    expect(many.get('10')?.map((p) => p.moActKey)).toEqual(['pub-a']);
  });
});

describe('Monitorul counts and discovery — measured under the same gate', () => {
  it('issuer-year counts and their total exclude restricted rows', async () => {
    const byIssuer = value(
      await repo!.countPublicationsByIssuerYear({ year: 2020, groupBy: 'issuer' })
    );
    expect(byIssuer.rows.map((r) => [r.issuerSlug, r.count])).toEqual([['guvernul-romaniei', 3]]);
    expect(byIssuer.total).toBe(3);
    const byType = value(
      await repo!.countPublicationsByIssuerYear({ year: 2020, groupBy: 'act_type' })
    );
    expect(byType.rows.map((r) => r.actType).sort()).toEqual(['hotarare', 'ordin']);
  });

  it('the issuer summary counts only public rows; a restricted-only issuer is absent', async () => {
    const summary = value(await repo!.getIssuerSummary('guvernul-romaniei'));
    expect(summary?.publicationCount).toBe(3);
    expect(summary?.topActTypes).toEqual(['ordin', 'hotarare']);
    expect(summary?.byPartCode).toEqual([{ partCode: 'PI', count: 3 }]);
    expect(value(await repo!.getIssuerSummary('presedintele-romaniei'))).toBeNull();
    expect(value(await repo!.countPublicationsByPartForIssuer('presedintele-romaniei'))).toEqual(
      []
    );
  });

  it('issuer and act-type resolution never surface restricted-only values', async () => {
    expect(value(await repo!.resolveIssuer('presedintele', 10))).toEqual([]);
    expect(value(await repo!.resolveIssuer('guvernul', 10)).map((h) => h.count)).toEqual([3]);
    expect(value(await repo!.resolveActType('decret', 10))).toEqual([]);
    expect(
      value(await repo!.resolveActType('', 10))
        .map((h) => h.value)
        .sort()
    ).toEqual(['hotarare', 'ordin']);
  });
});

describe('Monitorul issues, edges and status events — gated on their own class', () => {
  it('a restricted issue is not served by lookup, browse or year range', async () => {
    expect(value(await repo!.getIssueById('2'))).toBeNull();
    expect(value(await repo!.findIssueByCoordinates('PI', '7', 1999))).toBeNull();
    const list = value(
      await repo!.listIssues({ year: { eq: 1999 } }, { page: 1, pageSize: 10 }, 'issue_date_desc')
    );
    expect(list).toEqual({ items: [], total: 0 });
    expect(value(await repo!.getIssueYearRange())).toEqual({ min: 2020, max: 2020 });
  });

  it('edges touching a restricted publication, or restricted themselves, are withheld', async () => {
    const fromA = value(await repo!.getEdgesForSource('pub-a'));
    expect(fromA.map((e) => e.edgeId)).toEqual(['1', '2']);
    expect(value(await repo!.getEdgesForSource('restricted-a'))).toEqual([]);
    expect(value(await repo!.getEdgesForSource('pub-b'))).toEqual([]);
    const toB = value(await repo!.getEdgesForTargetAct('11'));
    expect(toB.map((e) => e.edgeId)).toEqual(['1']);
    const many = value(await repo!.getEdgesForTargetActs(['11', '12', '21']));
    expect([...many.keys()]).toEqual(['11']);
    const seen: string[] = [];
    let after: string | undefined;
    for (let draw = 0; draw < 10; draw += 1) {
      const page = value(
        await repo!.listEdges(
          { relation: { in: ['rectifica', 'republica', 'promulga'] } },
          { first: 1, ...(after !== undefined && { after }) }
        )
      );
      seen.push(...page.items.map((e) => e.edgeId));
      if (page.next === null) break;
      after = page.next;
    }
    expect(seen).toEqual(['1', '2']);
  });

  it('restricted Monitorul status events, and events naming a restricted publication, are withheld', async () => {
    const one = value(await repo!.getStatusEventsForAct('10'));
    expect(one.map((e) => e.eventId)).toEqual(['1']);
    const many = value(await repo!.getStatusEventsForActs(['10', '11']));
    expect([...many.keys()]).toEqual(['10']);
  });
});

describe('shared legal timeline and recent-changes feed — the same status gate', () => {
  it("an act's timeline keeps public events and withholds restricted-linked ones", async () => {
    const all = value(await acts!.getStatusEvents('10'));
    expect(all.map((e) => e.eventId)).toEqual(['1', '5']);
    const mo = value(await acts!.getStatusEvents('10', 'monitorul-oficial'));
    expect(mo.map((e) => e.eventId)).toEqual(['1']);
    expect(value(await acts!.getStatusEvents('11'))).toEqual([]);
  });

  it('the recent-changes feed and its count are measured under the gate', async () => {
    const seen: string[] = [];
    let after: string | undefined;
    for (let draw = 0; draw < 10; draw += 1) {
      const page = value(
        await acts!.listRecentChanges({ page: { first: 1, ...(after !== undefined && { after }) } })
      );
      seen.push(...page.items.map((e) => e.eventId));
      if (page.next === null) break;
      after = page.next;
    }
    expect(seen).toEqual(['5', '1']);
    expect(value(await acts!.countRecentChanges({}))).toBe(2);
    expect(value(await acts!.countRecentChanges({ eventSource: 'monitorul-oficial' }))).toBe(1);
  });
});
