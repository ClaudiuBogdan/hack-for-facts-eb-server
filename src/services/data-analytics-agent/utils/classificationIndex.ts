import * as fs from "fs-extra";
import * as path from "path";

type AnyNode = { description?: string; code?: string; children?: AnyNode[], keywords?: string[] };

export interface LevelInfo {
  code: string;
  name?: string;
  levelName?: string;
  chapterCode?: string;
  chapterName?: string;
  subchapterCode?: string;
  subchapterName?: string;
}

interface Indexes {
  byCode: Map<string, LevelInfo>;
  names: Map<string, Set<string>>; // normalized name -> codes
}

let functionalIdx: Indexes | null = null;
let economicIdx: Indexes | null = null;

function normalizeText(s?: string): string {
  if (!s) return "";
  return s
    .toLowerCase()
    .normalize("NFD")
    // Strip combining diacritical marks (robust across Node versions)
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function resolveDataPath(fileName: string): string | null {
  const candidates = [
    // dist runtime candidate (when compiled)
    path.resolve(__dirname, "..", "data", fileName),
    // source runtime candidate (ts-node or repo root execution)
    path.resolve(process.cwd(), "src", "services", "data-analytics-agent", "data", fileName),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

async function loadJson(fileName: string): Promise<AnyNode[] | null> {
  const filePath = resolveDataPath(fileName);
  if (!filePath) return null;
  try {
    const buf = await fs.readFile(filePath, "utf8");
    return JSON.parse(buf);
  } catch {
    return null;
  }
}

function buildIndexes(tree: AnyNode[] | null, codePrefix?: string): Indexes {
  const byCode = new Map<string, LevelInfo>();
  const names = new Map<string, Set<string>>();

  function addName(name: string | undefined, code: string) {
    const n = normalizeText(name);
    if (!n) return;
    if (!names.has(n)) names.set(n, new Set());
    names.get(n)!.add(code);
  }

  function upsert(code: string, patch: Partial<LevelInfo>) {
    const key = code;
    const existing = byCode.get(key) ?? { code: key };
    byCode.set(key, { ...existing, ...patch });
  }

  function walk(nodes: AnyNode[], parentCodes: string[] = [], parentNames: string[] = []) {
    for (const node of nodes) {
      const code = node.code;
      const desc = node.description;
      const keywords = node.keywords;
      const currCodes = [...parentCodes];
      const currNames = [...parentNames];
      if (code) {
        currCodes.push(code);
        currNames.push(desc ?? "");

        // determine chapter/subchapter by code depth
        const segments = code.split(".");
        const chapterCode = segments[0];
        const subchapterCode = segments.length >= 2 ? `${segments[0]}.${segments[1]}` : undefined;

        // find chapter/subchapter names from ancestry (best-effort)
        let chapterName: string | undefined;
        let subchapterName: string | undefined;
        // search in current path accumulations
        for (let i = currCodes.length - 1; i >= 0; i--) {
          const c = currCodes[i];
          const n = currNames[i];
          if (c === chapterCode && !chapterName) chapterName = n;
          if (subchapterCode && c === subchapterCode && !subchapterName) subchapterName = n;
        }

        upsert(code, {
          code,
          name: desc,
          chapterCode,
          chapterName,
          subchapterCode,
          subchapterName,
        });

        // Add description and hierarchical names
        addName(desc, code);
        if (chapterName) addName(chapterName, code);
        if (subchapterName) addName(subchapterName, code);

        // Add code itself for direct code search (with dots)
        addName(codePrefix ? `${codePrefix}:${code}` : code, code);

        // Add code without dots for flexible matching (e.g., "8401" matches "84.01")
        const codeNoDots = code.replace(/\./g, "");
        if (codeNoDots !== code) {
          addName(codeNoDots, code);
        }

        // Add each keyword to the searchable index
        if (keywords && Array.isArray(keywords)) {
          for (const keyword of keywords) {
            if (keyword) {
              addName(keyword, code);
            }
          }
        }
      }
      if (node.children && node.children.length) {
        walk(node.children, currCodes, currNames);
      }
    }
  }

  if (tree) walk(tree);
  return { byCode, names };
}

async function ensureFunctional() {
  if (functionalIdx) return functionalIdx;
  const data = await loadJson("functional-classifications-general-ro.json");
  functionalIdx = buildIndexes(data, "fn");
  return functionalIdx!;
}

async function ensureEconomic() {
  if (economicIdx) return economicIdx;
  const data = await loadJson("economic-classifications-general-ro.json");
  economicIdx = buildIndexes(data, "ec");
  return economicIdx!;
}

export async function getFunctionalLevelInfo(code: string): Promise<LevelInfo | undefined> {
  const idx = await ensureFunctional();
  return findLevelInfoByCode(idx.byCode, code);
}

export async function getEconomicLevelInfo(code: string): Promise<LevelInfo | undefined> {
  const idx = await ensureEconomic();
  return findLevelInfoByCode(idx.byCode, code);
}

function lookupByName(names: Map<string, Set<string>>, term: string): string[] {
  const normalizedTerm = normalizeText(term);
  if (!normalizedTerm) return [];

  const results = new Set<string>();
  for (const [n, codes] of names.entries()) {
    if (n.includes(normalizedTerm) || n.startsWith(normalizedTerm)) {
      for (const c of codes) results.add(c);
    }
  }
  return Array.from(results);
}

export async function findFunctionalCodesByName(term: string): Promise<string[]> {
  const idx = await ensureFunctional();
  return lookupByName(idx.names, term);
}

export async function findEconomicCodesByName(term: string): Promise<string[]> {
  const idx = await ensureEconomic();
  return lookupByName(idx.names, term);
}

export function computeNameMatchBoost(name: string | undefined, query: string): number {
  const n = normalizeText(name);
  const q = normalizeText(query);
  if (!n || !q) return 0;
  if (n === q) return 0.25;
  if (n.startsWith(q)) return 0.2;
  if (n.includes(q)) return 0.15;
  return 0;
}

function findLevelInfoByCode(map: Map<string, LevelInfo>, code: string): LevelInfo | undefined {
  if (!code) return undefined;
  let attempt = code.trim();
  const tried = new Set<string>();

  const tryGet = (c: string) => map.get(c);

  // Helper to strip common trailing segments: '.', '.00', or last '.xx'
  const stripOnce = (c: string): string => {
    let s = c.replace(/\.$/, "");
    if (s === c) {
      if (/\.00$/.test(s)) return s.replace(/\.00$/, "");
      if (/\.\d{2}$/.test(s)) return s.replace(/\.\d{2}$/, "");
    }
    return s;
  };

  while (attempt && !tried.has(attempt)) {
    tried.add(attempt);
    // Try exact
    const direct = tryGet(attempt);
    if (direct) return direct;
    // Try without trailing '.00' or last segment
    const next = stripOnce(attempt);
    if (next === attempt) break;
    attempt = next;
  }

  // As a last resort, try chapter (first segment)
  const chapter = code.split(".")[0];
  if (chapter && !tried.has(chapter)) {
    const got = tryGet(chapter);
    if (got) return got;
  }
  return undefined;
}


