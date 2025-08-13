
/**
 * Utility helpers to generate client deep-links that open the data explorer
 * with a pre-configured set of filters. The link structure is intentionally
 * simple and stable so that AI tools can present it to users.
 *
 * Links are formed as:
 *   <CLIENT_BASE_URL>/<route>?view=<view>&filters=<base64url(JSON)>
 *
 * Where `filters` is a base64url-encoded JSON payload that the client can
 * decode to restore the UI state.
 */

export type ClientView =
  | "entities-search"
  | "uat-search"
  | "classifications-functional"
  | "classifications-economic"
  | "spending-summary"
  | "analytics-entities-compare";

export interface BuildClientLinkOptions {
  view: ClientView;
  filters?: Record<string, unknown> | null;
  route?: string; // default: "/explore"
  extraParams?: Record<string, string | number | boolean | undefined | null>;
}

function toBase64Url(input: string): string {
  // btoa is not available in Node; use Buffer
  return Buffer.from(input, "utf8")
    .toString("base64")
    .replace(/=+$/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

export function buildQuery(params: Record<string, string | number | boolean | undefined | null>): string {
  const searchParams = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    searchParams.set(key, String(value));
  }
  const s = searchParams.toString();
  return s ? `?${s}` : "";
}

export function buildClientLink(opts: BuildClientLinkOptions): {
  absolute?: string; // present when CLIENT_BASE_URL configured
  relative: string;
  route: string;
  query: string;
} {
  const baseRoute = opts.route ?? "/explore";
  const encodedFilters = opts.filters ? toBase64Url(JSON.stringify(opts.filters)) : undefined;
  const query = buildQuery({ view: opts.view, filters: encodedFilters, ...opts.extraParams });

  const relative = `${baseRoute}${query}`;
  const clientBase = process.env.CLIENT_BASE_URL || process.env.PUBLIC_CLIENT_BASE_URL || "http://localhost:5173";
  const absolute = clientBase ? `${clientBase.replace(/\/$/, "")}${relative}` : undefined;

  return { absolute, relative, route: baseRoute, query };
}

export function buildEntitySearchLink(search: string): { absolute?: string; relative: string } {
  return buildClientLink({ view: "entities-search", filters: { search } });
}

export function buildFunctionalSearchLink(search: string): { absolute?: string; relative: string } {
  return buildClientLink({ view: "classifications-functional", filters: { search } });
}

export function buildEconomicSearchLink(search: string): { absolute?: string; relative: string } {
  return buildClientLink({ view: "classifications-economic", filters: { search } });
}

export function buildUatSearchLink(search: string): { absolute?: string; relative: string } {
  return buildClientLink({ view: "uat-search", filters: { search } });
}

export function buildSpendingSummaryLink(filters: Record<string, unknown>): { absolute?: string; relative: string } {
  return buildClientLink({ view: "spending-summary", filters });
}

export function buildEntitiesCompareLink(filters: Record<string, unknown>): { absolute?: string; relative: string } {
  return buildClientLink({ view: "analytics-entities-compare", filters });
}

export function buildEntityDetailsLink(cui: string, search?: Record<string, string | number | boolean | undefined | null>): { sourceLink?: string } {
  const baseRoute = `/entities/${encodeURIComponent(cui)}`;
  const query = buildQuery(search || {});
  const clientBase = process.env.CLIENT_BASE_URL || process.env.PUBLIC_CLIENT_BASE_URL || "http://localhost:5173";
  const absolute = clientBase ? `${clientBase.replace(/\/$/, "")}${baseRoute}${query}` : undefined;
  return { sourceLink: absolute };
}


