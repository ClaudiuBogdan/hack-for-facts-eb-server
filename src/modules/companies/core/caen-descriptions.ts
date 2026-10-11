/** Catalog descriptions are presentation evidence, never an inferred source revision. */
export interface CaenCatalogDescription {
  readonly revision: string;
  readonly label: string | null;
}

export type CaenDescriptionStatus = 'EXACT' | 'CONSENSUS' | 'CONFLICT' | 'MISSING';

export interface CaenDescriptionResolution {
  readonly label: string | null;
  readonly descriptionStatus: CaenDescriptionStatus;
  readonly descriptions: readonly CaenCatalogDescription[];
}

/** Exact revision when known; otherwise expose every candidate and require unanimous nonempty text. */
export const resolveCaenDescriptions = (
  revision: string | null,
  candidates: readonly CaenCatalogDescription[]
): CaenDescriptionResolution => {
  const descriptions = candidates
    .filter((candidate) => revision === null || candidate.revision === revision)
    .map((candidate) => {
      const label = candidate.label?.trim() ?? null;
      return { ...candidate, label: label === '' ? null : label };
    })
    .sort((a, b) => a.revision.localeCompare(b.revision));
  const labels = new Set(descriptions.map((candidate) => candidate.label));
  const label = descriptions[0]?.label ?? null;
  if (descriptions.length === 0 || [...labels].every((value) => value === null))
    return { label: null, descriptionStatus: 'MISSING', descriptions };
  if (labels.size !== 1 || label === null)
    return { label: null, descriptionStatus: 'CONFLICT', descriptions };
  return { label, descriptionStatus: revision === null ? 'CONSENSUS' : 'EXACT', descriptions };
};
