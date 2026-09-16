export function formatElapsedMs(ms: number, locale = "en"): string {
  if (!Number.isFinite(ms) || ms < 0) return "unknown";

  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  if (totalSeconds < 10)
    return `${new Intl.NumberFormat(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1, useGrouping: false }).format(ms / 1000)}s`;
  if (totalSeconds < 60)
    return `${new Intl.NumberFormat(locale, { useGrouping: false }).format(totalSeconds)}s`;

  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  const parts: string[] = [];
  if (hours > 0)
    parts.push(`${new Intl.NumberFormat(locale, { useGrouping: false }).format(hours)}h`);
  if (minutes > 0 || hours > 0)
    parts.push(`${new Intl.NumberFormat(locale, { useGrouping: false }).format(minutes)}m`);
  parts.push(`${new Intl.NumberFormat(locale, { useGrouping: false }).format(seconds)}s`);
  return parts.join(" ");
}

export function formatBytes(bytes: number, locale = "en"): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "unknown";
  const rounded = Math.floor(bytes);
  if (rounded < 1024)
    return `${new Intl.NumberFormat(locale, { useGrouping: false }).format(rounded)} B`;

  const units = ["KB", "MB", "GB", "TB"] as const;
  let value = rounded / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const digits = value >= 10 ? 0 : 1;
  return `${new Intl.NumberFormat(locale, { minimumFractionDigits: digits, maximumFractionDigits: digits, useGrouping: false }).format(value)} ${units[unitIndex]}`;
}

export function formatBytesPerSecond(bytesPerSecond: number, locale = "en"): string {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond < 0) return "unknown";
  return `${formatBytes(Math.round(bytesPerSecond), locale)}/s`;
}

export function formatMinutesSmart(valueMinutes: number, locale = "en"): string {
  if (!Number.isFinite(valueMinutes)) return "unknown";
  const minutes = Math.max(0, valueMinutes);
  const decimals = minutes >= 10 ? 0 : 1;
  const trimmed = new Intl.NumberFormat(locale, {
    maximumFractionDigits: decimals,
    useGrouping: false,
  }).format(minutes);
  return `${trimmed} min`;
}

export function formatDurationSecondsSmart(value: number, locale = "en"): string {
  if (!Number.isFinite(value)) return "unknown";
  const totalSeconds = Math.max(0, Math.round(value));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  const parts: string[] = [];
  if (hours > 0)
    parts.push(`${new Intl.NumberFormat(locale, { useGrouping: false }).format(hours)}h`);
  if (minutes > 0 || hours > 0)
    parts.push(`${new Intl.NumberFormat(locale, { useGrouping: false }).format(minutes)}m`);
  if (seconds > 0 || parts.length === 0)
    parts.push(`${new Intl.NumberFormat(locale, { useGrouping: false }).format(seconds)}s`);
  return parts.join(" ");
}
export { formatCompactCount } from "../shared/format-count.js";
