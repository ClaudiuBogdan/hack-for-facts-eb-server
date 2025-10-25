/**
 * Get a color for a series based on its index.
 * @param index The index of the series.
 * @returns A color string in HEX format. The colors are selected to be visually distinct.
 */
export const getSeriesColor = (index: number) => {
    const colors = [
        '#3B82F6', '#F97316', '#10B981', '#EC4899', '#8B5CF6',
        '#EAB308', '#06B6D4', '#EF4444', '#1D4ED8', '#CA8A04',
        '#059669', '#DB2777', '#6D28D9', '#B91C1C', '#60A5FA',
        '#22C55E', '#F59E0B', '#84CC16', '#475569', '#A16207'
    ];
    return colors[index % colors.length];
}