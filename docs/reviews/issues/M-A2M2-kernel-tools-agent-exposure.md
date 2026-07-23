# A2-M2 — Agent auto-exposes every kernel tool with no user-scope / mutation guard

|                       |                                                                                                                                       |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| **Original severity** | Medium (latent)                                                                                                                       |
| **Verified verdict**  | Confirmed · Severity unchanged (latent guard-rail gap; safe today)                                                                    |
| **Domain**            | mcp / auth                                                                                                                            |
| **Modules / files**   | `src/modules/agent/shell/tools/kernel-tools.ts:12-24`, `src/modules/shared/shell/mcp/types.ts:44-51`, `src/modules/agent/index.ts:78` |
| **Fix effort**        | S                                                                                                                                     |
| **Merge-blocker?**    | no (all current tools read-only)                                                                                                      |

## TL;DR

`kernelToolsToAiTools` (kernel-tools.ts:12-24) wraps **every** `KernelMcpTool` into the agent's `ToolSet` and calls `kernelTool.handler(args)` with **no user context and no per-tool gating**. The `KernelMcpTool` contract (types.ts:44-51) has **no `readonly`/`agentSafe`/user-scope marker**. All ~76 registered tools today are read-only public queries (verbs: `get_/list_/search_/rank_/aggregate_/resolve_/company_`), so it is safe now. The risk is latent: the first mutating or user-scoped kernel tool added anywhere is **auto-handed to every authenticated agent user with no ownership check**. Fix: add an explicit `agentSafe`/`readonly` marker (or allowlist) and filter on the agent side.

## Evidence (re-verified against current code)

Blanket wrap, no context, no filter (`kernel-tools.ts:12-24`):

```ts
export const kernelToolsToAiTools = (tools: readonly KernelMcpTool[]): ToolSet => {
  const toolSet: ToolSet = {};
  for (const kernelTool of tools) {
    // EVERY tool, unconditionally
    toolSet[kernelTool.name] = tool({
      description: kernelTool.description,
      inputSchema: kernelToolInputSchema(kernelTool),
      execute: async (args) => kernelTool.handler(args), // no userId, no ownership check
    });
  }
  return toolSet;
};
```

Wired verbatim into the agent's `toolSet` (`agent/index.ts:78`): `toolSet: kernelToolsToAiTools(deps.tools)`. The same `deps.tools` feed the public MCP surface — one registry, two consumers.

Contract has no capability marker (`shared/shell/mcp/types.ts:44-51`):

```ts
export interface KernelMcpTool {
  readonly name: string;
  readonly description: string;
  readonly inputShape: ZodRawShape;
  readonly strictInput?: boolean;
  handler(args: Record<string, unknown>): Promise<McpToolOutput>;
}
```

No `readonly`, `mutation`, `agentSafe`, or `scope` field. Nothing an agent-side filter _could_ key on even if it wanted to.

Current tool set is entirely read-only — enumerated all registered names:
`grep -rhoE "name: '[a-z_]+'" src/modules/*/shell/mcp/` → verbs are exclusively `aggregate_`, `company_`, `get_`, `list_`, `rank_`, `resolve_`, `search_`. A targeted `grep -iE 'create|update|delete|set_|submit|write|insert|remove|patch|put_'` over the same names → **NO MUTATING TOOLS**. So no exploit today.

## Root cause

The agent-tool adapter treats the kernel MCP registry as a flat, uniformly-safe capability set. Safety is currently an _emergent property of the tool inventory_ (all happen to be read-only public), not an _enforced invariant_. There is no marker on the contract and no allowlist on the agent side, so nothing prevents a future tool from being auto-exposed.

## Blast radius & impact

- **Today: none** — all ~76 tools are read-only public-data queries; handing them to authenticated agent users is the intended design.
- **Latent:** any future kernel tool that (a) mutates state, or (b) returns data scoped to a _specific_ user/owner, is **automatically** added to every authenticated user's agent `ToolSet` with `handler(args)` invoked using only the model-supplied `args` — no `userId` binding, no ownership assertion. A user could then invoke it (directly via crafted args, or the model could be steered to) against arbitrary targets.
- The MCP surface shares the same registry, so a mutating tool would also land there — but this issue is specifically the agent side's missing guard-rail.

## Reproduction / falsifiable scenario

No runtime repro today (no qualifying tool). Falsifiable design test: add a hypothetical `update_x` / `get_my_drafts(ownerId)` `KernelMcpTool` to any module registry → without code change it appears in `kernelToolsToAiTools(deps.tools)` output and is callable by every authenticated `/chat` user with attacker-chosen `args`. A guard-rail test should assert that the agent `ToolSet` only contains tools flagged agent-safe.

## Additional context discovered

- `McpToolOutput` (types.ts:22-42) carries a leak-audit guarantee for _output_ PII, but that is about response shaping, not authorization to _invoke_ — it does not bind the caller to a user scope.
- The adapter comment (kernel-tools.ts:5-6, 16-20) frames the design as "one canonical definition, two consumers, zero drift" — good for read tools, but it also means any drift toward mutation propagates to the agent automatically.

## Fix options

- **Option A (recommended):** add an explicit capability marker to `KernelMcpTool` (`readonly?: boolean` defaulting to read-only, or `agentSafe?: boolean`) and filter in `kernelToolsToAiTools` so only agent-safe tools are wrapped. Fail-closed: exclude unless explicitly marked safe. Cheap, and makes the invariant enforced rather than emergent.
- **Option B:** maintain an explicit allowlist of tool names on the agent side. Simpler but drifts from the registry and needs manual upkeep each time a read tool is added.
- **Option C (complementary):** when user-scoped tools eventually exist, thread the authenticated `userId` into `execute` and require handlers to assert ownership. Needed regardless once mutation lands.

Recommend A now (marker + fail-closed filter) plus a test pinning the agent `ToolSet` to only marked-safe tools.

## Related

- Sibling: [M-A2M1](M-A2M1-quota-reconcile-overcharge.md).
- Ties to the H3 unthrottled-MCP and MCP-surface reviews (shared kernel tool registry).
