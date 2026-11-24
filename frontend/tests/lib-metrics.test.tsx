import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { monthlyVolumeToActivity, reportHasData, useOutstanding } from "../src/lib/useReportMetrics";
import { parseJsonObject } from "../src/lib/validators";

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

beforeEach(() => {
  fetchMock.mockReset();
});

describe("monthlyVolumeToActivity", () => {
  it("converts a monthly volume map into ordered activity points", () => {
    expect(monthlyVolumeToActivity({ "2026-10": "12.5", "2026-11": 5 as unknown as string })).toEqual([
      { date: "2026-10-01", label: "2026-10", amount: "12.5" },
      { date: "2026-11-01", label: "2026-11", amount: "5" },
    ]);
  });

  it("handles missing and null amounts", () => {
    expect(monthlyVolumeToActivity()).toEqual([]);
    expect(monthlyVolumeToActivity({ "2026-01": null as unknown as string })).toEqual([
      { date: "2026-01-01", label: "2026-01", amount: "0" },
    ]);
  });
});

describe("reportHasData", () => {
  it("prefers the backend has_data flag", () => {
    expect(reportHasData({ has_data: true } as never)).toBe(true);
    expect(reportHasData({ has_data: false, counts: { invoices: 5 } } as never)).toBe(false);
  });

  it("falls back to real invoice/payment counts", () => {
    expect(reportHasData({ counts: { invoices: 1 } } as never)).toBe(true);
    expect(reportHasData({ counts: { payments_confirmed: "3" } } as never)).toBe(true);
    expect(reportHasData({ counts: { invoices: 0, payments_confirmed: 0 } } as never)).toBe(false);
    expect(reportHasData()).toBe(false);
    expect(reportHasData(null)).toBe(false);
  });
});

describe("useOutstanding", () => {
  it("uses a provided value without fetching analytics", () => {
    const { result } = renderHook(() => useOutstanding("123.45"));
    expect(result.current).toBe("123.45");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fetches analytics for missing values and stringifies the result", async () => {
    fetchMock.mockResolvedValue({
      status: 200,
      ok: true,
      headers: { get: () => "application/json" },
      json: async () => ({ outstanding_liabilities: 99 }),
      text: async () => '{"outstanding_liabilities":99}',
    });
    const { result } = renderHook(() => useOutstanding(undefined));
    await waitFor(() => expect(result.current).toBe("99"));
    expect(fetchMock.mock.calls[0][0]).toBe("/api/v1/reports/analytics");
  });

  it("returns null when analytics has no outstanding value", async () => {
    fetchMock.mockResolvedValue({
      status: 200,
      ok: true,
      headers: { get: () => "application/json" },
      json: async () => ({}),
      text: async () => "{}",
    });
    const { result } = renderHook(() => useOutstanding(""));
    await waitFor(() => expect(result.current).toBeNull());
  });
});

describe("parseJsonObject", () => {
  it("returns null for empty input and parses valid objects", () => {
    expect(parseJsonObject("  ")).toBeNull();
    expect(parseJsonObject('{"a": 1}')).toEqual({ a: 1 });
  });

  it("throws clear errors for invalid JSON and non-objects", () => {
    expect(() => parseJsonObject("{bad")).toThrow('Enter valid JSON, for example: {"key": "value"}.');
    expect(() => parseJsonObject("[]")).toThrow("Enter a JSON object");
    expect(() => parseJsonObject("null")).toThrow("Enter a JSON object");
    expect(() => parseJsonObject("5")).toThrow("Enter a JSON object");
  });
});
