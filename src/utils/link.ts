
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
  | "overview"
  | "expense-trends"
  | "income-trends"

export interface BuildClientLinkOptions {
  view: ClientView;
  route: string;
  filters?: Record<string, unknown> | null;
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

export function buildClientLink(opts: BuildClientLinkOptions): string {
  const baseRoute = opts.route;
  const encodedFilters = opts.filters ? toBase64Url(JSON.stringify(opts.filters)) : undefined;
  const query = buildQuery({ view: opts.view, filters: encodedFilters, ...opts.extraParams });

  const relative = `${baseRoute}${query}`;
  const clientBase = process.env.CLIENT_BASE_URL || process.env.PUBLIC_CLIENT_BASE_URL || "http://localhost:5173";
  const link = clientBase ? `${clientBase.replace(/\/$/, "")}${relative}` : "";

  return link;
}

export function buildFunctionalLink(cui: string, fnCode: string, type: "income" | "expense"): string {
  const search = type === "expense" ? "expenseSearch" : "incomeSearch";
  return buildClientLink({ route: `/entities/${cui}`, view: type === "expense" ? "expense-trends" : "income-trends", extraParams: { [search]: `fn:${fnCode}` } });
}

export function buildEconomicLink(cui: string, ecCode: string, type: "income" | "expense"): string {
  const search = type === "expense" ? "expenseSearch" : "incomeSearch";
  return buildClientLink({ route: `/entities/${cui}`, view: type === "expense" ? "expense-trends" : "income-trends", extraParams: { [search]: `ec:${ecCode}` } });
}

export function buildEntityDetailsLink(cui: string, search?: Record<string, string | number | boolean | undefined | null>): string {
  const baseRoute = `/entities/${encodeURIComponent(cui)}`;
  const query = buildQuery(search || {});
  const clientBase = process.env.CLIENT_BASE_URL || process.env.PUBLIC_CLIENT_BASE_URL || "http://localhost:5173";
  const link = clientBase ? `${clientBase.replace(/\/$/, "")}${baseRoute}${query}` : "";
  return link;
}


