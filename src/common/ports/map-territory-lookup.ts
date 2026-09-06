/** Complete, ordered keys for the configured map granularity (SIRUTA or county codes).
 * The adapter owns eligibility. Lookup failures must reject, never return an
 * empty universe as a fallback. Consumers must not infer geography from labels.
 */
export type MapTerritoryLookup = () => Promise<readonly string[]>;
