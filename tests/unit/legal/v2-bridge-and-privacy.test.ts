/**
 * legal_v2 source: the bridge (null handling for acts the old corpus lacks)
 * and the privacy rule (every legal_v2 relation a read touches is filtered on
 * `privacy_class = 'public'`; a restricted piece of a served text answers 403,
 * never a silently shortened text).
 */

import { describe, expect, it } from 'vitest';

import { V2_BRIDGED_ACT_FIELDS, mergeBridgedAct } from '@/modules/legal/core/v2/bridge.js';
import { makeLegalResolvers } from '@/modules/legal/shell/graphql/resolvers.js';
import { makeLegalActsRepo } from '@/modules/legal/shell/repo/acts-repo.js';
import { makeLegalActsRepoV2 } from '@/modules/legal/shell/repo/v2/acts-repo-v2.js';
import { makeLegalOutlineRepoV2 } from '@/modules/legal/shell/repo/v2/outline-v2.js';
import {
  makeLegalRenderRepoV2,
  makeLegalRenderSourceV2,
} from '@/modules/legal/shell/repo/v2/render-v2.js';

import { makeCapturingDb, type CapturedQuery } from '../../fixtures/capturing-db.js';

import type { LegalActsRepo } from '@/modules/legal/core/ports.js';
import type { LegalAct } from '@/modules/legal/core/types.js';

const identity = {
  actId: '7',
  actNaturalKey: 'lege/1/2020',
  actType: 'lege',
  actNumber: '1',
  actYear: 2020,
  issuerSlug: 'parlamentul',
  displayCitation: 'Legea nr. 1/2020',
  ended: false,
};

describe('the bridge', () => {
  it('labels bridged acts and leaves an act the old corpus lacks unbridged', () => {
    const bridged = mergeBridgedAct(identity, {
      status: 'abrogat',
      statusEvidence: { a: 1 },
      entryIntoForce: '2020-02-01',
      inDegree: 12,
    });
    expect(bridged).toMatchObject({ status: 'abrogat', inDegree: 12, bridged: true });
    expect(bridged.bridgedFields).toEqual(V2_BRIDGED_ACT_FIELDS);
    const alone = mergeBridgedAct(identity, null, 'f9');
    expect(alone).toMatchObject({ bridged: false, bridgedFields: [], canonicalDocumentId: 'f9' });
  });

  const resolvers = makeLegalResolvers({
    acts: {} as LegalActsRepo,
    graph: {} as never,
    outline: {} as never,
    render: {} as never,
    searchDeps: {} as never,
    resolveDeps: {} as never,
  }) as { LegalAct: Record<string, (parent: LegalAct) => unknown> };
  const field = (name: string, parent: LegalAct): unknown => resolvers.LegalAct[name]?.(parent);

  it('serves the bridged scalars as null for an unbridged act, and as stored otherwise', async () => {
    const alone = mergeBridgedAct(identity, null);
    for (const name of ['status', 'statusEvidence', 'inDegree']) {
      expect(field(name, alone)).toBeNull();
    }
    expect(await field('amendedAfterPublication', alone)).toBeNull();
    expect(field('dataSource', alone)).toBe('legal_v2');
    expect(field('bridgedFields', alone)).toEqual([]);
    const bridged = mergeBridgedAct(identity, {
      status: 'in-vigoare',
      statusEvidence: {},
      entryIntoForce: null,
      inDegree: 0,
    });
    expect(field('status', bridged)).toBe('in-vigoare');
    expect(field('inDegree', bridged)).toBe(0);
  });

  it('leaves legacy acts as they were', async () => {
    const legacy = {
      ...identity,
      canonicalDocumentId: '171282',
      status: 'modificat',
      statusEvidence: {},
      entryIntoForce: null,
      inDegree: 3,
    } as unknown as LegalAct;
    expect(field('status', legacy)).toBe('modificat');
    expect(field('dataSource', legacy)).toBe('legal');
    expect(field('bridgedFields', legacy)).toEqual([]);
    expect(await field('newerNotAvailable', legacy)).toBeNull();
    expect(await field('latestDocumentId', legacy)).toBeNull();
    expect(await field('canonicalDocumentId', legacy)).toBe('171282');
  });

  it('reads an act from legal_v2 and its facts from legal by act_id', async () => {
    const captured: CapturedQuery[] = [];
    const db = makeCapturingDb(captured, {
      respond: (sql) =>
        sql.replace(/\s+/gu, ' ').includes('from legal_v2.acts v left join legal.acts l')
          ? [
              {
                act_id: '7',
                act_natural_key: 'lege/1/2020',
                act_type: 'lege',
                act_number: '1',
                act_year: 2020,
                issuer_slug: 'parlamentul',
                display_citation: 'Legea nr. 1/2020',
                ended: false,
                bridged: false,
                status: null,
                status_evidence: null,
                entry_into_force: null,
                in_degree: null,
              },
            ]
          : [],
    });
    const repo = makeLegalActsRepoV2({ db, legacy: makeLegalActsRepo(db) });
    const act = (await repo.findActById('7'))._unsafeUnwrap();
    expect(act).toMatchObject({ actId: '7', bridged: false, status: 'necunoscut' });
    expect(field('status', act!)).toBeNull();
    expect(captured[0]?.sql.replace(/\s+/gu, ' ')).toContain(
      'left join legal.acts l on l.act_id = v.act_id'
    );
  });
});

