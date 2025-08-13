#!/usr/bin/env node
import fs from 'fs';
import path from 'path';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchWithFallback(urls, opts = {}) {
  let lastErr;
  for (const url of urls) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 10000);
      const res = await fetch(url, { signal: ctrl.signal, headers: opts.headers });
      clearTimeout(timer);
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      const text = await res.text();
      return { url, text };
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr ?? new Error('All fetch attempts failed');
}

async function main() {
  const port = process.env.PORT || '3000';
  const baseUrl = process.env.OPENAPI_BASE_URL || `http://localhost:${port}`;
  const rootDir = process.cwd();
  const outDir = path.join(rootDir, 'specs', 'openapi');
  fs.mkdirSync(outDir, { recursive: true });
  // Only include AI basic endpoints by default
  const includePrefix = process.env.OPENAPI_INCLUDE_PREFIX || '/ai/v1/';

  const jsonUrls = [
    `${baseUrl}/docs/json`,
    `${baseUrl}/documentation/json`,
  ];
  const yamlUrls = [
    `${baseUrl}/docs/yaml`,
    `${baseUrl}/documentation/yaml`,
  ];

  // Small wait to allow a freshly started dev server to bind
  if (process.env.WAIT_BEFORE_FETCH_MS) {
    await sleep(parseInt(process.env.WAIT_BEFORE_FETCH_MS, 10));
  }

  console.log(`[schema] Fetching OpenAPI JSON from ${jsonUrls.join(' or ')}`);
  const jsonRes = await fetchWithFallback(jsonUrls);
  let jsonText = jsonRes.text;
  try {
    const spec = JSON.parse(jsonText);
    // Filter paths to only include the requested prefix
    const filteredPaths = {};
    for (const [p, v] of Object.entries(spec.paths || {})) {
      if (typeof p === 'string' && p.startsWith(includePrefix)) {
        filteredPaths[p] = v;
      }
    }
    spec.paths = filteredPaths;
    const overrideUrl = process.env.OPENAPI_SERVER_URL || undefined;
    if (overrideUrl) {
      spec.servers = [{ url: overrideUrl }];
    }
    // Force latest OpenAPI version in output
    spec.openapi = '3.1.0';
    jsonText = JSON.stringify(spec, null, 2);
  } catch (_) {}
  const jsonPath = path.join(outDir, 'ai-basic.json');
  fs.writeFileSync(jsonPath, jsonText);
  console.log(`[schema] Wrote ${jsonPath}`);

  try {
    console.log(`[schema] Fetching OpenAPI YAML from ${yamlUrls.join(' or ')}`);
    const yamlRes = await fetchWithFallback(yamlUrls);
    let yamlText = yamlRes.text;
    // Filter YAML paths to only include the requested prefix
    if (/^paths:/m.test(yamlText)) {
      const lines = yamlText.split(/\n/);
      const out = [];
      let i = 0;
      // copy until and including 'paths:' line
      while (i < lines.length && !/^paths:\s*$/.test(lines[i])) {
        out.push(lines[i]);
        i++;
      }
      if (i < lines.length && /^paths:\s*$/.test(lines[i])) {
        out.push(lines[i]);
        i++;
        while (i < lines.length) {
          const line = lines[i];
          // stop if next top-level section
          if (/^[A-Za-z]/.test(line)) {
            break;
          }
          // path block start at two spaces then '/'
          const pathStart = /^\s{2}\/[^:]+:\s*$/.exec(line);
          if (pathStart) {
            const pathKey = line.trim().slice(0, -1); // remove trailing ':'
            // capture block until next path start or top-level section
            const block = [line];
            i++;
            while (i < lines.length) {
              const l2 = lines[i];
              if (/^[A-Za-z]/.test(l2)) break; // top-level
              if (/^\s{2}\/[^:]+:\s*$/.test(l2)) break; // next path
              block.push(l2);
              i++;
            }
            if (pathKey.startsWith(includePrefix)) {
              out.push(...block);
            }
            continue;
          }
          // other non-path lines under paths (unlikely); skip
          i++;
        }
        // append the rest (next top-level section and beyond) unchanged
        while (i < lines.length) {
          out.push(lines[i]);
          i++;
        }
      } else {
        // no explicit paths section line found; leave as is
      }
      yamlText = out.join('\n');
    }
    const overrideUrl = process.env.OPENAPI_SERVER_URL || undefined;
    if (overrideUrl) {
      // override or insert servers:
      const serversBlock = `servers:\n  - url: ${overrideUrl}`;
      if (/^servers:/m.test(yamlText)) {
        yamlText = yamlText.replace(/servers:[\s\S]*?(?=\n\w|\n#|\nopenapi|\ninfo|\npaths|\ncomponents|\n$)/m, serversBlock + '\n');
      } else {
        yamlText = yamlText.replace(/^(info:|openapi:)/m, (m) => `${serversBlock}\n\n${m}`);
      }
    }
    // Force latest OpenAPI version in output
    if (/^openapi:/m.test(yamlText)) {
      yamlText = yamlText.replace(/^openapi:\s*.*$/m, 'openapi: 3.1.0');
    } else {
      yamlText = `openapi: 3.1.0\n${yamlText}`;
    }
    const yamlPath = path.join(outDir, 'ai-basic.yaml');
    fs.writeFileSync(yamlPath, yamlText);
    console.log(`[schema] Wrote ${yamlPath}`);
  } catch (err) {
    console.warn(`[schema] YAML endpoint not available; skipped. (${err?.message || err})`);
  }
}

main().catch((err) => {
  console.error('[schema] Failed to generate OpenAPI schema:', err);
  process.exit(1);
});


