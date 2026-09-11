/**
 * Which corpus roots are served by the KERNEL endpoint, and the classification
 * built on it (review tests-ci.md improvement 7): a case whose roots are all
 * on the kernel and that FAILS the cutover is a mounted root without a
 * recorded parity decision for its blocking differences (an allowlist entry
 * may cover some of them: those cases are marked partly allowlisted). The run
 * partitions its failing cases accordingly in `summary.md` / `summary.json`
 * ("Failing cases on kernel-mounted roots without a recorded parity
 * decision"), so a root mounted without a decision is named, not buried among
 * the unported-root failures. It is a classification of failures, not a
 * separate gate: such a case already fails the run.
 *
 * The list is kept LITERAL so the harness stays a black box over the two
 * endpoints (it imports nothing from `src/`); `tests/unit/golden-master/
 * kernel-roots.test.ts` pins it to the modules' own root constants, so a root
 * mounted or dropped in a module fails that unit test until this list follows.
 */

import { Kind, parse } from 'graphql';

import type { CaseReport } from './report.js';

export const KERNEL_LEGACY_ROOTS = [
  // budget legacy slice (design 13 §4)
  'executionAnalytics',
  'budgetSectors',
  'fundingSources',
  'functionalClassifications',
  'economicClassifications',
  // budget grouped slice
  'entityAnalytics',
  'aggregatedLineItems',
  // ins-native legacy slice (decision D5: the eight client-sent roots)
  'insDatasets',
  'insDataset',
  'insDatasetDimensionValues',
  'insTerritories',
  'insContexts',
  'insObservations',
  'insUatDashboard',
  'insLatestDatasetValues',
] as const;

const KERNEL_ROOT_SET: ReadonlySet<string> = new Set<string>(KERNEL_LEGACY_ROOTS);

/** The root fields of every operation in a document, in document order (duplicates kept). */
export function documentRoots(document: string): string[] {
  const roots: string[] = [];
  for (const definition of parse(document).definitions) {
    if (definition.kind !== Kind.OPERATION_DEFINITION) continue;
    for (const selection of definition.selectionSet.selections) {
      if (selection.kind === Kind.FIELD) roots.push(selection.name.value);
    }
  }
  return roots;
}

export function isKernelRootedDocument(document: string): boolean {
  const roots = documentRoots(document);
  return roots.length > 0 && roots.every((root) => KERNEL_ROOT_SET.has(root));
}

export interface UncoveredKernelCase {
  id: string;
  key: string;
  roots: string[];
  /** Some differences matched an allowlist entry, the blocking ones did not. */
  partiallyAllowlisted: boolean;
  reasons: string[];
}

/**
 * The failing cases whose document is kernel-rooted, with the ones an
 * allowlist entry partly covers marked (their blocking differences still have
 * no decision). `documents` maps a case key to its document text (the
 * corpus); a report whose key is not in the corpus is skipped (it cannot be
 * classified).
 */
export function findUncoveredKernelCases(
  reports: readonly CaseReport[],
  documents: ReadonlyMap<string, string>
): UncoveredKernelCase[] {
  const out: UncoveredKernelCase[] = [];
  for (const report of reports) {
    if (report.verdict !== 'fail') continue;
    const document = documents.get(report.key);
    if (document === undefined || !isKernelRootedDocument(document)) continue;
    out.push({
      id: report.id,
      key: report.key,
      roots: [...new Set(documentRoots(document))],
      partiallyAllowlisted: report.allowedEntryIds.length > 0,
      reasons: [
        ...report.defects.map((defect) => `${defect.kind}: ${defect.message}`),
        ...report.blocking
          .slice(0, 5)
          .map((difference) => `${difference.class}/${difference.kind} at ${difference.path}`),
      ],
    });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}
