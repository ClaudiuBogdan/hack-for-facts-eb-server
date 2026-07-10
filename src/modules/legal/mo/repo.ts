/**
 * Monitorul-Oficial (`mo/` area, plan 06) — `MonitorulRepo` over live `legal.mo_*`
 * + `legal.act_status_events` (read, scoped to `event_source='monitorul-oficial'`).
 * The ONLY place reading the gazette tables. No writes (foundation F5).
 *
 * Cursor discipline (Codex #8, mirrors the legal acts-repo keyset):
 *  - publications: `(act_year desc/asc nulls last, mo_act_key)` — text tiebreaker.
 *  - issues: offset (year-bounded, 42K rows; cheap count).
 *  - issue contents / edges: `(mo_act_key)` / `(edge_id)` keyset, bigint tiebreak ::bigint.
 *
 * Bigint ids are read as strings (int8→string pg parser, configured by the kernel).
 * Internal columns (s3/sha256, raw fields, evidence jsonb) are NEVER selected.
 */

import { sql, type Kysely, type RawBuilder } from 'kysely';
import { err, ok } from 'neverthrow';

import {
  buildNextCursor,
  databaseError,
  decodeCursor,
  fhashFor,
  foldDiacritics,
  invalidInput,
  type CursorPage,
  type FilterInput,
  type ProdDatabase,
} from '@/modules/shared/index.js';

import { moEdgesSpec, moIssuesSpec, moPublicationsSpec } from './filters.js';
import {
  mapEdge,
  mapIssue,
  mapPublication,
  mapStatusEvent,
  type MoActPublicationRow,
  type MoIssueRow,
  type MoLifecycleEdgeRow,
  type MoStatusEventRow,
} from './mappers.js';
import {
  type MoActPublication,
  type MoIssuerSummary,
  type MoIssuerYearCount,
  type MoLifecycleEdge,
  type MoPartCount,
  type MoPartCode,
  type MoResolveHit,
  type MoStatusEvent,
} from './types.js';
import { kernelConditions } from '../shell/repo/filter-helpers.js';

import type { MonitorulRepo } from './ports.js';

type Db = Kysely<ProdDatabase>;

const ID_RE = /^\d+$/u;
const MAX_LIST = 100;
const MAX_BATCH_ACTS = 500;

const clampLimit = (first: number, max: number): number =>
  Math.min(Math.max(Math.floor(first), 1), max);

