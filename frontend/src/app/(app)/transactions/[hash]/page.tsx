"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { ArrowLeft, BadgeCheck, ExternalLink, Hash, ReceiptText } from "lucide-react";
import { PageHeader, SectionCard } from "@/components/PageHeader";
import { Skeleton } from "@/components/LoadingSkeleton";
import { StatusBadge } from "@/components/StatusBadge";
import { api } from "@/lib/api";
import { formatDateTime, formatMoney } from "@/lib/format";
import { explorerUrl } from "@/lib/stellar";
import { useApiResource } from "@/lib/useApiResource";
import type { BlockchainTransaction } from "@/lib/types";

export default function TransactionDetailPage() {
  const params = useParams<{ hash: string }>();
  const hash = params.hash;
  const { data, loading, error } = useApiResource<BlockchainTransaction>(() => api.get(`/transactions/${encodeURIComponent(hash)}`), [hash]);

  if (loading) return <div className="space-y-5"><Skeleton className="h-8 w-64" /><Skeleton className="h-72 w-full rounded-xl" /></div>;
  if (error) return <div role="alert" className="rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700">{error}</div>;
  if (!data) return null;

  const status = data.status || (data.successful ? "confirmed" : "pending");
  const verified = data.verification_status ? String(data.verification_status) : status;

  const rows: Array<[string, React.ReactNode]> = [
    ["Transaction hash", <span className="break-all font-mono text-xs text-navy-900">{data.hash}</span>],
    ["Status", <StatusBadge status={status} />],
    ["Verification", <StatusBadge status={verified} label={verified} />],
    ["Amount", data.amount ? `${formatMoney(data.amount, { decimals: 7 })} ${data.asset_code || "XLM"}` : "—"],
    ["Source", <span className="break-all font-mono text-xs text-navy-900">{data.source_account || "—"}</span>],
    ["Destination", <span className="break-all font-mono text-xs text-navy-900">{data.destination_account || "—"}</span>],
    ["Memo", <span className="font-mono text-xs text-navy-900">{data.memo || "(none)"}</span>],
    ["Ledger", data.ledger ? String(data.ledger) : "—"],
    ["Network fee", data.fee ? `${data.fee} stroops` : "—"],
    ["Created", formatDateTime(data.created_at)],
    ["Confirmed", formatDateTime(data.confirmed_at)],
  ];

  return (
    <div className="animate-fade-in">
      <Link href="/transactions" className="mb-5 inline-flex items-center gap-1.5 text-sm font-medium text-slate-500 hover:text-navy-900">
        <ArrowLeft className="h-4 w-4" /> Back to transactions
      </Link>
      <PageHeader
        eyebrow="Blockchain transaction"
        title="Transaction detail"
        description="Live data from the database cross-checked against the Stellar Testnet ledger."
        actions={
          <a href={explorerUrl(data.hash)} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3.5 py-2.5 text-sm font-medium text-navy-900 hover:bg-slate-50">
            <ExternalLink className="h-4 w-4" /> View on explorer
          </a>
        }
      />

      <div className="grid gap-5 lg:grid-cols-[1.5fr_1fr]">
        <SectionCard title="Ledger record">
          <dl className="divide-y divide-slate-100">
            {rows.map(([label, value]) => (
              <div key={label} className="grid gap-1 py-3.5 sm:grid-cols-[170px_1fr] sm:items-center">
                <dt className="text-xs font-medium text-slate-500">{label}</dt>
                <dd className="text-sm text-navy-900">{value}</dd>
              </div>
            ))}
          </dl>
        </SectionCard>

        <div className="space-y-5">
          <SectionCard title="Verification">
            <div className="rounded-xl border border-emerald-100 bg-emerald-50 p-4">
              <BadgeCheck className="h-5 w-5 text-emerald-600" />
              <p className="mt-3 text-sm font-semibold text-emerald-900">Independent verification</p>
              <p className="mt-1 text-xs leading-relaxed text-emerald-800">
                The backend checks the transaction on Horizon and confirms source, destination, asset, amount and memo before crediting any invoice. Only successful, ledger-confirmed transactions settle payments.
              </p>
            </div>
          </SectionCard>
          <SectionCard title="Public receipt">
            <p className="text-xs leading-relaxed text-slate-600">
              Share a verification link with your supplier. The public receipt shows only non-sensitive settlement data.
            </p>
            <Link href={`/verify/${encodeURIComponent(data.hash)}`} className="mt-4 inline-flex items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-accent-600 hover:bg-accent-50">
              <ReceiptText className="h-3.5 w-3.5" /> Open public receipt
            </Link>
          </SectionCard>
          <div className="flex items-center gap-2 rounded-lg bg-slate-50 px-4 py-3 text-xs text-slate-500">
            <Hash className="h-3.5 w-3.5" /> Hashes are never generated in the browser.
          </div>
        </div>
      </div>
    </div>
  );
}
