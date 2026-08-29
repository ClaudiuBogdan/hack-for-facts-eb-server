# # Reliable local testing workflow for MCP Apps (SEP-1865) before deploying

<!--
@web-flow begin
kind: prompt
id: prompt-20260826080223629
timestamp: "2026-08-26T08:02:23.629Z"
schema: web-flow/research/v1
version: 1
-->

# Reliable local testing workflow for MCP Apps (SEP-1865) before deploying

I built an MCP server (TypeScript, @modelcontextprotocol/sdk, Fastify, stateless JSON-only Streamable HTTP — each POST answered with plain JSON, no SSE stream, no session ids) and I am adding MCP Apps UI (the ratified SEP-1865 extension, `@modelcontextprotocol/ext-apps` 1.7.x, resources with mimetype `text/html;profile=mcp-app`, tool `_meta.ui.resourceUri`). Target hosts: claude.ai custom connectors and ChatGPT developer mode (both support MCP Apps as of 2026).

Find current, practical, verified guidance (2026) on:

1. The best LOCAL test loop for MCP Apps widgets before any deploy:
   - The `basic-host` example from github.com/modelcontextprotocol/ext-apps (`SERVERS='["http://localhost:3001/mcp"]' npm start`, UI at :8080) — does it work against any MCP server URL, and does it render the widget iframe + bridge faithfully compared to claude.ai/ChatGPT?
   - Does MCP Inspector (`npx @modelcontextprotocol/inspector`) render MCP Apps HTML views now, or only list resources?
   - Any other official/community MCP Apps preview hosts or "widget dev servers" with hot reload.
2. ChatGPT developer mode testing over a tunnel (ngrok): known gotchas — connector caching of tools/list and resources (when is "Refresh" needed, when does a new conversation matter), requirements on the endpoint path, and whether a JSON-only (no SSE) stateless Streamable HTTP server works with ChatGPT connectors or whether ChatGPT requires GET/SSE stream support.
3. claude.ai custom connectors against a local tunnel (`cloudflared tunnel --url http://localhost:PORT` or ngrok): does claude.ai require any SSE/GET stream on the MCP endpoint or is POST JSON enough; how fast does claude.ai pick up changed tool metadata / changed widget HTML (any caching); does the widget sandbox (claudemcpcontent.com) work against tunnel-hosted servers.
4. Common first-run failures people hit with MCP Apps widgets in claude.ai and ChatGPT (CSP blocks, `ui/initialize` handshake never completing, widget shows blank, size/height issues) and their fixes.

Prefer official docs (modelcontextprotocol.io, claude.com/docs, developers.openai.com) and recent (2026) firsthand reports. Give concrete commands and exact setting names/paths. Flag anything uncertain.
<!-- @web-flow end id=prompt-20260826080223629 -->

<!--
@web-flow begin
kind: response
status: completed
provider: chatgpt
url: "https://chatgpt.com/c/6a8e9dbc-8310-83eb-85eb-620b5e8af4ab"
id: response-20260826080312754-chatgpt
prompt_id: prompt-20260826080223629
timestamp: "2026-08-26T08:10:20.884Z"
schema: web-flow/research/v1
version: 1
-->

## Bottom line

For an MCP Apps server like yours, I would standardize on this development loop:

```text
1. Local MCP server
   ↓
2. ext-apps basic-host        ← fastest widget/bridge loop
   ↓
3. MCP Inspector Apps tab     ← protocol + resource + bridge debugging
   ↓
4. optional MCPJam            ← richer host/device/CSP emulation
   ↓
5. persistent HTTPS tunnel
   ↓
6. ChatGPT + Claude.ai        ← final host-specific smoke test
```

Your **stateless, JSON-response Streamable HTTP design is valid**. You do **not** need SSE streaming or session IDs for ChatGPT, and there is no MCP-level reason Claude should require SSE either. OpenAI's own current MCP Apps quickstart uses exactly:

```ts
new StreamableHTTPServerTransport({
  sessionIdGenerator: undefined,
  enableJsonResponse: true,
});
```

However, I would change one aspect of a literally POST-only Fastify route: implement `GET /mcp` and return **405 Method Not Allowed** when you don't support the server→client SSE stream. That is what the Streamable HTTP spec requires. A client MAY issue GET; the server must either provide an SSE stream or answer 405. ([OpenAI Developers][1])

