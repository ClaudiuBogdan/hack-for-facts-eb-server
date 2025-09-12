import { formatCurrency, formatNumberRO } from "./formatter";
import { getChapterMap, getFilterDescription } from "./functionalClassificationUtils";
import { buildEconomicLink, buildFunctionalLink } from "./link";
import { ExecutionLineItem } from "../db/models";

export interface GroupedEconomic {
  economicCode: string;
  economicName: string;
  amount: number;
  humanSummary: string;
  link: string;
  percentage: number; // 0..1 share of total income/expense for the entity-year
}

export interface GroupedFunctional {
  functionalCode: string;
  functionalName: string;
  totalAmount: number;
  humanSummary: string;
  link: string;
  economics?: GroupedEconomic[];
  percentage: number; // 0..1 share of total income/expense for the entity-year
}

export interface GroupedChapter {
  functionalCode: string;
  functionalDescription: string;
  totalAmount: number;
  humanSummary: string;
  link: string;
  functionalChildren?: GroupedFunctional[];
  percentage: number; // 0..1 share of total income/expense for the entity-year
}

export interface EnrichedLineItem extends ExecutionLineItem {
  functional_name?: string;
  economic_name?: string;
}

export function groupByFunctional(items: EnrichedLineItem[], cui: string, type: "income" | "expense", year: number): GroupedChapter[] {
  // Chapter map: 2-digit prefix -> description (built from classifications JSON)
  const chapterMap = getChapterMap();

  // Magic codes sometimes present in data that should be ignored
  const INVALID_ECONOMIC_CODES = new Set(["0", "00.00.00"]);

  type EconomicAccumulator = { name: string; amount: number };
  type FunctionalAccumulator = {
    functionalCode: string;
    functionalName: string;
    total: number;
    economics: Map<string, EconomicAccumulator>;
  };
  type ChapterAccumulator = {
    total: number;
    functionalChildren: Map<string, FunctionalAccumulator>;
  };

  const chapters = new Map<string, ChapterAccumulator>();

  const ensureChapter = (prefix: string): ChapterAccumulator => {
    let chapter = chapters.get(prefix);
    if (!chapter) {
      chapter = { total: 0, functionalChildren: new Map() };
      chapters.set(prefix, chapter);
    }
    return chapter;
  };

  const ensureFunctional = (chapter: ChapterAccumulator, code: string, name: string): FunctionalAccumulator => {
    let functional = chapter.functionalChildren.get(code);
    if (!functional) {
      functional = { functionalCode: code, functionalName: name || "Unknown", total: 0, economics: new Map() };
      chapter.functionalChildren.set(code, functional);
    }
    return functional;
  };

  const addLineItemToAccumulators = (lineItem: EnrichedLineItem) => {
    if (!lineItem?.functional_code) return;
    const prefix = lineItem.functional_code.slice(0, 2);
    if (!chapterMap.has(prefix)) return; // Skip unknown prefixes not in chapter map

    const chapter = ensureChapter(prefix);
    const functional = ensureFunctional(chapter, lineItem.functional_code, lineItem.functional_name || "");

    const amount = Number(lineItem.ytd_amount) || 0;
    functional.total += amount;
    chapter.total += amount;

    const ecoCode = lineItem.economic_code;
    if (ecoCode && !INVALID_ECONOMIC_CODES.has(ecoCode)) {
      let eco = functional.economics.get(ecoCode);
      if (!eco) {
        eco = { name: lineItem.economic_name || "Unknown", amount: 0 };
        functional.economics.set(ecoCode, eco);
      }
      eco.amount += amount;
    }
  };

  for (const lineItem of items) addLineItemToAccumulators(lineItem);

  // Compute overall total for this type (income or expense) to derive shares
  let overallTotal = 0;
  for (const chapter of chapters.values()) overallTotal += chapter.total;
  overallTotal = Number.isFinite(overallTotal) ? overallTotal : 0;

  const toPercent = (value: number): string => {
    if (!overallTotal || !Number.isFinite(value)) return "0%";
    const pct = (value / overallTotal) * 100;
    return `${formatNumberRO(pct, 'compact')}%`;
  };

  const result: GroupedChapter[] = [];

  for (const [prefix, chapter] of chapters) {
    const functionalChildren: GroupedFunctional[] = [];

    for (const [functionalCode, functional] of chapter.functionalChildren) {
      const economics: GroupedEconomic[] = Array.from(functional.economics, ([economicCode, eco]) => {
        const link = buildEconomicLink(cui, economicCode, type, year);
        const humanSummary = `The ${type} for economic category "${eco.name}" from the functional category "${functional.functionalName}" was ${formatCurrency(eco.amount, 'compact')} (${formatCurrency(eco.amount, 'standard')}) — ${toPercent(eco.amount)} of total ${type}.`;
        return { economicCode, economicName: eco.name, amount: eco.amount, humanSummary, link, percentage: overallTotal ? eco.amount / overallTotal : 0 };
      }).sort((a, b) => b.amount - a.amount);

      const functionalSummary = `The total ${type} for "${functional.functionalName}" was ${formatCurrency(functional.total, 'compact')} (${formatCurrency(functional.total, 'standard')}) — ${toPercent(functional.total)} of total ${type}.`;
      const link = buildFunctionalLink(cui, functionalCode, type, year);

      functionalChildren.push({
        functionalCode,
        functionalName: functional.functionalName,
        totalAmount: functional.total,
        humanSummary: functionalSummary,
        economics,
        link,
        percentage: overallTotal ? functional.total / overallTotal : 0,
      });
    }

    functionalChildren.sort((a, b) => b.totalAmount - a.totalAmount);
    const chapterDescription = chapterMap.get(prefix) || "Unknown";
    const chapterSummary = `The ${type} for functional category "${chapterDescription}" was ${formatCurrency(chapter.total, 'compact')} (${formatCurrency(chapter.total, 'standard')}) — ${toPercent(chapter.total)} of total ${type}.`;
    const chapterLink = buildFunctionalLink(cui, prefix, type, year);

    result.push({
      functionalCode: prefix,
      functionalDescription: chapterDescription,
      totalAmount: chapter.total,
      humanSummary: chapterSummary,
      functionalChildren,
      link: chapterLink,
      percentage: overallTotal ? chapter.total / overallTotal : 0,
    });
  }

  result.sort((a, b) => b.totalAmount - a.totalAmount);
  return result;
}

