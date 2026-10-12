/**
 * The class state on the REAL repository SQL path (scripted driver, nothing
 * executes): every directory CAEN predicate (broad, exact, both exclusions)
 * and the caenDivision facet keep `caen_class_state = 'class'`; the registry
 * footprint probes the new column so a missing migration pins `unavailable`;
 * the observation list labels only CLASS rows; and the activity evidence is
 * the bounded exact aggregate, the receipt-proven fiscal form (read through
 * the scrapper's function only) and the catalog candidates, with its
 * capability failures classified.
 */

import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  sql,
  type DatabaseConnection,
} from 'kysely';
import { describe, expect, it } from 'vitest';

import { ACTIVITY_AGGREGATE_GROUP_BOUND } from '@/modules/companies/core/activity-selection.js';
import { REGISTRY_CAPABILITY_LOST_MESSAGE } from '@/modules/companies/core/registry.js';
import { makeCompaniesRepo } from '@/modules/companies/shell/repo/companies-repo.js';
import {
  captureRegistryScope,
  readCaenObservations,
  registryConditions,
} from '@/modules/companies/shell/repo/registry-sql.js';

import { PUBLISHED_SCOPE, UNPUBLISHED_SCOPE } from './registry-fixtures.js';

import type { ProdDatabase } from '@/modules/shared/index.js';

interface Statement {
  readonly sql: string;
  readonly parameters: readonly unknown[];
}

const flat = (text: string): string => text.replace(/\s+/gu, ' ').trim();

/** A driver answering each statement through `answer` (rows, or a thrown error). */
class ScriptedDriver extends DummyDriver {
  constructor(private readonly answer: (statement: Statement) => readonly unknown[]) {
    super();
  }

  override acquireConnection(): Promise<DatabaseConnection> {
    const answer = this.answer;
    return Promise.resolve({
      executeQuery: (query) => {
        try {
          return Promise.resolve({
            rows: [...answer({ sql: flat(query.sql), parameters: query.parameters })] as never[],
          });
        } catch (error) {
          return Promise.reject(error instanceof Error ? error : new Error(String(error)));
        }
      },
      streamQuery: async function* () {
        // never streamed by the companies repo
      },
    });
  }
}

const scriptedDb = (answer: (statement: Statement) => readonly unknown[] = () => []) => {
  const statements: Statement[] = [];
  const db = new Kysely<ProdDatabase>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () =>
        new ScriptedDriver((statement) => {
          statements.push(statement);
          return answer(statement);
        }),
      createIntrospector: (d) => new PostgresIntrospector(d),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
  return { db, statements };
};

/** A capability SQLSTATE as node-postgres raises it. */
const denied = (code: string): Error => Object.assign(new Error(`denied ${code} (test)`), { code });

const CLASS_PREDICATE = "caen_class_state = 'class'";
const CUI = '2816464';

describe('directory CAEN predicates and the caenDivision facet', () => {
  it('keeps the class predicate inside every CAEN predicate: broad, exact and both exclusions', () => {
    const { db } = scriptedDb();
    const conds = registryConditions(
      {
        caenCode: { in: ['6201'] },
        onrcCaen: { eq: 'rev2:6201' },
        exclude: { caenCode: { eq: '4711' }, onrcCaen: { eq: 'rev3:4711' } },
      },
      '7'
    )._unsafeUnwrap();
    const compiled = flat(sql`select ${sql.join(conds.conds, sql` and `)}`.compile(db).sql);
    const caenSubqueries = compiled.split('companies_v2.onrc_published_caen_observations').slice(1);
    expect(caenSubqueries).toHaveLength(4);
    for (const subquery of caenSubqueries) {
      expect(subquery.slice(0, subquery.indexOf(')'))).toMatch(
        /^ cx? where .*caen_class_state = 'class'/u
      );
    }
    // An exclusion still needs complete coverage: "no CLASS row with these codes".
    expect(compiled).toContain(
      "p.caen_coverage in ('complete', 'complete_empty') and not exists ( select 1 from companies_v2.onrc_published_caen_observations cx where cx.edition_id = $"
    );
    expect(compiled.match(/cx\.caen_class_state = 'class'/gu)).toHaveLength(2);
    expect(compiled.match(/ c\.caen_class_state = 'class'/gu)).toHaveLength(2);
  });

  it('adds nothing to a filter without a CAEN criterion', () => {
    const { db } = scriptedDb();
    const conds = registryConditions({ status: { eq: '1048' } }, '7')._unsafeUnwrap();
    const compiled = sql`select ${sql.join(conds.conds, sql` and `)}`.compile(db).sql;
    expect(compiled).not.toContain(CLASS_PREDICATE);
  });

  it('counts only CLASS observations in the caenDivision facet', async () => {
    const { db, statements } = scriptedDb();
    const repo = makeCompaniesRepo(db);
    await repo.countBy('caenDivision', { status: { eq: '1048' } }, PUBLISHED_SCOPE);
    const facet = statements.find((s) => s.sql.includes('left(c.caen_code, 2)'));
    expect(facet?.sql).toContain(`where c.caen_code is not null and c.${CLASS_PREDICATE}`);
  });
});

