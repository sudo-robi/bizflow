"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { BadgeCheck, CircleDollarSign, ExternalLink, ShieldCheck } from "lucide-react";
import { PageHeader, SectionCard } from "@/components/PageHeader";
import { Skeleton } from "@/components/LoadingSkeleton";
import { StatusBadge } from "@/components/StatusBadge";
import { api } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import { explorerUrl } from "@/lib/stellar";
import { useApiResource } from "@/lib/useApiResource";
import type { PublicReceipt } from "@/lib/types";

export default function VerifyPage() {
  const params = useParams<{ hash: string }>();
  const hash = params.hash;
  const { data, loading, error } = useApiResource<PublicReceipt>(
    () => api.get(`/verify/${encodeURIComponent(hash)}`, { public: true }),
    [hash],
  );

  return (
    <div className="min-h-screen bg-[#F6F8FB]">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex h-16 max-w-4xl items-center justify-between px-5 sm:px-8">
          <Link href="/" className="flex items-center gap-2.5" aria-label="BizFlow home">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-navy-900 text-white"><CircleDollarSign className="h-5 w-5" /></span>
            <span className="font-display text-lg tracking-tight text-navy-900">BizFlow</span>
          </Link>
          <span className="rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-[11px] font-semibold text-emerald-700">PUBLIC RECEIPT</span>
        </div>
      </header>

      <main className="mx-auto max-w-4xl px-5 py-10 sm:px-8 sm:py-14">
        <PageHeader eyebrow="Verification" title="Payment receipt" description="This page shows non-sensitive settlement data recorded on Stellar Testnet." />

        {loading ? (
          <Skeleton className="h-96 w-full rounded-xl" />
        ) : error ? (
          <div role="alert" className="rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700">{error}</div>
        ) : data ? (
          <div className="grid gap-5 md:grid-cols-[1.5fr_1fr]">
            <SectionCard title="Receipt details">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <p className="text-xs uppercase tracking-wider text-slate-500">Amount</p>
                  <p className="mt-1 font-display text-3xl tracking-tight text-navy-900">
                    {data.amount ? `${data.amount} ${data.asset_code || "XLM"}` : "—"}
                  </p>
                </div>
                <StatusBadge status={data.status || (data.confirmed_at ? "confirmed" : "pending")} />
              </div>
              <dl className="mt-6 divide-y divide-slate-100 border-t border-slate-100 pt-2">
                {[
                  ["Transaction hash", data.hash],
                  ["Settled invoice", data.settled_invoice || "—"],
                  ["Source", data.source || "—"],
                  ["Destination", data.destination || "—"],
                  ["Memo", data.memo || "(none)"],
                  ["Confirmed", formatDateTime(data.confirmed_at)],
                ].map(([label, value]) => (
                  <div key={label} className="grid gap-1 py-3.5 sm:grid-cols-[160px_1fr]">
                    <dt className="text-xs font-medium text-slate-500">{label}</dt>
                    <dd className="break-all font-mono text-xs text-navy-900">{value}</dd>
                  </div>
                ))}
              </dl>
            </SectionCard>

            <div className="space-y-5">
              <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-5">
                <BadgeCheck className="h-6 w-6 text-emerald-600" />
                <p className="mt-3 text-sm font-semibold text-emerald-900">Independently verifiable</p>
                <p className="mt-1 text-xs leading-relaxed text-emerald-800">
                  This receipt is derived from a transaction confirmed on the Stellar Testnet ledger. You can verify the hash in any Stellar explorer.
                </p>
              </div>
              <a href={explorerUrl(data.hash)} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-4 py-2.5 text-sm font-semibold text-accent-600 hover:bg-accent-50">
                <ExternalLink className="h-4 w-4" /> Verify on Stellar Expert
              </a>
              <div className="flex items-start gap-2 rounded-lg bg-slate-100 p-4 text-xs leading-relaxed text-slate-600">
                <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-slate-500" />
                Internal notes, emails and private business data are intentionally omitted from public receipts.
              </div>
            </div>
          </div>
        ) : null}
      </main>
    </div>
  );
}
