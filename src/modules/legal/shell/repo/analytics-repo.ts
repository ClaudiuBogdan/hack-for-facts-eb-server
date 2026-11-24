/**
 * Legislation analytics: the reads of the published insights layer
 * (`legal_v2_analytics.insights_layer`, `insight_act`, `insight_link`; the
 * scrapper's migration 20261116T100020 and loader `analytics/insights/`).
 *
 * The read contract is the analytics release's (scrapper `analytics/api.ts`):
 * one READ ONLY, REPEATABLE READ transaction per request, the published
 * pointer read first inside it, the layer id bound to every statement, a
 * 15 s statement timeout. A view read first checks that the pointer still
 * names the layer the request was validated against; otherwise it answers
 * LAYER_CHANGED and runs nothing else.
 *
 * Every count is an exact integer (count(*)::int: a layer holds fewer than
 * 2^31 rows); no share is computed here. A weak placement is the bases the
 * layer's own `method.values.weak_bases` lists, bound as a parameter.
 *
 * The tables hold public acts only (the release reads public rows), but an
 * act can be restricted after a layer is built: every act this repo NAMES
 * (the acts list, the most-named targets) goes through `hydrate`, which reads
 * the current privacy gate; an act it does not return is not shown. Counts
 * are not re-gated: they name no act.
 *
 * Not deployed: a missing relation (42P01, 42703, 3F000) or an empty pointer
 * is ServiceUnavailable, so a server ahead of its database answers 503.
 * No secondary index is assumed: each statement reads the layer's rows once
 * (measured on a local copy of 227,202 acts: 50-75 ms; re-validate at scale).
 */

import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { sql, type Kysely, type RawBuilder } from 'kysely';
import { err, ok, type Result } from 'neverthrow';

import {
  databaseError,
  serviceUnavailable,
  timeoutError,
  type ApiError,
  type ProdDatabase,
} from '@/modules/shared/index.js';

import { encodeActsCursor } from '../../core/analytics/request.js';
import {
  UNCERTAIN,
  UNPLACED,
  type LegalAnalyticsActRef,
  type LegalAnalyticsActRow,
  type LegalAnalyticsActs,
  type LegalAnalyticsBreakdown,
  type LegalAnalyticsCount,
  type LegalAnalyticsData,
  type LegalAnalyticsDenominators,
  type LegalAnalyticsFilter,
  type LegalAnalyticsGrid,
  type LegalAnalyticsHead,
  type LegalAnalyticsLens,
  type LegalAnalyticsLinks,
  type LegalAnalyticsOrder,
  type LegalAnalyticsSeries,
  type LegalAnalyticsSummary,
} from '../../core/analytics/types.js';
import {
  LAYER_CHANGED,
  type LegalAnalyticsRepo,
  type LegalAnalyticsViewRequest,
} from '../../core/analytics/usecases.js';

type Db = Kysely<ProdDatabase>;

/** The acts a layer names, as the current privacy gate lets them be shown (absent = hidden). */
export type LegalAnalyticsHydrate = (
  actIds: readonly string[]
) => Promise<Result<ReadonlyMap<string, Omit<LegalAnalyticsActRef, 'actId'>>, ApiError>>;

export const ANALYTICS_STATEMENT_TIMEOUT_MS = 15_000;
/** How many targets per link kind the links view names. */
export const TOP_TARGETS = 30;
const GRID_ROWS = 10;
const GRID_COLS = 6;
/** The link kinds the acts list counts (design §11's link vocabulary). */
const AMENDS = 'amends';
const COURT_NAMES = 'court_names';

const ISO = (column: RawBuilder<unknown>) =>
  sql<string>`to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`;

// ───────────────────────────────────────────────────────── errors ──

const readError = (error: unknown): ApiError => {
  const code =
    typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
  if (code === '42P01' || code === '42703' || code === '3F000')
    return serviceUnavailable('Legislation analytics are not deployed on this database.');
  if (code === '57014' || code === '25P04')
    return timeoutError('Legislation analytics read timed out.');
  return databaseError('Legislation analytics read failed', error);
};

