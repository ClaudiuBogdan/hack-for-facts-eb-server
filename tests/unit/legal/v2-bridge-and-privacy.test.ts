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
        if (sql.includes('from legal_v2.forms f') && sql.includes('form_kind')) return [FORM_ROW];
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

  const sourceOver = (row: Record<string, unknown>) => {
    const captured: CapturedQuery[] = [];
    const db = makeCapturingDb(captured, {
      respond: (sql) =>
        sql.includes('as form_id, f.act_id::text as act_id')
          ? [{ form_id: '9', act_id: '7' }]
          : sql.includes('with f as')
            ? [row]
            : [],
    });
    return makeLegalRenderSourceV2(db);
  };
  const head = {
    form_id: '9',
    composition_digest: 'd'.repeat(64),
    receipt_id: '55',
    current_public: true,
    published_at: '2026-11-19 10:00:00+00',
    generation_seq: '4',
  };
  const component = {
    ordinal: 0,
    slot: 'whole',
    has_unit: true,
    public: true,
    render_state: 'text_only',
    text_sha256: 'e'.repeat(64),
    compiler_version: null,
    body_sha256: 'b'.repeat(64),
    parse_build_id: 'p',
    content_parser_version: 'v9',
    requested_url: 'https://legislatie.just.ro/Public/DetaliiDocumentAfis/1',
  };
  const chunk = { chunk_seq: 0, char_start: 0, char_end: 5, public: true, body: 'Text.' };

  it('answers 403 when a component or a chunk of the served text is restricted', async () => {
    for (const row of [
      {
        head,
        components: [{ ...component, public: false }],
        chunks: [chunk],
        links: [],
        assets: [],
      },
      {
        head,
        components: [component],
        chunks: [{ ...chunk, public: false }],
        links: [],
        assets: [],
      },
      {
        head: { ...head, current_public: false },
        components: [component],
        chunks: [chunk],
        links: [],
        assets: [],
      },
    ]) {
      const res = await sourceOver(row).read('f9', 0);
      expect(res._unsafeUnwrapErr()).toMatchObject({ reason: 'render_restricted' });
    }
  });

  it('answers not_loaded for a form without text, and composition_not_served for several units', async () => {
    const none = await sourceOver({ head, components: [], chunks: [], links: [], assets: [] }).read(
      'f9',
      0
    );
    expect(none._unsafeUnwrapErr()).toMatchObject({
      reason: 'render_unavailable',
      renderStatus: 'not_loaded',
    });
    const two = await sourceOver({
      head,
      components: [component, { ...component, ordinal: 1 }],
      chunks: [],
      links: [],
      assets: [],
    }).read('f9', 0);
    expect(two._unsafeUnwrapErr()).toMatchObject({ renderStatus: 'composition_not_served' });
  });

  it('serves a public text with the composition validator, under the form id', async () => {
    const res = await sourceOver({
      head,
      components: [component],
      chunks: [chunk],
      links: [],
      assets: [],
    }).read('171282', 0);
    const payload = res._unsafeUnwrap();
    expect(payload.kind).toBe('envelope');
    expect(payload.info.documentId).toBe('f9');
    expect(payload.info.runId).toBe('55');
    expect(payload.etag).toBe(`W/"v2c1-${'d'.repeat(32)}-g4"`);
    expect(payload.renderSource).toBe('legal_v2:tldf-unit/1');
    expect((payload.tldf as { document_id: string }).document_id).toBe('f9');
  });

  it('keeps the outline to the public provisions of public units', async () => {
    const captured: CapturedQuery[] = [];
    const db = makeCapturingDb(captured, {
      respond: (sql) =>
        sql.includes('as form_id, f.act_id::text as act_id') ? [{ form_id: '9', act_id: '7' }] : [],
    });
    const res = await makeLegalOutlineRepoV2(db).outline({
      documentId: 'f9',
      maxDepth: 7,
      page: { first: 5 },
    });
    expect(res._unsafeUnwrap()).toEqual({ items: [], next: null });
    const statement = captured.map((q) => q.sql).find((s) => s.includes('unit_provisions')) ?? '';
    expect(statement).toContain("p.privacy_class = 'public'");
    expect(statement).toContain("u.privacy_class = 'public'");
    expect(statement).toContain("c.privacy_class = 'public'");
  });
});

