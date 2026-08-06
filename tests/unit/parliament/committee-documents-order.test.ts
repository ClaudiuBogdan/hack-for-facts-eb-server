/**
 * `listCommitteeDocuments` — the keyset, the cursor, and the docType policy.
 *
 * THE REGRESSION THIS EXISTS FOR. `doc_date` is NULL on 1,980 of 2,056 Senate
 * rows, and SQL row comparison is three-valued: `ROW(NULL,'x') < ROW('…','y')`
 * evaluates to NULL, which is not true, so an undated row can never pass a naive
 * `(doc_date, key)` keyset. Measured on Chronos: a two-page walk of
 * `senate:a3ba8a6b-…` returned 3 of its 188 documents — and returned them without
 * an error, which is the part that makes it dangerous. Ordering on a coalesced
 * text ordinal takes the NULL out of the comparison entirely.
 *
 * The mapper half pins the OTHER measured decision: Senate `doc_type` is
 * suppressed because it was derived from senat.ro's navigation-menu label and,
 * checked against the source, filed a newsletter and a JPEG as minutes.
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

import {
  COMMITTEE_DOCUMENT_ORD_SENTINEL,
  COMMITTEE_DOCUMENT_PAGE_LIMIT,
  committeeDocumentOrd,
} from '@/modules/parliament/core/constants.js';
import { mapCommitteeDocument } from '@/modules/parliament/shell/repo/mappers.js';
import { makeParliamentRepo } from '@/modules/parliament/shell/repo/parliament-repo.js';
import { buildNextCursor, filterHash, type ProdDatabase } from '@/modules/shared/index.js';

interface Captured {
  readonly sql: string;
  readonly parameters: readonly unknown[];
}

/**
 * A fake driver that answers each statement from a QUEUE of row sets, so a
 * multi-page walk can be replayed the way the server would actually see it.
 */
