import { createHash } from 'crypto';

/**
 * Recursively sorts object keys to ensure stable serialization.
 * Arrays are mapped recursively, objects are sorted by key.
 */
const sortObjectKeys = (obj: any): any => {
    if (typeof obj !== 'object' || obj === null) return obj;
    if (Array.isArray(obj)) return obj.map(sortObjectKeys);

    return Object.keys(obj)
        .sort()
        .reduce((acc, key) => {
            acc[key] = sortObjectKeys(obj[key]);
            return acc;
        }, {} as { [key: string]: any });
};

/**
 * Generate a stable hash from a filter object.
 * @param filter The filter object to hash.
 * @returns A SHA-256 hash string.
 */
export const getFilterHash = (filter: Record<string, any>): string => {
    const sortedFilter = sortObjectKeys(filter);
    const stringifiedFilter = JSON.stringify(sortedFilter);
    return createHash('sha256').update(stringifiedFilter).digest('hex');
};

/**
 * Extended color palette with 50 visually distinct colors that work well for charts.
 * Colors are selected to have good contrast and be distinguishable from each other.
 */
const CHART_COLOR_PALETTE = [
    // Blues
    '#3B82F6', '#1D4ED8', '#60A5FA', '#0EA5E9', '#0284C7',
    // Oranges & Reds
    '#F97316', '#EF4444', '#DC2626', '#F59E0B', '#EA580C',
    // Greens
    '#10B981', '#059669', '#22C55E', '#16A34A', '#84CC16',
    // Pinks & Purples
    '#EC4899', '#DB2777', '#8B5CF6', '#7C3AED', '#A855F7',
    // Yellows & Ambers
    '#EAB308', '#CA8A04', '#FACC15', '#FCD34D', '#FDE047',
    // Cyans & Teals
    '#06B6D4', '#0891B2', '#14B8A6', '#0D9488', '#2DD4BF',
    // Additional Blues
    '#2563EB', '#1E40AF', '#3B82F6', '#6366F1', '#4F46E5',
    // Additional Reds & Oranges
    '#B91C1C', '#991B1B', '#FB923C', '#FDBA74', '#FED7AA',
    // Additional Greens
    '#15803D', '#166534', '#86EFAC', '#BBF7D0', '#4ADE80',
    // Additional Purples & Pinks
    '#9333EA', '#A21CAF', '#C026D3', '#D946EF', '#F0ABFC'
];

/**
 * Get a color for a series based on a stable hash of the filter.
 * This ensures that the same filter always gets the same color across different chart instances.
 * @param filter The filter object to generate a color for (or an index for backward compatibility).
 * @returns A color string in HEX format. The colors are selected to be visually distinct.
 */
export const getSeriesColor = (filter: Record<string, any> | number): string => {
    // Backward compatibility: if a number is passed, use index-based selection
    if (typeof filter === 'number') {
        return CHART_COLOR_PALETTE[filter % CHART_COLOR_PALETTE.length];
    }

    // Hash-based selection for consistent colors
    const hash = getFilterHash(filter);
    // Convert first 8 characters of hex hash to a number
    const hashValue = parseInt(hash.substring(0, 8), 16);
    const colorIndex = hashValue % CHART_COLOR_PALETTE.length;

    return CHART_COLOR_PALETTE[colorIndex];
}