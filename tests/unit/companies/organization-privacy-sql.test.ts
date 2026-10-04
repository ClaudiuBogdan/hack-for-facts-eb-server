/**
 * Every `core.organizations` read in the companies repo pins
 * `privacy_class = 'public'`, the same gate the kernel identity repo applies
 * (review M/M02). All rows are public today; the platform gates on class, not
 * distribution, and a company profile, list row, name hit, registration-number
 * hit or entity slice must never be built from a restricted organization row.
 *
 * The same allowlist holds for every consumed `companies_v2` TABLE (audit
 * CD-07): each read, join, filter, count and existence probe carries its own
 * predicate, and on a LEFT JOIN it sits in the ON clause, so a public company
 * whose auxiliary row is non-public reads like one with no auxiliary row
 * instead of disappearing.
 *
 * The ONRC registry is read ONLY through the public `onrc_published_*` views
 * (their access, parent and row predicates are inside the view), every one
 * bound to the pinned edition id, never the `onrc_current_*` data views and
 * never the base edition tables; the legacy registry projection is not read at
 * all, and no view is touched without a published edition. A scripted driver
 * answers the organization seek with a row so the per-CUI fan-out actually
 * runs. It executes nothing.
 */

import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type DatabaseConnection,
} from 'kysely';
import { err, ok } from 'neverthrow';
import { describe, expect, it } from 'vitest';

import { makeCompaniesRepo } from '@/modules/companies/shell/repo/companies-repo.js';
import { upstreamError } from '@/modules/shared/core/errors.js';

import { PUBLISHED_SCOPE, UNAVAILABLE_SCOPE, WITHDRAWN_SCOPE } from './registry-fixtures.js';

import type { CompanyRegistryEnvelope } from '@/modules/companies/core/registry.js';
import type { MeiliClient, ProdDatabase } from '@/modules/shared/index.js';

interface Statement {
  readonly sql: string;
  readonly parameters: readonly unknown[];
}

const recordingDb = (): { db: Kysely<ProdDatabase>; sql: string[] } => {
  const captured: string[] = [];
  const db = new Kysely<ProdDatabase>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new DummyDriver(),
      createIntrospector: (d) => new PostgresIntrospector(d),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
    log: (event) => {
      if (event.level === 'query') captured.push(event.query.sql.replace(/\s+/gu, ' '));
    },
  });
  return { db, sql: captured };
};

/** A driver that answers each statement with the rows `rowsFor` picks for its SQL. */
class ScriptedDriver extends DummyDriver {
  constructor(private readonly rowsFor: (sql: string) => readonly unknown[]) {
    super();
  }

  override acquireConnection(): Promise<DatabaseConnection> {
    const rowsFor = this.rowsFor;
    return Promise.resolve({
      executeQuery: (query) => Promise.resolve({ rows: [...rowsFor(query.sql)] as never[] }),
      streamQuery: async function* () {
        // never streamed by the companies repo
      },
    });
  }
}

/** One row shape that satisfies every organization-driven statement's mapper (all else null). */
const ORG_ROW = {
  org_id: '1517396',
  cui: '2816464',
  name: 'DEDEMAN SRL',
  core_name: 'DEDEMAN SRL',
  normalized_name: null,
  county_name: null,
  p_cui: null,
  is_vat_payer: null,
  is_inactive: null,
  anaf_as_of: null,
  key: '(not_in_edition)',
  basis: 'not_in_edition',
  label: null,
  cnt: '0',
  matched: '0',
  unmatched: '0',
};

const FISCAL_ROW = {
  is_vat_payer: true,
  is_inactive: false,
  main_caen_code: '4752',
  main_caen_rev: '',
  main_caen_label: null,
  registered_name: null,
  status_date: null,
};

/**
 * Organization reads answer one public company. A statement whose FROM is a
 * companies_v2 relation answers nothing, even when it consults
 * core.organizations in a subquery (the CD-08 parent check is not an
 * organization read).
 */
const defaultRows = (sql: string): readonly unknown[] => {
  if (/^select .*? from "companies_v2"\./u.test(sql)) return [];
  if (/^select .*? from companies_v2\./u.test(sql)) return [];
  if (sql.includes('"core"."organizations"') || sql.includes('core.organizations o')) {
    return [ORG_ROW];
  }
  return [];
};

