/**
 * Shared Kernel — MCP tool registration contract (foundation §6.3, §7.4).
 *
 * Each module contributes `KernelMcpTool`s; the kernel registers them into one
 * MCP server. A tool declares a Zod input shape (the SDK's `registerTool`
 * requires a Zod raw shape) and a handler returning the structured output object
 * `{ ok, kind, query?, link?, item|items?, summary? }`.
 */

import type { ZodRawShape } from 'zod';

/** The structured object every kernel/module MCP tool returns (§6.3). */
export interface McpToolOutput {
  readonly ok: boolean;
  readonly kind: string;
  readonly query?: unknown;
  readonly link?: string;
  readonly item?: unknown;
  readonly items?: readonly unknown[];
  readonly summary?: string;
  readonly error?: string;
}

export interface KernelMcpTool {
  readonly name: string; // `<verb>_<domain>_<noun>`
  readonly description: string;
  readonly inputShape: ZodRawShape;
  handler(args: Record<string, unknown>): Promise<McpToolOutput>;
}
