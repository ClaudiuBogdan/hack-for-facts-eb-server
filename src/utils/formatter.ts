export function formatCurrency(amount: number, notation?: "standard" | "compact"): string {
    return new Intl.NumberFormat("ro-RO", {
        style: "currency",
        currency: "RON",
        notation: notation || "standard",
        minimumFractionDigits: 0,
        maximumFractionDigits: 2,
    }).format(amount);
}

/**
 * Formats a number according to Romanian locale settings.
 * Handles thousands separators (.) and decimal comma (,).
 */
export const formatNumberRO = (value: number | null | undefined, notation?: "standard" | "compact"): string => {
    if (value === null || value === undefined || isNaN(value)) return 'N/A';

    return new Intl.NumberFormat("ro-RO", {
        style: "decimal",
        notation: notation || "standard",
        minimumFractionDigits: 0,
        maximumFractionDigits: 2,
    }).format(value);
};