export const makeMonitorulRepo = (db: Db): MonitorulRepo => {
  // Dates are cast ::text so the int8 parser doesn't touch them and they arrive as
  // 'YYYY-MM-DD'. timestamptz columns arrive ISO already.
  const selectIssues = () =>
    db
      .selectFrom('legal.mo_issues as i')
      .select([
        'i.mo_issue_id',
        'i.part_code',
        'i.mo_part',
        'i.issue_label',
        'i.issue_number',
        'i.issue_suffix',
        'i.issue_year',
        sql<string | null>`i.issue_date::text`.as('issue_date'),
        'i.pdf_url',
        'i.has_archive_index',
        'i.has_emonitor_link',
        'i.pdf_bytes',
        sql<string>`i.first_seen_at::text`.as('first_seen_at'),
        sql<string>`i.last_seen_at::text`.as('last_seen_at'),
      ]);

  const selectPubs = () =>
    db
      .selectFrom('legal.mo_act_publications as p')
      .select([
        'p.mo_act_key',
        'p.mo_issue_id',
        'p.act_type',
        'p.act_number_norm',
        'p.act_year',
        'p.issue_year',
        'p.issuer_slug',
        'p.title',
        sql<string | null>`p.act_date::text`.as('act_date'),
        'p.act_id',
        'p.resolution',
        'p.matched_via',
        'p.source_pdf_url',
        sql<string>`p.first_seen_at::text`.as('first_seen_at'),
        sql<string>`p.last_seen_at::text`.as('last_seen_at'),
      ]);

  const selectEdges = () =>
    db
      .selectFrom('legal.mo_lifecycle_edges as e')
      .select([
        'e.edge_id',
        'e.source_mo_act_key',
        'e.relation',
        'e.target_raw',
        'e.target_index',
        'e.target_act_type',
        'e.target_act_number',
        'e.target_act_year',
        'e.target_issuer_slug',
        'e.target_act_id',
        'e.target_mo_act_key',
        'e.resolution',
        'e.matched_via',
        'e.method',
        'e.confidence',
      ]);

  const selectStatusEvents = () =>
    db
      .selectFrom('legal.act_status_events as s')
      .select([
        's.event_id',
        's.act_id',
        's.event_kind',
        sql<string | null>`s.effective_date::text`.as('effective_date'),
        's.source_act_id',
      ])
      .where('s.event_source', '=', 'monitorul-oficial');

  const mapPubRows = (rows: readonly unknown[]): MoActPublication[] =>
    rows.map((r) => mapPublication(r as MoActPublicationRow));
  const mapEdgeRows = (rows: readonly unknown[]): MoLifecycleEdge[] =>
    rows.map((r) => mapEdge(r as MoLifecycleEdgeRow));
  const mapStatusRows = (rows: readonly MoStatusEventRow[]): MoStatusEvent[] => {
    const out: MoStatusEvent[] = [];
    for (const r of rows) {
      const m = mapStatusEvent(r);
      if (m !== null) out.push(m); // §2.4: out-of-set kind dropped, never thrown
    }
    return out;
  };

  const uniqueIds = (ids: readonly string[]): string[] =>
    [...new Set(ids.filter((id) => ID_RE.test(id)))].slice(0, MAX_BATCH_ACTS);

  // ── issue browsing ──────────────────────────────────────────────────────────

  const getIssueById: MonitorulRepo['getIssueById'] = async (moIssueId) => {
    if (!ID_RE.test(moIssueId)) return ok(null);
    try {
      const row = await selectIssues()
        .where('i.mo_issue_id', '=', moIssueId)
        .limit(1)
        .executeTakeFirst();
      return ok(row === undefined ? null : mapIssue(row as unknown as MoIssueRow));
    } catch (error) {
      return err(databaseError('getIssueById failed', error));
    }
  };

  const findIssueByCoordinates: MonitorulRepo['findIssueByCoordinates'] = async (
    partCode,
    moNumberText,
    issueYear
  ) => {
    // Match the identity uq: (part_code, lower(issue_label), issue_year). The
    // caller's number is whitespace-stripped + case-folded against issue_label.
    const folded = moNumberText.replace(/\s+/gu, '').toLowerCase();
    try {
      const row = await selectIssues()
        .where('i.part_code', '=', partCode)
        .where(sql<boolean>`lower(i.issue_label) = ${folded}`)
        .where('i.issue_year', '=', issueYear)
        .limit(1)
        .executeTakeFirst();
      return ok(row === undefined ? null : mapIssue(row as unknown as MoIssueRow));
    } catch (error) {
      return err(databaseError('findIssueByCoordinates failed', error));
    }
  };

  const listIssues: MonitorulRepo['listIssues'] = async (filter, page, sort) => {
    const kernel = kernelConditions(moIssuesSpec, filter);
    if (kernel.isErr()) return err(kernel.error);
    const pageSize = clampLimit(page.pageSize, MAX_LIST);
    const offset = Math.max(0, (Math.max(1, Math.floor(page.page)) - 1) * pageSize);
    const orderBy =
      sort === 'issue_date_asc'
        ? sql`order by i.issue_date asc nulls last, i.mo_issue_id asc`
        : sort === 'issue_year_desc'
          ? sql`order by i.issue_year desc, i.mo_issue_id desc`
          : sql`order by i.issue_date desc nulls last, i.mo_issue_id desc`;
    try {
      const rowsQ = sql<MoIssueRow & { total: string }>`
        select
          i.mo_issue_id, i.part_code, i.mo_part, i.issue_label, i.issue_number,
          i.issue_suffix, i.issue_year, i.issue_date::text as issue_date, i.pdf_url,
          i.has_archive_index, i.has_emonitor_link, i.pdf_bytes,
          i.first_seen_at::text as first_seen_at, i.last_seen_at::text as last_seen_at,
          count(*) over () as total
        from legal.mo_issues i
        where ${kernel.value}
        ${orderBy}
        limit ${pageSize} offset ${offset}
      `;
      const result = await rowsQ.execute(db);
      const items = result.rows.map((r) => mapIssue(r));
      const total = result.rows.length > 0 ? Number(result.rows[0]?.total ?? 0) : 0;
      return ok({ items, total });
    } catch (error) {
      return err(databaseError('listIssues failed', error));
    }
  };

  const getIssueContents: MonitorulRepo['getIssueContents'] = async (moIssueId, page) => {
    if (!ID_RE.test(moIssueId)) return ok({ items: [], next: null });
    const limit = clampLimit(page.first, MAX_LIST);
    const sortKey = 'mo_act_key';
    const dir = 'asc' as const;
    const fhash = fhashFor(moPublicationsSpec, { moIssueId: { eq: moIssueId } });
    let afterKey: string | undefined;
    if (page.after !== undefined) {
      const decoded = decodeCursor(page.after, { sort: sortKey, dir, fhash });
      if (decoded.isErr()) return err(decoded.error);
      afterKey = decoded.value.keys[0];
    }
    try {
      let q = selectPubs().where('p.mo_issue_id', '=', moIssueId);
      if (afterKey !== undefined) q = q.where('p.mo_act_key', '>', afterKey);
      const rows = await q
        .orderBy('p.mo_act_key', 'asc')
        .limit(limit + 1)
        .execute();
      return ok(
        toKeyedCursorPage(mapPubRows(rows), limit, sortKey, dir, fhash, (it) => it.moActKey)
      );
    } catch (error) {
      return err(databaseError('getIssueContents failed', error));
    }
  };

  // ── act-publication lookup ────────────────────────────────────────────────────

  const getPublicationByKey: MonitorulRepo['getPublicationByKey'] = async (moActKey) => {
    if (moActKey === '') return ok(null);
    try {
      const row = await selectPubs()
        .where('p.mo_act_key', '=', moActKey)
        .limit(1)
        .executeTakeFirst();
      return ok(row === undefined ? null : mapPublication(row as unknown as MoActPublicationRow));
    } catch (error) {
      return err(databaseError('getPublicationByKey failed', error));
    }
  };

  const listPublications: MonitorulRepo['listPublications'] = async (filter, page, sort) => {
    // ≥1 bounding predicate (§7): actYear ∨ issuerSlug ∨ actId ∨ moIssueId.
    if (!hasBoundingPredicate(filter)) {
      return err(
        invalidInput(
          'mo publications list requires at least one of: actYear, issuerSlug, actId, moIssueId',
          'filter'
        )
      );
    }
    const kernel = kernelConditions(moPublicationsSpec, filter);
    if (kernel.isErr()) return err(kernel.error);
    const limit = clampLimit(page.first, MAX_LIST);
    const dir = sort === 'act_year_asc' ? ('asc' as const) : ('desc' as const);
    const sortKey = dir === 'asc' ? 'act_year_asc' : 'act_year_desc';
    const fhash = fhashFor(moPublicationsSpec, filter);

    const conds: RawBuilder<unknown>[] = [kernel.value];
    if (page.after !== undefined) {
      const decoded = decodeCursor(page.after, { sort: sortKey, dir, fhash });
      if (decoded.isErr()) return err(decoded.error);
      const cVal = decoded.value.keys[0] ?? '';
      const cKey = decoded.value.keys[1] ?? '';
      conds.push(publicationKeyset(cVal, cKey, dir));
    }
    const where = sql.join(conds, sql` and `);
    const orderBy =
      dir === 'asc'
        ? sql`order by p.act_year asc nulls last, p.mo_act_key asc`
        : sql`order by p.act_year desc nulls last, p.mo_act_key desc`;
    try {
      const result = await sql<MoActPublicationRow>`
        select
          p.mo_act_key, p.mo_issue_id, p.act_type, p.act_number_norm, p.act_year,
          p.issue_year, p.issuer_slug, p.title, p.act_date::text as act_date, p.act_id,
          p.resolution, p.matched_via, p.source_pdf_url,
          p.first_seen_at::text as first_seen_at, p.last_seen_at::text as last_seen_at
        from legal.mo_act_publications p
        where ${where}
        ${orderBy}
        limit ${limit + 1}
      `.execute(db);
      const items = result.rows.map((r) => mapPublication(r));
      return ok(
        toKeyedCursorPage(items, limit, sortKey, dir, fhash, (it) => [
          it.actYear === null ? '' : String(it.actYear),
          it.moActKey,
        ])
      );
    } catch (error) {
      return err(databaseError('listPublications failed', error));
    }
  };

  const getPublicationsForAct: MonitorulRepo['getPublicationsForAct'] = async (actId) => {
    if (!ID_RE.test(actId)) return ok([]);
    try {
      const rows = await selectPubs()
        .where('p.act_id', '=', actId)
        .orderBy('p.act_year', 'desc')
        .orderBy('p.mo_act_key', 'asc')
        .limit(200)
        .execute();
      return ok(mapPubRows(rows));
    } catch (error) {
      return err(databaseError('getPublicationsForAct failed', error));
    }
  };

  const getPublicationsForActs: MonitorulRepo['getPublicationsForActs'] = async (actIds) => {
    const ids = uniqueIds(actIds);
    if (ids.length === 0) return ok(new Map());
    try {
      const rows = await selectPubs()
        .where('p.act_id', 'in', ids)
        .orderBy('p.act_year', 'desc')
        .orderBy('p.mo_act_key', 'asc')
        .execute();
      const map = new Map<string, MoActPublication[]>();
      for (const r of rows) {
        const pub = mapPublication(r);
        if (pub.actId === null) continue;
        const list = map.get(pub.actId) ?? [];
        list.push(pub);
        map.set(pub.actId, list);
      }
      return ok(map);
    } catch (error) {
      return err(databaseError('getPublicationsForActs failed', error));
    }
  };

  const countPublicationsByIssuerYear: MonitorulRepo['countPublicationsByIssuerYear'] = async (
    input
  ) => {
    // `groupBy` is a closed enum → branch to a fixed grouping column (no sql.raw).
    const groupExpr =
      input.groupBy === 'act_type'
        ? sql`p.act_type`
        : input.groupBy === 'year'
          ? sql`p.act_year`
          : sql`p.issuer_slug`;
    const conds: RawBuilder<unknown>[] = [sql`p.issue_year = ${input.year}`];
    if (input.issuerSlug !== undefined && input.issuerSlug !== '') {
      conds.push(sql`p.issuer_slug = ${input.issuerSlug}`);
    }
    if (input.actType !== undefined && input.actType.length > 0) {
      conds.push(
        sql`p.act_type in (${sql.join(
          input.actType.map((t) => sql`${t}`),
          sql`, `
        )})`
      );
    }
    const where = sql.join(conds, sql` and `);
    try {
      // The grouped top-100 AND a SEPARATE total over the same filters, so the
      // denominator is exact even when groups exceed the cap (Codex #1).
      const [grouped, totalRow] = await Promise.all([
        sql<{ g: string | null; cnt: string }>`
          select ${groupExpr} as g, count(*) as cnt
          from legal.mo_act_publications p
          where ${where}
          group by g
          order by cnt desc
          limit 100
        `.execute(db),
        sql<{ total: string }>`
          select count(*) as total from legal.mo_act_publications p where ${where}
        `.execute(db),
      ]);
      const rows: MoIssuerYearCount[] = grouped.rows.map((r) => ({
        issuerSlug: input.groupBy === 'issuer' ? r.g : (input.issuerSlug ?? null),
        actType: input.groupBy === 'act_type' ? r.g : null,
        // `act_year` can be NULL → don't coerce to 0 (Codex #2).
        year: input.groupBy === 'year' ? (r.g === null ? null : Number(r.g)) : input.year,
        count: Number(r.cnt),
      }));
      const total = Number(totalRow.rows[0]?.total ?? 0);
      return ok({ rows, total });
    } catch (error) {
      return err(databaseError('countPublicationsByIssuerYear failed', error));
    }
  };

  // ── lifecycle / status ────────────────────────────────────────────────────────

  const getEdgesForSource: MonitorulRepo['getEdgesForSource'] = async (moActKey) => {
    if (moActKey === '') return ok([]);
    try {
      const rows = await selectEdges()
        .where('e.source_mo_act_key', '=', moActKey)
        .orderBy('e.edge_id', 'asc')
        .limit(200)
        .execute();
      return ok(mapEdgeRows(rows));
    } catch (error) {
      return err(databaseError('getEdgesForSource failed', error));
    }
  };

  const getEdgesForTargetAct: MonitorulRepo['getEdgesForTargetAct'] = async (actId) => {
    if (!ID_RE.test(actId)) return ok([]);
    try {
      const rows = await selectEdges()
        .where('e.target_act_id', '=', actId)
        .orderBy('e.edge_id', 'asc')
        .limit(200)
        .execute();
      return ok(mapEdgeRows(rows));
    } catch (error) {
      return err(databaseError('getEdgesForTargetAct failed', error));
    }
  };

  const getEdgesForTargetActs: MonitorulRepo['getEdgesForTargetActs'] = async (actIds) => {
    const ids = uniqueIds(actIds);
    if (ids.length === 0) return ok(new Map());
    try {
      const rows = await selectEdges()
        .where('e.target_act_id', 'in', ids)
        .orderBy('e.edge_id', 'asc')
        .execute();
      const map = new Map<string, MoLifecycleEdge[]>();
      for (const r of rows) {
        const edge = mapEdge(r);
        if (edge.targetActId === null) continue;
        const list = map.get(edge.targetActId) ?? [];
        list.push(edge);
        map.set(edge.targetActId, list);
      }
      return ok(map);
    } catch (error) {
      return err(databaseError('getEdgesForTargetActs failed', error));
    }
  };

  const listEdges: MonitorulRepo['listEdges'] = async (filter, page) => {
    const kernel = kernelConditions(moEdgesSpec, filter);
    if (kernel.isErr()) return err(kernel.error);
    const limit = clampLimit(page.first, MAX_LIST);
    const sortKey = 'edge_id';
    const dir = 'asc' as const;
    const fhash = fhashFor(moEdgesSpec, filter);
    const conds: RawBuilder<unknown>[] = [kernel.value];
    if (page.after !== undefined) {
      const decoded = decodeCursor(page.after, { sort: sortKey, dir, fhash });
      if (decoded.isErr()) return err(decoded.error);
      const cId = decoded.value.keys[0] ?? '0';
      conds.push(sql`e.edge_id > ${cId}::bigint`);
    }
    const where = sql.join(conds, sql` and `);
    try {
      const result = await sql<MoLifecycleEdgeRow>`
        select
          e.edge_id, e.source_mo_act_key, e.relation, e.target_raw, e.target_index,
          e.target_act_type, e.target_act_number, e.target_act_year, e.target_issuer_slug,
          e.target_act_id, e.target_mo_act_key, e.resolution, e.matched_via, e.method, e.confidence
        from legal.mo_lifecycle_edges e
        where ${where}
        order by e.edge_id asc
        limit ${limit + 1}
      `.execute(db);
      const items = result.rows.map((r) => mapEdge(r));
      return ok(toKeyedCursorPage(items, limit, sortKey, dir, fhash, (it) => it.edgeId));
    } catch (error) {
      return err(databaseError('listEdges failed', error));
    }
  };

  const getStatusEventsForAct: MonitorulRepo['getStatusEventsForAct'] = async (actId) => {
    if (!ID_RE.test(actId)) return ok([]);
    try {
      const rows = await selectStatusEvents()
        .where('s.act_id', '=', actId)
        .orderBy(sql`s.effective_date asc nulls last`)
        .orderBy('s.event_id', 'asc')
        .limit(200)
        .execute();
      return ok(mapStatusRows(rows as unknown as MoStatusEventRow[]));
    } catch (error) {
      return err(databaseError('getStatusEventsForAct failed', error));
    }
  };

  const getStatusEventsForActs: MonitorulRepo['getStatusEventsForActs'] = async (actIds) => {
    const ids = uniqueIds(actIds);
    if (ids.length === 0) return ok(new Map());
    try {
      const rows = (await selectStatusEvents()
        .where('s.act_id', 'in', ids)
        .orderBy(sql`s.effective_date asc nulls last`)
        .orderBy('s.event_id', 'asc')
        .execute()) as unknown as MoStatusEventRow[];
      const map = new Map<string, MoStatusEvent[]>();
      for (const r of rows) {
        const ev = mapStatusEvent(r);
        if (ev === null) continue;
        const list = map.get(ev.actId) ?? [];
        list.push(ev);
        map.set(ev.actId, list);
      }
      return ok(map);
    } catch (error) {
      return err(databaseError('getStatusEventsForActs failed', error));
    }
  };

  // ── coverage / discovery / contributor support ────────────────────────────────

  const getIssueYearRange: MonitorulRepo['getIssueYearRange'] = async () => {
    try {
      const row = await db
        .selectFrom('legal.mo_issues')
        .select([
          sql<number | null>`min(issue_year)`.as('mn'),
          sql<number | null>`max(issue_year)`.as('mx'),
        ])
        .executeTakeFirst();
      return ok({ min: row?.mn ?? null, max: row?.mx ?? null });
    } catch (error) {
      return err(databaseError('getIssueYearRange failed', error));
    }
  };

  const countPublicationsByPartForIssuer: MonitorulRepo['countPublicationsByPartForIssuer'] =
    async (issuerSlug) => {
      if (issuerSlug === '') return ok([]);
      try {
        const rows = await db
          .selectFrom('legal.mo_act_publications as p')
          .innerJoin('legal.mo_issues as i', 'i.mo_issue_id', 'p.mo_issue_id')
          .where('p.issuer_slug', '=', issuerSlug)
          .select(['i.part_code', sql<string>`count(*)`.as('cnt')])
          .groupBy('i.part_code')
          .orderBy(sql`cnt desc`)
          .execute();
        return ok(rows.map((r): MoPartCount => ({ partCode: r.part_code, count: Number(r.cnt) })));
      } catch (error) {
        return err(databaseError('countPublicationsByPartForIssuer failed', error));
      }
    };

  const getIssuerSummary: MonitorulRepo['getIssuerSummary'] = async (issuerSlug) => {
    if (issuerSlug === '') return ok(null);
    try {
      const agg = await db
        .selectFrom('legal.mo_act_publications as p')
        .where('p.issuer_slug', '=', issuerSlug)
        .select([
          sql<string>`count(*)`.as('cnt'),
          sql<string | null>`max(p.act_date)::text`.as('last_date'),
        ])
        .executeTakeFirst();
      const count = Number(agg?.cnt ?? 0);
      if (count === 0) return ok(null);

      const [byPartRes, topTypeRows] = await Promise.all([
        countPublicationsByPartForIssuer(issuerSlug),
        db
          .selectFrom('legal.mo_act_publications as p')
          .where('p.issuer_slug', '=', issuerSlug)
          .where('p.act_type', 'is not', null)
          .select(['p.act_type', sql<string>`count(*)`.as('cnt')])
          .groupBy('p.act_type')
          .orderBy(sql`cnt desc`)
          .limit(5)
          .execute(),
      ]);
      if (byPartRes.isErr()) return err(byPartRes.error);

      const summary: MoIssuerSummary = {
        issuerSlug,
        publicationCount: count,
        byPartCode: byPartRes.value,
        lastIssueDate: agg?.last_date ?? null,
        topActTypes: topTypeRows.map((r) => r.act_type).filter((t): t is string => t !== null),
        matchConfidence: 0.4, // best-effort; issuer-slug→org is name-matched, low-confidence
      };
      return ok(summary);
    } catch (error) {
      return err(databaseError('getIssuerSummary failed', error));
    }
  };

  const resolveIssuer: MonitorulRepo['resolveIssuer'] = async (q, limit) => {
    const trimmed = q.trim();
    if (trimmed === '') return ok([]);
    const folded = foldDiacritics(trimmed).toLowerCase();
    const capped = clampLimit(limit, 20);
    const pattern = `%${folded.replace(/[\\%_]/gu, (m) => `\\${m}`).replace(/\s+/gu, '%')}%`;
    try {
      // Distinct issuer_slug counts, name-matched on the folded slug (slugs are
      // already diacritics-folded hyphenated names; match the folded query).
      const rows = await db
        .selectFrom('legal.mo_act_publications as p')
        .where('p.issuer_slug', 'is not', null)
        .where('p.issuer_slug', '<>', '')
        .where(sql<boolean>`replace(p.issuer_slug, '-', ' ') ilike ${pattern} escape '\\'`)
        .select(['p.issuer_slug', sql<string>`count(*)`.as('cnt')])
        .groupBy('p.issuer_slug')
        .orderBy(sql`cnt desc`)
        .limit(capped)
        .execute();
      return ok(
        rows.map(
          (r): MoResolveHit => ({
            kind: 'mo_issuer',
            value: r.issuer_slug ?? '',
            label: (r.issuer_slug ?? '').replace(/-/gu, ' '),
            count: Number(r.cnt),
          })
        )
      );
    } catch (error) {
      return err(databaseError('resolveIssuer failed', error));
    }
  };

  const resolveActType: MonitorulRepo['resolveActType'] = async (q, limit) => {
    const trimmed = foldDiacritics(q.trim()).toLowerCase();
    const capped = clampLimit(limit, 20);
    try {
      let qb = db
        .selectFrom('legal.mo_act_publications as p')
        .where('p.act_type', 'is not', null)
        .select(['p.act_type', sql<string>`count(*)`.as('cnt')])
        .groupBy('p.act_type')
        .orderBy(sql`cnt desc`)
        .limit(capped);
      if (trimmed !== '') {
        const pattern = `%${trimmed.replace(/[\\%_]/gu, (m) => `\\${m}`)}%`;
        qb = qb.where(sql<boolean>`p.act_type ilike ${pattern} escape '\\'`);
      }
      const rows = await qb.execute();
      return ok(
        rows.map(
          (r): MoResolveHit => ({
            kind: 'mo_act_type',
            value: r.act_type ?? '',
            label: r.act_type ?? '',
            count: Number(r.cnt),
          })
        )
      );
    } catch (error) {
      return err(databaseError('resolveActType failed', error));
    }
  };

  return {
    getIssueById,
    findIssueByCoordinates,
    listIssues,
    getIssueContents,
    getPublicationByKey,
    listPublications,
    getPublicationsForAct,
    getPublicationsForActs,
    countPublicationsByIssuerYear,
    getEdgesForSource,
    getEdgesForTargetAct,
    getEdgesForTargetActs,
    listEdges,
    getStatusEventsForAct,
    getStatusEventsForActs,
    getIssueYearRange,
    getIssuerSummary,
    countPublicationsByPartForIssuer,
    resolveIssuer,
    resolveActType,
  };
};

