/**
 * Site-wide D6 (owner, 2026-11-18): the supplier codes the API may name as a
 * direct-acquisition supplier, read from the data platform's
 * `procurement_v3.supplier_privacy` (`public = true`).
 *
 * The set is rewritten in the nightly publish together with
 * `procurement_v3.da_release.data_as_of`, so it is cached per `data_as_of`: each
 * call reads that one timestamp and reloads the set only when it moved. Both
 * reads share one read-only repeatable-read snapshot. Concurrent reloads share
 * one load.
 *
 * Fails closed. An absent schema, table or release row, or any read error,
 * yields an EMPTY set: every supplier is withheld. An absent source is cached
 * briefly so a missing table is not re-probed on every request.
 *
 * Also here: the flows decorator that withholds a non-public code's
 * direct-acquisition money (its own DA totals are personal data even without
 * a name, per procurement-prod, 2026-11-18).
 */

import { sql, type Kysely } from 'kysely';
import { ok, type Result } from 'neverthrow';

import { makeDocumentRepo } from './document-repo.js';
import { makeFlowsRepo } from './flows-repo.js';

import type { ApiError } from '../../core/errors.js';
import type {
  DocumentRepo,
  FlowReadOptions,
  FlowsRepo,
  SupplierDisclosurePort,
} from '../../core/ports.js';
import type { ProdDatabase } from '../db/types.js';

const SCHEMA = 'procurement_v3';
/** How long an ABSENT or unreadable source is trusted before it is probed again. */
const ABSENT_TTL_MS = 60_000;
const DIRECT_ACQUISITION_FLOW = 'direct_acquisition';

const EMPTY: ReadonlySet<string> = new Set();

interface Loaded {
  readonly asOf: string | null;
  readonly codes: ReadonlySet<string>;
  readonly loadedAt: number;
}

export const makeSupplierDisclosureRepo = (
  db: Kysely<ProdDatabase>,
  enforced: boolean,
  now: () => number = Date.now
): SupplierDisclosurePort => {
  let cached: Loaded | null = null;
  let inflight: Promise<Loaded> | null = null;

  const load = async (): Promise<Loaded> => {
    try {
      return await db
        .transaction()
        .setIsolationLevel('repeatable read')
        .execute(async (trx) => {
          await sql`set transaction read only`.execute(trx);
          const present = await sql<{ release: boolean; privacy: boolean }>`
            select to_regclass(${`${SCHEMA}.da_release`}) is not null as release,
                   to_regclass(${`${SCHEMA}.supplier_privacy`}) is not null as privacy`.execute(
            trx
          );
          const tables = present.rows[0];
          if (tables?.release !== true || !tables.privacy)
            return { asOf: null, codes: EMPTY, loadedAt: now() };
          const release = await sql<{ as_of: string | null }>`
            select max(data_as_of)::text as as_of from ${sql.table(`${SCHEMA}.da_release`)}`.execute(
            trx
          );
          const asOf = release.rows[0]?.as_of ?? null;
          if (asOf === null) return { asOf: null, codes: EMPTY, loadedAt: now() };
          if (cached?.asOf === asOf) return { ...cached, loadedAt: now() };
          const rows = await sql<{ code: string }>`
            select fiscal_code_clean as code from ${sql.table(`${SCHEMA}.supplier_privacy`)}
            where public is true and fiscal_code_clean is not null`.execute(trx);
          return { asOf, codes: new Set(rows.rows.map((row) => row.code)), loadedAt: now() };
        });
    } catch {
      // Unreadable: withhold everyone, and retry after the absent TTL.
      return { asOf: null, codes: EMPTY, loadedAt: now() };
    }
  };

  /** The current set: reuse it while data_as_of is unchanged; an absent source for ABSENT_TTL_MS. */
  const current = async (): Promise<Loaded> => {
    if (cached?.asOf === null && now() - cached.loadedAt < ABSENT_TTL_MS) return cached;
    inflight ??= load().finally(() => {
      inflight = null;
    });
    cached = await inflight;
    return cached;
  };

  return {
    enforced,
    publicSupplierCodes: async (): Promise<Result<ReadonlySet<string>, ApiError>> => {
      if (!enforced) return ok(EMPTY);
      return ok((await current()).codes);
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
  const optionsFor = async (
    cui: string,
    direction: 'in' | 'out',
    options: FlowReadOptions | undefined
  ): Promise<FlowReadOptions | undefined> => {
    if (!disclosure.enforced || direction !== 'in') return options;
    const codes = await disclosure.publicSupplierCodes();
    if (codes.isOk() && codes.value.has(cui)) return options;
    return {
      ...options,
      excludeFlowTypes: [...(options?.excludeFlowTypes ?? []), DIRECT_ACQUISITION_FLOW],
    };
  };
  return {
    ...flows,
    getFlowSummary: async (cui, direction, includeYearBreakdown, options) =>
      flows.getFlowSummary(
        cui,
        direction,
        includeYearBreakdown,
        await optionsFor(cui, direction, options)
      ),
    getTopCounterparties: async (cui, direction, limit, options) =>
      flows.getTopCounterparties(cui, direction, limit, await optionsFor(cui, direction, options)),
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
    getCounterpartyNetwork: async (rootCui, depth, nodeLimit, options) =>
      flows.getCounterpartyNetwork(
        rootCui,
        depth,
        nodeLimit,
        disclosure.enforced
          ? {
              ...options,
              excludeFlowTypes: [...(options?.excludeFlowTypes ?? []), DIRECT_ACQUISITION_FLOW],
            }
          : options
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
        listByCui: async (cui, limit) => {
          const found = await documents.listByCui(cui, limit);
          return found.map((docs) => docs.filter((doc) => doc.docType !== DIRECT_ACQUISITION_DOC));
        },
      };

/**
 * The kernel's flows and document repos, built ONLY through here so every read
 * that can carry a direct-acquisition supplier passes the D6 gate (the guard
 * test drives this function with a capturing database).
 */
export const makeDisclosedReadRepos = (
  db: Kysely<ProdDatabase>,
  enforced: boolean
): {
  readonly supplierDisclosure: SupplierDisclosurePort;
  readonly flowsRepo: FlowsRepo;
  readonly documentRepo: DocumentRepo;
} => {
  const supplierDisclosure = makeSupplierDisclosureRepo(db, enforced);
  return {
    supplierDisclosure,
    flowsRepo: withSupplierDisclosure(makeFlowsRepo(db), supplierDisclosure),
    documentRepo: withDocumentDisclosure(makeDocumentRepo(db), supplierDisclosure),
  };
};
