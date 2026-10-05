/**
 * Companies repo — `resolveByName` over the palette index (the F11 re-point)
 * and its generation witness (api-repair-08).
 *
 * The query goes to the CONFIGURED palette index with the privacy-pinned,
 * role-filtered array filter, and the CUI comes from `hit.docKey` (palette
 * docs carry no `attrs.cui`). The engine's candidates — and its zero — are
 * accepted only when the palette generation is witnessed (its control read
 * before and after the fetch, equal) and was built for exactly the pinned
 * PUBLISHED scope; otherwise the existing bounded fallback answers as
 * `degraded`. A scripted Kysely driver answers by statement and executes
 * nothing; every expected value is a literal.
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
import { describe, expect, it, vi } from 'vitest';

import { makeCompaniesRepo } from '@/modules/companies/shell/repo/companies-repo.js';
import { upstreamError } from '@/modules/shared/core/errors.js';

import { MOVED_SCOPE, PUBLISHED_SCOPE, UNAVAILABLE_SCOPE } from './registry-fixtures.js';

import type { MeiliClient, ProdDatabase, SearchHit } from '@/modules/shared/index.js';

/** The generation control for edition 7 at publication epoch 3, access epoch 11 (PUBLISHED_SCOPE). */
const CONTROL_7: Readonly<Record<string, unknown>> = {
  id: 'palette_generation_control',
  doc_type: 'palette_generation_control',
  doc_key: 'palette_generation_control',
  privacy_class: 'internal',
  control_version: 'palette-generation-control-v1',
  projection_version: 'palette-company-v1',
  generation_id: 'entities_build_1759600000000_ab12cd',
  registry_scope_key: 'onrc:published:7:3:11',
  onrc_edition_id: '7',
  onrc_publication_epoch: '3',
  company_access_epoch: '11',
  onrc_source_snapshot_id: 'onrc:2026-07-08',
  onrc_source_published_at: '2026-07-08',
  onrc_interpretation_version: 'onrc-edition-v1',
  onrc_dimension_policy_version: 'onrc-dimensions-v1',
  entity_count: 10,
  company_count: 4,
  company_value_digest: '00000000000000000000000000000000000000000000000000000000000000aa',
};
/** Another generation (a later build for the same scope key would differ in its id). */
const CONTROL_7_NEXT = { ...CONTROL_7, generation_id: 'entities_build_1759600900000_ef34gh' };

class ScriptedDriver extends DummyDriver {
  constructor(private readonly rowsFor: (sql: string) => readonly unknown[]) {
    super();
  }

  override acquireConnection(): Promise<DatabaseConnection> {
    const rowsFor = this.rowsFor;
    return Promise.resolve({
      executeQuery: (query) => Promise.resolve({ rows: [...rowsFor(query.sql)] as never[] }),
      streamQuery: async function* () {
        // never streamed
      },
    });
  }
}

const VALIDATION_ROW = { cui: '2816464', name: 'DEDEMAN SRL' };
const FALLBACK_ROW = {
  cui: '2816464',
  name: 'DEDEMAN SRL',
  normalized_name: 'dedeman srl',
  county_name: null,
};

/** Spine validation, qualified edition names and the capped fallback, by statement. */
const scriptedDb = (opts: { fallback?: readonly unknown[] } = {}) => {
  const statements: string[] = [];
  const db = new Kysely<ProdDatabase>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () =>
        new ScriptedDriver((sql) => {
          if (sql.includes(' ilike ')) return opts.fallback ?? [FALLBACK_ROW];
          if (sql.includes('onrc_published_profiles')) {
            return [{ cui: '2816464', name: 'DEDEMAN S.R.L.' }];
          }
          if (sql.includes('"core"."organizations"')) return [VALIDATION_ROW];
          return [];
        }),
      createIntrospector: (d) => new PostgresIntrospector(d),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
    log: (event) => {
      if (event.level === 'query') statements.push(event.query.sql.replace(/\s+/gu, ' '));
    },
  });
  return { db, statements };
};

