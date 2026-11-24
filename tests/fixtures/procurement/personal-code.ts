/**
 * A synthetic personal numeric code (CNP) for privacy tests: built here from a made-up prefix with
 * the CNP check digit, so it passes a CNP validator without being anyone's. Never put a real code
 * in a fixture.
 */
const WEIGHTS = [2, 7, 9, 1, 4, 6, 3, 5, 8, 2, 7, 9] as const;

/** The 13-digit code whose first 12 digits are `prefix12`, with a valid check digit. */
export const syntheticCnp = (prefix12: string): string => {
  if (!/^[0-9]{12}$/u.test(prefix12)) throw new Error('prefix12 must be 12 digits');
  const sum = WEIGHTS.reduce((acc, weight, i) => acc + weight * Number(prefix12[i]), 0);
  const check = sum % 11 === 10 ? 1 : sum % 11;
  return `${prefix12}${String(check)}`;
};

/** A valid synthetic CNP (born 1 Jan 1900, county 99: no such county exists). */
export const SYNTHETIC_CNP = syntheticCnp('190010199001');

/** A party name the source wrote with a personal code. */
export const CODED_NAME = `POPESCU ION ${SYNTHETIC_CNP}`;

/** An ordinary supplier name: served unchanged. */
export const ORDINARY_NAME = 'FIRMA EXEMPLU SRL';
