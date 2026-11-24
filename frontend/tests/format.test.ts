import { describe, expect, it } from "vitest";
import {
  formatCompact,
  formatDate,
  formatMoney,
  formatNumber,
  formatPercent,
  formatRelativeTime,
  formatStellarAmount,
  formatDateTime,
  humanize,
  initials,
  stroopsToXlm,
  toNumber,
  truncateAddress,
} from "../src/lib/format";

describe("toNumber", () => {
  it("parses decimal strings and numbers", () => {
    expect(toNumber("1250.50")).toBe(1250.5);
    expect(toNumber("1,250.50")).toBe(1250.5);
    expect(toNumber(42)).toBe(42);
  });

  it("returns 0 for empty or invalid values", () => {
    expect(toNumber(null)).toBe(0);
    expect(toNumber(undefined)).toBe(0);
    expect(toNumber("")).toBe(0);
    expect(toNumber("abc")).toBe(0);
  });
});

describe("formatMoney", () => {
  it("formats with fixed decimals and grouping", () => {
    expect(formatMoney("1250.5")).toBe("1,250.50");
    expect(formatMoney("1234567.891", { decimals: 3 })).toBe("1,234,567.891");
    expect(formatMoney(0)).toBe("0.00");
  });

  it("supports currency formatting", () => {
    const result = formatMoney("1234.5", { currency: "USD" });
    expect(result).toContain("$");
    expect(result).toContain("1,234.50");
  });
});

describe("formatStellarAmount", () => {
  it("keeps up to 7 decimals and trims trailing zeros", () => {
    expect(formatStellarAmount("12.5000000")).toBe("12.5");
    expect(formatStellarAmount("0.0000001")).toBe("0.0000001");
    expect(formatStellarAmount("100")).toBe("100");
  });
});

describe("formatNumber / formatCompact / formatPercent", () => {
  it("formats counts and percentages", () => {
    expect(formatNumber("1234")).toBe("1,234");
    expect(formatCompact(1500)).toBe("1.5K");
    expect(formatPercent("12.34")).toBe("12.3%");
  });
});

describe("formatDate / formatDateTime / formatRelativeTime", () => {
  it("formats ISO dates deterministically", () => {
    const iso = "2026-11-24T12:00:00Z";
    expect(formatDate(iso)).toBe("Nov 24, 2026");
    expect(formatDateTime(iso)).toContain("Nov 24, 2026");
  });

  it("returns a dash for missing or invalid dates", () => {
    expect(formatDate(null)).toBe("—");
    expect(formatDate("not-a-date")).toBe("—");
  });

  it("formats relative times", () => {
    expect(formatRelativeTime(null)).toBe("—");
    expect(formatRelativeTime(new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString())).toMatch(/2 hours ago/);
  });
});

describe("truncateAddress", () => {
  it("shortens long hashes while keeping prefix and suffix", () => {
    const hash = "abcdefghijklmnopqrstuvwxyz0123456789";
    expect(truncateAddress(hash, 6, 4)).toBe("abcdef…6789");
    expect(truncateAddress("short", 6, 6)).toBe("short");
  });
});

describe("humanize / initials / stroopsToXlm", () => {
  it("humanizes status labels", () => {
    expect(humanize("partially_paid")).toBe("Partially Paid");
    expect(humanize("awaiting-acceptance")).toBe("Awaiting Acceptance");
  });

  it("builds initials", () => {
    expect(initials("Alex Morgan")).toBe("AM");
    expect(initials("finance@acme.com")).toBe("F");
  });

  it("converts stroops to XLM", () => {
    expect(stroopsToXlm(10_000_000)).toBe("1");
    expect(stroopsToXlm(25_000_000)).toBe("2.5");
    expect(stroopsToXlm(100)).toBe("0.00001");
  });
});