---

# 1. Best local MCP Apps test loop

## A. `ext-apps/examples/basic-host`: use this as your primary widget loop

Yes. This is currently the most useful **minimal local MCP Apps host**.

The official MCP Apps repo explicitly recommends:

```bash
git clone https://github.com/modelcontextprotocol/ext-apps.git
cd ext-apps
npm install

cd examples/basic-host

SERVERS='["http://localhost:3001/mcp"]' npm start
```

Then:

```text
http://localhost:8080
```

The `SERVERS` variable accepts an array of MCP server URLs, not just one hard-coded example:

```bash
SERVERS='[
  "http://localhost:3001/mcp",
  "http://localhost:4001/mcp"
]' npm start
```

([GitHub][2])

### Does it work with "any" MCP URL?

Practically: **any reachable, compatible MCP Streamable HTTP server URL**.

Not literally every possible MCP server:

- it must be reachable from the host/proxy;
- authentication may introduce additional requirements;
- your local HTTP server needs appropriate CORS behavior;
- stdio obviously isn't represented by an HTTP URL;
- host-specific extensions aren't necessarily reproduced.

The official example defaults to `http://localhost:3001/mcp`, but `SERVERS` is explicitly arbitrary URLs. ([GitHub][3])

For your Fastify server, I would enable permissive CORS during local development. OpenAI's own local example handles `/mcp` preflight and permits `POST`, `GET`, and `OPTIONS`. ([OpenAI Developers][1])

### How faithful is it to Claude/ChatGPT?

**Protocol-faithful: yes. Host-faithful: no.**

The interesting thing about `basic-host` is that it isn't just dumping your HTML into an ordinary iframe. It implements the reference security architecture:

```text
Host :8080
 └─ outer sandbox/proxy iframe :8081
      └─ inner srcdoc iframe containing your MCP App
```

The outer iframe validates and relays messages between the app and host. That exercises the MCP Apps bridge and sandboxing model meaningfully. ([GitHub][3])

It is good for testing:

- `ui/initialize`
- `ui/notifications/initialized`
- tool input/result delivery
- app→server tool calls
- `ui/notifications/size-changed`
- host context
- iframe restrictions
- bridge lifecycle
- tool/resource association

But it **cannot guarantee identical behavior** to Claude.ai or ChatGPT because those hosts have their own:

- CSP enforcement;
- iframe origins;
- resource caching;
- sizing policy;
- host context;
- display-mode implementation;
- optional extensions;
- authentication/network behavior.

So I would use `basic-host` as the fast inner loop, never as the final compatibility test.

---

## B. MCP Inspector now really does render MCP Apps

This has changed materially during 2026.

**Current MCP Inspector has an `Apps` tab and actually renders the MCP App.** It is no longer limited to listing the UI resource.

Run:

```bash
npx @modelcontextprotocol/inspector@latest
```

Connect with:

```text
Transport: Streamable HTTP
URL:       http://localhost:3001/mcp
```

Then go to:

```text
Apps
 → select your app/tool
 → Open App
```

The current Inspector documentation explicitly says its MCP App fixture renders in a sandbox iframe and exercises:

- host-context rendering;
- `size-changed`;
- `ui/message`;
- app logs.

([GitHub][4])

OpenAI's own MCP Apps quickstart also currently tells developers to test locally with:

```bash
npx @modelcontextprotocol/inspector@latest
```

before tunneling the server to ChatGPT. ([OpenAI Developers][1])

### One Inspector gotcha in 2026

Inspector now has support for the newer **2026-07-28 "modern" protocol era**, but its MCP Apps demo is explicitly a **legacy/default-era Streamable HTTP app**. The Inspector README says to connect that MCP Apps fixture using the default/legacy protocol era rather than `Modern`. ([GitHub][4])

For an `@modelcontextprotocol/sdk` 1.x + `ext-apps` 1.7.x implementation like yours, I would therefore start with the default protocol mode unless you've deliberately implemented the newer core protocol era.

---

## Which one should you use?

Both:

