const functionalTree = require("./functional-classificatinos-general.json");

interface BudgetNode {
    description: string;
    code?: string;
    children?: BudgetNode[];
}

const tidy = (s: string | null | undefined) =>
    (s ?? '')
        .replace(/\u00A0/g, ' ')
        .replace(/[\u200B-\u200D\u2060]/g, '')
        .replace(/\uFEFF/g, '')
        .trim();

const twoDigitPrefix = (codeLike: string | null | undefined): string | null => {
    if (!codeLike) return null;
    const raw = tidy(codeLike).replace(/\.$/, '');
    const m = raw.match(/^(\d{2})/);
    return m ? m[1] : null;
};

const buildChapterMapFromTree = (roots: BudgetNode[]): Map<string, string> => {
    type Entry = { name: string; depth: number; exact: boolean };
    const best = new Map<string, Entry>();

    const visit = (node: BudgetNode, depth: number) => {
        const prefix = node.code ? twoDigitPrefix(node.code) : null;
        if (prefix) {
            const exact = /^\d{2}$/.test(tidy(node.code!));
            const name = tidy(node.description) || prefix;

            const existing = best.get(prefix);
            if (!existing) {
                best.set(prefix, { name, depth, exact });
            } else {
                if ((!existing.exact && exact) || (existing.exact === exact && depth < existing.depth)) {
                    best.set(prefix, { name, depth, exact });
                }
            }
        }
        if (node.children?.length) {
            for (const child of node.children) visit(child, depth + 1);
        }
    };

    for (const root of roots) visit(root, 0);

    const map = new Map<string, string>();
    best.forEach((v, k) => map.set(k, v.name));
    return map;
};

let chapterMapInstance: Map<string, string> | null = null;

export const getChapterMap = (): Map<string, string> => {
    if (chapterMapInstance) {
        return chapterMapInstance;
    }
    const tree = Array.isArray(functionalTree) ? functionalTree : [];
    chapterMapInstance = buildChapterMapFromTree(tree);
    return chapterMapInstance;
}
