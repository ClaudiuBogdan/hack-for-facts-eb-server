/**
 * Site-wide D6 (owner, 2026-11-18): the supplier codes the API may name as a
 * direct-acquisition supplier, read from the data platform's
 * `procurement_v3.supplier_privacy` (`public = true`).
 *
 * The set is rewritten in the nightly publish together with
 * `procurement_v3.da_release.data_as_of`, so it is cached per `data_as_of`: each
 * call reads that one timestamp and reloads the set only when it moved. Both
 * reads share one read-only repeatable-read snapshot. Concurrent calls share a
 * load only until it starts reading: a call never joins a load whose snapshot
 * may predate the call, so it sees every publication committed before it began.
 *
 * Fails closed. An absent schema, table or release row, or any read error,
 * yields an EMPTY set: every supplier is withheld. An absent source is cached
 * briefly so a missing table is not re-probed on every request. A publication
 * older than one this process already served (a replica behind another) is
 * also withheld, and logged: the served `privacyAsOf` never goes backwards.
 *
 * Also here: the flows decorator that withholds a non-public code's
 * direct-acquisition money (its own DA totals are personal data even without
 * a name, per procurement-prod, 2026-11-18).
 */

import { sql, type Kysely } from 'kysely';
import { ok, type Result } from 'neverthrow';

import { makeDocumentRepo } from './document-repo.js';
import { makeFlowsRepo } from './flows-repo.js';
import { makeSearchRepo } from './search-repo.js';
import { FiscalCodeSet, type PublicSupplierCodes } from '../../core/types.js';

import type { ApiError } from '../../core/errors.js';
import type {
  DocumentRepo,
  FlowReadOptions,
  FlowsRepo,
  SearchRepo,
  SupplierDisclosurePort,
} from '../../core/ports.js';
import type { ProdDatabase } from '../db/types.js';

const SCHEMA = 'procurement_v3';
/** How long an ABSENT or unreadable source is trusted before it is probed again. */
const ABSENT_TTL_MS = 60_000;
const DIRECT_ACQUISITION_FLOW = 'direct_acquisition';

/** The public codes, in the platform's form (no leading zeros). */
const EMPTY: PublicSupplierCodes = new FiscalCodeSet([], null);
/** D6 off: no publication applies. */
const OFF: PublicSupplierCodes = new FiscalCodeSet();

/** The structured logger the port warns on (pino, Fastify's `app.log` or console). */
interface DisclosureLog {
  warn(obj: unknown, msg?: string): void;
}

const WITHHELD = (loadedAt: number): Loaded => ({ asOf: null, codes: EMPTY, loadedAt });

interface Loaded {
  readonly asOf: string | null;
  readonly codes: PublicSupplierCodes;
  readonly loadedAt: number;
}