function textMatches(text: string, query: string): boolean {
  if (!text || !query) return false;
  return text.toLowerCase().includes(query.toLowerCase());
}

export function filterGroups(args:
  {
    initialGroups: GroupedChapter[],
    fnCode?: string,
    ecCode?: string,
    level?: "group" | "functional" | "economic",
    type?: "income" | "expense",
  }
): GroupedChapter[] {
  const { initialGroups, fnCode, ecCode, level, type } = args;
  const groups: GroupedChapter[] = [];

  if (level === "group") {
    for (const chapter of initialGroups) {
      groups.push({
        ...chapter,
        functionalChildren: undefined, // We remove the functionalChildren to avoid too much noise
      });
    }
  } else if (level === "functional") {
    for (const chapter of initialGroups) {
      groups.push({
        ...chapter,
        functionalChildren: chapter.functionalChildren?.map((f) => ({ ...f, economics: undefined })), // We remove the economics to avoid too much noise
      });
    }
  } else {
    groups.push(...initialGroups);
  }

  const fnQuery = (fnCode || "").trim();
  const ecQuery = (ecCode || "").trim();
  if (!fnQuery && !ecQuery) return groups;

  const filteredChapters = new Map<string, GroupedChapter>();

  const totalAmountWithoutFilters = initialGroups.reduce((sum, ch) => sum + (Number(ch.totalAmount) || 0), 0);

  for (const chapter of groups) {
    const chapterText = `${chapter.functionalDescription} ${chapter.functionalCode}`;
    const chapterMatches = textMatches(chapterText, fnQuery);

    if (chapterMatches) {
      filteredChapters.set(chapter.functionalCode, { ...chapter });
      continue;
    }

    const matchedFunctionalChildren: GroupedFunctional[] = [];
    for (const func of chapter.functionalChildren || []) {
      const funcText = `${func.functionalName} fn:${func.functionalCode}`;
      const funcMatches = textMatches(funcText, fnQuery);

      if (funcMatches) {
        matchedFunctionalChildren.push({ ...func });
        continue;
      }

      const matchedEconomics: GroupedEconomic[] = [];
      for (const eco of func.economics || []) {
        const ecoText = `${eco.economicName} ec:${eco.economicCode}`;
        if (textMatches(ecoText, ecQuery)) {
          matchedEconomics.push({ ...eco });
        }
      }

      if (matchedEconomics.length > 0) {
        const newTotal = matchedEconomics.reduce((sum, eco) => sum + eco.amount, 0);
        matchedFunctionalChildren.push({ ...func, economics: matchedEconomics, totalAmount: newTotal });
      }
    }

    if (matchedFunctionalChildren.length > 0) {
      const newChapterTotal = matchedFunctionalChildren.reduce((sum, f) => sum + f.totalAmount, 0);
      const updatedChapter: GroupedChapter = {
        ...chapter,
        functionalChildren: matchedFunctionalChildren.sort((a, b) => b.totalAmount - a.totalAmount),
        totalAmount: newChapterTotal,
      };
      filteredChapters.set(chapter.functionalCode, updatedChapter);
    }
  }

  // Recompute shares based on filtered totals
  const filteredArray = Array.from(filteredChapters.values()).sort((a, b) => b.totalAmount - a.totalAmount);
  const toPercent = (value: number): string => {
    if (!totalAmountWithoutFilters || !Number.isFinite(value)) return "0%";
    const pct = (value / totalAmountWithoutFilters) * 100;
    return `${formatNumberRO(pct, 'compact')}%`;
  };
  const filterDescription = getFilterDescription({ fnCode, ecCode });

  return filteredArray.map((chapter) => {
    const updatedFunctionalChildren = (chapter.functionalChildren || []).map((func) => {
      const updatedEconomics = (func.economics || []).map((eco) => ({
        ...eco,
        percentage: totalAmountWithoutFilters ? eco.amount / totalAmountWithoutFilters : 0,
        humanSummary: `The ${type ?? 'amount'} for economic category "${eco.economicName}" from the functional category "${func.functionalName}" was ${formatCurrency(eco.amount, 'compact')} (${formatCurrency(eco.amount, 'standard')}) — ${toPercent(eco.amount)} of total ${type ?? 'amount'}.`,
      }));
      const newFunc = {
        ...func,
        economics: updatedEconomics,
        percentage: totalAmountWithoutFilters ? func.totalAmount / totalAmountWithoutFilters : 0,
        humanSummary: `The total ${type ?? 'amount'} for "${func.functionalName}"${filterDescription} was ${formatCurrency(func.totalAmount, 'compact')} (${formatCurrency(func.totalAmount, 'standard')}) — ${toPercent(func.totalAmount)} of total ${type ?? 'amount'}.`,
      } as GroupedFunctional;
      return newFunc;
    });
    return {
      ...chapter,
      functionalChildren: updatedFunctionalChildren,
      percentage: totalAmountWithoutFilters ? chapter.totalAmount / totalAmountWithoutFilters : 0,
      humanSummary: `The ${type ?? 'amount'} for functional category "${chapter.functionalDescription}"${filterDescription} was ${formatCurrency(chapter.totalAmount, 'compact')} (${formatCurrency(chapter.totalAmount, 'standard')}) — ${toPercent(chapter.totalAmount)} of total ${type ?? 'amount'}.`,
    } as GroupedChapter;
  });
}


