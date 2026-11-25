/** The display text between two captures, in both the fold and UTF-16 coordinates. */
export const COMPONENT_BOUNDARY = '\n';

export const placeComponents = <T extends { readonly componentOrdinal: number }>(
  units: readonly T[],
  lengthOf: (unit: T) => number
): { unit: T; offset: number; namespace: number | null }[] => {
  let offset = 0;
  return [...units]
    .sort((a, b) => a.componentOrdinal - b.componentOrdinal)
    .map((unit) => {
      const placed = { unit, offset, namespace: units.length > 1 ? unit.componentOrdinal : null };
      offset += lengthOf(unit) + COMPONENT_BOUNDARY.length;
      return placed;
    });
};

/** Keep TLDF's dotted DOM paths and its separate, exact-match unmarked:N keys. */
export const componentBlockId = (namespace: number | null, id: string): string => {
  if (namespace === null) return id;
  if (id.startsWith('unmarked:')) {
    // Slots 0 and 1 use leading digits 1 and 2. unmarked:0 is the display boundary.
    return `unmarked:${String(namespace + 1)}${id.slice('unmarked:'.length)}`;
  }
  return `${String(namespace)}.${id}`;
};
