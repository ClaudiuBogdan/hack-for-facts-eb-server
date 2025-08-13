import { ExecutionLineItem } from "../db/models";
import { formatCurrency, formatNumberRO } from "./formatter";
import { getChapterMap } from "./functionalClassificationUtils";
import { buildFunctionalLink } from "./link";

export interface GroupedEconomic {
  code: string;
  name: string;
  amount: number;
}

export interface GroupedFunctional {
  code: string;
  name: string;
  totalAmount: number;
  totalAmountHumanReadable: string;
  link: string;
  economics: GroupedEconomic[];
}

export interface GroupedChapter {
  prefix: string;
  description: string;
  totalAmount: number;
  totalAmountHumanReadable: string;
  link: string;
  functionals?: GroupedFunctional[];
}

export interface EnrichedLineItem {
  account_category: string; // "vn" | "ch"
  amount: number;
  functionalClassification?: { functional_code: string; functional_name?: string };
  economicClassification?: { economic_code: string; economic_name?: string };
}

export function groupByFunctional(items: EnrichedLineItem[], cui: string, type: "income" | "expense"): GroupedChapter[] {
  // Create chapter map: prefix -> description, built from classifications JSON
  const chapterMap = getChapterMap();

  const chapters = new Map<string, { total: number; functionals: Map<string, { name: string; total: number; economics: Map<string, { name: string; amount: number }> }> }>();
  for (const item of items) {
    const f = item.functionalClassification;
    if (!f?.functional_code) continue;
    const prefix = f.functional_code.slice(0, 2);
    // Skip unknown prefixes not in chapter map, as requested
    if (!chapterMap.has(prefix)) continue;
    if (!chapters.has(prefix)) chapters.set(prefix, { total: 0, functionals: new Map() });
    const ch = chapters.get(prefix)!;
    let fn = ch.functionals.get(f.functional_code);
    if (!fn) {
      fn = { name: f.functional_name || "Unknown", total: 0, economics: new Map() };
      ch.functionals.set(f.functional_code, fn);
    }
    const amt = Number(item.amount) || 0;
    fn.total += amt;
    ch.total += amt;
    const e = item.economicClassification;
    if (e?.economic_code && e.economic_code !== "0" && e.economic_code !== "00.00.00") {
      let eco = fn.economics.get(e.economic_code);
      if (!eco) {
        eco = { name: e.economic_name || "Unknown", amount: 0 };
        fn.economics.set(e.economic_code, eco);
      }
      eco.amount += amt;
    }
  }
  const result: GroupedChapter[] = [];
  for (const [prefix, ch] of chapters) {
    const functionals: GroupedFunctional[] = [];
    for (const [code, f] of ch.functionals) {
      const economics: GroupedEconomic[] = Array.from(f.economics, ([ecoCode, eco]) => ({ code: ecoCode, name: eco.name, amount: eco.amount })).sort((a, b) => b.amount - a.amount);
      const totalAmountHumanReadable = `The total ${type} for "${f.name}" was ${formatCurrency(f.total, 'compact')} (${formatCurrency(f.total, 'standard')})`;
      const link = buildFunctionalLink(cui, code, type);
      functionals.push({ code, name: f.name, totalAmount: f.total, totalAmountHumanReadable, economics, link });
    }
    functionals.sort((a, b) => b.totalAmount - a.totalAmount);
    const description = chapterMap.get(prefix) || "Unknown";
    const totalAmountHumanReadable = `The total ${type} for "${description}" was ${formatCurrency(ch.total, 'compact')} (${formatCurrency(ch.total, 'standard')})`;
    const link = buildFunctionalLink(cui, prefix, type);
    result.push({ prefix, description, totalAmount: ch.total, totalAmountHumanReadable, functionals, link });
  }
  result.sort((a, b) => b.totalAmount - a.totalAmount);

  return result;
}

function textMatches(text: string, query: string): boolean {
  if (!text || !query) return false;
  return text.toLowerCase().includes(query.toLowerCase());
}

export function filterGroups(initialGroups: GroupedChapter[], term?: string, topLevelOnly?: boolean): GroupedChapter[] {
  const groups: GroupedChapter[] = [];

  if (topLevelOnly) {
    for (const chapter of initialGroups) {
      groups.push({
        ...chapter,
        functionals: undefined, // We remove the functionals to avoid too much noise
      });
    }
  } else {
    groups.push(...initialGroups);
  }

  const query = (term || "").trim();
  if (!query) return groups;

  const filteredChapters = new Map<string, GroupedChapter>();

  for (const chapter of groups) {
    const chapterText = `${chapter.description} ${chapter.prefix}`;
    const chapterMatches = textMatches(chapterText, query);

    if (chapterMatches) {
      filteredChapters.set(chapter.prefix, { ...chapter });
      continue;
    }

    const matchedFunctionals: GroupedFunctional[] = [];
    for (const func of chapter.functionals || []) {
      const funcText = `${func.name} fn:${func.code}`;
      const funcMatches = textMatches(funcText, query);

      if (funcMatches) {
        matchedFunctionals.push({ ...func });
        continue;
      }

      const matchedEconomics: GroupedEconomic[] = [];
      for (const eco of func.economics) {
        const ecoText = `${eco.name} ec:${eco.code}`;
        if (textMatches(ecoText, query)) {
          matchedEconomics.push({ ...eco });
        }
      }

      if (matchedEconomics.length > 0) {
        const newTotal = matchedEconomics.reduce((sum, eco) => sum + eco.amount, 0);
        matchedFunctionals.push({ ...func, economics: matchedEconomics, totalAmount: newTotal });
      }
    }

    if (matchedFunctionals.length > 0) {
      const newChapterTotal = matchedFunctionals.reduce((sum, f) => sum + f.totalAmount, 0);
      const updatedChapter: GroupedChapter = {
        ...chapter,
        functionals: matchedFunctionals.sort((a, b) => b.totalAmount - a.totalAmount),
        totalAmount: newChapterTotal,
      };
      filteredChapters.set(chapter.prefix, updatedChapter);
    }
  }

  return Array.from(filteredChapters.values()).sort((a, b) => b.totalAmount - a.totalAmount);
}