const scriptedDb = (
  rowsFor: (sql: string) => readonly unknown[] = defaultRows
): { db: Kysely<ProdDatabase>; statements: Statement[] } => {
  const statements: Statement[] = [];
  const db = new Kysely<ProdDatabase>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new ScriptedDriver(rowsFor),
      createIntrospector: (d) => new PostgresIntrospector(d),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
    log: (event) => {
      if (event.level === 'query') {
        statements.push({
          sql: event.query.sql.replace(/\s+/gu, ' '),
          parameters: event.query.parameters,
        });
      }
    },
  });
  return { db, statements };
};

/** Every statement that reads the organizations table. */
const organizationReads = (sql: readonly string[]): string[] =>
  sql.filter((s) => s.includes('"core"."organizations"') || s.includes('core.organizations o'));

const GATE = /"?o?"?\.?"privacy_class" = \$\d+|o\."privacy_class" = \$\d+/u;

const meiliDown = {
  searchEntities: () => Promise.resolve(err(upstreamError('meili unreachable', 'meilisearch'))),
  healthCheck: () => Promise.resolve(err(upstreamError('down', 'meilisearch'))),
} as unknown as MeiliClient;

const meiliWithHit = {
  searchEntities: () =>
    Promise.resolve(
      ok({
        hits: [
          {
            id: 'company_2816464',
            docType: 'company',
            title: 'DEDEMAN SRL',
            snippet: null,
            score: 0.9,
            source: 'meili' as const,
            attrs: {},
            docKey: '2816464',
            cuis: ['2816464'],
          },
        ],
        facetDistribution: {},
        estimatedTotalHits: 1,
      })
    ),
  healthCheck: () => Promise.resolve(ok(undefined)),
} as unknown as MeiliClient;

type Run = (
  db: Kysely<ProdDatabase>,
  scope: CompanyRegistryEnvelope
) => Promise<{ isOk(): boolean }>;

/** Every ONRC-bearing repo read, under a given scope. */
const registryCalls: readonly [string, Run][] = [
  ['getProfileData', (db, s) => makeCompaniesRepo(db).getProfileData('2816464', s)],
  [
    'getRegistrationDiffData',
    (db, s) => makeCompaniesRepo(db).getRegistrationDiffData('2816464', s),
  ],
  [
    'listCompanies (rows + bounded total)',
    (db, s) => makeCompaniesRepo(db).listCompanies({}, 'name', { page: 1, pageSize: 10 }, s),
  ],
  [
    'resolveByName pg fallback (engine down)',
    (db, s) => makeCompaniesRepo(db).resolveByName('dedeman', 8, meiliDown, s),
  ],
  [
    'resolveByName hit validation (engine up)',
    (db, s) => makeCompaniesRepo(db).resolveByName('dedeman', 8, meiliWithHit, s),
  ],
  [
    'profileSlicesForCuis',
    (db, s) => makeCompaniesRepo(db).profileSlicesForCuis(['2816464', '111'], s),
  ],
  ['presenceCounts', (db, s) => makeCompaniesRepo(db).presenceCounts('2816464', s)],
];

/** Reads that need a published edition (refused otherwise). */
const publishedOnlyCalls: readonly [string, Run][] = [
  [
    'findByRegistrationNumber',
    (db, s) => makeCompaniesRepo(db).findByRegistrationNumber('J40/1/2000', s),
  ],
  ['countBy status', (db, s) => makeCompaniesRepo(db).countBy('status', {}, s)],
  [
    'countBy county',
    (db, s) => makeCompaniesRepo(db).countBy('county', { status: { eq: '1048' } }, s),
  ],
  [
    'countBy caenDivision',
    (db, s) => makeCompaniesRepo(db).countBy('caenDivision', { status: { eq: '1048' } }, s),
  ],
  [
    'listCompanies (every registry filter, both sides, recorded-date sort)',
    (db, s) =>
      makeCompaniesRepo(db).listCompanies(
        {
          caenCode: { prefix: '62' },
          onrcCaen: { in: ['rev2:6201', 'rev0:1111'] },
          county: { in: ['Cluj'] },
          hasFinancials: { isNull: false },
          status: { eq: '1048' },
          legalForm: { in: ['SRL'] },
          registrationDate: { between: { from: '2000-01-01', to: '2010-12-31' } },
          registrationDatePresent: { isNull: false },
          exclude: {
            caenCode: { eq: '6210' },
            onrcCaen: { eq: 'rev3:6210' },
            county: { eq: 'Bacău' },
            status: { in: ['1070'] },
            legalForm: { eq: 'PFA' },
          },
        },
        'registrationDate',
        { page: 1, pageSize: 10 },
        s
      ),
  ],
];

