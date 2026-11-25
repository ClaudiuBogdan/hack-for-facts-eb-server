/**
 * Regenerates tests/fixtures/procurement/ca-public-views-ddl.ts from the data
 * platform's migrations (PROC-KB0Z), so the contract-award e2e runs the views'
 * real DDL. Reads the scrapper checkout with `git show` (no network, no
 * database): renders each migration's up() SQL with a dummy Kysely driver and
 * cuts out the statements the views need.
 *
 *   pnpm tsx scripts/procurement-ca-public-views-ddl.ts <scrapper checkout> [ref=origin/main]
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
} from 'kysely';

const MIGRATIONS = {
  tables: '20261121T090000__procurement_v3_tables',
  maskPerson: '20261121T090096__procurement_v3_mask_person_buyer_names',
  naming: '20261124T120000__procurement_v3_supplier_naming',
  views: '20261124T120040__procurement_v3_contract_award_public_views',
} as const;

const TABLES = [
  'da_buyer_geography',
  'supplier_privacy',
  'ca_publications',
  'ca_lots',
  'ca_contract_lots',
  'ca_contract_winners',
  'ca_contract_identity',
  'ca_money_facts',
];

const [checkout, ref = 'origin/main'] = process.argv.slice(2);
if (checkout === undefined) {
  console.error('usage: tsx scripts/procurement-ca-public-views-ddl.ts <scrapper checkout> [ref]');
  process.exit(2);
}
const git = (...args: string[]): string =>
  execFileSync('git', ['-C', checkout, ...args], { encoding: 'utf8' });
const sha = git('rev-parse', '--short', ref).trim();

// Under node_modules so the migrations' `kysely` import resolves to this repo's copy.
const work = resolve('node_modules/.cache/ca-public-views-ddl');
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });

const render = async (name: string): Promise<string> => {
  const file = join(work, `${name}.ts`);
  writeFileSync(file, git('show', `${ref}:src/db/prod-migrations/${name}.ts`));
  const statements: string[] = [];
  const db = new Kysely<unknown>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new DummyDriver(),
      createIntrospector: (k) => new PostgresIntrospector(k),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
    log: (event) => {
      if (event.level === 'query') statements.push(`${event.query.sql};`);
    },
  });
  const migration = (await import(pathToFileURL(file).href)) as {
    up: (db: Kysely<unknown>) => Promise<void>;
  };
  await migration.up(db);
  return `${statements.join('\n\n')}\n`;
};

const cut = (source: string, pattern: RegExp, what: string): string => {
  const match = pattern.exec(source);
  if (match === null) throw new Error(`not found: ${what}`);
  return match[0];
};
const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
const table = (source: string, name: string): string =>
  cut(
    source,
    new RegExp(
      `^( *)create table procurement_v3\\.${escape(name)} \\(\\n[\\s\\S]*?^\\1\\);\\n`,
      'mu'
    ),
    name
  );
const fn = (source: string, name: string): string =>
  cut(
    source,
    new RegExp(
      `^( *)create function procurement_v3\\.${escape(name)}\\([\\s\\S]*?\\$f\\$;\\n`,
      'mu'
    ),
    name
  );

const main = async (): Promise<void> => {
  const tables = await render(MIGRATIONS.tables);
  const maskPerson = await render(MIGRATIONS.maskPerson);
  const naming = await render(MIGRATIONS.naming);
  const views = await render(MIGRATIONS.views);
  const parts = {
    CA_PLATFORM_TABLES:
      TABLES.map((name) => table(tables, name)).join('') +
      cut(tables, /^ *create index ca_contract_identity_match_idx .*?;\n/mu, 'identity index'),
    CA_NAMING_DDL:
      fn(maskPerson, 'mask_person_name') +
      fn(naming, 'mask_supplier_text') +
      table(naming, 'supplier_naming'),
    CA_PUBLIC_VIEWS_DDL: views,
  };
  for (const [name, text] of Object.entries(parts))
    if (text.includes('`') || text.includes('${'))
      throw new Error(`${name} cannot be embedded in String.raw`);
  const header = `/**
 * The data platform's DDL for the contract-award public views (PROC-KB0Z), for the
 * e2e throwaway. GENERATED from scrapper ${ref} ${sha} by
 * scripts/procurement-ca-public-views-ddl.ts (rendering the migrations' up() SQL);
 * do not edit by hand.
 *
 * - CA_PLATFORM_TABLES: verbatim \`create table\` statements of
 *   ${MIGRATIONS.tables} (${TABLES.join(', ')}) and its ca_contract_identity_match_idx.
 * - CA_NAMING_DDL: verbatim procurement_v3.mask_person_name (${MIGRATIONS.maskPerson.slice(0, 15)}),
 *   mask_supplier_text and the supplier_naming table (${MIGRATIONS.naming.slice(0, 15)}; its
 *   truncate trigger left out).
 * - CA_PUBLIC_VIEWS_DDL: the whole of ${MIGRATIONS.views.slice(0, 15)}'s up(), the four views and
 *   their comments, character for character.
 *
 * Not verbatim (the stubs in the test): core.cui_is_mintable's checksum over a digits-only
 * normalize_cui, and minimal core.organizations and companies_v2.onrc_current_profiles with the
 * columns the views read.
 */
`;
  const body = Object.entries(parts)
    .map(([name, text]) => `export const ${name} = String.raw\`\n${text}\`;\n`)
    .join('\n');
  writeFileSync('tests/fixtures/procurement/ca-public-views-ddl.ts', `${header}\n${body}`);
  rmSync(work, { recursive: true, force: true });
  console.log(`wrote tests/fixtures/procurement/ca-public-views-ddl.ts from ${ref} ${sha}`);
};

await main();