describe('the caenDivision facet reads a one-company scope per CUI and keeps the set join otherwise', () => {
  const facetOf = async (
    filter: Parameters<ReturnType<typeof makeCompaniesRepo>['countBy']>[1]
  ) => {
    const { db, statements } = scriptedDb();
    await makeCompaniesRepo(db).countBy('caenDivision', filter, PUBLISHED_SCOPE);
    // The budget statement, the facet and the population, in that order.
    expect(statements.map((s) => s.sql.split(' ').slice(0, 3).join(' '))).toEqual([
      'set local statement_timeout',
      'with filtered as',
      'select count(*)::text as',
    ]);
    expect(statements[0]?.sql).toBe('set local statement_timeout = 45000');
    return { facet: statements[1]?.sql ?? '', parameters: statements[1]?.parameters ?? [] };
  };

  it.each([
    ['a positive CUI', { cui: { eq: CUI } }],
    ['a one-value CUI list', { cui: { in: [CUI] } }],
    ['an empty CUI list (no company)', { cui: { in: [] } }],
    [
      'a positive CUI and a same-identifier CAEN key',
      { cui: { eq: CUI }, onrcCaen: { eq: 'rev2:8552' } },
    ],
    ['a one-value CUI list and a status', { cui: { in: [CUI] }, status: { eq: '1048' } }],
    [
      'a positive CUI with a longer CUI list and an exclusion (all ANDed)',
      { cui: { eq: CUI, in: [CUI, '6488696', '1234567'] }, exclude: { cui: { eq: '6488696' } } },
    ],
  ] as const)('%s: a grouped LATERAL bound to each filtered CUI', async (_name, filter) => {
    const { facet } = await facetOf(filter);
    const lateral = facet.slice(facet.indexOf('cross join lateral ('), facet.indexOf(') cd '));
    expect(lateral).not.toBe('');
    // Both public views, both bound to the outer CUI and the pinned edition, inside the lateral.
    expect(lateral).toContain(
      'from companies_v2.onrc_published_identifier_profiles i join companies_v2.onrc_published_caen_observations c on c.edition_id = i.edition_id and c.identifier_key = i.identifier_key and c.cui = i.cui'
    );
    expect(lateral).toMatch(/where i\.edition_id = \$\d+::bigint and i\.cui = fil\.cui and /u);
    expect(lateral).toContain(
      `and c.cui = fil.cui and c.caen_code is not null and c.${CLASS_PREDICATE} group by 1, 2`
    );
    expect(facet.slice(facet.indexOf('select cd.key'), facet.indexOf('cross join lateral'))).toBe(
      'select cd.key, cd.revision, count(distinct fil.cui)::text as cnt, (select n from population) as population from filtered fil '
    );
    expect(facet.slice(facet.indexOf(') cd ') + 4)).toBe(
      ' group by 1, 2 order by count(distinct fil.cui) desc, 1 limit 500'
    );
  });

  it.each([
    ['a multi-value CUI list', { cui: { in: [CUI, '6488696'] } }],
    [
      'a multi-value CUI list and a status',
      { cui: { in: [CUI, '6488696'] }, status: { eq: '1048' } },
    ],
    ['a status', { status: { eq: '1048' } }],
    ['a same-identifier CAEN key', { onrcCaen: { eq: 'rev2:8552' } }],
    ['a broad CAEN code', { caenCode: { in: ['6201'] } }],
    ['an excluded CUI only', { exclude: { cui: { eq: CUI } } }],
    [
      'an excluded one-value list and a status',
      { exclude: { cui: { in: [CUI] } }, status: { eq: '1048' } },
    ],
    ['an empty cui object', { cui: {} }],
    ['an absent cui', { cui: undefined }],
    ['no filter', {}],
  ] as const)('%s: the set join, unchanged', async (_name, filter) => {
    const { facet } = await facetOf(filter);
    expect(facet).not.toContain('lateral');
    expect(facet).toMatch(
      /\) select coalesce\(c\.caen_revision, 'unknown'\) \|\| ':' \|\| left\(c\.caen_code, 2\) as key, c\.caen_revision as revision, count\(distinct fil\.cui\)::text as cnt, \(select n from population\) as population from filtered fil join companies_v2\.onrc_published_identifier_profiles i on i\.edition_id = \$\d+::bigint and i\.cui = fil\.cui and .* join companies_v2\.onrc_published_caen_observations c on c\.edition_id = i\.edition_id and c\.identifier_key = i\.identifier_key and c\.cui = i\.cui where c\.caen_code is not null and c\.caen_class_state = 'class' group by 1, 2 order by count\(distinct fil\.cui\) desc, 1 limit 500$/u
    );
  });

  it('keeps every predicate of a bounded scope ANDed in the population: eq, a longer in and the exclusion', async () => {
    const { facet, parameters } = await facetOf({
      cui: { eq: CUI, in: [CUI, '6488696', '1234567'] },
      exclude: { cui: { eq: '6488696' } },
    });
    const population = facet.slice(0, facet.indexOf('), population as'));
    expect(population).toMatch(/"o"\."cui" = \$\d+/u);
    expect(population).toMatch(/"o"\."cui" in \(\$\d+, \$\d+, \$\d+\)/u);
    expect(population).toMatch(/ and not "o"\."cui" = \$\d+\s*$/u);
    expect(parameters.filter((value) => value === CUI)).toHaveLength(2);
    expect(parameters).toContain('6488696');
    expect(parameters).toContain('1234567');
  });

  it('keeps the set join for a malformed CUI value the kernel still compiles, and refuses one it cannot, before any SQL', async () => {
    // A non-string `eq` (the usecase normalizes to strings; the repo is also reachable directly) is not the validated singleton.
    for (const eq of [2816464, ['2816464']]) {
      const { facet } = await facetOf({ cui: { eq } });
      expect(facet).not.toContain('lateral');
    }
    const { db, statements } = scriptedDb();
    const refused = await makeCompaniesRepo(db).countBy(
      'caenDivision',
      { cui: { in: 'x' } },
      PUBLISHED_SCOPE
    );
    expect(refused.isErr() && refused.error.type).toBe('InvalidInput');
    expect(statements).toEqual([]);
  });

  it('compiles an empty CUI list to no company: the population is false, never all companies', async () => {
    const { facet } = await facetOf({ cui: { in: [] } });
    expect(facet.slice(0, facet.indexOf('), population as'))).toMatch(/ and false\s*$/u);
  });

  it('keeps the same-identifier predicates on the identifier the lateral reads, with the request’s values', async () => {
    const { facet, parameters } = await facetOf({
      cui: { eq: CUI },
      onrcCaen: { eq: 'rev2:8552' },
      status: { eq: '1048' },
    });
    const lateral = facet.slice(facet.indexOf('cross join lateral ('), facet.indexOf(') cd '));
    expect(lateral).toContain('i.status_codes && array(select jsonb_array_elements_text(');
    expect(lateral).toMatch(
      /exists \(select 1 from companies_v2\.onrc_published_caen_observations c where c\.edition_id = i\.edition_id and c\.identifier_key = i\.identifier_key and c\.cui = i\.cui and c\.caen_class_state = 'class'/u
    );
    expect(parameters).toContain('7');
    expect(parameters).toContain(CUI);
    expect(parameters).toContain('[{"revision":"rev2","code":"8552"}]');
    expect(parameters).toContain('["1048"]');
  });
});