| Test                                | Best tool                |
| ----------------------------------- | ------------------------ |
| Fast UI changes                     | `basic-host`             |
| `ui/initialize` / bridge behavior   | `basic-host` + Inspector |
| Verify `_meta.ui.resourceUri`       | Inspector                |
| Verify `resources/read`             | Inspector                |
| Inspect exact JSON-RPC              | Inspector                |
| Test iframe behavior                | Both                     |
| Reproduce ChatGPT-specific behavior | ChatGPT                  |
| Reproduce Claude-specific behavior  | Claude                   |
| Device/theme/client emulation       | MCPJam                   |

If something works in Inspector but fails in Claude/ChatGPT, you have already narrowed the problem to **host-specific behavior**, which is extremely useful.

---

## C. MCPJam is currently the best richer community previewer I found

MCPJam is not an MCP-spec authority, but it is substantially more featureful as a UI debugging environment:

```bash
npx @mcpjam/inspector@latest
```

Its current widget tooling includes:

- MCP Apps UI rendering;
- ChatGPT Apps rendering;
- JSON-RPC tracing;
- Chrome-DevTools-style widget emulator;
- client emulation;
- different viewport/device conditions.

([GitHub][5])

I'd put it **after** official Inspector/basic-host, not before them.

### Dedicated official hot-reload widget server?

I did **not** find a separate first-party "MCP Apps Storybook" or host-faithful HMR server that supersedes `basic-host`.

OpenAI's current recommendation is essentially:

```text
watch/rebuild widget bundle
+
hot-reload/restart MCP server
```

They specifically say you can rebuild the component as React changes and hot-reload the server. ([OpenAI Developers][6])

For your setup I'd do:

```bash
# terminal 1
npm run dev:server

# terminal 2
npm run dev:ui

# terminal 3
SERVERS='["http://localhost:3001/mcp"]' npm start
```

and have the MCP resource handler read the latest generated HTML/bundle on each `resources/read` rather than importing it once at process startup.

---

# 2. ChatGPT developer mode + ngrok

## Transport: your JSON-only stateless approach is fine

This is the clearest finding.

OpenAI's **current official example** is:

```ts
const transport = new StreamableHTTPServerTransport({
  sessionIdGenerator: undefined,
  enableJsonResponse: true,
});
```

So:

- stateless: **yes**
- no MCP session ID: **yes**
- JSON response to POST: **yes**
- SSE response required: **no**

([OpenAI Developers][1])

That effectively matches the architecture you described.

### But make `GET /mcp` return 405

The MCP Streamable HTTP spec states:

> A client MAY issue GET to the MCP endpoint.

If it does, your server must either:

1. return `text/event-stream`, or
2. return **405 Method Not Allowed**.

([Model Context Protocol][7])

So instead of:

```text
POST /mcp   → works
GET  /mcp   → Fastify 404
```

I recommend:

```text
POST   /mcp → JSON MCP
GET    /mcp → 405
DELETE /mcp → 405 for stateless server
OPTIONS     → CORS preflight
```

The important distinction is:

> **"No SSE" is compliant. "POST-only route that accidentally returns 404 on GET" isn't the ideal Streamable HTTP implementation.**

Whether ChatGPT currently probes GET in every connection flow is an implementation detail I would not rely on.

---

## Endpoint path

OpenAI's current docs explicitly instruct developers to tunnel the port:

```bash
ngrok http 3001
```

and register the complete MCP URL:

```text
https://xxxx.ngrok.app/mcp
```

not merely:

```text
https://xxxx.ngrok.app
```

([OpenAI Developers][1])

`/mcp` isn't intrinsically magical in MCP — your endpoint can conceptually have another path — but ChatGPT must be configured with the **exact endpoint URL**.

I would keep `/mcp` because it matches essentially every current example and eliminates one variable.

---

## Current ChatGPT setting path

As of the docs I checked today:

```text
ChatGPT
 → Settings
 → Security and login
 → Developer mode
```

Then:

```text
ChatGPT Plugins
 → +
 → create developer-mode app
 → HTTPS MCP URL
```

And within a conversation:

```text
+
 → Developer mode
 → select your app
```

([OpenAI Developers][8])

---

# ChatGPT caching: there are two separate caches to think about

This distinction is important.