/** One read-only, repeatable-read transaction: every statement of a request shares a snapshot. */
const snapshot = async <T>(
  db: Db,
  read: (trx: Db) => Promise<Result<T, ApiError>>
): Promise<Result<T, ApiError>> => {
  try {
    return await db
      .transaction()
      .setIsolationLevel('repeatable read')
      .setAccessMode('read only')
      .execute(async (trx) => {
        await sql`set local statement_timeout = ${sql.lit(ANALYTICS_STATEMENT_TIMEOUT_MS)}`.execute(
          trx
        );
        return read(trx);
      });
  } catch (error) {
    return err(readError(error));
  }
};

// ─────────────────────────────────────────────────────────── head ──

const ValuesSchema = Type.Object({
  felul_groups: Type.Array(Type.String()),
  felul_kinds: Type.Record(Type.String(), Type.String()),
  stock_kinds: Type.Array(Type.String()),
  weak_bases: Type.Array(Type.String()),
  issuer_families: Type.Array(Type.String()),
  link_kinds: Type.Array(Type.String()),
  link_notes: Type.Array(Type.String()),
});
const RulesSchema = Type.Record(Type.String(), Type.String());

interface HeadRow {
  layer_id: string;
  release_id: string;
  built_at: string;
  published_at: string;
  release_built_at: string;
  release_published_at: string;
  rules: unknown;
  vals: unknown;
}

const readPointer = async (trx: Db): Promise<string | null> => {
  const { rows } = await sql<{ layer_id: string }>`
    select layer_id::text as layer_id from legal_v2_analytics.current_insights_layer where singleton
  `.execute(trx);
  return rows[0]?.layer_id ?? null;
};

const readHeadIn = async (trx: Db): Promise<Result<LegalAnalyticsHead, ApiError>> => {
  const { rows } = await sql<HeadRow>`
    select l.layer_id::text as layer_id, l.release_id::text as release_id,
           ${ISO(sql`l.built_at`)} as built_at, ${ISO(sql`l.published_at`)} as published_at,
           ${ISO(sql`r.built_at`)} as release_built_at, ${ISO(sql`r.published_at`)} as release_published_at,
           l.method -> 'rules' as rules, l.method -> 'values' as vals
      from legal_v2_analytics.current_insights_layer p
      join legal_v2_analytics.insights_layer l on l.layer_id = p.layer_id
      join legal_v2_analytics.release r on r.release_id = l.release_id
     where p.singleton and l.published_at is not null
  `.execute(trx);
  const row = rows[0];
  if (row === undefined)
    return err(serviceUnavailable('No legislation analytics layer is published.'));
  if (!Value.Check(ValuesSchema, row.vals) || !Value.Check(RulesSchema, row.rules))
    return err(databaseError('The published analytics layer carries malformed value lists.'));
  const v: Static<typeof ValuesSchema> = row.vals;
  const layerId = row.layer_id;

  const totals = await sql<{
    acts: number;
    with_text: number;
    in_stock: number;
    uncertain: number;
    unplaced: number;
    min_year: number | null;
    max_year: number | null;
  }>`
    select count(*)::int as acts, (count(*) filter (where has_text))::int as with_text,
           (count(*) filter (where in_stock))::int as in_stock,
           (count(*) filter (where felul_basis = any(${v.weak_bases}::text[])))::int as uncertain,
           (count(*) filter (where felul_group = ${UNPLACED}))::int as unplaced,
           min(year)::int as min_year, max(year)::int as max_year
      from legal_v2_analytics.insight_act where layer_id = ${layerId}::bigint
  `.execute(trx);
  const types = await sql<{ key: string; acts: number }>`
    select type_normal as key, count(*)::int as acts from legal_v2_analytics.insight_act
     where layer_id = ${layerId}::bigint group by 1 order by 2 desc, 1
  `.execute(trx);
  const issuers = await sql<{ lineage: string; family: string; acts: number }>`
    select issuer_lineage as lineage, issuer_family as family, count(*)::int as acts
      from legal_v2_analytics.insight_act
     where layer_id = ${layerId}::bigint and issuer_lineage is not null
     group by 1, 2 order by 3 desc, 1, 2
  `.execute(trx);
  const t = totals.rows[0];
  if (t === undefined) return err(databaseError('The analytics totals read returned no row.'));
  return ok({
    layer: {
      layerId,
      releaseId: row.release_id,
      builtAt: row.built_at,
      publishedAt: row.published_at,
      releaseBuiltAt: row.release_built_at,
      releasePublishedAt: row.release_published_at,
    },
    rules: row.rules,
    values: {
      felulGroups: v.felul_groups,
      felulKinds: v.felul_kinds,
      stockKinds: v.stock_kinds,
      weakBases: v.weak_bases,
      issuerFamilies: v.issuer_families,
      linkKinds: v.link_kinds,
      linkNotes: v.link_notes,
    },
    totals: {
      acts: t.acts,
      actsWithText: t.with_text,
      inStock: t.in_stock,
      uncertain: t.uncertain,
      unplaced: t.unplaced,
    },
    types: types.rows,
    issuerCount: issuers.rows.length,
    issuers: issuers.rows,
    years: { min: t.min_year, max: t.max_year },
  });
};