const makeDb = (
  captured: Captured[],
  pages: readonly (readonly unknown[])[]
): Kysely<ProdDatabase> => {
  const queue = [...pages];
  const connection: DatabaseConnection = {
    executeQuery<R>(query: CompiledQuery): Promise<QueryResult<R>> {
      captured.push({ sql: query.sql, parameters: query.parameters });
      return Promise.resolve({ rows: (queue.shift() ?? []) as R[] });
    },
    streamQuery(): AsyncIterableIterator<QueryResult<never>> {
      throw new Error('streamQuery not supported');
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
      createIntrospector: (db) => new PostgresIntrospector(db),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
};

const flat = (s: string): string => s.replace(/\s+/gu, ' ').trim();

const SENATE = 'senate:a3ba8a6b-8b59-47b1-8932-0d30b5f7add1';
const OTHER = 'senate:ef36e8b3-2fb2-43e8-bd6d-1ad040db24b3';

/** A row as the SQL returns it: `ord` is the DATABASE's ordinal, not a TS guess. */
const row = (key: string, docDate: string | null, over: Record<string, unknown> = {}) => ({
  committee_document_key: key,
  committee_key: SENATE,
  title: `Document ${key}`,
  doc_type: 'raport',
  doc_date: docDate,
  document_url: null,
  source_url: 'https://www.senat.ro/ComisiiDetaliu.aspx',
  bill_key: null,
  ord: docDate === null ? COMMITTEE_DOCUMENT_ORD_SENTINEL : docDate.replaceAll('-', ''),
  ...over,
});

describe('listCommitteeDocuments — the keyset', () => {
  it('sorts and compares on the coalesced ordinal, never on the bare doc_date', async () => {
    const captured: Captured[] = [];
    const repo = makeParliamentRepo(makeDb(captured, [[row('d1', '2024-03-01')]]));

    const res = await repo.listCommitteeDocuments(SENATE, { first: 20 });
    expect(res.isOk()).toBe(true);

    const text = flat(captured[0]!.sql);
    expect(text).toContain("coalesce(to_char(cd.doc_date, 'YYYYMMDD')");
    expect(text).toContain('order by coalesce(');
    expect(text).toContain('desc, cd.committee_document_key desc');
    // The bare-tuple keyset this replaced — the exact shape that silently
    // dropped 185 of 188 rows. Note `to_char(cd.doc_date, …)` legitimately
    // contains "cd.doc_date," so the negative is the TUPLE, not the substring.
    expect(text).not.toMatch(/\(\s*doc_date\s*,/u);
    expect(text).not.toContain('(cd.doc_date, cd.committee_document_key)');
    expect(text).not.toMatch(/order by\s+cd\.doc_date/u);
  });

  it('walks an undated page to completion — the row-loss regression', async () => {
    // 3 rows, 1 dated: the shape that broke. Page size 2, so the second page is
    // reached through a real cursor comparison against an UNDATED last row.
    const captured: Captured[] = [];
    const repo = makeParliamentRepo(
      makeDb(captured, [
        [row('d-dated', '2024-03-01'), row('d-undated-b', null), row('d-undated-a', null)],
        [row('d-undated-a', null)],
      ])
    );

    const first = await repo.listCommitteeDocuments(SENATE, { first: 2 });
    expect(first.isOk()).toBe(true);
    if (!first.isOk()) return;
    expect(first.value.items).toHaveLength(2);
    const cursor = first.value.next;
    expect(cursor).not.toBeNull();

    const second = await repo.listCommitteeDocuments(SENATE, { first: 2, after: cursor! });
    expect(second.isOk()).toBe(true);
    if (!second.isOk()) return;

    const keys = [...first.value.items, ...second.value.items].map((d) => d.committeeDocumentKey);
    expect(new Set(keys).size).toBe(3);

    // The second page's comparison must carry the SENTINEL, not a NULL: the
    // cursor was minted on an undated row, and it is that comparison a naive
    // keyset makes unsatisfiable.
    const secondSql = captured[1]!;
    expect(secondSql.parameters).toContain(COMMITTEE_DOCUMENT_ORD_SENTINEL);
    expect(flat(secondSql.sql)).toContain(', cd.committee_document_key) <');
  });

  it('rejects a cursor minted on another committee', async () => {
    const captured: Captured[] = [];
    const repo = makeParliamentRepo(makeDb(captured, [[row('d1', null)], []]));

    const mine = await repo.listCommitteeDocuments(SENATE, { first: 1 });
    expect(mine.isOk()).toBe(true);
    if (!mine.isOk()) return;
    // Only one row came back for a `first: 1` page, so there is no next cursor;
    // mint the equivalent one the connection builder would hand an edge.
    const stolen = await repo.listCommitteeDocuments(OTHER, { first: 1 });
    expect(stolen.isOk()).toBe(true);

    const captured2: Captured[] = [];
    const repo2 = makeParliamentRepo(
      makeDb(captured2, [[row('a', '2024-01-01'), row('b', '2023-01-01')]])
    );
    const page = await repo2.listCommitteeDocuments(OTHER, { first: 1 });
    expect(page.isOk()).toBe(true);
    if (!page.isOk()) return;
    const otherCursor = page.value.next;
    expect(otherCursor).not.toBeNull();

    // Replayed against a DIFFERENT committee: the fhash is signed over the
    // committee_key, so this never reaches SQL.
    const replay = await repo2.listCommitteeDocuments(SENATE, { first: 1, after: otherCursor! });
    expect(replay.isErr()).toBe(true);
    if (replay.isErr()) expect(replay.error.type).toBe('InvalidInput');
    expect(filterHash(`committee-documents:${SENATE}`)).not.toBe(
      filterHash(`committee-documents:${OTHER}`)
    );
  });

  it('rejects a cursor whose ordinal key is not the 8-digit shape', async () => {
    const captured: Captured[] = [];
    const repo = makeParliamentRepo(makeDb(captured, [[row('a', '2024-01-01')]]));

    // A WELL-FORMED envelope for the right committee, carrying a junk ordinal:
    // the fhash matches, so nothing but the key-shape guard stands between this
    // and a comparison against a text ordinal that can never match.
    const tampered = buildNextCursor({
      sort: 'docOrd',
      dir: 'desc',
      fhash: filterHash(`committee-documents:${SENATE}`),
      lastKeys: ['not-a-date', 'a'],
    });

    const replay = await repo.listCommitteeDocuments(SENATE, { first: 1, after: tampered });
    expect(replay.isErr()).toBe(true);
    if (replay.isErr()) expect(replay.error.type).toBe('InvalidInput');
    // It never reached SQL.
    expect(captured).toHaveLength(0);
  });

  it('clamps `first` to the measured page limit', async () => {
    const captured: Captured[] = [];
    const repo = makeParliamentRepo(makeDb(captured, [[]]));
    await repo.listCommitteeDocuments(SENATE, { first: 5_000 });
    // limit + 1 — the has-next probe.
    expect(captured[0]!.parameters).toContain(COMMITTEE_DOCUMENT_PAGE_LIMIT + 1);
  });
});

describe('committeeDocumentOrd — the TS reading equals the SQL reading', () => {
  it('agrees with coalesce(to_char(doc_date, YYYYMMDD), sentinel)', () => {
    expect(committeeDocumentOrd('2024-03-01')).toBe('20240301');
    // The repo selects `doc_date::text`, which is date-only; tolerate a
    // timestamp-shaped value rather than folding the time into the ordinal.
    expect(committeeDocumentOrd('2024-03-01T00:00:00Z')).toBe('20240301');
    expect(committeeDocumentOrd(null)).toBe(COMMITTEE_DOCUMENT_ORD_SENTINEL);
    // Undated sorts LAST under DESC — the sentinel is below every real date.
    expect(COMMITTEE_DOCUMENT_ORD_SENTINEL < '19900101').toBe(true);
  });
});

describe('mapCommitteeDocument — the docType policy', () => {
  const base = {
    committee_document_key: 'k',
    title: 'Raport',
    doc_date: '2024-01-01',
    document_url: null,
    source_url: 'https://example.invalid',
    bill_key: null,
  };

  it('serves null docType for a Senate row even though the column is populated', () => {
    const mapped = mapCommitteeDocument({
      ...base,
      committee_key: 'senate:abc',
      doc_type: 'proces_verbal',
    });
    expect(mapped.docType).toBeNull();
  });

  it('passes a Camera docType through', () => {
    const mapped = mapCommitteeDocument({
      ...base,
      committee_key: 'cdep:2:2024:11',
      doc_type: 'raport',
    });
    expect(mapped.docType).toBe('raport');
  });

  it('never carries docTypeRaw onto the payload in any shape', () => {
    const mapped = mapCommitteeDocument({
      ...base,
      committee_key: 'cdep:2:2024:11',
      doc_type: 'raport',
    });
    expect(Object.keys(mapped).sort()).toEqual([
      'billKey',
      'committeeDocumentKey',
      'docDate',
      'docType',
      'documentUrl',
      'sourceUrl',
      'title',
    ]);
  });
});
