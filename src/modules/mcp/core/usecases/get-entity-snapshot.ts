/**
 * MCP Use Case: get_entity_snapshot
 *
 * Returns a point-in-time financial overview for a single public entity.
 */

import { Decimal } from 'decimal.js';
import { ok, err, type Result } from 'neverthrow';

import {
  entityNotFoundError,
  entitySearchNotFoundError,
  databaseError,
  toMcpError,
  type McpError,
} from '../errors.js';
import {
  formatCompact as formatCompactNum,
  formatStandard as formatStandardNum,
  formatAmountBilingual as formatAmountBilingualNum,
} from '../utils.js';

import type { GetEntitySnapshotInput, GetEntitySnapshotOutput } from '../schemas/tools.js';

// ─────────────────────────────────────────────────────────────────────────────
// Dependencies
// ─────────────────────────────────────────────────────────────────────────────

export interface GetEntitySnapshotDeps {
  entityRepo: {
    getById(
      cui: string
    ): Promise<Result<{ cui: string; name: string; address: string | null } | null, unknown>>;
    getAll(
      filter: { search?: string },
      limit: number,
      offset: number
    ): Promise<Result<{ nodes: { cui: string; name: string; address: string | null }[] }, unknown>>;
  };
  executionRepo: {
    getYearlySnapshotTotals(
      cui: string,
      year: number,
      reportType?: string
    ): Promise<Result<{ totalIncome: Decimal; totalExpenses: Decimal }, unknown>>;
  };
  shareLink: {
    create(url: string): Promise<Result<string, unknown>>;
  };
  config: {
    clientBaseUrl: string;
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Formatting Helpers (Decimal wrappers for shared utilities)
// ─────────────────────────────────────────────────────────────────────────────

/** Formats Decimal amount in compact form */
const formatCompact = (amount: Decimal): string => formatCompactNum(amount.toNumber());

/** Formats Decimal amount in standard form */
const formatStandard = (amount: Decimal): string => formatStandardNum(amount.toNumber());

/** Creates bilingual formatted amount string from Decimal */
const formatAmountBilingual = (amount: Decimal, labelRo: string, labelEn: string): string =>
  formatAmountBilingualNum(amount.toNumber(), labelRo, labelEn);

// ─────────────────────────────────────────────────────────────────────────────
// Use Case
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Get a point-in-time financial overview for a single public entity.
 */
export async function getEntitySnapshot(
  deps: GetEntitySnapshotDeps,
  input: GetEntitySnapshotInput
): Promise<Result<GetEntitySnapshotOutput, McpError>> {
  const { entityCui, entitySearch, year } = input;

  // 1. Resolve entity
  let entity: { cui: string; name: string; address: string | null } | null = null;

  if (entityCui !== undefined && entityCui !== '') {
    // Try by CUI first
    const result = await deps.entityRepo.getById(entityCui);
    if (result.isErr()) {
      return err(databaseError());
    }
    entity = result.value;

    if (entity === null) {
      return err(entityNotFoundError(entityCui));
    }
  } else if (entitySearch !== undefined && entitySearch !== '') {
    // Fallback to search
    const result = await deps.entityRepo.getAll({ search: entitySearch }, 1, 0);
    if (result.isErr()) {
      return err(databaseError());
    }

    const firstEntity = result.value.nodes[0];
    if (firstEntity === undefined) {
      return err(entitySearchNotFoundError(entitySearch));
    }
    entity = firstEntity;
  } else {
    return err(entityNotFoundError(''));
  }

  // 2. Get yearly snapshot totals
  const snapshotResult = await deps.executionRepo.getYearlySnapshotTotals(entity.cui, year);
  if (snapshotResult.isErr()) {
    const domainError = snapshotResult.error as { type?: string; message?: string };
    if (domainError.type !== undefined) {
      return err(toMcpError({ type: domainError.type, message: domainError.message ?? '' }));
    }
    return err(databaseError());
  }

  const snapshot = snapshotResult.value;

  // 3. Format amounts
  const totalIncomeFormatted = formatAmountBilingual(
    snapshot.totalIncome,
    'Venituri totale',
    'Total income'
  );
  const totalExpensesFormatted = formatAmountBilingual(
    snapshot.totalExpenses,
    'Cheltuieli totale',
    'Total expenses'
  );

  // 4. Create summary
  const summary = `In ${String(year)}, ${entity.name} had a total income of ${formatCompact(
    snapshot.totalIncome
  )} (${formatStandard(snapshot.totalIncome)}) and total expenses of ${formatCompact(
    snapshot.totalExpenses
  )} (${formatStandard(snapshot.totalExpenses)}).`;

  // 5. Build and shorten link
  const fullLink = `${deps.config.clientBaseUrl}/entities/${entity.cui}?year=${String(year)}`;
  const linkResult = await deps.shareLink.create(fullLink);
  const link = linkResult.isOk() ? linkResult.value : fullLink;

  // 6. Return result
  return ok({
    ok: true,
    kind: 'entities.details' as const,
    query: {
      cui: entity.cui,
      year,
    },
    link,
    item: {
      cui: entity.cui,
      name: entity.name,
      address: entity.address,
      totalIncome: snapshot.totalIncome.toNumber(),
      totalExpenses: snapshot.totalExpenses.toNumber(),
      totalIncomeFormatted,
      totalExpensesFormatted,
      summary,
    },
  });
}
