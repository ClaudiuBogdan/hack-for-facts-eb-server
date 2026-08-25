/**
 * Shared Kernel — Flows repo (foundation §4.3, §14.6).
 *
 * The ONLY repo that reads `flows.money_flows`. Authoritative for the unified
 * entity-360 flow summary / counterparty network / cross-source totals (the
 * grain gate, §14.6) — source-native top-N/HHI stays in source modules.
 *
 * Money amounts are returned as strings (numeric → string), never floats.
 * Bigint ids are strings. List uses the kernel cursor envelope keyed on
 * (flow_date, flow_id); the `fhash` binds the cursor to the active filter set.
 */

import { sql, type Kysely } from 'kysely';
import { err, ok, type Result } from 'neverthrow';

import { databaseError, invalidInput, type ApiError } from '../../core/errors.js';
import { filterHash } from '../../core/filters/derive.js';
import { buildNextCursor, decodeCursor, type CursorPage } from '../../core/pagination.js';
import { isPlaceholderName } from '../../core/usecases/organization-labels.js';

import type { FlowListOptions, FlowsRepo } from '../../core/ports.js';
import type {
  Counterparty,
  CounterpartyNetwork,
  FlowAggregateGroup,
  FlowDirection,
  FlowSummary,
  FlowTypeBreakdown,
  FlowYearBreakdown,
  MoneyFlow,
  NetworkEdge,
  NetworkNode,
} from '../../core/types.js';
import type { ProdDatabase } from '../db/types.js';

type Db = Kysely<ProdDatabase>;

const cuiColumnFor = (direction: FlowDirection): 'payer_cui' | 'payee_cui' =>
  direction === 'in' ? 'payee_cui' : 'payer_cui';

/** Stable filter hash for a flow list query (binds the cursor — §14.3). */
const flowFhash = (cui: string, o: FlowListOptions): string =>
  filterHash(
    JSON.stringify({
      cui,
      dir: o.direction,
      ft: o.flowType ?? null,
      yf: o.yearFrom ?? null,
      yt: o.yearTo ?? null,
    })
  );