## 1. MCP tool/schema metadata

After changing:

- tools;
- descriptions;
- schemas;
- `_meta`;
- server instructions;
- related MCP configuration;

**Refresh the plugin/app connection.**

OpenAI explicitly says:

> Refresh the plugin connection after each change to the MCP server.

The refresh is on the app's detail page under `chatgpt.com/plugins`. ([OpenAI Developers][1])

The Developer Mode docs likewise say Refresh pulls new:

- tools;
- descriptions;
- server instructions.

([OpenAI Developers][8])

So your loop should be:

```text
change tool metadata
       ↓
restart/hot reload server
       ↓
ChatGPT Plugins → your draft → Refresh
       ↓
invoke again
```

---

## 2. Widget HTML/resource caching

This is different.

OpenAI explicitly instructs developers:

> Treat the resource URI as a cache key.

If HTML/JS/CSS changes materially:

```text
ui://video-editor/v1.html
```

should become something like:

```text
ui://video-editor/v2.html
```

and `_meta.ui.resourceUri` must also be updated. ([OpenAI Developers][6])

For development, I'd automate this.

For example:

```ts
const UI_VERSION = process.env.UI_VERSION ?? 'dev-42';

const UI_URI = `ui://video-editor/${UI_VERSION}/index.html`;
```

Then:

```bash
UI_VERSION=dev-43 npm run dev
```

or use a build/content hash.

This is considerably more reliable than wondering whether ChatGPT has fetched the latest `resources/read` response.

### Recommended ChatGPT update procedure

For UI code:

```text
1. rebuild HTML
2. bump ui:// URI
3. update tool _meta.ui.resourceUri
4. Refresh app in ChatGPT
5. invoke tool again
```

That gives you deterministic invalidation.

---

## Does a new ChatGPT conversation clear it?

**Not documented as a cache invalidation mechanism.**

OpenAI tells you to open a new conversation when initially connecting/using an app, but its actual refresh mechanism for MCP definitions is the app **Refresh** operation. ([OpenAI Developers][1])

A new conversation can be useful if the current conversation still behaves oddly because:

- the app was selected before a refresh;
- an old widget instance is already mounted;
- existing conversation state contains earlier tool behavior.

But I would not use:

```text
new conversation = clear connector cache
```

as a reliable rule.

Instead:

```text
tool metadata → Refresh connector
widget HTML   → version resourceUri
stale chat    → new conversation as fallback
```

That distinction is supported much better by the current docs.

---

# 3. Claude.ai over Cloudflare/ngrok

## Tunnel workflow is officially recommended

Anthropic currently recommends exposing a local MCP server through a public tunnel for testing, **including MCP Apps**:

```bash
npx cloudflared tunnel --url http://localhost:3001
```

or:

```bash
ngrok http 3001
```

Then configure:

```text
https://<tunnel-host>/mcp
```

as your custom connector. ([Claude][9])

So tunnel-hosted MCP Apps are not some accidental unsupported path; Anthropic explicitly recommends this development workflow.

---

## Does Claude require SSE?

**No evidence that it does, and the protocol says it shouldn't.**

Anthropic says Claude's preferred MCP transport is:

```text
Streamable HTTP
```

with legacy HTTP+SSE being deprecated. ([Claude][10])

Their current examples POST directly to `/mcp` with:

```http
Accept: application/json, text/event-stream
```

([Claude][11])

A Streamable HTTP server is allowed to choose a JSON response rather than SSE for a POST.

Therefore your:

```text
stateless
sessionless
POST → application/json
```

server architecture is protocol-valid.

### My qualification

I found an **explicit OpenAI implementation example** demonstrating `enableJsonResponse: true`.

I did **not** find an equally explicit Anthropic example saying:

> "Claude.ai has been tested with `enableJsonResponse: true` and no SSE."

So I would classify this as:

**High confidence based on MCP transport semantics and Claude's declared Streamable HTTP support, but not separately documented by Anthropic as a named JSON-only mode.**

Again, add `GET /mcp → 405` and you eliminate the main protocol ambiguity.

---

# Claude's `claudemcpcontent.com` sandbox + tunnel: important gotcha

Claude uses a sandbox domain derived from your MCP server URL.

Anthropic's current cross-platform MCP Apps documentation says that for Claude you can calculate `Resource._meta.ui.domain` as:

```bash
node -e '
const yourServerUrl = "https://example.com/mcp";
console.log(
  require("crypto")
    .createHash("sha256")
    .update(yourServerUrl)
    .digest("hex")
    .slice(0,32) + ".claudemcpcontent.com"
)
'
```

([Claude][12])

Therefore:

```text
https://foo.ngrok.app/mcp
```

and

```text
https://bar.ngrok.app/mcp
```

have **different Claude sandbox domains**.

This matters particularly with ephemeral ngrok/Cloudflare URLs.

### Practical consequence

If you explicitly set:

```ts
_meta: {
  ui: {
    domain: '....claudemcpcontent.com';
  }
}
```

then restarting an ephemeral tunnel changes the MCP server URL and therefore changes the required hash.

So:

```text
new tunnel URL
 → recompute Claude ui.domain
 → restart MCP server
 → reconnect/refresh connector
