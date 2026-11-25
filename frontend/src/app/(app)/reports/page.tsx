"use client";

import dynamic from "next/dynamic";
import { useState } from "react";
import { CircleDollarSign, Download, FileDown, FileText, Handshake, Loader2, Wallet } from "lucide-react";
import { PageHeader, SectionCard } from "@/components/PageHeader";
import { Skeleton } from "@/components/LoadingSkeleton";
import { StatCard } from "@/components/StatCard";
import { useToast } from "@/components/ToastProvider";
import { api, downloadBlob, getErrorMessage } from "@/lib/api";
import { formatMoney, toNumber, truncateAddress } from "@/lib/format";
import { useApiResource } from "@/lib/useApiResource";
import { monthlyVolumeToActivity, reportHasData } from "@/lib/useReportMetrics";
import type { AnalyticsReport, DashboardReport } from "@/lib/types";

const VolumeChart = dynamic(() => import("@/components/ReportsCharts").then((module) => module.VolumeChart), { ssr: false, loading: () => <Skeleton className="h-72 w-full" /> });
const StatusChart = dynamic(() => import("@/components/ReportsCharts").then((module) => module.StatusChart), { ssr: false, loading: () => <Skeleton className="h-56 w-full" /> });

interface Analytics extends AnalyticsReport {
  monthly_payment_volume?: Record<string, { volume?: string; change_pct?: string | null }>;
  supplier_breakdown?: Array<{ supplier?: string; total?: string }>;
  completed_payments?: number;
  failed_payments?: number;
  invoice_aging?: Record<string, { count?: string; amount?: string }>;
  agreements_by_status?: Record<string, number>;
}

interface ReconciliationReport {
  unmatched_transactions?: Array<{ hash?: string; amount?: string | null; asset_code?: string }>;
  partial_payments?: Array<{ invoice_number?: string; paid?: string; amount?: string }>;
  overpayments?: Array<{ invoice_number?: string; paid?: string; amount?: string }>;
  duplicate_transaction_hashes?: Array<{ hash?: string; count?: number }>;
  confirmed_payments_without_hash?: number;
}

const AGING_LABELS: Record<string, string> = {
  "0_30": "0–30 days",
  "31_60": "31–60 days",
  "61_90": "61–90 days",
  "90_plus": "90+ days",
};

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-control border border-line bg-canvas/60 px-3 py-2.5">
      <p className="text-2xs font-semibold uppercase tracking-wider text-ink-400">{label}</p>
      <p className="mt-1 text-base font-semibold tabular-nums text-ink-900">{value}</p>
    </div>
  );
}

