export function formatCompactCount(value: number, locale = "en"): string {
  if (!Number.isFinite(value)) return "unknown";
  if (locale !== "en")
    return new Intl.NumberFormat(locale, { notation: "compact", maximumFractionDigits: 1 }).format(
      value,
    );
  const abs = Math.abs(value);
  const format = (n: number, suffix: string) => {
    const decimals = n >= 10 ? 0 : 1;
    return `${new Intl.NumberFormat(locale, { useGrouping: false, minimumFractionDigits: decimals, maximumFractionDigits: decimals }).format(n)}${suffix}`;
  };
  if (abs >= 1_000_000_000) return format(value / 1_000_000_000, "B");
  if (abs >= 1_000_000) return format(value / 1_000_000, "M");
  if (abs >= 10_000) return format(value / 1_000, "k");
  if (abs >= 1_000)
    return `${new Intl.NumberFormat(locale, { useGrouping: false, minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(value / 1_000)}k`;
  return new Intl.NumberFormat(locale, { useGrouping: false }).format(Math.floor(value));
}