/**
 * Every `legal_v2.<table> <alias>` a statement names must be filtered by
 * `<alias>.privacy_class` in the same statement. The few relations read for
 * bookkeeping only (the identity generation, a receipt's timestamp) are named.
 */
const BOOKKEEPING = new Set(['identity_publication', 'package_receipts']);

const unguardedRelations = (statement: string): string[] => {
  const missing: string[] = [];
  for (const m of statement.matchAll(/legal_v2\.(\w+)\s+(?:as\s+)?(\w+)/gu)) {
    const [, table, alias] = m;
    if (table === undefined || alias === undefined || BOOKKEEPING.has(table)) continue;
    if (['on', 'where', 'join', 'left', 'cross', 'order', 'limit', 'group'].includes(alias)) {
      missing.push(`${table} (no alias)`);
      continue;
    }
    if (!statement.includes(`${alias}.privacy_class`)) missing.push(`${table} ${alias}`);
  }
  return missing;
};

const FORM_ROW = {
  form_id: '9',
  act_id: '7',
  act_ended: false,
  form_kind: 'original',
  form_key: 'orig',
  portal_order_date: '2020-01-01',
  order_rank: null,
  accepted: true,
  body_resolved: true,
  ended: false,
  portal_label_raw: null,
  portal_label_date: null,
  caveat: null,
  gazette_number: '1',
  gazette_part: 1,
  gazette_date_reported: '2020-01-01',
  publication_raw: null,
  entry_into_force_reported: null,
  readable: true,
  held: false,
  source_url: 'https://legislatie.just.ro/Public/DetaliiDocumentAfis/1',
};

describe('privacy: every legal_v2 read filters public rows', () => {
  it('holds for every v2 repository read', async () => {
    const captured: CapturedQuery[] = [];
    const db = makeCapturingDb(captured, {
      respond: (sql) => {
        if (sql.includes('as act_ended') && sql.includes('gate.readable')) return [FORM_ROW];
        if (sql.includes('as form_id, f.act_id::text as act_id'))
          return [{ form_id: '9', act_id: '7' }];
        return [];
      },
    });
    const legacy = makeLegalActsRepo(db);
    const acts = makeLegalActsRepoV2({ db, legacy, today: () => '2026-11-20' });
    await acts.findActById('7');
    await acts.findActsByIds(['7', '8']);
    await acts.findActsByCitationNumber({ actType: 'lege', actNumber: '1', actYear: 2020 }, 5);
    await acts.findActsByCitationKey({
      actType: 'lege',
      actNumber: '1',
      actYear: 2020,
      issuerSlug: '',
    });
    await acts.findActsByAlias('codul fiscal', 5);
    await acts.searchActsByName('codul', 5);
    await acts.listActs({ filter: {}, sort: 'in_degree', dir: 'desc', page: { first: 5 } });
    await acts.countActs({});
    await acts.countActsBy('status', {});
    await acts.listDocuments('7');
    await acts.countDocuments('7');
    await acts.documentActId('f9');
    await acts.documentActId('171282');
    await acts.versionProvenanceForDocument('f9');
    await makeLegalOutlineRepoV2(db).outline({
      documentId: 'f9',
      maxDepth: 7,
      page: { first: 50 },
    });
    await makeLegalRenderRepoV2(db).renderInfoForDocuments(['f9']);
    await makeLegalRenderSourceV2(db).read('f9', 0);

    const v2Statements = captured.map((q) => q.sql).filter((s) => s.includes('legal_v2.'));
    expect(v2Statements.length).toBeGreaterThan(15);
    for (const statement of v2Statements) {
      expect(unguardedRelations(statement), statement).toEqual([]);
    }
  });

  /** A v2 body row as the one render statement returns it. */
  const bodyRow = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    route_status: 'bound',
    head: {
      form_id: '9',
      form_kind: 'consolidation',
      caveat: 'unofficial_consolidation',
      portal_label_raw: null,
      portal_label_date: '2024-03-01',
      portal_order_date: '2024-03-01',
      receipt_id: '55',
      status: 'served',
      public_chunks: 1,
      published_at: '2026-11-19T10:00:00+00:00',
      text_sha256: 'e'.repeat(64),
      compiler_version: null,
      body_sha256: 'b'.repeat(64),
      parse_build_id: 'p',
      content_parser_version: 'v9',
      source_url: 'https://legislatie.just.ro/Public/DetaliiDocumentAfis/1',
    },
    components: [
      {
        ordinal: 0,
        render_state: 'text_only',
        fidelity_flags: ['text_only_no_structure_compiled'],
        chunks: [{ chunk_seq: 0, char_start: 0, char_end: 5, body: 'Text.' }],
        links: [],
        assets: [],
      },
    ],
    ...over,
  });
  const sourceOver = (row: Record<string, unknown>) =>
    makeLegalRenderSourceV2(
      makeCapturingDb([], { respond: (sql) => (sql.includes('with pick as') ? [row] : []) })
    );

  it('returns the restriction verdict before inspecting any component', async () => {
    const row = bodyRow({ head: { form_id: '9', status: 'restricted' }, components: [] });
    const res = await sourceOver(row).read('f9', 0);
    expect(res._unsafeUnwrapErr()).toMatchObject({ reason: 'render_restricted' });
  });

  it('answers 404 for a restricted page route, and never another route for a held one', async () => {
    const restricted = await sourceOver(bodyRow({ route_status: 'restricted' })).read('171282', 0);
    expect(restricted._unsafeUnwrapErr()).toMatchObject({ reason: 'render_not_found' });
    const held = await sourceOver(bodyRow({ route_status: 'held', head: null })).read('171282', 0);
    expect(held._unsafeUnwrapErr()).toMatchObject({
      reason: 'render_unavailable',
      renderStatus: 'not_loaded',
    });
  });

  it('serves a public text with no validator, stating the served form', async () => {
    const res = await sourceOver(bodyRow()).read('171282', 0);
    const payload = res._unsafeUnwrap();
    expect(payload.kind).toBe('envelope');
    expect(payload.info.documentId).toBe('f9');
    expect(payload.cacheable).toBe(false);
    expect(payload.extraMeta?.['servedForm']).toEqual({
      documentId: 'f9',
      versionKind: 'consolidare',
      versionDate: '2024-03-01',
      caveat: 'unofficial_consolidation',
      portalLabelRaw: null,
      portalLabelDate: '2024-03-01',
      sourceUrl: 'https://legislatie.just.ro/Public/DetaliiDocumentAfis/1',
    });
    expect(payload.extraMeta?.['renderHead']).toMatchObject({ version: 1 });
  });

  it('keeps the outline to the public provisions of public units', async () => {
    const captured: CapturedQuery[] = [];
    const db = makeCapturingDb(captured);
    const res = await makeLegalOutlineRepoV2(db).outline({
      documentId: 'f9',
      maxDepth: 7,
      page: { first: 5 },
    });
    expect(res._unsafeUnwrap()).toEqual({ items: [], next: null });
    const statement = captured.map((q) => q.sql).find((s) => s.includes('unit_provisions')) ?? '';
    expect(statement).toContain('p.privacy_class');
    expect(statement).toContain("u.privacy_class = 'public'");
    expect(statement).toContain("c.privacy_class = 'public'");
  });
});

