export type MoneyInput = string | number | null | undefined;

/** Parses a decimal string into a number, returning 0 for invalid input. */
export function toNumber(value: MoneyInput): number {
  if (value === null || value === undefined || value === "") return 0;
  const parsed = typeof value === "number" ? value : Number(String(value).replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Formats money with thousands separators and a fixed number of decimals. */
export function formatMoney(
  value: MoneyInput,
  options: { decimals?: number; currency?: string; locale?: string } = {},
): string {
  const { decimals = 2, currency, locale = "en-US" } = options;
  const amount = toNumber(value);
  if (currency) {
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency,
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    }).format(amount);
  }
  return new Intl.NumberFormat(locale, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(amount);
}

/** Stellar amounts can carry up to 7 decimals; trailing zeros are trimmed. */
export function formatStellarAmount(value: MoneyInput): string {
  const formatted = formatMoney(value, { decimals: 7 });
  const [whole, fraction] = formatted.split(".");
  if (!fraction) return whole;
  const trimmed = fraction.replace(/0+$/, "");
  return trimmed ? `${whole}.${trimmed}` : whole;
}

export function formatCompact(value: MoneyInput): string {
  return new Intl.NumberFormat("en-US", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(toNumber(value));
}

export function formatNumber(value: MoneyInput, decimals = 0): string {
  return formatMoney(value, { decimals });
}

export function formatPercent(value: MoneyInput, decimals = 1): string {
  return `${formatMoney(value, { decimals })}%`;
}

export function formatDate(
  value: string | number | Date | null | undefined,
  options: Intl.DateTimeFormatOptions = { year: "numeric", month: "short", day: "numeric" },
): string {
  if (!value) return "—";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("en-US", options).format(date);
}

export function formatDateTime(value: string | number | Date | null | undefined): string {
  return formatDate(value, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function formatRelativeTime(value: string | number | Date | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  const timestamp = date.getTime();
  if (Number.isNaN(timestamp)) return "—";
  const diff = timestamp - Date.now();
  const abs = Math.abs(diff);
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ["year", 31_536_000_000],
    ["month", 2_592_000_000],
    ["day", 86_400_000],
    ["hour", 3_600_000],
    ["minute", 60_000],
  ];
  const formatter = new Intl.RelativeTimeFormat("en-US", { numeric: "auto" });
  for (const [unit, ms] of units) {
    if (abs >= ms) return formatter.format(Math.round(diff / ms), unit);
  }
  return "just now";
}

/** GABCDEFGHI... -> GABC…WXYZ */
export function truncateAddress(value: string, start = 6, end = 6): string {
  if (!value) return "—";
  if (value.length <= start + end + 1) return value;
  return `${value.slice(0, start)}…${value.slice(-end)}`;
}

/** Converts a human label into a readable badge label: "pending_approval" -> "Pending Approval". */
export function humanize(value: string): string {
  if (!value) return "";
  return value
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase())
    .replace(/\s+/g, " ")
    .trim();
}

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}

/** Stroops (1 XLM = 10,000,000 stroops) to XLM. */
export function stroopsToXlm(stroops: string | number): string {
  return formatStellarAmount(toNumber(stroops) / 10_000_000);
}
