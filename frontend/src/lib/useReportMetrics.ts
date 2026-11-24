"use client";

import { api } from "./api";
import type { ActivityPoint, AnalyticsReport, DashboardReport } from "./types";
import { useApiResource } from "./useApiResource";

/** Turns the backend's monthly_volume map into ordered chart points. */
export function monthlyVolumeToActivity(monthly?: Record<string, string>): ActivityPoint[] {
  return Object.entries(monthly || {}).map(([month, amount]) => ({
    date: `${month}-01`,
    label: month,
    amount: String(amount ?? "0"),
  }));
}

/** Authoritative empty state: prefer the backend flag, fall back to real counts. */
export function reportHasData(report?: DashboardReport | null): boolean {
  if (typeof report?.has_data === "boolean") return report.has_data;
  const counts = report?.counts;
  return Number(counts?.invoices || 0) > 0 || Number(counts?.payments_confirmed || 0) > 0;
}

/**
 * Outstanding is not part of /reports/dashboard. Read the backend-provided
 * value when present, otherwise use the real aggregate from /reports/analytics.
 * Returns null when neither source is available so callers can show "—".
 */
export function useOutstanding(provided?: string | null): string | null {
  const needsAnalytics = provided === undefined || provided === null || provided === "";
  const { data } = useApiResource<AnalyticsReport>(() => api.get("/reports/analytics"), [], needsAnalytics);
  if (!needsAnalytics) return String(provided);
  const value = data?.outstanding_liabilities;
  return value === undefined || value === null ? null : String(value);
}
