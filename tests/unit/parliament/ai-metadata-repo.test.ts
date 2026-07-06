/**
 * Parliament AI-metadata repo gates (B1) — behavioral, no live DB.
 *
 * The repo runs the REAL Kysely query against a fixture-backed capturing driver
 * that (a) records the compiled SQL + parameters, and (b) answers by filtering the
 * fixture on the query's own equality predicates. This proves BOTH gates are
 * applied — `validation_status='valid'` AND `privacy_class='public'` — via genuine
 * red/green cases (a restricted or invalid row yields null), not just a string
 * grep of the SQL.
 */

import {
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type CompiledQuery,
  type DatabaseConnection,
  type Driver,
  type QueryResult,
} from 'kysely';
import { describe, expect, it } from 'vitest';

import { makeParliamentRepo } from '@/modules/parliament/shell/repo/parliament-repo.js';

import type { ProdDatabase } from '@/modules/shared/index.js';

type Row = Record<string, unknown>;
interface Captured {
  sql: string;
  parameters: readonly unknown[];
}

/**
 * A Kysely over a fake driver: it records every compiled query and answers by
 * filtering the fixture on the equality predicates the compiler emitted
 * (`"alias"."col" = $n`). So a WHERE the repo forgot to add simply would not filter
 * the fixture — the gate is proven by behavior.
 */
const makeFixtureDb = (rows: readonly Row[], captured: Captured[]): Kysely<ProdDatabase> => {
  const connection: DatabaseConnection = {
    async executeQuery<R>(cq: CompiledQuery): Promise<QueryResult<R>> {
      captured.push({ sql: cq.sql, parameters: cq.parameters });
      const eq = new Map<string, unknown>();
      const re = /"[a-z_]+"\."([a-z_]+)"\s*=\s*\$(\d+)/gu;
      let m: RegExpExecArray | null;
      while ((m = re.exec(cq.sql)) !== null) {
        eq.set(m[1] ?? '', cq.parameters[Number(m[2]) - 1]);
      }
      const matched = rows.filter((r) => [...eq.entries()].every(([col, val]) => r[col] === val));
      return { rows: matched as R[] };
    },
    streamQuery(): AsyncIterableIterator<QueryResult<never>> {
      // These repo methods only use executeTakeFirst; streaming is never exercised.
      throw new Error('streamQuery not supported in the fixture db');
    },
  };
  const driver: Driver = {
    init: () => Promise.resolve(),
    acquireConnection: () => Promise.resolve(connection),
    beginTransaction: () => Promise.resolve(),
    commitTransaction: () => Promise.resolve(),
    rollbackTransaction: () => Promise.resolve(),
    releaseConnection: () => Promise.resolve(),
    destroy: () => Promise.resolve(),
  };
  return new Kysely<ProdDatabase>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => driver,
      createIntrospector: (d) => new PostgresIntrospector(d),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
};

const controlRow = (over: Partial<Row>): Row => ({
  item_key: 'ctrl-x',
  validation_status: 'valid',
  privacy_class: 'public',
  summary: 'Rezumat control.',
  policy_domains: ['sanatate'],
  issue_types: ['intrebare'],
  urgency: 'normal',
  keywords: ['spital'],
  config_key: 'ctrl-v1',
  prompt_version: 'p2',
  schema_version: 1,
  model: 'glm-5.2',
  confidence: null,
  source_updated_at: null,
  loaded_at: '2026-06-21T00:00:00Z',
  ...over,
});

const billRow = (over: Partial<Row>): Row => ({
  bill_key: 'b-x',
  validation_status: 'valid',
  privacy_class: 'public',
  summary: 'Rezumat lege.',
  topic: 'fiscal',
  domains: ['fiscal'],
  keywords: ['tva'],
  value_class: 'standard',
  config_key: 'bill-v1',
  prompt_version: 'p3',
  schema_version: 2,
  model: 'glm-5.2',
  confidence: '0.870',
  source_updated_at: null,
  loaded_at: '2026-06-21T00:00:00Z',
  ...over,
});

describe('findControlItemAiMetadata — validation + privacy gates (B1)', () => {
  it('GREEN: a valid + public row is served (with the AI trust class stamped)', async () => {
    const captured: Captured[] = [];
    const repo = makeParliamentRepo(
      makeFixtureDb([controlRow({ item_key: 'ctrl-pub' })], captured)
    );
    const r = await repo.findControlItemAiMetadata('ctrl-pub');
    expect(r.isOk()).toBe(true);
    const v = r._unsafeUnwrap();
    expect(v).not.toBeNull();
    expect(v?.summary).toBe('Rezumat control.');
    expect(v?.trustClass).toBe('inference_only_label');
    // Belt-and-suspenders: BOTH predicate columns + literal params are in the SQL.
    const q = captured[0];
    expect(q?.sql).toContain('validation_status');
    expect(q?.sql).toContain('privacy_class');
    expect(q?.parameters).toContain('valid');
    expect(q?.parameters).toContain('public');
  });

  it('RED (privacy): a valid but RESTRICTED item yields null (privacy_class gate)', async () => {
    const repo = makeParliamentRepo(
      makeFixtureDb([controlRow({ item_key: 'ctrl-restr', privacy_class: 'restricted' })], [])
    );
    const r = await repo.findControlItemAiMetadata('ctrl-restr');
    expect(r.isOk()).toBe(true);
    expect(r._unsafeUnwrap()).toBeNull();
  });

  it('RED (validity): a public but INVALID item yields null (validation_status gate)', async () => {
    const repo = makeParliamentRepo(
      makeFixtureDb([controlRow({ item_key: 'ctrl-inv', validation_status: 'invalid' })], [])
    );
    const r = await repo.findControlItemAiMetadata('ctrl-inv');
    expect(r.isOk()).toBe(true);
    expect(r._unsafeUnwrap()).toBeNull();
  });
});

describe('findBillAiMetadata — validation + privacy gates (B1)', () => {
  it('GREEN: a valid + public bill row is served (valueClass carried, low_value included)', async () => {
    const captured: Captured[] = [];
    const repo = makeParliamentRepo(
      makeFixtureDb([billRow({ bill_key: 'b-pub', value_class: 'low_value' })], captured)
    );
    const r = await repo.findBillAiMetadata('b-pub');
    expect(r.isOk()).toBe(true);
    const v = r._unsafeUnwrap();
    expect(v).not.toBeNull();
    expect(v?.valueClass).toBe('low_value'); // low_value rows ARE served (client hides them)
    expect(v?.trustClass).toBe('inference_only_label');
    const q = captured[0];
    expect(q?.sql).toContain('validation_status');
    expect(q?.sql).toContain('privacy_class');
    expect(q?.parameters).toContain('valid');
    expect(q?.parameters).toContain('public');
  });

  it('RED (privacy): a restricted bill row yields null', async () => {
    const repo = makeParliamentRepo(
      makeFixtureDb([billRow({ bill_key: 'b-restr', privacy_class: 'restricted' })], [])
    );
    expect((await repo.findBillAiMetadata('b-restr'))._unsafeUnwrap()).toBeNull();
  });

  it('RED (validity): an invalid bill row yields null', async () => {
    const repo = makeParliamentRepo(
      makeFixtureDb([billRow({ bill_key: 'b-inv', validation_status: 'invalid' })], [])
    );
    expect((await repo.findBillAiMetadata('b-inv'))._unsafeUnwrap()).toBeNull();
  });
});
