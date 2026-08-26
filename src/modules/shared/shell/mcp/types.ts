/**
 * Shared Kernel — MCP tool registration contract (foundation §6.3, §7.4).
 *
 * Each module contributes `KernelMcpTool`s; the kernel registers them into one
 * MCP server. A tool declares a Zod input shape (the SDK's `registerTool`
 * requires a Zod raw shape) and a handler returning the structured output object
 * `{ ok, kind, query?, link?, item|items?, summary? }`.
 */

import type { ApiError } from '../../core/errors.js';
import type { ZodRawShape } from 'zod';

/**
 * The structured object every kernel/module MCP tool returns (§6.3).
 *
 * `T` types the `item`/`items` payload. It DEFAULTS to `unknown`, so the bare
 * `McpToolOutput` is identical to before and no existing usage changes — a module
 * MAY narrow it (`McpToolOutput<PnrrProjectView>`) for stronger handler typing
 * without any kernel/cross-module churn. The runtime privacy property (no raw/PII
 * leakage) is enforced separately by the leak-audit tests, not by this type.
 */
export interface McpToolOutput<T = unknown> {
  readonly ok: boolean;
  readonly kind: string;
  readonly query?: unknown;
  readonly link?: string;
  readonly item?: T;
  readonly items?: readonly T[];
  /**
   * Structured envelope metadata for list/aggregate tools — totals, coverage,
   * pagination flags an agent must read PROGRAMMATICALLY rather than parse out of
   * the human-readable `summary` (audit H6: totalCount/denominator/coverage were
   * summary-text-only). Rides into the SDK `structuredContent` like every field.
   */
  readonly meta?: Readonly<Record<string, unknown>>;
  readonly summary?: string;
  /** Stable machine-readable category for an expected handler failure. */
  readonly errorType?: ApiError['type'];
  /** Transport-neutral code aligned with GraphQL's extensions.code values. */
  readonly errorCode?: string;
  readonly error?: string;
}

/**
 * MCP Apps (SEP-1865) UI binding for a tool: which `ui://` resource the host
 * should render for this tool's results. `visibility` defaults to
 * `["model","app"]`; `["app"]` makes a tool widget-callable but model-hidden.
 */
export interface KernelMcpToolUi {
  readonly resourceUri: string;
  readonly visibility?: readonly ('model' | 'app')[];
}

export interface KernelMcpTool {
  readonly name: string; // `<verb>_<domain>_<noun>`
  readonly title?: string;
  readonly description: string;
  readonly inputShape: ZodRawShape;
  /** Reject unknown top-level keys instead of Zod's default strip behavior. */
  readonly strictInput?: boolean;
  /** Present ⇒ hosts that support MCP Apps render this tool's results as a widget. */
  readonly ui?: KernelMcpToolUi;
  handler(args: Record<string, unknown>): Promise<McpToolOutput>;
}

/**
 * A kernel-served MCP resource. Widget templates (`ui://` URIs with the
 * MCP Apps HTML mimetype) and static guides both fit; `meta` rides into the
 * resource's `_meta` (e.g. `{ ui: { prefersBorder: true, csp: {...} } }`).
 */
export interface KernelMcpResource {
  readonly name: string;
  readonly uri: string;
  readonly title?: string;
  readonly description?: string;
  /** Defaults to the MCP Apps HTML mimetype for `ui://` URIs. */
  readonly mimeType?: string;
  readonly meta?: Readonly<Record<string, unknown>>;
  readonly text: string;
}