describe('the registry footprint and the observation list', () => {
  it.each([
    ['the form function', 'companies_v2.anaf_fiscal_caen_form('],
    ['the usability function', 'companies_v2.anaf_fiscal_caen_usable('],
    ['the policy function', 'companies_v2.anaf_fiscal_caen_form_policy()'],
    ['the catalogue function', 'companies_v2.caen_code_is_catalogued('],
    ['the receipt column', 'f.caen_code_qualification'],
  ])('probes %s at capture: a missing migration pins UNAVAILABLE', async (_label, fragment) => {
    const { db, statements } = scriptedDb((s) => {
      if (
        s.sql.includes(fragment) &&
        s.sql.includes('from companies_v2.fiscal_status f where false')
      )
        throw denied('42883');
      return [];
    });
    expect((await captureRegistryScope(db))._unsafeUnwrap().state).toBe('unavailable');
    expect(statements[0]?.sql).toContain(fragment);
  });

  it('probes caen_class_state at capture: a missing migration pins UNAVAILABLE', async () => {
    const { db, statements } = scriptedDb((s) => {
      if (s.sql.includes('c.caen_class_state') && s.sql.includes('where false'))
        throw denied('42703');
      return [];
    });
    const scope = (await captureRegistryScope(db))._unsafeUnwrap();
    expect(scope.state).toBe('unavailable');
    expect(statements[0]?.sql).toContain(
      'c.caen_revision, c.caen_class_state, "c"."source_row_number" as source_row_number'
    );
  });

  it('labels only CLASS rows; a short token keeps its padded code and no label', async () => {
    const row = (n: number, state: string) => ({
      identifier_key: 'J04/2621/1992',
      caen_parse_state: 'code',
      caen_code: '0111',
      caen_revision_state: 'known',
      caen_revision: 'rev2',
      caen_class_state: state,
      catalog_label: 'Cultivarea cerealelor',
      catalog_system: 'caen_rev2',
      source_row_number: n,
      resource_key: 'OD_CAEN_AUTORIZAT',
      source_row_sha256: 'a'.repeat(64),
      source_url: null,
      source_file_sha256: null,
      source_published_at: '2026-07-08',
    });
    const { db } = scriptedDb(() => [row(1, 'class'), row(2, 'short_token'), row(3, 'novel')]);
    const { rows } = await readCaenObservations(db, '7', CUI);
    expect(rows.map((r) => [r.classState, r.code, r.catalogLabel?.label ?? null])).toEqual([
      ['class', '0111', 'Cultivarea cerealelor'],
      ['short_token', '0111', null],
      // An unknown state fails closed: never CLASS, never labelled.
      ['unparsed', '0111', null],
    ]);
  });
});

