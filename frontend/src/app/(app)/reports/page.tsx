"use client";

import dynamic from "next/dynamic";
import { Download, Loader2 } from "lucide-react";
import { PageHeader, SectionCard } from "@/components/PageHeader";
import { Skeleton } from "@/components/LoadingSkeleton";
import { StatCard } from "@/components/StatCard";
import { useToast } from "@/components/ToastProvider";
import { api, downloadBlob, getErrorMessage } from "@/lib/api";
import { formatMoney, toNumber } from "@/lib/format";
import { useApiResource } from "@/lib/useApiResource";
import { monthlyVolumeToActivity, reportHasData, useOutstanding } from "@/lib/useReportMetrics";
import type { DashboardReport } from "@/lib/types";
import { CircleDollarSign, FileText, Handshake, Wallet } from "lucide-react";
import { useState } from "react";

const VolumeChart = dynamic(() => import("@/components/ReportsCharts").then((module) => module.VolumeChart), { ssr: false, loading: () => <Skeleton className="h-72 w-full" /> });
const StatusChart = dynamic(() => import("@/components/ReportsCharts").then((module) => module.StatusChart), { ssr: false, loading: () => <Skeleton className="h-56 w-full" /> });

export default function ReportsPage() {
  const toast = useToast();
  const [exporting, setExporting] = useState(false);
  const { data, loading, error } = useApiResource<DashboardReport>(() => api.get("/reports/dashboard"));
  const outstanding = useOutstanding(data?.outstanding);

  const onExport = async () => {
    setExporting(true);
    try {
      const { blob, filename } = await api.download("/reports/payments.csv", "bizflow-payments.csv");
      downloadBlob(blob, filename);
      toast.success("Export ready", "Your payment report has been downloaded.");
    } catch (reason) {
      toast.error("Could not export report", getErrorMessage(reason));
    } finally {
      setExporting(false);
    }
  };

  const activity = monthlyVolumeToActivity(data?.monthly_volume);
  const hasData = reportHasData(data);
  const segments = [
    { name: "Paid", value: toNumber(data?.total_paid) },
    ...(outstanding === null ? [] : [{ name: "Outstanding", value: toNumber(outstanding) }]),
  ];

  return (
    <div className="animate-fade-in">
      <PageHeader
        eyebrow="Insights"
        title="Reports"
        description="Payment volume, settlement status and a full CSV export for your finance records."
        actions={
          <button onClick={() => void onExport()} disabled={exporting} className="inline-flex items-center gap-2 rounded-lg bg-accent-600 px-3.5 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-accent-700 disabled:opacity-50">
            {exporting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
            {exporting ? "Preparing…" : "Export CSV"}
          </button>
        }
      />

      {error ? <div role="alert" className="mb-4 rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">{error}</div> : null}

      {loading ? (
        <div className="space-y-5"><div className="grid gap-4 sm:grid-cols-3">{[1, 2, 3].map((key) => <Skeleton key={key} className="h-32 rounded-xl" />)}</div><Skeleton className="h-80 rounded-xl" /></div>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard label="Total paid" value={formatMoney(data?.total_paid)} hint="Confirmed on Testnet" icon={<CircleDollarSign className="h-5 w-5" />} accent="green" />
            <StatCard label="Outstanding" value={outstanding === null ? "—" : formatMoney(outstanding)} hint="Awaiting settlement" icon={<Wallet className="h-5 w-5" />} accent="amber" />
            <StatCard label="Invoices" value={String(data?.counts?.invoices ?? 0)} hint="Issued overall" icon={<FileText className="h-5 w-5" />} />
            <StatCard label="Active agreements" value={String(data?.counts?.agreements_active ?? 0)} hint="Currently in progress" icon={<Handshake className="h-5 w-5" />} accent="slate" />
          </div>

          <div className="mt-5 grid gap-5 xl:grid-cols-2">
            <SectionCard title="Payment volume" description="Confirmed settlement volume by month">
              {hasData && activity.length ? <VolumeChart activity={activity} /> : <p className="py-20 text-center text-sm text-slate-400">No activity to chart yet.</p>}
            </SectionCard>
            <SectionCard title="Settlement split" description="Paid vs outstanding (XLM, rounded)">
              <StatusChart segments={segments} />
            </SectionCard>
          </div>

          <div className="mt-5 rounded-xl border border-slate-200 bg-white p-6 shadow-card">
            <h2 className="text-sm font-semibold text-navy-900">About this export</h2>
            <p className="mt-2 max-w-3xl text-sm leading-relaxed text-slate-600">
              The CSV contains every payment record in your workspace, including status and linked transaction hashes. Amounts are exported as decimal strings and all timestamps are ISO-8601.
            </p>
          </div>
        </>
      )}
    </div>
  );
}