// ───────────────────────────────────────────────────────── filter ──

/** The Felul class: the group of a firm placement, `uncertain` for a weak one. */
const classSql = (weak: readonly string[]) =>
  sql<string>`case when a.felul_basis = any(${weak}::text[]) then ${UNCERTAIN} else a.felul_group end`;

const lensSql = (lens: LegalAnalyticsLens, weak: readonly string[]): RawBuilder<string | null> => {
  switch (lens) {
    case 'felul':
      return classSql(weak);
    case 'kind':
      return sql`case when a.felul_basis = any(${weak}::text[]) then ${UNCERTAIN} else a.felul_kind end`;
    case 'issuer':
      return sql`a.issuer_lineage`;
    case 'family':
      return sql`a.issuer_family`;
    case 'type':
      return sql`a.type_normal`;
    case 'versions':
      return sql`a.version_band::text`;
    case 'year':
      return sql`a.year::text`;
  }
};

/** The selection: the layer's acts under the filter. A group or kind matches firm placements only. */
const whereSql = (layerId: string, f: LegalAnalyticsFilter, head: LegalAnalyticsHead) => {
  const weak = head.values.weakBases;
  const parts: RawBuilder<unknown>[] = [sql`a.layer_id = ${layerId}::bigint`];
  if (f.population === 'stock') parts.push(sql`a.in_stock`);
  if (f.from !== null) parts.push(sql`a.year >= ${f.from}`);
  if (f.to !== null) parts.push(sql`a.year <= ${f.to}`);
  if (f.types.length > 0) parts.push(sql`a.type_normal = any(${f.types}::text[])`);
  if (f.issuer !== null) parts.push(sql`a.issuer_lineage = ${f.issuer}`);
  if (f.family !== null) parts.push(sql`a.issuer_family = ${f.family}`);
  if (f.felul === UNCERTAIN) parts.push(sql`a.felul_basis = any(${weak}::text[])`);
  else if (f.felul !== null) {
    const column = head.values.felulGroups.includes(f.felul)
      ? sql`a.felul_group`
      : sql`a.felul_kind`;
    parts.push(sql`${column} = ${f.felul} and not (a.felul_basis = any(${weak}::text[]))`);
  }
  if (f.versions !== null) parts.push(sql`a.version_band = ${f.versions}`);
  return sql.join(parts, sql` and `);
};

const denominators = async (
  trx: Db,
  layerId: string,
  f: LegalAnalyticsFilter,
  head: LegalAnalyticsHead
) => {
  const { rows } = await sql<{
    total: number;
    uncertain: number;
    unplaced: number;
    with_text: number;
    with_versions: number;
  }>`
    select count(*)::int as total,
           (count(*) filter (where a.felul_basis = any(${head.values.weakBases}::text[])))::int as uncertain,
           (count(*) filter (where a.felul_group = ${UNPLACED}))::int as unplaced,
           (count(*) filter (where a.has_text))::int as with_text,
           (count(*) filter (where a.version_band > 0))::int as with_versions
      from legal_v2_analytics.insight_act a where ${whereSql(layerId, f, head)}
  `.execute(trx);
  const r = rows[0] ?? { total: 0, uncertain: 0, unplaced: 0, with_text: 0, with_versions: 0 };
  const base: LegalAnalyticsDenominators = {
    total: r.total,
    population: f.population === 'stock' ? head.totals.inStock : head.totals.acts,
    uncertain: r.uncertain,
    unplaced: r.unplaced,
  };
  return { base, withText: r.with_text, withVersions: r.with_versions };
};

// ────────────────────────────────────────────────────────── views ──