describe('the activity evidence reads', () => {
  const FISCAL = {
    main_caen_code: '4711',
    main_caen_code_form: 'three_digit',
    main_caen_code_usable: false,
    anaf_caen_form_policy: 'anaf-caen-form-policy-v1',
    main_caen_code_catalogued: true,
    status_date: '2026-09-28',
  };
  const GROUPS = [
    { caen_revision: 'rev2', caen_code: '4711', caen_class_state: 'class', rows: 2 },
    { caen_revision: 'rev2', caen_code: '0111', caen_class_state: 'short_token', rows: 1 },
  ];
  const CANDIDATES = [{ code: '4711', revision: 'rev2', label: 'Comerț' }];

  const answer =
    (
      over: {
        fiscal?: (s: Statement) => readonly unknown[];
        groups?: () => readonly unknown[];
      } = {}
    ) =>
    (s: Statement): readonly unknown[] => {
      if (s.sql.includes('from companies_v2.fiscal_status f')) return over.fiscal?.(s) ?? [FISCAL];
      if (s.sql.includes('count(*)::int as rows')) return over.groups?.() ?? GROUPS;
      if (s.sql.includes('from core.classification_codes cc')) return CANDIDATES;
      return [];
    };

  it('reads the bounded exact aggregate, the DB-decided form/usability/catalogue and the candidates', async () => {
    const { db, statements } = scriptedDb(answer());
    const evidence = (
      await makeCompaniesRepo(db).getActivityEvidence(CUI, PUBLISHED_SCOPE)
    )._unsafeUnwrap();
    expect(evidence).toEqual({
      groups: [
        { revision: 'rev2', code: '4711', classState: 'class', rows: 2 },
        { revision: 'rev2', code: '0111', classState: 'short_token', rows: 1 },
      ],
      // Every decision is the database's, passed through unchanged.
      fiscal: {
        code: '4711',
        form: 'three_digit',
        usable: false,
        policy: 'anaf-caen-form-policy-v1',
        catalogued: true,
        statusDate: '2026-09-28',
      },
      catalog: new Map([['4711', [{ revision: 'rev2', label: 'Comerț' }]]]),
    });
    const fiscal = statements.find((s) => s.sql.includes('fiscal_status f'));
    const form =
      'companies_v2.anaf_fiscal_caen_form( f.caen_code_qualification, f.source_snapshot_id, f.source_hash, f.raw_row_sha256, f.main_caen_code)';
    for (const column of [
      `${form} as main_caen_code_form`,
      `companies_v2.anaf_fiscal_caen_usable(${form}) as main_caen_code_usable`,
      'companies_v2.anaf_fiscal_caen_form_policy() as anaf_caen_form_policy',
      'companies_v2.caen_code_is_catalogued(f.main_caen_code) as main_caen_code_catalogued',
    ])
      expect(fiscal?.sql).toContain(column);
    // No usable set and no catalog test in the API's own SQL or code.
    expect(fiscal?.sql).not.toContain("'four_digit'");
    expect(fiscal?.sql).toContain('where f.cui = $1 and "f"."privacy_class" = $2 limit 1');
    expect(fiscal?.parameters).toEqual([CUI, 'public']);
    // The receipt JSON is never read by the API: only the function sees it.
    expect(fiscal?.sql).not.toMatch(/caen_code_qualification\s*(->|#>|\?)/u);
    const aggregate = statements.find((s) => s.sql.includes('count(*)::int as rows'));
    expect(aggregate?.sql).toBe(
      'select c.caen_revision, c.caen_code, c.caen_class_state, count(*)::int as rows from companies_v2.onrc_published_caen_observations c where c.edition_id = $1::bigint and c.cui = $2 group by 1, 2, 3 order by 1, 2, 3 limit $3'
    );
    expect(aggregate?.parameters).toEqual(['7', CUI, ACTIVITY_AGGREGATE_GROUP_BOUND + 1]);
    const catalog = statements.find((s) => s.sql.includes('core.classification_codes cc'));
    // The class code and the ANAF code; never the short token's padded code.
    expect(catalog?.parameters).toEqual(['["4711"]']);
  });

  it('reads nothing without a published edition or outside the CUI namespace', async () => {
    const { db, statements } = scriptedDb(answer());
    const repo = makeCompaniesRepo(db);
    expect((await repo.getActivityEvidence(CUI, UNPUBLISHED_SCOPE))._unsafeUnwrap()).toBeNull();
    expect((await repo.getActivityEvidence('4', PUBLISHED_SCOPE))._unsafeUnwrap()).toBeNull();
    expect(statements).toEqual([]);
  });

  it('treats a lost form/usability/catalogue function as the registry lost under the pin', async () => {
    const { db } = scriptedDb(
      answer({
        fiscal: () => {
          throw denied('42883');
        },
      })
    );
    expect(
      (await makeCompaniesRepo(db).getActivityEvidence(CUI, PUBLISHED_SCOPE))._unsafeUnwrapErr()
    ).toEqual({ type: 'ServiceUnavailable', message: REGISTRY_CAPABILITY_LOST_MESSAGE });
  });

  it('treats a lost view or catalog capability as the registry lost under the pin', async () => {
    const { db } = scriptedDb(
      answer({
        groups: () => {
          throw denied('42501');
        },
      })
    );
    const error = (
      await makeCompaniesRepo(db).getActivityEvidence(CUI, PUBLISHED_SCOPE)
    )._unsafeUnwrapErr();
    expect(error).toEqual({
      type: 'ServiceUnavailable',
      message: REGISTRY_CAPABILITY_LOST_MESSAGE,
    });
  });

  it('fails a broken fiscal read as a database error (never a missing row)', async () => {
    const { db } = scriptedDb(
      answer({
        fiscal: () => {
          throw new Error('connection reset');
        },
      })
    );
    expect(
      (await makeCompaniesRepo(db).getActivityEvidence(CUI, PUBLISHED_SCOPE))._unsafeUnwrapErr()
        .type
    ).toBe('Database');
  });

  it('reads no catalog for an overflowing aggregate (the selection refuses it)', async () => {
    const overflow = Array.from({ length: ACTIVITY_AGGREGATE_GROUP_BOUND + 1 }, (_, i) => ({
      caen_revision: null,
      caen_code: String(i).padStart(4, '0'),
      caen_class_state: 'unparsed',
      rows: 1,
    }));
    const { db, statements } = scriptedDb(answer({ groups: () => overflow }));
    const evidence = (
      await makeCompaniesRepo(db).getActivityEvidence(CUI, PUBLISHED_SCOPE)
    )._unsafeUnwrap();
    expect(evidence?.groups).toHaveLength(ACTIVITY_AGGREGATE_GROUP_BOUND + 1);
    expect(statements.some((s) => s.sql.includes('core.classification_codes cc'))).toBe(false);
  });
});