describe('compositions this version does not serve', () => {
  const sourceWith = (components: Record<string, unknown>[]) => {
    const db = makeCapturingDb([], {
      respond: (sql) =>
        sql.includes('as form_id, f.act_id::text as act_id')
          ? [{ form_id: '9', act_id: '7' }]
          : sql.includes('with f as')
            ? [
                {
                  head: {
                    form_id: '9',
                    composition_digest: 'd'.repeat(64),
                    receipt_id: '55',
                    current_public: true,
                    published_at: '2026-11-19T10:00:00+00:00',
                    generation_seq: '4',
                  },
                  components,
                  chunks: [
                    { chunk_seq: 0, char_start: 0, char_end: 5, public: true, body: 'Text.' },
                  ],
                  links: [],
                  assets: [],
                },
              ]
            : [],
    });
    return makeLegalRenderSourceV2(db);
  };
  const unitComponent = (slot: string) => ({
    ordinal: 0,
    slot,
    has_unit: true,
    public: true,
    render_state: 'text_only',
    text_sha256: 'e'.repeat(64),
    compiler_version: null,
    body_sha256: 'b'.repeat(64),
    parse_build_id: 'p',
    content_parser_version: 'v9',
    requested_url: 'u',
  });
  const linkComponent = (slot: string) => ({ ordinal: 1, slot, has_unit: false, public: true });

  it('refuses a header without its body as a complete text', async () => {
    const res = await sourceWith([unitComponent('header'), linkComponent('missing_body')]).read(
      'f9',
      0
    );
    expect(res._unsafeUnwrapErr()).toMatchObject({ renderStatus: 'composition_not_served' });
    const bodyOnly = await sourceWith([unitComponent('body')]).read('f9', 0);
    expect(bodyOnly._unsafeUnwrapErr()).toMatchObject({ renderStatus: 'composition_not_served' });
  });

  it('serves a whole unit beside linked annexes', async () => {
    const res = await sourceWith([unitComponent('whole'), linkComponent('linked_annex')]).read(
      'f9',
      0
    );
    expect(res._unsafeUnwrap().kind).toBe('envelope');
  });

  it('refuses a whole unit beside a restricted linked annex component', async () => {
    const res = await sourceWith([
      unitComponent('whole'),
      { ...linkComponent('linked_annex'), public: false },
    ]).read('f9', 0);
    expect(res._unsafeUnwrapErr()).toMatchObject({ reason: 'render_restricted' });
  });
});

describe('the outline has the render gate', () => {
  it('reads only a public act, form, published composition and unrestricted chunks', async () => {
    const captured: CapturedQuery[] = [];
    const db = makeCapturingDb(captured, {
      respond: (sql) =>
        sql.includes('as form_id, f.act_id::text as act_id') ? [{ form_id: '9', act_id: '7' }] : [],
    });
    await makeLegalOutlineRepoV2(db).outline({ documentId: 'f9', maxDepth: 7, page: { first: 5 } });
    const statement = (
      captured.map((q) => q.sql).find((s) => s.includes('unit_provisions')) ?? ''
    ).replace(/\s+/gu, ' ');
    expect(statement).toContain(
      "join legal_v2.acts a on a.act_id = f.act_id and a.privacy_class = 'public'"
    );
    expect(statement).toContain(
      "join legal_v2.form_current fc on fc.form_id = f.form_id and fc.privacy_class = 'public'"
    );
    expect(statement).toContain("ur.privacy_class <> 'public'");
    expect(statement).toContain(
      'not exists (select 1 from comps where not comps.public or comps.chunk_restricted)'
    );
    expect(statement).toContain(
      "not exists (select 1 from comps where comps.slot = 'missing_body')"
    );
  });
});

describe('render availability reads the composition shape', () => {
  it('selects the whole-unit and missing-body counts the status rule needs', async () => {
    const captured: CapturedQuery[] = [];
    const db = makeCapturingDb(captured, {
      respond: (sql) =>
        sql.includes('cross join lateral')
          ? [
              {
                form_id: '9',
                receipt_id: '5',
                published_at: 'x',
                current_public: true,
                units: 1,
                whole_units: 1,
                missing_body: 0,
                restricted: false,
                text_sha256: 'e',
                compiler_version: 'c',
                chunks: 1,
                chunk_restricted: false,
              },
            ]
          : [],
    });
    const info = (await makeLegalRenderRepoV2(db).renderInfoForDocuments(['f9']))._unsafeUnwrap();
    expect(info.get('f9')).toMatchObject({ renderStatus: 'served', chunkCount: 1 });
    const statement = captured[0]?.sql.replace(/\s+/gu, ' ') ?? '';
    // The outer select must carry them: without them every form read as a composition.
    expect(statement).toMatch(
      /select f\.form_id.*x\.whole_units, x\.missing_body.*from legal_v2\.forms f/u
    );
  });
});
