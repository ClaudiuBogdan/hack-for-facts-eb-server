/**
 * Functional Chapter Map
 *
 * Static lookup of COFOG 2-digit chapter codes to Romanian chapter names.
 * Built from the same JSON the client uses (functional-classifications-general-ro.json).
 */

import classificationsJson from '@/infra/database/seeds/functional-classifications-general-ro.json' with { type: 'json' };

interface ClassificationNode {
  description: string;
  code?: string;
  children?: ClassificationNode[];
}

/**
 * Recursively extracts all {code, description} entries from the nested structure.
 */
const extractCodes = (nodes: ClassificationNode[]): Map<string, string> => {
  const map = new Map<string, string>();

  const walk = (nodeList: ClassificationNode[]): void => {
    for (const node of nodeList) {
      if (node.code !== undefined) {
        map.set(node.code, node.description);
      }

      if (node.children !== undefined) {
        walk(node.children);
      }
    }
  };

  walk(nodes);
  return map;
};

/** Full code → name map (all levels) */
const allCodes = extractCodes(classificationsJson as ClassificationNode[]);

/** 2-digit chapter code → name map */
const chapterMap = new Map<string, string>();
for (const [code, name] of allCodes) {
  if (/^\d{2}$/u.test(code)) {
    chapterMap.set(code, name);
  }
}

/**
 * Resolves a 2-digit COFOG chapter code to its Romanian name.
 * Falls back to the code itself if not found.
 */
export const resolveChapterName = (chapterCode: string): string => {
  return chapterMap.get(chapterCode) ?? chapterCode;
};
