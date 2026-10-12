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
