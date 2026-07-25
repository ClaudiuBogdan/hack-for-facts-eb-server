export type ContractDisplayTitleSource = 'native' | 'matched_award' | 'procedure';

export interface ContractDisplayTitleEvidence {
  readonly title: string | null;
  readonly sourceUrl: string | null;
}

export interface ContractDisplayTitleCandidates {
  readonly matchedAwards: readonly ContractDisplayTitleEvidence[];
  readonly procedure: ContractDisplayTitleEvidence | null;
}

export interface ContractDisplayTitle {
  readonly text: string;
  readonly source: ContractDisplayTitleSource;
  readonly sourceUrl: string | null;
}

/**
 * Exact low-information headings measured in transparenta_prod on 2026-07-26:
 * award titles included "contract" (107,141 rows), "contract subsecvent"
 * (60,625), and "acord cadru" (44,715). Keep this deliberately narrow: native
 * titles are never rejected, and descriptive continuations such as
 * "Contract subsecvent de furnizare medicamente" remain valid.
 *
 * Re-validate these empirical values when the full procurement corpus changes.
 */
const GENERIC_DERIVED_TITLE_PATTERN =
  /^(?:contract(?:ul)?(?:\s+(?:nr|numarul)\s*[\p{Number}\s]+)?|contract\s+sub(?:secvent|s)?(?:\s+(?:nr|numarul)\s*[\p{Number}\s]+)?|acord\s+cadru(?:\s+(?:nr|numarul)\s*[\p{Number}\s]+)?)$/u;

const normalizeForGate = (value: string): string =>
  value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLocaleLowerCase('ro-RO')
    .replace(/[^\p{Letter}\p{Number}]+/gu, ' ')
    .trim();

const cleanTitle = (value: string | null): string | null => {
  const cleaned = value?.trim();
  return cleaned === undefined || cleaned.length === 0 ? null : cleaned;
};

export const isMeaningfulDerivedContractTitle = (value: string | null): boolean => {
  const cleaned = cleanTitle(value);
  return cleaned !== null && !GENERIC_DERIVED_TITLE_PATTERN.test(normalizeForGate(cleaned));
};

export const resolveContractDisplayTitle = (
  nativeTitle: string | null,
  nativeSourceUrl: string | null,
  candidates: ContractDisplayTitleCandidates
): ContractDisplayTitle | null => {
  const native = cleanTitle(nativeTitle);
  if (native !== null) {
    return {
      text: native,
      source: 'native',
      sourceUrl: nativeSourceUrl,
    };
  }

  const meaningfulAwards = new Map<string, ContractDisplayTitleEvidence>();
  for (const award of candidates.matchedAwards) {
    if (isMeaningfulDerivedContractTitle(award.title)) {
      const title = cleanTitle(award.title);
      if (title !== null && !meaningfulAwards.has(normalizeForGate(title))) {
        meaningfulAwards.set(normalizeForGate(title), award);
      }
    }
  }

  // The correlation key is intentionally non-unique across physical source
  // observations. Borrow award text only when all meaningful observations
  // agree; otherwise use the broader procedure instead of choosing a
  // plausible but potentially wrong lot title.
  if (meaningfulAwards.size === 1) {
    const award = meaningfulAwards.values().next().value;
    const title = award === undefined ? null : cleanTitle(award.title);
    if (award !== undefined && title !== null) {
      return {
        text: title,
        source: 'matched_award',
        sourceUrl: award.sourceUrl,
      };
    }
  }

  const procedureTitle = cleanTitle(candidates.procedure?.title ?? null);
  if (
    candidates.procedure !== null &&
    procedureTitle !== null &&
    isMeaningfulDerivedContractTitle(procedureTitle)
  ) {
    return {
      text: procedureTitle,
      source: 'procedure',
      sourceUrl: candidates.procedure.sourceUrl,
    };
  }

  return null;
};