```

This is a strong argument for a **stable ngrok reserved domain / named Cloudflare Tunnel** during MCP Apps development.

---

## Does `claudemcpcontent.com` work with a tunnel?

Yes. Anthropic's documentation simultaneously:

1. recommends tunnels for local MCP App testing; and
2. documents Claude's `claudemcpcontent.com` sandbox model.

([Claude][9])

One subtlety:

### MCP resource loading

Your HTML is normally obtained by Claude through:

```text
resources/read(ui://...)
```

so the iframe itself does **not** need to HTTP-GET your `ui://` resource from your ngrok server.

### Browser API calls from the widget

If the widget itself does:

```js
fetch('https://xxxx.ngrok.app/api/foo');
```

that is a browser-origin request from the Claude sandbox.

Now you need both:

```text
CSP connectDomains
+
server-side CORS
```

for the `claudemcpcontent.com` origin.

This is why, where possible, I would prefer:

```text
widget
 → MCP Apps bridge
 → tools/call
 → MCP server
```

over direct browser `fetch()` back to your own backend. It avoids an entire class of iframe CSP/CORS problems.

---

# Claude caching / how quickly changes appear

This is less well documented than ChatGPT.

I found **no official Anthropic TTL or guarantee** for:

- `tools/list` freshness;
- `_meta` refresh timing;
- MCP App HTML caching.

And the MCP Apps spec permits hosts to prefetch/cache UI resources.

So I would not claim something like "Claude refreshes every 30 seconds."

### Safest Claude dev workflow

For changed tool metadata:

```text
server change
 → start a new Claude conversation
```

If stale:

```text
disconnect/reconnect custom connector
```

Anthropic's current troubleshooting documentation explicitly recommends:

- new conversation if the interface doesn't appear;
- refresh/restart if interactions fail;
- disconnect/reconnect the connector if needed.

([Anthropic Help Center][13])

For changed HTML, I would use the same deterministic technique as ChatGPT:

```text
ui://widget/dev-41.html
         ↓
ui://widget/dev-42.html
```

even though Anthropic does not currently document OpenAI's explicit "resource URI = cache key" rule.

That also protects you against the general MCP Apps permission for hosts to cache/prefetch resources.

---

# Claude UI setting path

There is a small documentation/UI naming inconsistency.

Anthropic's developer docs currently describe:

```text
Settings → Connectors
```

for custom connectors. ([Claude][10])

Some newer product surfaces/help material have moved connector discovery/management into the broader Customize/Connectors UI.

So if you don't see the exact developer-doc wording, search for **Connectors** rather than assuming the feature is missing.

---

# 4. First-run MCP Apps failures

These are the ones I would test in this order.

| Symptom                                | Most likely cause                        | Fix                           |
| -------------------------------------- | ---------------------------------------- | ----------------------------- |
| Tool works, no widget                  | wrong/missing `_meta.ui.resourceUri`     | Check `tools/list`            |
| Resource exists, blank iframe          | bridge never initialized                 | `await app.connect()`         |
| Bridge request rejected                | incorrect `ui/initialize` shape          | use ext-apps SDK              |
| HTML appears locally only              | CSP                                      | fix resource `_meta.ui.csp`   |
| JS/CSS absent                          | external bundle blocked                  | inline/build single-file      |
| Claude only blank                      | wrong Claude `ui.domain`, host/CSP issue | recompute domain              |
| Widget height ~0                       | size notification/layout                 | ensure nonzero content/height |
| old UI appears                         | cached `ui://` URI                       | version resource URI          |
| new tool description ignored           | connector metadata cache                 | ChatGPT Refresh               |
| Claude doesn't see change              | connector/conversation state             | new chat/reconnect            |
| widget hydrates locally but not Claude | enormous tool result                     | reduce/paginate result        |

---

## Failure 1: CSP

MCP Apps are **deny-by-default** for external network origins.

Claude explicitly documents:

```ts
_meta: {
  ui: {
    csp: {
      connectDomains: [
        "https://api.example.com"
      ],
      resourceDomains: [
        "https://cdn.example.com"
      ],
      baseUriDomains: []
    }
  }
}
```

All external origins are blocked unless allowed. Claude also currently restricts `frameDomains` more heavily. ([Claude][14])

OpenAI has essentially the same division:

- `connectDomains`: `fetch`/API;
- `resourceDomains`: JS, CSS, images, fonts;
- `frameDomains`: nested iframe sources.

([OpenAI Developers][6])

### Important metadata location

Put the UI CSP on the **resource contents metadata**:

```ts
return {
  contents: [{
    uri: UI_URI,
    mimeType: RESOURCE_MIME_TYPE,
    text: html,
    _meta: {
      ui: {
        csp: {
          ...
        }
      }
    }
  }]
};
```

not arbitrarily on the tool definition.

---

# Failure 2: `ui/initialize` never completes

The safest solution is simply:

```ts
import { App } from "@modelcontextprotocol/ext-apps";

const app = new App({
  name: "My Widget",
  version: "1.0.0",
});

app.ontoolinput = ...
app.ontoolresult = ...

await app.connect();
```

**Register handlers before connecting.**

Claude lists missing `app.connect()` as one of the two most common reasons an MCP App tool executes but its app remains invisible. ([Claude][15])

### Especially relevant 2026 gotcha

There was misleading spec example text earlier this year that caused people to implement the View→Host handshake as regular MCP:

```text
initialize
clientInfo
```

instead of MCP Apps:

```text
ui/initialize
appInfo
appCapabilities
```

A firsthand April 22, 2026 report verified that Claude web/Desktop rejected the wrong shape and left the iframe hidden. ([GitHub][16])

Correct conceptual handshake:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "ui/initialize",
  "params": {
    "appInfo": {
      "name": "My Widget",
      "version": "1.0.0"
    },
    "appCapabilities": {}
  }
}
```

If you're already on `ext-apps` 1.7.x, **do not hand-roll this unless you need to**. Let `App.connect()` do it.

---

# Failure 3: blank widget despite successful resource read

There have been genuine Claude host bugs.

For example, an April 2026 issue reports:

```text
ngrok server
resources/read succeeds
Inspector renders correctly
Claude.ai opens app container
Claude iframe remains blank
```

even with minimal inline HTML. ([GitHub][17])

There was also a February 2026 Claude regression where external resources were blocked despite declared `connectDomains`/`resourceDomains`. ([GitHub][18])

So this diagnostic outcome is meaningful:

```text
basic-host ✅
Inspector ✅
Claude.ai ❌
```

Do **not** automatically rewrite your MCP server when that happens.

First check:

```text
Claude console
Claude iframe origin/domain
CSP
ui.domain
host incident/regression
```

That is precisely why keeping Inspector in your loop is valuable.

---

# Failure 4: external JS/CSS bundle never loads

For maximum portability, I strongly recommend compiling the widget into a **single HTML response**:

```html
<div id="root"></div>
<style>
  /* bundled CSS */