export const makeSupplierDisclosureRepo = (
  db: Kysely<ProdDatabase>,
  enforced: boolean,
  now: () => number = Date.now,
  log: DisclosureLog = console
): SupplierDisclosurePort => {
  let cached: Loaded | null = null;
  /**
   * The newest publication served by this process. `asOf` is fixed-width ISO UTC
   * (`YYYY-MM-DDTHH:MM:SS.ffffffZ`), so string order is time order.
   */
  let newest: string | null = null;
  /** The last (read, served) pair warned about, so a lagging replica logs once. */
  let warned: string | null = null;
  /** The newest shared load; joinable only while `reading` is false. */
  let open: { readonly state: { reading: boolean }; readonly loaded: Promise<Loaded> } | null =
    null;

  /** `onRead` runs before the first statement, i.e. before the snapshot is taken. */
  const load = async (onRead: () => void = () => undefined): Promise<Loaded> => {
    try {
      return await db
        .transaction()
        .setIsolationLevel('repeatable read')
        .execute(async (trx) => {
          onRead();
          await sql`set transaction read only`.execute(trx);
          const present = await sql<{ release: boolean; privacy: boolean }>`
            select to_regclass(${`${SCHEMA}.da_release`}) is not null as release,
                   coalesce(
                     has_table_privilege(to_regclass(${`${SCHEMA}.supplier_privacy`}), 'SELECT'),
                     false
                   ) as privacy`.execute(trx);
          const tables = present.rows[0];
          if (tables?.release !== true || !tables.privacy) return WITHHELD(now());
          const release = await sql<{ as_of: string | null }>`
            select to_char(max(data_as_of) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as as_of
            from ${sql.table(`${SCHEMA}.da_release`)}`.execute(trx);
          const asOf = release.rows[0]?.as_of ?? null;
          if (asOf === null) return WITHHELD(now());
          if (cached?.asOf === asOf) return { ...cached, loadedAt: now() };
          const rows = await sql<{ code: string }>`
            select fiscal_code_clean as code from ${sql.table(`${SCHEMA}.supplier_privacy`)}
            where public is true and fiscal_code_clean is not null`.execute(trx);
          return {
            asOf,
            codes: new FiscalCodeSet(
              rows.rows.map((row) => row.code),
              asOf
            ),
            loadedAt: now(),
          };
        });
    } catch {
      // Unreadable: withhold everyone, and retry after the absent TTL.
      return WITHHELD(now());
    }
  };

  /**
   * A load the caller may share: the open one while it has not started reading
   * (its snapshot will be taken after this call began), otherwise a new one. A
   * load that already read may hold the publication before a publish the caller
   * observed (e.g. a status request right after the nightly publish).
   */
  const shared = (): Promise<Loaded> => {
    if (open !== null && !open.state.reading) return open.loaded;
    const state = { reading: false };
    const loaded = load(() => {
      state.reading = true;
    }).finally(() => {
      if (open?.loaded === loaded) open = null;
    });
    open = { state, loaded };
    return loaded;
  };

  /**
   * The current set: reuse it while data_as_of is unchanged; an absent source for
   * ABSENT_TTL_MS (that answer withholds everyone, so reusing it is fail-closed).
   * A `fresh` call starts its own load and shares none. A load that read an
   * older publication than one already served withholds everyone (it may come
   * from a lagging replica, or have started before a publish another load saw).
   */
  const current = async (fresh: boolean): Promise<Loaded> => {
    if (cached?.asOf === null && now() - cached.loadedAt < ABSENT_TTL_MS) return cached;
    const got = await (fresh ? load() : shared());
    if (got.asOf !== null && newest !== null && got.asOf < newest) {
      const pair = `${got.asOf}<${newest}`;
      if (warned !== pair) {
        warned = pair;
        log.warn(
          { component: 'supplier-disclosure', readAsOf: got.asOf, servedAsOf: newest },
          'D6: read an older supplier_privacy publication than already served; withholding every supplier'
        );
      }
      return WITHHELD(got.loadedAt);
    }
    if (got.asOf !== null) newest = got.asOf;
    cached = got;
    return got;
  };

  return {
    enforced,
    publicSupplierCodes: async (options): Promise<Result<PublicSupplierCodes, ApiError>> => {
      if (!enforced) return ok(OFF);
      return ok((await current(options?.fresh === true)).codes);
    },
    privacyAsOf: async (): Promise<Result<string | null, ApiError>> => {
      if (!enforced) return ok(null);
      return ok((await current(false)).asOf);
    },
  };
};

/**
 * Withhold a non-public code's direct-acquisition money from its incoming flow
 * summaries and counterparties (counts, sums, years and the per-type rows).
 * Outgoing flows (the code as payer, e.g. a buyer) are unchanged.
 */
