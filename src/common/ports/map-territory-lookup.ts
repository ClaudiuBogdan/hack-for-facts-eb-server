/** Complete, ordered SIRUTA universe supported by the map presentation layer.
 * The adapter owns eligibility. Lookup failures must reject, never return an
 * empty universe as a fallback. Consumers must not infer geography from labels.
 */
export type MapTerritoryLookup = () => Promise<readonly string[]>;
