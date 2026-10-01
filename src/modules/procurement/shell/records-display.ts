/**
 * Display-only labels for an analysis records page, shared by GraphQL and MCP.
 *
 * Applied AFTER the usecase fixed membership, order and money from the pinned
 * build: a contract's display title (its native title, else a public matched
 * award's, else its public procedure's — the existing projection and its
 * privacy filters) is read from the production database by primary key. A
 * contract the database no longer serves, or a failed read, has no display
 * title — never another row, another order or another value.
 */

import type { AnalysisRecordsResult } from '../core/analysis-usecases.js';
import type { ContractDisplayTitle } from '../core/contract-display-title.js';
import type { AnalysisRecordRow, ProcurementRepo } from '../core/ports.js';

export type DisplayedRecord = AnalysisRecordRow & {
  readonly displayTitle: ContractDisplayTitle | null;
};

export const withDisplayTitles = async (
  repo: ProcurementRepo,
  result: AnalysisRecordsResult
): Promise<readonly DisplayedRecord[]> => {
  const titles =
    result.grain === 'contract' && result.items.length > 0
      ? await repo.contractsByIds(result.items.map((item) => item.id))
      : null;
  const contracts = titles?.isOk() === true ? titles.value : null;
  return result.items.map((item) => ({
    ...item,
    displayTitle: contracts?.get(item.id)?.displayTitle ?? null,
  }));
};
