/**
 * Display-only labels for an analysis records page, shared by GraphQL and MCP.
 *
 * Applied AFTER the usecase fixed membership, order and money from the pinned
 * build: a contract's display title (its native title, else a public matched
 * award's, else its public procedure's — the existing projection and its
 * privacy filters) is read from the production database by primary key. A
 * contract the database no longer serves, or a failed read, has no display
 * title — never another row, another order or another value. The shipped
 * free-text rule applies to it as to the source title.
 */

import { isWithheldOrganizationIdentifier } from '@/modules/shared/index.js';

import { isFreeTextWithheld, publicPartyName } from '../core/free-text-rule.js';

import type { AnalysisRecordsResult } from '../core/analysis-usecases.js';
import type { ContractDisplayTitle } from '../core/contract-display-title.js';
import type { AnalysisRecordRow, ProcurementRepo } from '../core/ports.js';

export type DisplayedRecord = AnalysisRecordRow & {
  readonly displayTitle: ContractDisplayTitle | null;
};

/** A code as the records usecase serves it: null for a person's (kernel P0 containment). */
const servedCode = (cui: string | null): string | null =>
  cui !== null && !isWithheldOrganizationIdentifier(cui) ? cui : null;

export const withDisplayTitles = async (
  repo: ProcurementRepo,
  result: AnalysisRecordsResult
): Promise<readonly DisplayedRecord[]> => {
  const titles =
    result.grain === 'contract' && result.items.length > 0
      ? await repo.contractsByIds(result.items.map((item) => item.id))
      : null;
  const contracts = titles?.isOk() === true ? titles.value : null;
  return result.items.map(({ titleWithheld, supplierPerson: _person, ...item }) => {
    const contract = contracts?.get(item.id);
    const displayTitle = contract?.displayTitle ?? null;
    return {
      ...item,
      // A contract's supplier name: only the one production serves for it (its read masks a
      // person's, whatever the build says), never one that may carry a personal code; null when not
      // read. On another grain the usecase already nulled a person's name (`supplierPerson`).
      // And only for the same supplier: the production row's served code must equal the record's.
      ...(result.grain === 'contract' && {
        supplierName:
          contract !== undefined && servedCode(contract.supplierCui) === item.supplierCui
            ? publicPartyName(contract.supplierName)
            : null,
      }),
      // The free-text rule (interim gate): a withheld source title takes its
      // display title with it, and a display title the rule hits is withheld.
      displayTitle:
        titleWithheld === true || displayTitle === null || isFreeTextWithheld(displayTitle.text)
          ? null
          : displayTitle,
    };
  });
};