describe('companies repo — every organizations read pins privacy_class = public', () => {
  // The diff reads edition views only (no organizations read of its own).
  it.each(
    [...registryCalls, ...publishedOnlyCalls].filter(([name]) => name !== 'getRegistrationDiffData')
  )('%s', async (_name, run) => {
    const { db, sql } = recordingDb();
    const res = await run(db, PUBLISHED_SCOPE);
    expect(res.isOk()).toBe(true);
    const reads = organizationReads(sql);
    expect(reads.length, 'expected at least one organizations read').toBeGreaterThanOrEqual(1);
    for (const statement of reads) {
      expect(statement).toMatch(GATE);
    }
  });
});

// ── companies_v2: every consumed table carries its own allowlist ──────────────

/** The public ONRC views: their predicates are inside the view definition. */
const ONRC_VIEW = /^onrc_(published_\w+|current_publication)$/u;

/**
 * Each `companies_v2` relation occurrence with the alias the statement gives it
 * (null = unaliased Kysely table). Covers both Kysely's quoted form and the
 * repo's raw-SQL form (`companies_v2.fiscal_status f`).
 */
const companiesV2Relations = (sql: string): { table: string; alias: string | null }[] => {
  const out: { table: string; alias: string | null }[] = [];
  for (const m of sql.matchAll(/"companies_v2"\."(\w+)"(?: as "(\w+)")?/gu)) {
    out.push({ table: m[1] ?? '', alias: m[2] ?? null });
  }
  const keywords = new Set(['where', 'on', 'and', 'group', 'order', 'limit', 'as']);
  for (const m of sql.matchAll(/(?<!")\bcompanies_v2\.(\w+)(?: (\w+))?/gu)) {
    const alias = m[2] ?? null;
    out.push({ table: m[1] ?? '', alias: alias !== null && !keywords.has(alias) ? alias : null });
  }
  return out;
};

/** True when the statement pins `<alias>.privacy_class` (or the bare column) to 'public'. */
const hasPublicGate = (statement: Statement, alias: string | null): boolean => {
  if (alias !== null && statement.sql.includes(`${alias}.privacy_class = 'public'`)) return true;
  const column = alias === null ? '(?<![."])"privacy_class"' : `"${alias}"\\."privacy_class"`;
  for (const m of statement.sql.matchAll(new RegExp(`${column} = \\$(\\d+)`, 'gu'))) {
    if (statement.parameters[Number(m[1]) - 1] === 'public') return true;
  }
  return false;
};

/** The pinned edition id as the statement binds it (`edition_id = $n::bigint` or `in ($n::bigint, …)`). */
const bindsPinnedEdition = (statement: Statement, editionId: string): boolean => {
  for (const m of statement.sql.matchAll(/edition_id (?:=|<>|in \() ?\$(\d+)::bigint/gu)) {
    if (statement.parameters[Number(m[1]) - 1] === editionId) return true;
  }
  return false;
};

const LEGACY_REGISTRY = [
  'registrations',
  'registration_history',
  'registration_identifiers',
  'status_flags',
  'caen_profile',
  'eu_branches',
  'source_snapshots',
];

const ONRC_BASE_TABLES = [
  'onrc_editions',
  'onrc_edition_profiles',
  'onrc_identifier_profiles',
  'onrc_identity_observations',
  'onrc_caen_observations',
  'onrc_status_observations',
  'onrc_publications',
  'onrc_publication',
];

const D1_AND_ANAF_CALLS: readonly [string, Run][] = [
  ['getFinancials', (db) => makeCompaniesRepo(db).getFinancials('2816464')],
  [
    'getFinancialQualityAssessment',
    (db) => makeCompaniesRepo(db).getFinancialQualityAssessment('2816464'),
  ],
  ['resolveCounty', (db) => makeCompaniesRepo(db).resolveCounty('cluj')],
];

describe('companies repo — every companies_v2 TABLE read pins its own privacy_class = public (CD-07)', () => {
  it.each([...registryCalls, ...publishedOnlyCalls, ...D1_AND_ANAF_CALLS])(
    '%s',
    async (_name, run) => {
      const { db, statements } = scriptedDb();
      const res = await run(db, PUBLISHED_SCOPE);
      expect(res.isOk()).toBe(true);
      for (const statement of statements) {
        for (const { table, alias } of companiesV2Relations(statement.sql)) {
          if (ONRC_VIEW.test(table)) continue;
          expect(
            hasPublicGate(statement, alias),
            `companies_v2.${table} (${alias ?? 'unaliased'}) has no public gate in: ${statement.sql}`
          ).toBe(true);
        }
      }
    }
  );
});

describe('companies repo — ONRC reads: published views bound to the pinned edition only', () => {
  it.each([...registryCalls, ...publishedOnlyCalls])(
    '%s binds every view statement to the pinned edition and reads no base or legacy registry table',
    async (_name, run) => {
      const { db, statements } = scriptedDb();
      expect((await run(db, PUBLISHED_SCOPE)).isOk()).toBe(true);
      for (const statement of statements) {
        const relations = companiesV2Relations(statement.sql).map((r) => r.table);
        for (const table of relations) {
          expect(LEGACY_REGISTRY, `legacy registry read: ${statement.sql}`).not.toContain(table);
          expect(ONRC_BASE_TABLES, `ONRC base table read: ${statement.sql}`).not.toContain(table);
          // The per-statement pointer views would let two reads see two editions.
          expect(table, statement.sql).not.toMatch(/^onrc_current_(?!publication$)/u);
        }
        const viewData = relations.filter(
          (t) => t.startsWith('onrc_published_') && t !== 'onrc_published_editions'
        );
        if (viewData.length > 0) {
          expect(
            bindsPinnedEdition(statement, PUBLISHED_SCOPE.editionId ?? ''),
            `view read not bound to the pinned edition: ${statement.sql}`
          ).toBe(true);
        }
      }
    }
  );

  it.each(registryCalls)(
    '%s touches no ONRC view when the registry is not published',
    async (_name, run) => {
      for (const scope of [UNAVAILABLE_SCOPE, WITHDRAWN_SCOPE]) {
        const { db, statements } = scriptedDb();
        expect((await run(db, scope)).isOk()).toBe(true);
        for (const statement of statements) {
          expect(statement.sql).not.toMatch(/onrc_/u);
          for (const table of companiesV2Relations(statement.sql).map((r) => r.table)) {
            expect(LEGACY_REGISTRY, `legacy fallback read: ${statement.sql}`).not.toContain(table);
          }
        }
      }
    }
  );

  it.each(publishedOnlyCalls)(
    '%s is refused (typed unavailable, never empty) without a published edition',
    async (_name, run) => {
      for (const scope of [UNAVAILABLE_SCOPE, WITHDRAWN_SCOPE]) {
        const { db, statements } = scriptedDb();
        const res = (await run(db, scope)) as unknown as {
          isErr(): boolean;
          error?: { type: string };
        };
        expect(res.isErr()).toBe(true);
        expect(res.error?.type).toBe('ServiceUnavailable');
        expect(statements.filter((s) => s.sql.includes('onrc_'))).toEqual([]);
      }
    }
  );
});

describe('companies repo — the fiscal LEFT JOIN gate sits in ON, never in WHERE', () => {
  /** `left join <fiscal_status> f on f.cui = o.cui and <gate>` in either SQL form. */
  const gatedJoin = new RegExp(
    `left join (?:"companies_v2"\\."fiscal_status" as "f"|companies_v2\\.fiscal_status f) ` +
      `on (?:"f"\\."cui" = "o"\\."cui"|f\\.cui = o\\.cui) and "f"\\."privacy_class" = \\$\\d+`,
    'gu'
  );

  it.each(
    [...registryCalls, ...publishedOnlyCalls].filter(([name]) =>
      [
        'listCompanies (every registry filter, both sides, recorded-date sort)',
        'countBy status',
        'countBy county',
        'countBy caenDivision',
        'profileSlicesForCuis',
        'presenceCounts',
      ].includes(name)
    )
  )('%s', async (_name, run) => {
    const { db, statements } = scriptedDb();
    expect((await run(db, PUBLISHED_SCOPE)).isOk()).toBe(true);
    const joined = statements.filter(
      (s) => s.sql.includes('left join') && s.sql.includes('core.organizations o')
    );
    expect(joined.length).toBeGreaterThanOrEqual(1);
    for (const { sql } of joined) {
      const joins = [...sql.matchAll(gatedJoin)].length;
      expect(joins, `fiscal_status join is not gated in ON: ${sql}`).toBeGreaterThanOrEqual(1);
      // Exactly one gate per join: a second copy in WHERE would turn the LEFT
      // JOIN into an inner join and drop public companies with absent rows.
      const gates = sql.split('"f"."privacy_class"').length - 1;
      expect(gates, `f.privacy_class outside the ON clause: ${sql}`).toBe(joins);
    }
  });
});

describe('companies repo — profile activities and source dates', () => {
  it('reads ONRC activities from the pinned edition and the ANAF main activity from fiscal_status', async () => {
    const { db, statements } = scriptedDb();
    expect((await makeCompaniesRepo(db).getProfileData('2816464', PUBLISHED_SCOPE)).isOk()).toBe(
      true
    );
    const caen = statements.find((s) =>
      s.sql.includes('companies_v2.onrc_published_caen_observations c')
    );
    expect(caen).toBeDefined();
    expect(caen !== undefined && bindsPinnedEdition(caen, '7')).toBe(true);
    // The catalog label joins by the row's OWN revision only.
    expect(caen?.sql).toContain("cc.system = 'caen_' || c.caen_revision and cc.code = c.caen_code");
    expect(caen?.sql).toContain('c.caen_revision is not null');
    const fiscal = statements.find((s) => s.sql.includes('"companies_v2"."fiscal_status" as "f"'));
    expect(fiscal?.sql).toContain("'caen_' || nullif(f.main_caen_rev, '')");
  });

  it('presence counts read the same caen observations the profile lists (in edition)', async () => {
    const inEdition = (sql: string): readonly unknown[] =>
      sql.includes('core.organizations o') ? [{ ...ORG_ROW, p_cui: '2816464' }] : defaultRows(sql);
    const { db, statements } = scriptedDb(inEdition);
    expect((await makeCompaniesRepo(db).presenceCounts('2816464', PUBLISHED_SCOPE)).isOk()).toBe(
      true
    );
    const caen = statements.find((s) =>
      s.sql.includes('companies_v2.onrc_published_caen_observations c')
    );
    expect(caen).toBeDefined();
    expect(caen !== undefined && bindsPinnedEdition(caen, '7')).toBe(true);
  });

  it('serves source dates: ONRC = the pinned edition source date, ANAF = status_date, unknown null', async () => {
    const rowsFor = (sql: string): readonly unknown[] =>
      sql.includes('"companies_v2"."fiscal_status" as "f"') ? [FISCAL_ROW] : defaultRows(sql);
    const repo = makeCompaniesRepo(scriptedDb(rowsFor).db);
    const profile = (await repo.getProfileData('2816464', PUBLISHED_SCOPE))._unsafeUnwrap();
    expect(profile?.asOf).toEqual({ onrc: '2026-07-08', anaf: null });
    expect(profile?.fiscal?.asOf).toBeNull();
    const unpublished = (await repo.getProfileData('2816464', WITHDRAWN_SCOPE))._unsafeUnwrap();
    expect(unpublished?.asOf.onrc).toBeNull();

    const dated = (sql: string): readonly unknown[] =>
      sql.includes('"companies_v2"."fiscal_status" as "f"')
        ? [{ ...FISCAL_ROW, status_date: '2026-06-15' }]
        : defaultRows(sql);
    const withDate = (
      await makeCompaniesRepo(scriptedDb(dated).db).getProfileData('2816464', PUBLISHED_SCOPE)
    )._unsafeUnwrap();
    expect(withDate?.asOf).toEqual({ onrc: '2026-07-08', anaf: '2026-06-15' });
    expect(withDate?.fiscal?.asOf).toBe('2026-06-15');
  });

  it('a write or fetch time is never served as a source date', async () => {
    const { db, statements } = scriptedDb();
    const repo = makeCompaniesRepo(db);
    expect((await repo.getProfileData('2816464', PUBLISHED_SCOPE)).isOk()).toBe(true);
    expect((await repo.profileSlicesForCuis(['2816464'], PUBLISHED_SCOPE)).isOk()).toBe(true);
    expect((await repo.presenceCounts('2816464', PUBLISHED_SCOPE)).isOk()).toBe(true);
    const all = statements.map((s) => s.sql).join('\n');
    expect(all).not.toMatch(/updated_at|retrieved_at|snapshot_at|changed_at/u);
  });
});

describe('standalone financial and quality reads by CUI: parent privacy, not membership (CD-08)', () => {
  /**
   * `not exists (<core organization for this CUI whose class is not 'public'>)`:
   * a KNOWN non-public parent (NULL class included, via `is distinct from`)
   * denies; a missing parent or a public one of any kind does not.
   */
  const parentDeny = (alias: string): RegExp =>
    new RegExp(
      `not exists \\(select "parent"\\."org_id" from "core"\\."organizations" as "parent" ` +
        `where "parent"\\."cui" = "${alias}"\\."cui" and "parent"\\."privacy_class" is distinct from \\$(\\d+)\\)`,
      'u'
    );

  /** The three standalone reads: the statements, the CUI's quality flags, the corpus-wide flag coverage. */
  const standaloneReads = async (): Promise<{ statement: Statement; alias: string }[]> => {
    const { db, statements } = scriptedDb();
    const repo = makeCompaniesRepo(db);
    expect((await repo.getFinancials('2816464')).isOk()).toBe(true);
    expect((await repo.getFinancialQualityAssessment('2816464')).isOk()).toBe(true);
    const of = (needle: string, alias: string): { statement: Statement; alias: string } => {
      const statement = statements.find((s) => s.sql.includes(needle));
      if (statement === undefined) throw new Error(`no statement for ${needle}`);
      return { statement, alias };
    };
    return [
      of('from "companies_v2"."financials" as "fin"', 'fin'),
      of('"qf"."cui" = $', 'qf'),
      of('array_agg(distinct year order by year)', 'qf'),
    ];
  };

  it('denies a public statement or flag under a KNOWN non-public organization, whatever the CUI length', async () => {
    // 2816464 is a short (≤10-digit) CUI: the usecase length rule never sees it,
    // so the parent check is what withholds it if its organization is withdrawn.
    for (const { statement, alias } of await standaloneReads()) {
      const deny = parentDeny(alias).exec(statement.sql);
      expect(deny, `no parent-privacy deny in: ${statement.sql}`).not.toBeNull();
      expect(statement.parameters[Number(deny?.[1]) - 1]).toBe('public');
      // The row itself is still allowlisted.
      expect(hasPublicGate(statement, alias)).toBe(true);
    }
  });

  it('keeps a public non-company parent: no kind gate on statements or flags', async () => {
    for (const { statement } of await standaloneReads()) {
      expect(statement.sql).not.toMatch(/"kind"/u);
      expect(statement.parameters).not.toContain('company');
    }
  });

  it('keeps a CUI with NO core organization: the parent check is a NOT EXISTS, never a join or a positive EXISTS', async () => {
    for (const { statement } of await standaloneReads()) {
      expect(statement.sql).not.toMatch(/join "core"\."organizations"/u);
      expect(statement.sql.match(/exists \(/gu)?.length).toBe(1);
      expect(statement.sql).toMatch(/not exists \(/u);
    }
  });

  it('a non-public quality flag never reaches the per-CUI list or the coverage set', async () => {
    const reads = await standaloneReads();
    for (const { statement, alias } of reads.filter((r) => r.alias === 'qf')) {
      expect(hasPublicGate(statement, alias)).toBe(true);
      expect(parentDeny(alias).test(statement.sql)).toBe(true);
    }
  });

  it('the standalone financial history never consults the ONRC registry (independent of its state)', async () => {
    const { db, statements } = scriptedDb();
    const repo = makeCompaniesRepo(db);
    expect((await repo.getFinancials('2816464')).isOk()).toBe(true);
    expect(statements.map((s) => s.sql).join('\n')).not.toMatch(/onrc_/u);
  });
});