describe('the outline has the render gate', () => {
  it('reads only a public act, form, published composition and unrestricted chunks', async () => {
    const captured: CapturedQuery[] = [];
    const db = makeCapturingDb(captured);
    await makeLegalOutlineRepoV2(db).outline({ documentId: 'f9', maxDepth: 7, page: { first: 5 } });
    const statement = (
      captured.map((q) => q.sql).find((s) => s.includes('unit_provisions')) ?? ''
    ).replace(/\s+/gu, ' ');
    expect(statement).toContain(
      "join legal_v2.acts a on a.act_id = f.act_id and a.privacy_class = 'public'"
    );
    expect(statement).toContain("fc.privacy_class <> 'public'");
    expect(statement).toContain("ur.privacy_class <> 'public'");
    expect(statement).toContain('s.component_slot = c.slot');
    expect(statement).toContain('f.portal_label_date is null');
    expect(statement).toContain('and gate.readable');
  });
});

describe('render availability over GraphQL', () => {
  const infoRow = (over: Record<string, unknown> = {}) => ({
    form_id: '9',
    form_kind: 'original',
    portal_label_raw: null,
    portal_label_date: null,
    receipt_id: '5',
    published_at: '2026-11-19T10:00:00+00:00',
    status: 'served',
    text_sha256: 'e',
    compiler_version: 'c',
    public_chunks: 1,
    ...over,
  });
  const infoOver = async (row: Record<string, unknown>) =>
    (
      await makeLegalRenderRepoV2(
        makeCapturingDb([], { respond: (sql) => (sql.includes('cross join lateral') ? [row] : []) })
      ).renderInfoForDocuments(['f9'])
    )
      ._unsafeUnwrap()
      .get('f9');

  it('serves the metadata of a served form', async () => {
    expect(await infoOver(infoRow())).toMatchObject({
      renderStatus: 'served',
      textSha256: 'e',
      compilerVersion: 'c',
      chunkCount: 1,
    });
  });

  it('withholds hash, compiler, time and count of a restricted form', async () => {
    expect(await infoOver(infoRow({ status: 'restricted' }))).toEqual({
      documentId: 'f9',
      renderStatus: 'content_unavailable',
      privacyClass: 'restricted',
      runId: '',
      textSha256: '',
      compilerVersion: '',
      compiledAt: '',
      chunkCount: null,
    });
  });
});
