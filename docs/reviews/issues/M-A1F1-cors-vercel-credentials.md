# M-A1F1 — CORS glob `*`→`.*` reflects credentialed origins

|                       |                                                                                                             |
| --------------------- | ----------------------------------------------------------------------------------------------------------- |
| **Original severity** | Medium                                                                                                      |
| **Verified verdict**  | Refuted (as stated) → Revised → Low (latent code hardening)                                                 |
| **Confidence**        | CONFIRMED                                                                                                   |
| **Domain**            | auth                                                                                                        |
| **Modules / files**   | `src/infra/plugins/cors.ts:33-38,149,178`; `k8s/overlays/{prod,dev}/secrets/app-secret.secret.yaml`; `.env` |
| **Fix effort**        | S                                                                                                           |
| **Merge-blocker?**    | no                                                                                                          |

## TL;DR

The `globToRegex` weakness is real: `*`→`.*` (not `[^.]*`) plus origin reflection (`isOriginAllowed`) plus `credentials: true` would let any `*.vercel.app` deploy be reflected as a credentialed origin. But the stated attack does **not** hold for any deployed environment: **production and dev `ALLOWED_ORIGINS` contain no wildcards at all** — only exact `https://…transparenta.eu` origins. The `*.vercel.app` / `*.transparenta.eu` wildcards exist **only** in a developer's local, malformed `.env`. And auth is **Bearer-only (no cookies)**, so even a reflected credentialed origin carries no ambient user session to steal. Keep the `*`→`[^.]*` hardening as defense-in-depth; it is not a live vulnerability.

## Evidence (re-verified against current code)

- `cors.ts:33-38` — `globToRegex` escapes regex metachars **except** `*`, then `replace(/\*/g, '.*')`. So `https://*.vercel.app` → `/^https:\/\/.*\.vercel\.app$/`. `.*` crosses dots (multi-label) and matches any single-label subdomain too.
- `cors.ts:82-86` — `isOriginAllowed` tests the **raw** origin against `allowed.patterns` (exact set uses normalized origin; patterns use raw).
- `cors.ts:149` — in production the matched origin is passed to `cb(null, true)`, and `@fastify/cors` reflects the specific request origin.
- `cors.ts:178` — `credentials: true`.
- **Actual deployed config (decisive):**
  - `k8s/overlays/prod/secrets/app-secret.secret.yaml:17` → `ALLOWED_ORIGINS: "https://transparenta.eu,https://www.transparenta.eu,https://clerk.transparenta.eu"` — **three exact origins, zero wildcards.**
  - `k8s/overlays/dev/secrets/app-secret.secret.yaml:15` → `https://dev.transparenta.eu,https://www.dev.transparenta.eu,https://clerk.dev.transparenta.eu,http://localhost:3000` — exact only.
  - `k8s/base/configmap.yaml:15` → `# ALLOWED_ORIGINS: "" # Set in overlays`.
- The only wildcard config anywhere is the untracked local `.env:8`: `ALLOWED_ORIGINS: "https://*.transparenta.eu,http://localhost:*,https://localhost:*,https://*.vercel.app,http://localhost:3000"` — and note it is written `ALLOWED_ORIGINS:` **with a colon, not `=`**, so `dotenv` (KEY=VALUE) will not even parse it into the environment.
- **Auth surface is Bearer/API-key, not cookies:** `src/modules/auth/shell/extractors/http-extractor.ts` extracts `Authorization: Bearer <token>`; `mcp-extractor.ts` + `gpt-auth.ts` use bearer / `x-api-key`. Repo-wide grep for cookie/session auth found none (only `campaign-admin/shell/rest/csv.ts:88` sets a `Vary: …Cookie` header — not auth). No `@fastify/cookie`/`@fastify/session` in use.

## Root cause

`*`→`.*` is an over-broad translation, and the CORS callback reflects the origin with `credentials: true`. This is a latent footgun that becomes exploitable **only if** a wildcard origin over a shared multi-tenant apex (e.g. `*.vercel.app`) is ever configured in a deployed environment.

## Blast radius & impact

Preconditions that must ALL hold for real impact — none currently do:

1. A wildcard over an attacker-registrable apex must be in a deployed `ALLOWED_ORIGINS` (prod/dev have none).
2. An authenticated surface must rely on **ambient browser credentials** (cookies/basic) — this app uses `Authorization: Bearer`, which the browser never auto-attaches cross-origin, so a reflected origin gains only anonymous access (equivalent to curl).

Given (1) and (2) are both false, the credential-theft/CSRF blast radius is effectively nil today. The residual risk is purely forward-looking: an operator adding `https://*.transparenta.eu` for preview deploys would silently also admit deeper/adjacent labels via `.*`.

## Reproduction / falsifiable scenario

Not reproducible against prod/dev config. Hypothetical only: set `ALLOWED_ORIGINS=https://*.vercel.app`, then `curl -H 'Origin: https://evil-abc.vercel.app' https://api/...` returns `Access-Control-Allow-Origin: https://evil-abc.vercel.app` + `Access-Control-Allow-Credentials: true`. Even then, absent cookies, a browser attack yields no authenticated data.

## Additional context discovered

- Production intentionally lists `clerk.transparenta.eu` (Clerk auth) as an exact origin — consistent with token-based auth, no wildcard.
- `http://localhost:*` / `https://localhost:*` in the local `.env` would (if parsed) be admitted in prod too, but localhost origins can only be the victim's own machine — negligible.
- No test covers `globToRegex`; a wildcard regression would ship silently. This is the strongest reason to harden the function now.

## Fix options

- **A (recommended, cheap hardening):** In `globToRegex`, map `*`→`[^.]*` (single-label), and **reject degenerate globs** (a bare `*`, or a wildcard that would span the registrable apex). Add a unit test pinning `https://*.transparenta.eu` matches `a.transparenta.eu` but **not** `a.b.transparenta.eu` or `transparenta.eu.evil.com`.
- **B (policy):** Forbid wildcards entirely; require exact preview origins (matches how prod/dev are already configured). Fail startup if `ALLOWED_ORIGINS` contains `*`.
- **C (independent cleanup):** Fix the malformed local `.env` line (`:` → `=`) and drop the `*.vercel.app`/localhost wildcards from it so a dev copying it into a deployment cannot introduce the footgun.

Recommend A + C. Not a merge-blocker.

## Related

Ties to the MCP auth/exposure cluster ([H3](H3-unthrottled-public-mcp.md)). Main report: A1-F1.
