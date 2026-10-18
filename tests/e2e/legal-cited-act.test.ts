/**
 * E2E — the act a citation names (I-21), against a REAL Postgres.
 *
 * 1. One act holding several issuer keys for one (type, number, year) — a joint
 *    order, as the schema permits — is ONE candidate, not one per key row; a
 *    bare citation it alone holds is that act, not an ambiguity.
 * 2. A number several acts hold is an ambiguity listing them.
 * 3. An alias is matched as the whole input, case-folded.
 * 4. Input with further words (a second citation, a name fragment) is refused
 *    with its candidates even when one act is returned.
 *
 * The tables are the scrapper's `legal.acts`, `legal.act_citation_keys` and
 * `legal.act_aliases` columns and keys (20260612T150000__legal_domain), without
 * the later constraints these reads do not touch. Docker-guarded like the other
 * e2e suites.
 */

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it as vitestIt } from 'vitest';

import { resolveCitedAct } from '@/modules/legal/core/usecases.js';
import { makeLegalActsRepo } from '@/modules/legal/shell/repo/acts-repo.js';

import { dockerCliUp } from './disposable-postgres.js';

import type { LegalActsRepo } from '@/modules/legal/core/ports.js';
import type { ProdDatabase } from '@/modules/shared/index.js';

let container: StartedPostgreSqlContainer | undefined;
let db: Kysely<ProdDatabase> | undefined;
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
  create table legal.acts (
    act_id           bigint primary key,
    act_natural_key  text not null unique,
    act_type         text not null,
    act_number       text,
    act_year         smallint,
    issuer_slug      text,
    canonical_document_id text,
    display_citation text not null,
    status           text not null default 'necunoscut',
    status_evidence  jsonb not null default '{}'::jsonb,
    entry_into_force date,
    in_degree        integer not null default 0
  );
  create table legal.act_citation_keys (
    act_type    text not null,
    act_number  text not null,
    act_year    smallint not null,
    issuer_slug text not null default '',
    act_id      bigint not null references legal.acts(act_id),
    primary key (act_type, act_number, act_year, issuer_slug, act_id)
  );
  create table legal.act_aliases (
    alias  text not null,
    act_id bigint not null references legal.acts(act_id),
    primary key (alias, act_id)
  );
`;

const SEED = `
  insert into legal.acts (act_id, act_natural_key, act_type, act_number, act_year, issuer_slug, display_citation, in_degree) values
    (10, 'ordin:867:2011:ms', 'ordin', '867', 2011, 'ms', 'Ordinul nr. 867/2011', 4),
    (20, 'ordin:1:2020:ms',   'ordin', '1',   2020, 'ms',  'Ordinul nr. 1/2020', 9),
    (21, 'ordin:1:2020:mfp',  'ordin', '1',   2020, 'mfp', 'Ordinul nr. 1/2020', 0),
    (30, 'lege:227:2015:',    'lege',  '227', 2015, '',    'Legea nr. 227/2015 privind Codul fiscal', 50);
  -- One joint order, two co-signers' keys for the same number.
  insert into legal.act_citation_keys values
    ('ordin', '867', 2011, 'ms', 10), ('ordin', '867', 2011, 'cnas', 10),
    ('ordin', '1', 2020, 'ms', 20), ('ordin', '1', 2020, 'mfp', 21),
    ('lege', '227', 2015, '', 30);
  insert into legal.act_aliases values ('codul fiscal', 30);
`;

beforeAll(async () => {
  if (!dockerCliUp()) {
    console.warn('Docker CLI unavailable — legal cited-act e2e SKIPPED.');
    return;
  }
  try {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
  } catch (error) {
    console.warn(
      `Testcontainers runtime unavailable — legal cited-act e2e SKIPPED: ${
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
  acts = makeLegalActsRepo(db);
  dockerAvailable = true;
}, 120_000);

afterAll(async () => {
  await db?.destroy();
  await container?.stop();
});

const repo = (): LegalActsRepo => {
  if (acts === undefined) throw new Error('repo not ready');
  return acts;
};

describe('the act a citation names, on real rows (I-21)', () => {
  it('an act holding two keys for one number is one candidate', async () => {
    const held = (
      await repo().findActsByCitationNumber(
        { actType: 'ordin', actNumber: '867', actYear: 2011 },
        25
      )
    )._unsafeUnwrap();
    expect(held.map((a) => a.actId)).toEqual(['10']);
    const candidates = (
      await repo().resolveActCandidates({ citation: 'ordinul 867/2011' })
    )._unsafeUnwrap();
    expect(candidates.map((a) => a.actId)).toEqual(['10']);
    const named = (
      await resolveCitedAct(repo(), { citation: 'Ordinul nr. 867/2011' })
    )._unsafeUnwrap();
    expect(named?.actId).toBe('10');
  });

  it('a number two acts hold is an ambiguity naming both', async () => {
    const res = await resolveCitedAct(repo(), { citation: 'ordinul 1/2020' });
    const message = res._unsafeUnwrapErr().message;
    expect(message).toContain('matches 2 acts — pass actId');
    expect(message).toContain('20 Ordinul nr. 1/2020 (ms');
    expect(message).toContain('21 Ordinul nr. 1/2020 (mfp');
  });

  it('an alias is the whole input, case-folded', async () => {
    expect(
      (await resolveCitedAct(repo(), { citation: ' Codul Fiscal ' }))._unsafeUnwrap()?.actId
    ).toBe('30');
    expect((await repo().findActsByAlias('codul', 25))._unsafeUnwrap()).toEqual([]);
  });

  it('further words are refused with their candidates, even a single one', async () => {
    const second = await resolveCitedAct(repo(), { citation: 'legea 227/2015 și legea 95/2006' });
    expect(second._unsafeUnwrapErr().message).toContain('is not exactly one citation');
    expect(second._unsafeUnwrapErr().message).toContain('30 Legea nr. 227/2015');
    const fragment = await resolveCitedAct(repo(), { citation: 'privind codul' });
    expect(fragment._unsafeUnwrapErr().message).toContain('1 candidate(s) returned');
  });

  it('nothing matching is no act', async () => {
    expect(
      (await resolveCitedAct(repo(), { citation: 'legea 99999/2099' }))._unsafeUnwrap()
    ).toBeNull();
  });
});