</style>
<script type="module">
  // bundled JS
</script>
```

OpenAI's current MCP Apps examples likewise show reading the built JS and inlining it into the resource HTML. ([OpenAI Developers][6])

This removes:

- CDN dependency;
- script CSP;
- tunnel asset paths;
- cache mismatch between HTML and JS;
- CORS;
- localhost assets accidentally embedded into production HTML.

For Vite, this is where `vite-plugin-singlefile` or equivalent bundling is particularly useful.

---

# Failure 5: zero-height iframe

Claude explicitly calls this out as the other most common invisible-app bug.

Bad:

```ts
app.sendSizeChanged({
  width,
  height: 0,
});
```

or:

```css
#root {
  height: 100%;
}
```

when none of its ancestors establishes a height.

Ensure the app has non-zero intrinsic content and report an actual measured height. ([Claude][15])

Also note that Claude inline MCP Apps currently have a **500px maximum inline height**. ([Claude][14])

So don't design the app around an unbounded iframe.

For ChatGPT, similarly avoid assuming a fixed viewport; use host context/display-mode/max-height information where available.

---

# Failure 6: huge `structuredContent`

This one is Claude-specific and easy to overlook.

Claude says that around **150,000 characters**, large tool results may be moved into its execution sandbox rather than delivered to the app as normal inline structured content. Then the MCP App receives a pointer instead of the data it expected and may never hydrate. ([Claude][15])

For an interactive UI:

```text
initial tool result = small summary + IDs
widget interactions = follow-up tools/call
```

is much safer than returning a huge object on the first tool call.

---

# What I would change in your Fastify server

Given your description, the architecture itself is good. I'd aim for this exact behavior:

```text
OPTIONS /mcp
    → 204
    → appropriate CORS