const ranked = async (
  trx: Db,
  layerId: string,
  f: LegalAnalyticsFilter,
  head: LegalAnalyticsHead,
  lens: LegalAnalyticsLens,
  limit: number
): Promise<LegalAnalyticsCount[]> => {
  const { rows } = await sql<{ key: string | null; acts: number }>`
    select ${lensSql(lens, head.values.weakBases)} as key, count(*)::int as acts
      from legal_v2_analytics.insight_act a where ${whereSql(layerId, f, head)}
     group by 1 order by 2 desc, 1 asc nulls last limit ${limit}
  `.execute(trx);
  return rows;
};

const summary = async (
  trx: Db,
  layerId: string,
  f: LegalAnalyticsFilter,
  head: LegalAnalyticsHead
): Promise<LegalAnalyticsSummary> => {
  const d = await denominators(trx, layerId, f, head);
  const felul = await ranked(trx, layerId, f, head, 'felul', 100);
  return { ...d.base, withText: d.withText, withVersions: d.withVersions, felul };
};

const breakdown = async (
  trx: Db,
  layerId: string,
  f: LegalAnalyticsFilter,
  head: LegalAnalyticsHead,
  lens: LegalAnalyticsLens,
  limit: number
): Promise<LegalAnalyticsBreakdown> => {
  const d = await denominators(trx, layerId, f, head);
  const rows = await ranked(trx, layerId, f, head, lens, limit + 1);
  const served = rows.slice(0, limit);
  const sum = served.reduce((s, r) => s + r.acts, 0);
  return {
    ...d.base,
    lens,
    rows: served,
    rest: d.base.total - sum,
    truncated: rows.length > limit,
  };
};

const series = async (
  trx: Db,
  layerId: string,
  f: LegalAnalyticsFilter,
  head: LegalAnalyticsHead,
  lens: LegalAnalyticsLens,
  top: number
): Promise<LegalAnalyticsSeries> => {
  const d = await denominators(trx, layerId, f, head);
  const keys = (await ranked(trx, layerId, f, head, lens, top)).map((r) => r.key);
  const expr = lensSql(lens, head.values.weakBases);
  const { rows } = await sql<{ year: number | null; rank: number | null; acts: number }>`
    with top as (select k.key, k.rank from unnest(${keys}::text[]) with ordinality as k(key, rank))
    select a.year::int as year, (min(t.rank) - 1)::int as rank, count(*)::int as acts
      from legal_v2_analytics.insight_act a
      left join top t on t.key is not distinct from ${expr}
     where ${whereSql(layerId, f, head)}
     group by a.year, t.rank order by 1, 2
  `.execute(trx);
  const byYear = new Map<number, number[]>();
  let unknownYear = 0;
  for (const r of rows) {
    if (r.year === null) {
      unknownYear += r.acts;
      continue;
    }
    const values = byYear.get(r.year) ?? new Array<number>(keys.length + 1).fill(0);
    const slot = r.rank ?? keys.length;
    values[slot] = (values[slot] ?? 0) + r.acts;
    byYear.set(r.year, values);
  }
  return {
    ...d.base,
    lens,
    keys,
    years: [...byYear.entries()].sort(([a], [b]) => a - b).map(([year, acts]) => ({ year, acts })),
    restKey: true,
    unknownYear,
  };
};

const grid = async (
  trx: Db,
  layerId: string,
  f: LegalAnalyticsFilter,
  head: LegalAnalyticsHead,
  lens: LegalAnalyticsLens,
  by: LegalAnalyticsLens
): Promise<LegalAnalyticsGrid> => {
  const d = await denominators(trx, layerId, f, head);
  const rowList = await ranked(trx, layerId, f, head, lens, GRID_ROWS);
  const colList = await ranked(trx, layerId, f, head, by, GRID_COLS);
  const weak = head.values.weakBases;
  const { rows } = await sql<{ r: number; c: number | null; acts: number }>`
    with r as (select k.key, k.rank from unnest(${rowList.map((x) => x.key)}::text[]) with ordinality as k(key, rank)),
         c as (select k.key, k.rank from unnest(${colList.map((x) => x.key)}::text[]) with ordinality as k(key, rank))
    select (rr.rank - 1)::int as r, (min(cc.rank) - 1)::int as c, count(*)::int as acts
      from legal_v2_analytics.insight_act a
      join r rr on rr.key is not distinct from ${lensSql(lens, weak)}
      left join c cc on cc.key is not distinct from ${lensSql(by, weak)}
     where ${whereSql(layerId, f, head)}
     group by rr.rank, cc.rank
  `.execute(trx);
  const cells = rowList.map(() => new Array<number>(colList.length + 1).fill(0));
  for (const x of rows) {
    const line = cells[x.r];
    if (line === undefined) continue;
    const slot = x.c ?? colList.length;
    line[slot] = (line[slot] ?? 0) + x.acts;
  }
  return { ...d.base, lens, by, rows: rowList, cols: colList, cells };
};

