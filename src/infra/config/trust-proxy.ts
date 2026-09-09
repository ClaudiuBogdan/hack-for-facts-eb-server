/**
 * The ONE `TRUST_PROXY` contract, shared by the legacy and the kernel
 * entrypoints (review X/F15; Codex P2 on the first cut): Fastify accepts a
 * boolean, a hop count, or a named proxy / CIDR list, and both servers read
 * the same variable. `true`/`false` → boolean; digits → hop count; anything
 * else → passed through as the address list; unset/blank → undefined (the
 * caller applies its default).
 */
export type TrustProxySetting = boolean | number | string;

export const parseTrustProxy = (value: string | undefined): TrustProxySetting | undefined => {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (/^\d+$/u.test(trimmed)) return Number.parseInt(trimmed, 10);
  return trimmed;
};