// ── helpers ────────────────────────────────────────────────────────────────────

/** ≥1 bounding predicate present on the publications filter (§7). */
const hasBoundingPredicate = (filter: FilterInput): boolean => {
  const has = (k: string): boolean => {
    const v = filter[k] as Record<string, unknown> | undefined;
    return v !== undefined && typeof v === 'object' && Object.keys(v).length > 0;
  };
  return has('actYear') || has('issuerSlug') || has('actId') || has('moIssueId');
};

/** The keyset predicate for publications `(act_year <dir> nulls last, mo_act_key)`. */
const publicationKeyset = (
  cVal: string,
  cKey: string,
  dir: 'asc' | 'desc'
): RawBuilder<unknown> => {
  const cmp = dir === 'desc' ? sql`<` : sql`>`;
  if (cVal === '') {
    // already in the trailing NULL section: only the key tiebreak applies.
    return sql`(p.act_year is null and p.mo_act_key ${cmp} ${cKey})`;
  }
  const v = sql`${cVal}::int`;
  // nulls last in both dirs → the null section is reachable after a non-null cursor.
  return sql`(p.act_year ${cmp} ${v} or p.act_year is null or (p.act_year = ${v} and p.mo_act_key ${cmp} ${cKey}))`;
};

/** Build a keyed cursor page from `limit+1` items + a key extractor. */
const toKeyedCursorPage = <T>(
  rows: readonly T[],
  limit: number,
  sort: string,
  dir: 'asc' | 'desc',
  fhash: string,
  keysOf: (item: T) => string | readonly string[]
): CursorPage<T> => {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : [...rows];
  let next: string | null = null;
  if (hasMore && items.length > 0) {
    const last = items[items.length - 1] as T;
    const raw = keysOf(last);
    const lastKeys = Array.isArray(raw) ? raw : [raw as string];
    next = buildNextCursor({ sort, dir, fhash, lastKeys });
  }
  return { items, next };
};

// Re-export the part-code type for the contributor (slug→part breakdown).
export type { MoPartCode };