POST /mcp
    Accept: application/json, text/event-stream
    → application/json
    → no session ID

GET /mcp
    → 405 Method Not Allowed

DELETE /mcp
    → 405 Method Not Allowed
```

And use:

```ts
const transport = new StreamableHTTPServerTransport({
  sessionIdGenerator: undefined,
  enableJsonResponse: true,
});
```

This gives you:

```text
stateless       ✅
JSON only       ✅
no SSE stream   ✅
no session IDs  ✅
ChatGPT pattern ✅
MCP GET semantics ✅
Claude Streamable HTTP compatible ✅
```

The important correction is therefore not **"add SSE."**

It is:

> **Keep JSON-only POST responses, but make the overall `/mcp` endpoint a conforming Streamable HTTP endpoint by returning 405 for unsupported GET streaming.**

---

# The workflow I'd actually use day-to-day

```bash
# 1. Run your Fastify MCP server
npm run dev

# 2. Test the raw protocol + UI
npx @modelcontextprotocol/inspector@latest

# Connect:
# Streamable HTTP
# http://localhost:3001/mcp
#
# Tools → verify _meta.ui.resourceUri
# Resources → resources/read
# Apps → Open App
```

Separately:

```bash
git clone https://github.com/modelcontextprotocol/ext-apps.git
cd ext-apps
npm install
cd examples/basic-host

SERVERS='["http://localhost:3001/mcp"]' npm start
```

Open:

```text
http://localhost:8080
```

Then, only after the local bridge is green:

```bash
# ChatGPT
ngrok http 3001
```

and preferably keep the same ngrok hostname.

Or:

```bash
# Claude
npx cloudflared tunnel --url http://localhost:3001
```

Register:

```text
https://<stable-host>/mcp
```

For every meaningful widget build:

```text
ui://my-widget/dev-001.html
ui://my-widget/dev-002.html
ui://my-widget/dev-003.html
```

Then for ChatGPT:

```text
ChatGPT Plugins
 → your draft
 → Refresh
