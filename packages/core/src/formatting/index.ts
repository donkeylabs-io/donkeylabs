export const formatToMoney = (value: number): string => {
  return `$${Intl.NumberFormat("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value)}`;
};

/**
 * Format a number to compact form for display (e.g., 10000 -> "10K", 2500000 -> "2.5M")
 * Useful for displaying large monetary values in limited space.
 *
 * @param value - The number to format
 * @param options - Optional configuration
 * @param options.decimals - Number of decimal places for non-whole numbers (default: 1)
 * @param options.prefix - Prefix to add (e.g., "$") (default: "")
 * @returns Formatted string like "10K", "$2.5M", "500"
 */
export const formatMoneyCompact = (
  value: number,
  options: { decimals?: number; prefix?: string } = {}
): string => {
  const { decimals = 1, prefix = "" } = options;

  const absValue = Math.abs(value);
  const sign = value < 0 ? "-" : "";

  if (absValue >= 1_000_000_000) {
    const val = absValue / 1_000_000_000;
    const formatted = val % 1 === 0 ? val.toString() : val.toFixed(decimals);
    return `${sign}${prefix}${formatted}B`;
  }

  if (absValue >= 1_000_000) {
    const val = absValue / 1_000_000;
    const formatted = val % 1 === 0 ? val.toString() : val.toFixed(decimals);
    return `${sign}${prefix}${formatted}M`;
  }

  if (absValue >= 1_000) {
    const val = absValue / 1_000;
    const formatted = val % 1 === 0 ? val.toString() : val.toFixed(decimals);
    return `${sign}${prefix}${formatted}K`;
  }

  return `${sign}${prefix}${absValue}`;
};

export const cutOffText = (text: string, maxLength: number = 20) => {
  return text.length > maxLength ? text.replace(/\n/g, " ").substring(0, maxLength) + "..." : text;
};