const indexHit = (over: Partial<SearchHit> = {}): SearchHit => ({
  id: 'company_2816464_x',
  docType: 'company',
  title: 'STALE INDEX TITLE SRL',
  snippet: null,
  score: 0.66,
  source: 'meili',
  attrs: {},
  docKey: '2816464',
  cuis: ['2816464'],
  ...over,
});

/** A Meili client whose control reads answer `controls` in order (the last repeats). */
const meiliWith = (
  hits: readonly SearchHit[] | 'down',
  controls: readonly (Readonly<Record<string, unknown>> | null)[] | 'absent'
) => {
  const searchEntities = vi.fn(async () =>
    hits === 'down'
      ? err(upstreamError('meili unreachable', 'meilisearch'))
      : ok({ hits, facetDistribution: {}, estimatedTotalHits: hits.length })
  );
  let reads = 0;
  const readGenerationControl = vi.fn(async () => {
    const list = controls === 'absent' ? [null] : controls;
    const answer = list[Math.min(reads, list.length - 1)] ?? null;
    reads += 1;
    return ok(answer);
  });
  const client = (controls === 'absent'
    ? { searchEntities }
    : { searchEntities, readGenerationControl }) as unknown as MeiliClient;
  return { client, searchEntities, readGenerationControl };
};

const NAME_HIT = (label: string, labelSource: string, confidence: number) => ({
  dim: 'name',
  value: '2816464',
  label,
  cui: '2816464',
  confidence,
  labelSource,
});

describe('resolveByName over a witnessed palette generation', () => {
  it('accepts the engine candidates for the pinned published scope, labelled from the edition', async () => {
    const meili = meiliWith([indexHit()], [CONTROL_7]);
    const { db, statements } = scriptedDb();
    const repo = makeCompaniesRepo(db, { meiliEntitiesIndex: 'entities' });
    const res = await repo.resolveByName('dedeman', 8, meili.client, PUBLISHED_SCOPE);

    expect(meili.searchEntities).toHaveBeenCalledWith('dedeman', 'entities', {
      policy: 'baseline',
      filter: ['privacy_class = "public"', 'roles IN ["company"]'],
      limit: 8,
    });
    expect(meili.readGenerationControl).toHaveBeenCalledTimes(2);
    expect(meili.readGenerationControl).toHaveBeenCalledWith('entities');
    // Search-index text is never a label: the edition's qualified name is.
    expect(res._unsafeUnwrap()).toEqual({
      hits: [NAME_HIT('DEDEMAN S.R.L.', 'onrc_edition', 0.66)],
      degraded: false,
    });
    expect(statements.some((s) => s.includes(' ilike '))).toBe(false);
  });

  it('a witnessed zero takes the existing fallback as a healthy (not degraded) answer', async () => {
    const meili = meiliWith([], [CONTROL_7]);
    const { db, statements } = scriptedDb({ fallback: [] });
    const repo = makeCompaniesRepo(db, { meiliEntitiesIndex: 'entities' });
    expect(
      (await repo.resolveByName('zzz', 8, meili.client, PUBLISHED_SCOPE))._unsafeUnwrap()
    ).toEqual({
      hits: [],
      degraded: false,
    });
    expect(statements.filter((s) => s.includes(' ilike '))).toHaveLength(1);
  });

  it('drops an engine candidate whose CUI fails the kind=company validation', async () => {
    const meili = meiliWith([indexHit({ docKey: '4305857', cuis: ['4305857'] })], [CONTROL_7]);
    const { db } = scriptedDb({ fallback: [] });
    const repo = makeCompaniesRepo(db, { meiliEntitiesIndex: 'entities' });
    // The validation answers only 2816464, so 4305857 is not a company: the
    // fallback answers (empty here), and the witnessed engine is not degraded.
    expect(
      (await repo.resolveByName('cluj', 8, meili.client, PUBLISHED_SCOPE))._unsafeUnwrap()
    ).toEqual({ hits: [], degraded: false });
  });
});