```

For Claude when stale:

```text
new conversation
```

then, if necessary:

```text
disconnect/reconnect connector
```

That is the development workflow I would trust in August 2026.

### Primary references

[MCP Apps — testing with basic-host](https://github.com/modelcontextprotocol/ext-apps/blob/main/docs/testing-mcp-apps.md?utm_source=chatgpt.com)
[basic-host reference implementation](https://github.com/modelcontextprotocol/ext-apps/tree/main/examples/basic-host?utm_source=chatgpt.com)
[MCP Inspector](https://github.com/modelcontextprotocol/inspector?utm_source=chatgpt.com)
[MCP Streamable HTTP transport specification](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports?utm_source=chatgpt.com)
[OpenAI MCP server + UI quickstart](https://developers.openai.com/plugins/build/app-quickstart?utm_source=chatgpt.com)
[OpenAI MCP Apps UI guidance](https://developers.openai.com/plugins/build/chatgpt-ui?utm_source=chatgpt.com)
[OpenAI ChatGPT Developer mode](https://developers.openai.com/api/docs/guides/developer-mode?utm_source=chatgpt.com)
[Claude custom connectors](https://claude.com/docs/connectors/building?utm_source=chatgpt.com)
[Claude MCP Apps cross-platform guidance](https://claude.com/docs/connectors/building/mcp-apps/cross-compatibility?utm_source=chatgpt.com)
[Claude MCP Apps troubleshooting](https://claude.com/docs/connectors/building/mcp-apps/troubleshooting?utm_source=chatgpt.com)

I can also monitor the MCP Apps/OpenAI/Claude docs for transport, caching, or host-behavior changes.

[1]: https://developers.openai.com/plugins/build/app-quickstart 'MCP server and UI quickstart – Plugins | OpenAI Developers'
[2]: https://github.com/modelcontextprotocol/ext-apps/blob/main/docs/testing-mcp-apps.md?utm_source=chatgpt.com 'ext-apps/docs/testing-mcp-apps.md at main · modelcontextprotocol/ext-apps · GitHub'
[3]: https://github.com/modelcontextprotocol/ext-apps/blob/main/examples/basic-host/README.md 'ext-apps/examples/basic-host/README.md at main · modelcontextprotocol/ext-apps · GitHub'
[4]: https://github.com/modelcontextprotocol/inspector/blob/main/README.md 'inspector/README.md at main · modelcontextprotocol/inspector · GitHub'
[5]: https://github.com/MCPJam/inspector 'GitHub - MCPJam/inspector: Testing and evaluation platform to chat, inspect, and debug MCP servers, MCP apps, and ChatGPT apps. · GitHub'
[6]: https://developers.openai.com/plugins/build/chatgpt-ui 'Add UI to your MCP server – Plugins | OpenAI Developers'
[7]: https://modelcontextprotocol.io/specification/2025-11-25/basic/transports 'Transports - Model Context Protocol'
[8]: https://developers.openai.com/api/docs/guides/developer-mode 'ChatGPT Developer mode'
[9]: https://claude.com/docs/connectors/building/testing?utm_source=chatgpt.com 'Testing your connector - Claude.ai Documentation'
[10]: https://claude.com/docs/connectors/building?utm_source=chatgpt.com 'Building custom connectors - Claude.ai Documentation'
[11]: https://claude.com/docs/connectors/building/lazy-authentication?utm_source=chatgpt.com 'Lazy authentication for MCP servers - Claude.ai Documentation'
[12]: https://claude.com/docs/connectors/building/mcp-apps/cross-compatibility?utm_source=chatgpt.com 'Building cross-platform MCP Apps - Claude.ai Documentation'
[13]: https://support.claude.com/en/articles/13454812-use-interactive-connectors-in-claude?utm_source=chatgpt.com 'Use interactive connectors in Claude | Claude Help Center'
[14]: https://claude.com/docs/connectors/building/mcp-apps/design-guidelines?utm_source=chatgpt.com 'Design guidelines - Claude.ai Documentation'
[15]: https://claude.com/docs/connectors/building/mcp-apps/troubleshooting 'Troubleshooting MCP Apps - Claude.ai Documentation'
[16]: https://github.com/modelcontextprotocol/ext-apps/issues/634?utm_source=chatgpt.com 'Spec 2026-01-26: misleading "View initialize" example uses `initialize` + `clientInfo` instead of `ui/initialize` + `appInfo` · Issue #634 · modelcontextprotocol/ext-apps · GitHub'
[17]: https://github.com/modelcontextprotocol/ext-apps/issues/615?utm_source=chatgpt.com 'Claude MCP App renders blank (works in Inspector) · Issue #615 · modelcontextprotocol/ext-apps · GitHub'
[18]: https://github.com/modelcontextprotocol/ext-apps/issues/509?utm_source=chatgpt.com 'ext-apps viewer cannot fetch external resources despite correct resourceDomains/connectDomains CSP (regression ~Feb 26) · Issue #509 · modelcontextprotocol/ext-apps · GitHub'

<!-- @web-flow end id=response-20260826080312754-chatgpt -->