const linkFrom = sql`legal_v2_analytics.insight_link l
  join legal_v2_analytics.insight_act a on a.layer_id = l.layer_id and a.act_id = l.source_act`;

const links = async (
  trx: Db,
  layerId: string,
  f: LegalAnalyticsFilter,
  head: LegalAnalyticsHead,
  hydrate: LegalAnalyticsHydrate
): Promise<Result<LegalAnalyticsLinks, ApiError>> => {
  const d = await denominators(trx, layerId, f, head);
  const where = whereSql(layerId, f, head);
  const byKind = await sql<{ kind: string; note: string; links: number }>`
    select l.kind, l.target_note as note, count(*)::int as links from ${linkFrom}
     where ${where} group by 1, 2 order by 1, 2
  `.execute(trx);
  const amends = await sql<{ sourceBand: string; target: string; links: number }>`
    select a.type_band as "sourceBand", coalesce(t.type_band, l.target_note) as target, count(*)::int as links
      from ${linkFrom}
      left join legal_v2_analytics.insight_act t on t.layer_id = l.layer_id and t.act_id = l.target_act
     where ${where} and l.kind = ${AMENDS}
     group by 1, 2 order by 3 desc, 1, 2
  `.execute(trx);
  const top = await sql<{ kind: string; target_act: string; links: number }>`
    select kind, target_act, links from (
      select l.kind, l.target_act::text as target_act, count(*)::int as links,
             row_number() over (partition by l.kind order by count(*) desc, l.target_act) as rk
        from ${linkFrom}
       where ${where} and l.target_act is not null
       group by l.kind, l.target_act) x
     where rk <= ${TOP_TARGETS} order by kind, links desc, target_act
  `.execute(trx);
  const days = await sql<{ kind: string; links: number; q: number[] | null }>`
    select l.kind, count(*)::int as links,
           percentile_disc(array[0.25, 0.5, 0.75]) within group (order by a.first_publication - t.first_publication) as q
      from ${linkFrom}
      join legal_v2_analytics.insight_act t on t.layer_id = l.layer_id and t.act_id = l.target_act
     where ${where} and a.first_publication is not null and t.first_publication is not null
     group by 1 order by 1
  `.execute(trx);
  const shown = await hydrate(top.rows.map((r) => r.target_act));
  if (shown.isErr()) return err(shown.error);
  const topTargets = top.rows.flatMap((r) => {
    const act = shown.value.get(r.target_act);
    return act === undefined
      ? []
      : [{ kind: r.kind, target: { actId: r.target_act, ...act }, links: r.links }];
  });
  return ok({
    ...d.base,
    byKind: byKind.rows,
    amends: amends.rows,
    topTargets,
    days: days.rows.map((r) => ({
      kind: r.kind,
      links: r.links,
      p25: r.q?.[0] ?? null,
      median: r.q?.[1] ?? null,
      p75: r.q?.[2] ?? null,
    })),
  });
};

const ORDER_SQL: Readonly<Record<LegalAnalyticsOrder, RawBuilder<number>>> = {
  amended: sql`coalesce(am.n, 0)`,
  court: sql`coalesce(cc.n, 0)`,
  versions: sql`a.consolidations`,
  cited: sql`a.cited_by`,
  year: sql`coalesce(a.year::int, -1)`,
};

interface ActRow {
  act_id: string;
  year: number | null;
  type_normal: string;
  issuer_lineage: string | null;
  issuer_family: string;
  felul_group: string;
  felul_kind: string;
  weak: boolean;
  amended: number;
  court: number;
  consolidations: number;
  cited_by: number;
  has_text: boolean;
  v: number;
}