describe('resolveByName when the generation is not witnessed current', () => {
  it.each([
    ['no control document', [null]],
    ['a client without the exact control read', 'absent'],
    ['a malformed control', [{ ...CONTROL_7, onrc_edition_id: '07' }]],
    ['a generation changed between the two reads', [CONTROL_7, CONTROL_7_NEXT]],
  ] as const)(
    '%s: the engine candidates are not accepted; the bounded fallback answers degraded',
    async (_label, controls) => {
      const meili = meiliWith([indexHit()], controls === 'absent' ? 'absent' : [...controls]);
      const { db, statements } = scriptedDb();
      const repo = makeCompaniesRepo(db, { meiliEntitiesIndex: 'entities' });
      const res = await repo.resolveByName('dedeman', 8, meili.client, PUBLISHED_SCOPE);
      expect(res._unsafeUnwrap()).toEqual({
        hits: [NAME_HIT('DEDEMAN S.R.L.', 'onrc_edition', 1)],
        degraded: true,
      });
      // No validation of engine candidates ran: only the fallback scan did.
      expect(statements.filter((s) => s.includes(' ilike '))).toHaveLength(1);
      expect(statements.filter((s) => s.includes('"cui" in'))).toHaveLength(0);
    }
  );

  it('a published A → B move with identical values: the generation for A is stale', async () => {
    const meili = meiliWith([indexHit()], [CONTROL_7]);
    const { db } = scriptedDb();
    const repo = makeCompaniesRepo(db, { meiliEntitiesIndex: 'entities' });
    // MOVED_SCOPE: edition 7, publication epoch 4 (everything else equal).
    const res = await repo.resolveByName('dedeman', 8, meili.client, MOVED_SCOPE);
    expect(res._unsafeUnwrap().degraded).toBe(true);
  });

  it('a stale zero is never a healthy zero', async () => {
    const meili = meiliWith([], [null]);
    const { db } = scriptedDb({ fallback: [] });
    const repo = makeCompaniesRepo(db, { meiliEntitiesIndex: 'entities' });
    expect(
      (await repo.resolveByName('zzz', 8, meili.client, PUBLISHED_SCOPE))._unsafeUnwrap()
    ).toEqual({ hits: [], degraded: true });
  });

  it('an unpublished pin is never witnessed (the control is only for a published scope)', async () => {
    const meili = meiliWith([indexHit()], [CONTROL_7]);
    const { db } = scriptedDb();
    const repo = makeCompaniesRepo(db, { meiliEntitiesIndex: 'entities' });
    const res = await repo.resolveByName('dedeman', 8, meili.client, UNAVAILABLE_SCOPE);
    // No edition: the spine name, attributed as such, from the fallback.
    expect(res._unsafeUnwrap()).toEqual({
      hits: [NAME_HIT('DEDEMAN SRL', 'core_organization', 1)],
      degraded: true,
    });
  });

  it('an engine failure is degraded and reads the control once (nothing to witness)', async () => {
    const meili = meiliWith('down', [CONTROL_7]);
    const { db } = scriptedDb({ fallback: [] });
    const repo = makeCompaniesRepo(db, { meiliEntitiesIndex: 'entities' });
    expect(
      (await repo.resolveByName('cluj', 8, meili.client, PUBLISHED_SCOPE))._unsafeUnwrap().degraded
    ).toBe(true);
    expect(meili.searchEntities).toHaveBeenCalledTimes(1);
    expect(meili.readGenerationControl).toHaveBeenCalledTimes(1);
  });

  it('reports degraded when no engine is configured at all', async () => {
    const { db } = scriptedDb({ fallback: [] });
    const repo = makeCompaniesRepo(db, { meiliEntitiesIndex: 'entities' });
    expect(
      (await repo.resolveByName('cluj', 8, null, PUBLISHED_SCOPE))._unsafeUnwrap().degraded
    ).toBe(true);
  });
});
