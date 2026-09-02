/**
 * Node module-customization hooks that let `scripts/gm/gen-client-corpus.mts`
 * import the CLIENT repo's TypeScript builders as they are, without Vite:
 *
 * - `@/…` (the client's tsconfig path alias) → `<client>/src/…`; extension
 *   probing is left to tsx's own resolver further down the chain;
 * - `@lingui/core/macro` and `@lingui/react/macro` (compile-time macros) →
 *   `lingui-macro-shim.mts`;
 * - inside client sources only, `import.meta.env` / `import.meta.glob`
 *   (Vite compile-time constructs) → `globalThis.gmViteEnv` /
 *   `globalThis.gmViteGlob`, which the generator defines before
 *   importing anything. This is a textual substitution of Vite's meta, not a
 *   change to any builder's logic.
 *
 * Registered by the generator via `module.register(url, { data })`.
 */

import path from 'node:path';
import { pathToFileURL } from 'node:url';

import type { InitializeHook, LoadHook, ResolveHook } from 'node:module';

export interface ClientModuleHookData {
  /** Absolute path of `<client>/src`. */
  clientSrc: string;
  /** `file://` URL of the Lingui macro shim module. */
  linguiShimUrl: string;
}

const LINGUI_MACROS = new Set(['@lingui/core/macro', '@lingui/react/macro']);

let clientSrc = '';
let clientSrcUrlPrefix = '';
let linguiShimUrl = '';

export const initialize: InitializeHook = (data: unknown) => {
  const hookData = data as ClientModuleHookData;
  clientSrc = hookData.clientSrc;
  clientSrcUrlPrefix = pathToFileURL(clientSrc + path.sep).href;
  linguiShimUrl = hookData.linguiShimUrl;
};

export const resolve: ResolveHook = (specifier, context, nextResolve) => {
  if (LINGUI_MACROS.has(specifier)) {
    return { url: linguiShimUrl, shortCircuit: true };
  }
  if (specifier.startsWith('@/')) {
    return nextResolve(path.join(clientSrc, specifier.slice(2)), context);
  }
  return nextResolve(specifier, context);
};

export const load: LoadHook = async (url, context, nextLoad) => {
  const result = await nextLoad(url, context);
  if (!url.startsWith(clientSrcUrlPrefix) || result.source === undefined) {
    return result;
  }
  const text =
    typeof result.source === 'string'
      ? result.source
      : Buffer.from(result.source as Uint8Array).toString('utf8');
  if (!text.includes('import.meta.')) return result;
  return {
    ...result,
    source: text
      .replace(/import\.meta\.env\b/g, 'globalThis.gmViteEnv')
      .replace(/import\.meta\.glob\b/g, 'globalThis.gmViteGlob'),
  };
};