export default function ReportsPage() {
  const toast = useToast();
  const [exporting, setExporting] = useState<"csv" | "pdf" | null>(null);
  const { data, loading, error } = useApiResource<DashboardReport>(() => api.get("/reports/dashboard"));
  const { data: analytics, loading: analyticsLoading, error: analyticsError } = useApiResource<Analytics>(() => api.get("/reports/analytics"));
  const { data: reconciliation, loading: reconciliationLoading, error: reconciliationError } = useApiResource<ReconciliationReport>(() => api.get("/reports/reconciliation"));

  const onExport = async (kind: "csv" | "pdf") => {
    setExporting(kind);
    try {
      if (kind === "csv") {
        const { blob, filename } = await api.download("/reports/payments.csv", "bizflow-payments.csv");
        downloadBlob(blob, filename);
        toast.success("Export ready", "Your payment report has been downloaded.");
      } else {
        const { blob, filename } = await api.download("/reports/analytics.pdf", "bizflow-analytics.pdf");
        downloadBlob(blob, filename);
        toast.success("Analytics PDF ready", "Your analytics summary has been downloaded.");
      }
    } catch (reason) {
      toast.error(kind === "csv" ? "Could not export report" : "Could not export analytics", getErrorMessage(reason));
    } finally {
      setExporting(null);
    }
  };

  const providedOutstanding = data?.outstanding;
  const outstanding =
    providedOutstanding !== undefined && providedOutstanding !== null && providedOutstanding !== ""
      ? String(providedOutstanding)
      : analytics?.outstanding_liabilities
        ? String(analytics.outstanding_liabilities)
        : null;

  const activity = monthlyVolumeToActivity(data?.monthly_volume);
  const hasData = reportHasData(data);
  const segments = [
    { name: "Paid", value: toNumber(data?.total_paid) },
    ...(outstanding === null ? [] : [{ name: "Outstanding", value: toNumber(outstanding) }]),
  ];

  const hasReconciliation =
    !!reconciliation &&
    Array.isArray(reconciliation.unmatched_transactions) &&
    Array.isArray(reconciliation.partial_payments) &&
    Array.isArray(reconciliation.overpayments) &&
    Array.isArray(reconciliation.duplicate_transaction_hashes);
  const exceptionCount = hasReconciliation
    ? (reconciliation!.unmatched_transactions?.length ?? 0) +
      (reconciliation!.partial_payments?.length ?? 0) +
      (reconciliation!.overpayments?.length ?? 0) +
      (reconciliation!.duplicate_transaction_hashes?.length ?? 0) +
      Number(reconciliation!.confirmed_payments_without_hash ?? 0)
    : null;

  return (
    <div className="animate-fade-in space-y-5">
      <PageHeader
        eyebrow="Insights"
        title="Reports"
        description="Payment volume, settlement status and exports generated from verified workspace records."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={() => void onExport("pdf")} disabled={!!exporting} className="ui-btn-secondary min-h-9">
              {exporting === "pdf" ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileDown className="h-4 w-4" />}
              {exporting === "pdf" ? "Preparing…" : "Export PDF"}
            </button>
            <button type="button" onClick={() => void onExport("csv")} disabled={!!exporting} className="ui-btn-accent min-h-9">
              {exporting === "csv" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
              {exporting === "csv" ? "Preparing…" : "Export CSV"}
            </button>
          </div>
        }
      />

      {error ? <div role="alert" className="ui-panel border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">{error}</div> : null}

      {loading ? (
        <div role="status" aria-label="Loading reports" className="space-y-5">
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">{[1, 2, 3, 4].map((key) => <Skeleton key={key} className="h-32 rounded-card" />)}</div>
          <div className="grid gap-5 xl:grid-cols-2"><Skeleton className="h-80 rounded-card" /><Skeleton className="h-80 rounded-card" /></div>
        </div>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard label="Total paid" value={formatMoney(data?.total_paid)} hint="Confirmed on Testnet" icon={<CircleDollarSign className="h-5 w-5" />} accent="green" />
            <StatCard label="Outstanding" value={outstanding === null ? "—" : formatMoney(outstanding)} hint="Awaiting settlement" icon={<Wallet className="h-5 w-5" />} accent="amber" />
            <StatCard label="Invoices" value={String(data?.counts?.invoices ?? 0)} hint="Issued overall" icon={<FileText className="h-5 w-5" />} />
            <StatCard label="Active agreements" value={String(data?.counts?.agreements_active ?? 0)} hint="Currently in progress" icon={<Handshake className="h-5 w-5" />} accent="slate" />
          </div>

          <div className="grid gap-5 xl:grid-cols-2">
            <SectionCard title="Payment volume" description="Confirmed settlement volume by month">
              {hasData && activity.length ? <VolumeChart activity={activity} /> : <p className="py-20 text-center text-sm text-ink-400">No activity to chart yet.</p>}
            </SectionCard>
            <SectionCard title="Settlement split" description="Paid vs outstanding (XLM, rounded)">
              <StatusChart segments={segments} />
            </SectionCard>
          </div>

          <div className="grid gap-5 xl:grid-cols-2">
            <SectionCard title="Payment analytics" description="Aggregates from stored, verified records">
              {analyticsLoading ? (
                <div className="space-y-3" role="status" aria-label="Loading analytics"><Skeleton className="h-14" /><Skeleton className="h-24" /></div>
              ) : analyticsError ? (
                <p className="ui-muted">Analytics are unavailable right now. {analyticsError}</p>
              ) : !analytics ? (
                <p className="ui-muted">Analytics are not available for this workspace yet.</p>
              ) : (
                <div className="space-y-5">
                  <div className="grid grid-cols-2 gap-3">
                    <Metric label="Completed" value={analytics.completed_payments === undefined ? "—" : String(analytics.completed_payments)} />
                    <Metric label="Failed" value={analytics.failed_payments === undefined ? "—" : String(analytics.failed_payments)} />
                  </div>
                  <div>
                    <p className="ui-kicker mb-2">Invoice aging</p>
                    <ul className="divide-y divide-line">
                      {Object.entries(AGING_LABELS).map(([key, label]) => {
                        const bucket = analytics.invoice_aging?.[key];
                        return (
                          <li key={key} className="flex items-center justify-between gap-3 py-2 text-sm">
                            <span className="text-ink-500">{label}</span>
                            <span className="tabular-nums text-ink-900">
                              {bucket ? `${bucket.count ?? "—"} · ${bucket.amount ?? "—"}` : "—"}
                            </span>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                  <div>
                    <p className="ui-kicker mb-2">Supplier breakdown</p>
                    {analytics.supplier_breakdown?.length ? (
                      <ul className="divide-y divide-line">
                        {analytics.supplier_breakdown.slice(0, 5).map((entry, index) => (
                          <li key={`${entry.supplier || "supplier"}-${index}`} className="flex items-center justify-between gap-3 py-2 text-sm">
                            <span className="truncate text-ink-500">{entry.supplier || "—"}</span>
                            <span className="tabular-nums font-semibold text-ink-900">{entry.total ? formatMoney(entry.total) : "—"}</span>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="ui-muted">No confirmed supplier payments to break down yet.</p>
                    )}
                  </div>
                </div>
              )}
            </SectionCard>

            <SectionCard title="Reconciliation" description="Exceptions between ledger activity and payment records">
              {reconciliationLoading ? (
                <div className="space-y-3" role="status" aria-label="Loading reconciliation"><Skeleton className="h-14" /><Skeleton className="h-24" /></div>
              ) : reconciliationError ? (
                <p className="ui-muted">Reconciliation is unavailable right now. {reconciliationError}</p>
              ) : !hasReconciliation ? (
                <p className="ui-muted">Reconciliation details are not available for this workspace.</p>
              ) : (
                <div className="space-y-5">
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                    <Metric label="Unmatched" value={String(reconciliation!.unmatched_transactions?.length ?? 0)} />
                    <Metric label="Partial" value={String(reconciliation!.partial_payments?.length ?? 0)} />
                    <Metric label="Overpaid" value={String(reconciliation!.overpayments?.length ?? 0)} />
                    <Metric label="Duplicate hashes" value={String(reconciliation!.duplicate_transaction_hashes?.length ?? 0)} />
                    <Metric label="Missing hash" value={String(reconciliation!.confirmed_payments_without_hash ?? 0)} />
                    <Metric label="Total exceptions" value={String(exceptionCount ?? 0)} />
                  </div>
                  {exceptionCount === 0 ? (
                    <p className="ui-muted">No reconciliation exceptions found in the available records.</p>
                  ) : (
                    <ul className="space-y-2 text-sm">
                      {reconciliation!.unmatched_transactions?.slice(0, 3).map((item, index) => (
                        <li key={`${item.hash || "unmatched"}-${index}`} className="flex flex-wrap items-center justify-between gap-2 rounded-control border border-line px-3 py-2">
                          <span className="text-ink-500">Unmatched · {truncateAddress(item.hash || "—", 8, 6)}</span>
                          <span className="tabular-nums font-semibold text-ink-900">{item.amount ? formatMoney(item.amount) : "—"}</span>
                        </li>
                      ))}
                      {reconciliation!.partial_payments?.slice(0, 3).map((item, index) => (
                        <li key={`partial-${item.invoice_number || index}`} className="flex flex-wrap items-center justify-between gap-2 rounded-control border border-line px-3 py-2">
                          <span className="text-ink-500">Partial · {item.invoice_number || "—"}</span>
                          <span className="tabular-nums font-semibold text-ink-900">{item.paid ? formatMoney(item.paid) : "—"} / {item.amount ? formatMoney(item.amount) : "—"}</span>
                        </li>
                      ))}
                      {reconciliation!.overpayments?.slice(0, 3).map((item, index) => (
                        <li key={`over-${item.invoice_number || index}`} className="flex flex-wrap items-center justify-between gap-2 rounded-control border border-line px-3 py-2">
                          <span className="text-ink-500">Overpaid · {item.invoice_number || "—"}</span>
                          <span className="tabular-nums font-semibold text-ink-900">{item.paid ? formatMoney(item.paid) : "—"} / {item.amount ? formatMoney(item.amount) : "—"}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </SectionCard>
          </div>

          <section className="ui-card p-5">
            <h2 className="text-sm font-semibold text-ink-900">About these exports</h2>
            <div className="mt-3 grid gap-4 text-sm leading-relaxed text-ink-500 sm:grid-cols-2">
              <p>The CSV contains every payment record in your workspace, including status and linked transaction hashes. Amounts are decimal strings and timestamps are ISO-8601.</p>
              <p>The PDF summarises the same verified analytics shown above. Both files are generated server-side from stored records; pending and failed payments are excluded from completed totals.</p>
            </div>
          </section>
        </>
      )}
    </div>
  );
}
