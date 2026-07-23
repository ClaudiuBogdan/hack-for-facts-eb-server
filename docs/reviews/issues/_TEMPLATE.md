# <ID> — <Short title>

|                       |                                                                              |
| --------------------- | ---------------------------------------------------------------------------- |
| **Original severity** | <High / Medium>                                                              |
| **Verified verdict**  | <Confirmed · Severity unchanged / Revised → X / Refuted / Needs-owner-input> |
| **Confidence**        | <CONFIRMED / PLAUSIBLE>                                                      |
| **Domain**            | <erasure · mcp · auth · privacy · procurement · correctness · architecture>  |
| **Modules / files**   | <primary paths>                                                              |
| **Fix effort**        | <S / M / L>                                                                  |
| **Merge-blocker?**    | <yes / no / owner-call>                                                      |

## TL;DR

_2–4 lines: what the bug is, whether it's real, and the one-line fix direction._

## Evidence (re-verified against current code)

_Exact `file:line` + minimal code excerpts you actually read. State what you confirmed vs. what you couldn't (e.g. needs a live DB)._

## Root cause

_Why it happens — the specific logic/wiring gap._

## Blast radius & impact

_Who/what is affected, the preconditions that must hold, when it fires, and what data/behavior is wrong or exposed. Note anything that bounds it (self-heals, dormant, requires config drift)._

## Reproduction / falsifiable scenario

_Concrete inputs → wrong outcome. A test sketch or curl/GraphQL/MCP call if applicable._

## Additional context discovered

_New findings from digging: other call sites, related tests (do they cover it?), config gates, whether the same bug class exists elsewhere, git history of the area, doc claims that conflict._

## Fix options

_Option A / B with trade-offs; mark the recommended one. Note any test that should be added to pin it._

## Related

_Links to sibling issue files ([H1](H1-...md)) and the main report section._