export const makeFlowsRepo = (db: Db): FlowsRepo => ({
  async getFlowSummary(
    cui: string,
    direction: FlowDirection,
    includeYearBreakdown = false
  ): Promise<Result<FlowSummary, ApiError>> {
    const col = cuiColumnFor(direction);
    try {
      // The per-(year, flow_type) breakdown is an EXTRA aggregate over money_flows;
      // only run it when a caller needs it (Company.publicMoney). The entity-360 hot
      // path exposes only byFlowType, so it leaves this off and gets an empty byYear.
      const yearBreakdownQuery = includeYearBreakdown
        ? db
            .selectFrom('flows.money_flows')
            .select([
              'flow_year',
              'flow_type',
              sql<string>`count(*)`.as('count'),
              sql<string>`coalesce(sum(amount_ron), 0)`.as('total'),
            ])
            .where(col, '=', cui)
            .groupBy(['flow_year', 'flow_type'])
            .orderBy(sql`flow_year desc nulls last`)
            .orderBy(sql`sum(amount_ron) desc nulls last`)
            .execute()
        : Promise.resolve([]);

      const [summary, breakdown, yearBreakdown] = await Promise.all([
        db
          .selectFrom('flows.money_flows')
          .select([
            sql<string>`count(*)`.as('count'),
            sql<string>`coalesce(sum(amount_ron), 0)`.as('total'),
            sql<number | null>`min(flow_year)`.as('min_year'),
            sql<number | null>`max(flow_year)`.as('max_year'),
          ])
          .where(col, '=', cui)
          .executeTakeFirst(),
        db
          .selectFrom('flows.money_flows')
          .select([
            'flow_type',
            sql<string>`count(*)`.as('count'),
            sql<string>`coalesce(sum(amount_ron), 0)`.as('total'),
          ])
          .where(col, '=', cui)
          .groupBy('flow_type')
          .execute(),
        yearBreakdownQuery,
      ]);

      const byFlowType: FlowTypeBreakdown[] = breakdown.map((r) => ({
        flowType: r.flow_type,
        count: Number(r.count),
        totalAmountRon: r.total,
      }));

      const byYear: FlowYearBreakdown[] = yearBreakdown.map((r) => ({
        year: r.flow_year,
        flowType: r.flow_type,
        count: Number(r.count),
        totalAmountRon: r.total,
      }));

      return ok({
        direction,
        count: Number(summary?.count ?? 0),
        totalAmountRon: summary?.total ?? '0',
        minYear: summary?.min_year ?? null,
        maxYear: summary?.max_year ?? null,
        byFlowType,
        byYear,
      });
    } catch (error) {
      return err(databaseError('getFlowSummary failed', error));
    }
  },

  async getTopCounterparties(
    cui: string,
    direction: FlowDirection,
    limit: number
  ): Promise<Result<readonly Counterparty[], ApiError>> {
    const self = cuiColumnFor(direction);
    const cp = self === 'payee_cui' ? 'payer_cui' : 'payee_cui';
    const cpName = cp === 'payer_cui' ? 'payer_name' : 'payee_name';
    const cappedLimit = Math.min(Math.max(limit, 1), 100);
    try {
      const rows = await db
        .selectFrom('flows.money_flows')
        .select([
          sql.ref(cp).as('cp_cui'),
          sql<string | null>`max(${sql.ref(cpName)})`.as('cp_name'),
          sql<string>`coalesce(sum(amount_ron), 0)`.as('total'),
          sql<string>`count(*)`.as('flow_count'),
        ])
        .where(self, '=', cui)
        .where(cp, 'is not', null)
        .groupBy(cp)
        .orderBy(sql`sum(amount_ron) desc nulls last`)
        .limit(cappedLimit)
        .execute();

      // M2: the flows-side counterparty name is whatever the source contract spelled
      // (diacritics dropped, `RO`+CUI prefixes, old abbreviations). Overlay the
      // canonical `core.organizations.name` when the counterparty CUI is a known org
      // (any kind — many payers are public entities), keeping the flows-side name as
      // a fallback. Bounded by the ≤100 top-N, so it's one small extra lookup.
      const cpCuis = rows.map((r) => r.cp_cui).filter((c): c is string => c !== null);
      const canonicalName = new Map<string, string>();
      if (cpCuis.length > 0) {
        const orgs = await db
          .selectFrom('core.organizations')
          .select(['cui', 'name'])
          .where('cui', 'in', cpCuis)
          .execute();
        // 23,093 `kind='unknown'` rows are minted placeholders whose name IS the
        // CUI (measured 2026-08-25) — overlaying one DEGRADES a real flows-side
        // name into a bare number. Same predicate as the kernel labels path.
        for (const o of orgs)
          if (o.cui !== null && !isPlaceholderName(o.name, o.cui)) canonicalName.set(o.cui, o.name);
      }

      return ok(
        rows.map((r) => ({
          cui: r.cp_cui as string,
          name: canonicalName.get(r.cp_cui as string) ?? r.cp_name,
          totalAmountRon: r.total,
          flowCount: Number(r.flow_count),
        }))
      );
    } catch (error) {
      return err(databaseError('getTopCounterparties failed', error));
    }
  },

  async listFlows(
    cui: string,
    options: FlowListOptions
  ): Promise<Result<CursorPage<MoneyFlow>, ApiError>> {
    const col = cuiColumnFor(options.direction);
    const limit = Math.min(Math.max(options.limit, 1), 500);
    const fhash = flowFhash(cui, options);

    // Decode + validate the cursor against the active filter set at this
    // boundary (rejects filter-mismatched cursors — §14.3).
    let cursorKeys: readonly string[] | undefined;
    if (options.cursor !== undefined) {
      const decoded = decodeCursor(options.cursor, { sort: 'flow_date', dir: 'desc', fhash });
      if (decoded.isErr()) return err(decoded.error);
      cursorKeys = decoded.value.keys;
    }

    try {
      let query = db.selectFrom('flows.money_flows').where(col, '=', cui);
      if (options.flowType !== undefined) query = query.where('flow_type', '=', options.flowType);
      if (options.yearFrom !== undefined) query = query.where('flow_year', '>=', options.yearFrom);
      if (options.yearTo !== undefined) query = query.where('flow_year', '<=', options.yearTo);

      // Keyset on (flow_date desc nulls last, flow_id desc). flow_id is bigint:
      // compare as ::bigint (NOT lexicographic text). The next-cursor encoder
      // coalesces a null last-date to a sentinel, so cDate is always a real date
      // here for the non-null page; the trailing null-date rows are reached only
      // after the non-null pages are exhausted.
      if (cursorKeys?.length === 2) {
        const cDate = cursorKeys[0] ?? '';
        const cId = cursorKeys[1] ?? '';
        if (cDate === '' || !/^\d+$/u.test(cId)) {
          return err(invalidInput('malformed cursor; restart pagination', 'cursor'));
        }
        query = query.where(
          sql<boolean>`(flow_date < ${cDate}::date or (flow_date = ${cDate}::date and flow_id < ${cId}::bigint))`
        );
      }

      const rows = await query
        .select([
          'flow_id',
          'flow_type',
          'source_id',
          'source_ref',
          'payer_cui',
          'payer_name',
          'payer_org_id',
          'payee_cui',
          'payee_name',
          'payee_org_id',
          'amount_ron',
          'amount_eur',
          'currency',
          'flow_date',
          'flow_year',
          'title',
          'classification_system',
          'classification_code',
          'county_name',
        ])
        .orderBy(sql`flow_date desc nulls last`)
        .orderBy('flow_id', 'desc')
        .limit(limit + 1)
        .execute();

      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;

      const items: MoneyFlow[] = page.map((r) => ({
        flowId: r.flow_id,
        flowType: r.flow_type,
        sourceId: r.source_id,
        sourceRef: r.source_ref,
        payerCui: r.payer_cui,
        payerName: r.payer_name,
        payerOrgId: r.payer_org_id,
        payeeCui: r.payee_cui,
        payeeName: r.payee_name,
        payeeOrgId: r.payee_org_id,
        amountRon: r.amount_ron,
        amountEur: r.amount_eur,
        currency: r.currency,
        flowDate: r.flow_date,
        flowYear: r.flow_year,
        title: r.title,
        classificationSystem: r.classification_system,
        classificationCode: r.classification_code,
        countyName: r.county_name,
      }));

      let next: string | null = null;
      if (hasMore) {
        const last = page[page.length - 1];
        if (last !== undefined) {
          next = buildNextCursor({
            sort: 'flow_date',
            dir: 'desc',
            fhash,
            lastKeys: [last.flow_date ?? '1900-01-01', last.flow_id],
          });
        }
      }

      return ok({ items, next });
    } catch (error) {
      return err(databaseError('listFlows failed', error));
    }
  },

  async getCounterpartyNetwork(
    rootCui: string,
    depth: number,
    nodeLimit: number
  ): Promise<Result<CounterpartyNetwork, ApiError>> {
    const effectiveDepth = Math.min(Math.max(depth, 1), 2);
    const effectiveNodeLimit = Math.min(Math.max(nodeLimit, 1), 50);

    const directRows = async (cui: string, perSide: number) =>
      db
        .selectFrom('flows.money_flows')
        .select([
          'payee_cui as cp_cui',
          sql<string | null>`max(payee_name)`.as('cp_name'),
          sql<string>`'out'`.as('direction'),
          sql<string>`coalesce(sum(amount_ron), 0)`.as('total'),
          sql<string>`count(*)`.as('flow_count'),
        ])
        .where('payer_cui', '=', cui)
        .where('payee_cui', 'is not', null)
        .groupBy('payee_cui')
        .orderBy(sql`sum(amount_ron) desc nulls last`)
        .limit(perSide)
        .unionAll(
          db
            .selectFrom('flows.money_flows')
            .select([
              'payer_cui as cp_cui',
              sql<string | null>`max(payer_name)`.as('cp_name'),
              sql<string>`'in'`.as('direction'),
              sql<string>`coalesce(sum(amount_ron), 0)`.as('total'),
              sql<string>`count(*)`.as('flow_count'),
            ])
            .where('payee_cui', '=', cui)
            .where('payer_cui', 'is not', null)
            .groupBy('payer_cui')
            .orderBy(sql`sum(amount_ron) desc nulls last`)
            .limit(perSide)
        )
        .execute();

    try {
      const nodes = new Map<string, NetworkNode>();
      const edges: NetworkEdge[] = [];

      const rootOrg = await db
        .selectFrom('core.organizations')
        .select(['name'])
        .where('cui', '=', rootCui)
        .limit(1)
        .executeTakeFirst();
      nodes.set(rootCui, {
        cui: rootCui,
        name: rootOrg?.name ?? rootCui,
        totalIn: '0',
        totalOut: '0',
      });

      const addEdge = (from: string, to: string, amount: string, count: number): void => {
        edges.push({ payerCui: from, payeeCui: to, totalAmount: amount, flowCount: count });
      };

      for (const row of await directRows(rootCui, effectiveNodeLimit)) {
        const cpCui = row.cp_cui;
        if (cpCui === null) continue;
        if (!nodes.has(cpCui)) {
          nodes.set(cpCui, {
            cui: cpCui,
            name: row.cp_name ?? cpCui,
            totalIn: '0',
            totalOut: '0',
          });
        }
        if (row.direction === 'out') addEdge(rootCui, cpCui, row.total, Number(row.flow_count));
        else addEdge(cpCui, rootCui, row.total, Number(row.flow_count));
      }

      if (effectiveDepth >= 2) {
        const depth1 = [...nodes.keys()].filter((c) => c !== rootCui);
        for (const d1 of depth1) {
          if (nodes.size >= effectiveNodeLimit) break;
          const perNode = Math.min(5, effectiveNodeLimit - nodes.size);
          for (const row of await directRows(d1, perNode)) {
            if (nodes.size >= effectiveNodeLimit) break;
            const cpCui = row.cp_cui;
            if (cpCui === null) continue;
            if (!nodes.has(cpCui)) {
              nodes.set(cpCui, {
                cui: cpCui,
                name: row.cp_name ?? cpCui,
                totalIn: '0',
                totalOut: '0',
              });
            }
            if (row.direction === 'out') addEdge(d1, cpCui, row.total, Number(row.flow_count));
            else addEdge(cpCui, d1, row.total, Number(row.flow_count));
          }
        }
      }

      return ok({ rootCui, depth: effectiveDepth, nodes: [...nodes.values()], edges });
    } catch (error) {
      return err(databaseError('getCounterpartyNetwork failed', error));
    }
  },

  async aggregateFlows(
    groupBy: 'year' | 'flow_type' | 'county' | 'cpv',
    filters: { flowType?: string; yearFrom?: number; yearTo?: number }
  ): Promise<Result<readonly FlowAggregateGroup[], ApiError>> {
    const groupExpr =
      groupBy === 'year'
        ? sql<string>`flow_year::text`
        : groupBy === 'flow_type'
          ? sql<string>`flow_type`
          : groupBy === 'county'
            ? sql<string>`county_name`
            : sql<string>`left(classification_code, 4)`;

    try {
      let query = db.selectFrom('flows.money_flows');
      if (filters.flowType !== undefined) query = query.where('flow_type', '=', filters.flowType);
      if (filters.yearFrom !== undefined) query = query.where('flow_year', '>=', filters.yearFrom);
      if (filters.yearTo !== undefined) query = query.where('flow_year', '<=', filters.yearTo);
      if (groupBy === 'cpv') {
        query = query
          .where('classification_system', '=', 'cpv')
          .where('classification_code', 'is not', null);
      }

      const rows = await query
        .select([
          groupExpr.as('group_key'),
          sql<string>`count(*)`.as('count'),
          sql<string>`coalesce(sum(amount_ron), 0)`.as('total'),
        ])
        .where(sql<boolean>`${groupExpr} is not null`)
        .groupBy(groupExpr)
        .orderBy(sql`sum(amount_ron) desc nulls last`)
        .limit(500)
        .execute();

      return ok(
        rows.map((r) => ({
          key: r.group_key,
          count: Number(r.count),
          totalAmountRon: r.total,
        }))
      );
    } catch (error) {
      return err(databaseError('aggregateFlows failed', error));
    }
  },
});
