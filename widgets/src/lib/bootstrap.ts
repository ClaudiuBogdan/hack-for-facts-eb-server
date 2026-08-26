/**
 * Widget bootstrap — one `App` per iframe, wired for theme + tool results.
 *
 * The host pushes `ui/notifications/tool-result` after render; we hand the
 * `structuredContent` (the kernel `McpToolOutput`) to the widget's render
 * function. `autoResize` keeps the iframe height synced to the document.
 */

import { App } from '@modelcontextprotocol/ext-apps';

import type { McpUiHostContext } from '@modelcontextprotocol/ext-apps';

export interface ToolEnvelope {
  readonly ok: boolean;
  readonly kind: string;
  readonly query?: unknown;
  readonly link?: string;
  readonly item?: unknown;
  readonly items?: readonly unknown[];
  readonly meta?: Record<string, unknown>;
  readonly summary?: string;
  readonly error?: string;
}

const applyTheme = (context: McpUiHostContext | undefined): void => {
  const theme = context?.theme;
  if (theme === 'dark' || theme === 'light') {
    document.documentElement.dataset['theme'] = theme;
  }
  // No host theme → leave unset so the prefers-color-scheme fallback decides.
};

/**
 * ChatGPT extension layer: theme arrives via `window.openai.theme` +
 * `openai:set_globals`, not the MCP Apps host context. Feature-detected.
 */
const wireOpenaiTheme = (): void => {
  const w = window as { openai?: { theme?: string } };
  const fromGlobal = (): void => {
    const theme = w.openai?.theme;
    if (theme === 'dark' || theme === 'light') {
      document.documentElement.dataset['theme'] = theme;
    }
  };
  fromGlobal();
  window.addEventListener('openai:set_globals', fromGlobal);
};

export interface WidgetHandle {
  openLink(url: string): void;
}

export const bootstrapWidget = (
  name: string,
  render: (output: ToolEnvelope, handle: WidgetHandle) => void
): void => {
  const app = new App({ name, version: '1.0.0' }, undefined, { autoResize: true });

  const handle: WidgetHandle = {
    openLink(url: string): void {
      void app.openLink({ url }).catch(() => {
        /* host may decline; nothing to do */
      });
    },
  };

  wireOpenaiTheme();

  app.ontoolresult = (result) => {
    const output = result.structuredContent as ToolEnvelope | undefined;
    if (output !== undefined) render(output, handle);
  };
  app.onhostcontextchanged = (context) => {
    applyTheme(context);
  };

  void app
    .connect()
    .then(() => {
      applyTheme(app.getHostContext());
    })
    .catch((error: unknown) => {
      const root = document.getElementById('root');
      if (root !== null) {
        root.textContent = 'Nu s-a putut inițializa vizualizarea.';
      }
      console.error(`[${name}] connect failed`, error);
    });
};