export const withSupplierDisclosure = (
  flows: FlowsRepo,
  disclosure: SupplierDisclosurePort
): FlowsRepo => {
  const withDa = (options: FlowReadOptions | undefined): FlowReadOptions => ({
    ...options,
    excludeFlowTypes: [...(options?.excludeFlowTypes ?? []), DIRECT_ACQUISITION_FLOW],
  });
  const isPublic = async (cui: string, fresh = false): Promise<boolean> => {
    const codes = await disclosure.publicSupplierCodes({ fresh });
    return codes.isOk() && codes.value.has(cui);
  };
  /**
   * A code's incoming flows carry its DA money only while it is public, checked
   * before AND after the read (a nightly publish can withhold it mid-request).
   */
  const incoming = async <T>(
    cui: string,
    options: FlowReadOptions | undefined,
    read: (options: FlowReadOptions | undefined) => Promise<T>
  ): Promise<T> => {
    if (!(await isPublic(cui))) return read(withDa(options));
    const result = await read(options);
    return (await isPublic(cui, true)) ? result : read(withDa(options));
  };
  return {
    ...flows,
    getFlowSummary: (cui, direction, includeYearBreakdown, options) =>
      !disclosure.enforced || direction !== 'in'
        ? flows.getFlowSummary(cui, direction, includeYearBreakdown, options)
        : incoming(cui, options, (o) =>
            flows.getFlowSummary(cui, direction, includeYearBreakdown, o)
          ),
    // Outgoing counterparties are payees, named and ranked: while D6 is enforced
    // they carry no DA money at all (a payee may be a withheld supplier).
    getTopCounterparties: (cui, direction, limit, options) =>
      !disclosure.enforced
        ? flows.getTopCounterparties(cui, direction, limit, options)
        : direction === 'out'
          ? flows.getTopCounterparties(cui, direction, limit, withDa(options))
          : incoming(cui, options, (o) => flows.getTopCounterparties(cui, direction, limit, o)),
    // Per-flow lists and the network name every counterparty: while D6 is enforced
    // they carry no direct-acquisition flow at all (no caller today; gated so a
    // future caller cannot bypass D6).
    listFlows: async (cui, options) => {
      if (!disclosure.enforced) return flows.listFlows(cui, options);
      if (options.flowType === DIRECT_ACQUISITION_FLOW) return ok({ items: [], next: null });
      return flows.listFlows(cui, {
        ...options,
        excludeFlowTypes: [...(options.excludeFlowTypes ?? []), DIRECT_ACQUISITION_FLOW],
      });
    },
    getCounterpartyNetwork: (rootCui, depth, nodeLimit, options) =>
      flows.getCounterpartyNetwork(
        rootCui,
        depth,
        nodeLimit,
        disclosure.enforced ? withDa(options) : options
      ),
  };
};

const DIRECT_ACQUISITION_DOC = 'procurement_direct_acquisition';

/**
 * While D6 is enforced the shared document view serves no direct-acquisition
 * document: its title and text can name a withheld supplier, and legacy free
 * text is withheld (no caller today; gated so a future caller cannot bypass it).
 */
export const withDocumentDisclosure = (
  documents: DocumentRepo,
  disclosure: SupplierDisclosurePort
): DocumentRepo =>
  !disclosure.enforced
    ? documents
    : {
        findById: async (docId) => {
          const found = await documents.findById(docId);
          return found.map((doc) => (doc?.docType === DIRECT_ACQUISITION_DOC ? null : doc));
        },
        // Excluded in SQL, before the limit, so hidden rows never shorten a page.
        listByCui: (cui, limit, options) =>
          documents.listByCui(cui, limit, {
            ...options,
            excludeDocTypes: [...(options?.excludeDocTypes ?? []), DIRECT_ACQUISITION_DOC],
          }),
      };

/** The document count by code never counts a DA document while D6 is enforced. */
export const withSearchDisclosure = (
  search: SearchRepo,
  disclosure: SupplierDisclosurePort
): SearchRepo =>
  !disclosure.enforced
    ? search
    : {
        ...search,
        countByCui: (cui, options) =>
          search.countByCui(cui, {
            ...options,
            excludeDocTypes: [...(options?.excludeDocTypes ?? []), DIRECT_ACQUISITION_DOC],
          }),
      };

/**
 * The kernel's flows, document and document-count repos, built ONLY through here so every read
 * that can carry a direct-acquisition supplier passes the D6 gate (the guard
 * test drives this function with a capturing database).
 */
export const makeDisclosedReadRepos = (
  db: Kysely<ProdDatabase>,
  enforced: boolean,
  log: DisclosureLog = console
): {
  readonly supplierDisclosure: SupplierDisclosurePort;
  readonly flowsRepo: FlowsRepo;
  readonly documentRepo: DocumentRepo;
  readonly searchRepo: SearchRepo;
} => {
  const supplierDisclosure = makeSupplierDisclosureRepo(db, enforced, Date.now, log);
  return {
    supplierDisclosure,
    flowsRepo: withSupplierDisclosure(makeFlowsRepo(db), supplierDisclosure),
    documentRepo: withDocumentDisclosure(makeDocumentRepo(db), supplierDisclosure),
    searchRepo: withSearchDisclosure(makeSearchRepo(db), supplierDisclosure),
  };
};