const acts = async (
  trx: Db,
  layerId: string,
  request: Extract<LegalAnalyticsViewRequest, { view: 'acts' }>,
  head: LegalAnalyticsHead,
  hydrate: LegalAnalyticsHydrate
): Promise<Result<LegalAnalyticsActs, ApiError>> => {
  const f = request.filter;
  const d = await denominators(trx, layerId, f, head);
  const v = ORDER_SQL[request.order];
  const after =
    request.after === null
      ? sql`true`
      : sql`(${v}, a.act_id) < (${request.after.value}, ${request.after.actId}::bigint)`;
  const { rows } = await sql<ActRow>`
    with am as (select target_act, count(*)::int as n from legal_v2_analytics.insight_link
                 where layer_id = ${layerId}::bigint and kind = ${AMENDS} and target_act is not null group by 1),
         cc as (select target_act, count(*)::int as n from legal_v2_analytics.insight_link
                 where layer_id = ${layerId}::bigint and kind = ${COURT_NAMES} and target_act is not null group by 1)
    select a.act_id::text as act_id, a.year::int as year, a.type_normal, a.issuer_lineage, a.issuer_family,
           a.felul_group, a.felul_kind, a.felul_basis = any(${head.values.weakBases}::text[]) as weak,
           coalesce(am.n, 0) as amended, coalesce(cc.n, 0) as court, a.consolidations, a.cited_by, a.has_text,
           ${v}::int as v
      from legal_v2_analytics.insight_act a
      left join am on am.target_act = a.act_id
      left join cc on cc.target_act = a.act_id
     where ${whereSql(layerId, f, head)} and ${after}
     order by ${v} desc, a.act_id desc
     limit ${request.limit + 1}
  `.execute(trx);
  const page = rows.slice(0, request.limit);
  const last = page.at(-1);
  const next =
    rows.length > request.limit && last !== undefined
      ? encodeActsCursor(layerId, request.key, { value: last.v, actId: last.act_id })
      : null;
  const shown = await hydrate(page.map((r) => r.act_id));
  if (shown.isErr()) return err(shown.error);
  const out: LegalAnalyticsActRow[] = [];
  for (const r of page) {
    const act = shown.value.get(r.act_id);
    if (act === undefined) continue;
    out.push({
      actId: r.act_id,
      ...act,
      year: r.year,
      type: r.type_normal,
      issuer: r.issuer_lineage,
      family: r.issuer_family,
      felul: r.weak ? UNCERTAIN : r.felul_group,
      kind: r.weak ? UNCERTAIN : r.felul_kind,
      guess: r.weak ? { group: r.felul_group, kind: r.felul_kind } : null,
      amended: r.amended,
      court: r.court,
      versions: r.consolidations,
      cited: r.cited_by,
      hasText: r.has_text,
    });
  }
  return ok({
    ...d.base,
    order: request.order,
    rows: out,
    hidden: page.length - out.length,
    next,
  });
};

// ─────────────────────────────────────────────────────────── repo ──

export interface MakeLegalAnalyticsRepoDeps {
  readonly db: Db;
  readonly hydrate: LegalAnalyticsHydrate;
}

export const makeLegalAnalyticsRepo = (deps: MakeLegalAnalyticsRepoDeps): LegalAnalyticsRepo => ({
  readHead: () => snapshot(deps.db, readHeadIn),
  read: (request, head) =>
    snapshot(
      deps.db,
      async (trx): Promise<Result<LegalAnalyticsData | typeof LAYER_CHANGED, ApiError>> => {
        const layerId = head.layer.layerId;
        if ((await readPointer(trx)) !== layerId) return ok(LAYER_CHANGED);
        switch (request.view) {
          case 'summary':
            return ok(await summary(trx, layerId, request.filter, head));
          case 'breakdown':
            return ok(
              await breakdown(trx, layerId, request.filter, head, request.lens, request.limit)
            );
          case 'series':
            return ok(await series(trx, layerId, request.filter, head, request.lens, request.top));
          case 'grid':
            return ok(await grid(trx, layerId, request.filter, head, request.lens, request.by));
          case 'links':
            return links(trx, layerId, request.filter, head, deps.hydrate);
          case 'acts':
            return acts(trx, layerId, request, head, deps.hydrate);
        }
      }
    ),
});
