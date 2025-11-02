export function formatCurrency(amount: number, notation?: "standard" | "compact"): string {
    return new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "RON",
        notation: notation || "standard",
        minimumFractionDigits: 0,
        maximumFractionDigits: 2,
    }).format(amount);
}

/**
 * Formats a number according to international (US) standard.
 * Handles thousands separators (,) and decimal point (.).
 */
export const formatNumberRO = (value: number | null | undefined, notation?: "standard" | "compact"): string => {
    if (value === null || value === undefined || isNaN(value)) return 'N/A';

    return new Intl.NumberFormat("en-US", {
        style: "decimal",
        notation: notation || "standard",
        minimumFractionDigits: 0,
        maximumFractionDigits: 2,
    }).format(value);
};

export function getMonthLabel(month: number): string {
    return String(month).padStart(2, '0');
}

export function getQuarterLabel(quarter: number): string {
    return `Q${quarter}`;
}