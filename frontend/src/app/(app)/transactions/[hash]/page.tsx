"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import {
  ArrowLeft,
  BadgeCheck,
  CircleAlert,
  Clock3,
  ExternalLink,
  Hash,
  ReceiptText,
  ShieldCheck,
} from "lucide-react";
import { PageHeader, SectionCard } from "@/components/PageHeader";
import { Skeleton } from "@/components/LoadingSkeleton";
import { StatusBadge } from "@/components/StatusBadge";
import { api } from "@/lib/api";
import { formatDateTime, formatMoney } from "@/lib/format";
import { explorerUrl } from "@/lib/stellar";
import { useApiResource } from "@/lib/useApiResource";
import type { BlockchainTransaction } from "@/lib/types";

type VerificationTone = "success" | "warning" | "danger";

function verificationPanel(status: string, verification: string): { tone: VerificationTone; title: string; body: string } {
  const key = verification.toLowerCase();
  if (["failed", "rejected", "error"].includes(key)) {
    return { tone: "danger", title: "Verification failed", body: "The ledger did not confirm a successful result. No payment was settled from this transaction." };
  }
  if (["verified", "confirmed", "successful", "released", "paid"].includes(key)) {
    return { tone: "success", title: "Independently verified", body: "The backend matched this transaction against the ledger record for source, destination, asset, amount and memo before crediting any invoice." };
  }
  if (["pending", "unconfirmed", "submitted", "processing"].includes(key) || ["pending", "unconfirmed", "submitted"].includes(status.toLowerCase())) {
    return { tone: "warning", title: "Awaiting confirmation", body: "The transaction was submitted, but Horizon has not yet returned a verified ledger result. No settlement is credited until then." };
  }
  return { tone: "warning", title: "Verification result recorded", body: "The backend status is shown below. Settlement is credited only after the ledger result is independently verified." };
}

const PANEL_STYLE: Record<VerificationTone, { wrap: string; icon: string; title: string; body: string }> = {
  success: { wrap: "border-emerald-200 bg-emerald-50", icon: "text-emerald-600", title: "text-emerald-900", body: "text-emerald-800" },
  warning: { wrap: "border-amber-200 bg-amber-50", icon: "text-amber-600", title: "text-amber-900", body: "text-amber-800" },
  danger: { wrap: "border-rose-200 bg-rose-50", icon: "text-rose-600", title: "text-rose-900", body: "text-rose-800" },
};

export default function TransactionDetailPage() {
  const params = useParams<{ hash: string }>();
  const hash = params.hash;
  const { data, loading, error } = useApiResource<BlockchainTransaction>(() => api.get(`/transactions/${encodeURIComponent(hash)}`), [hash]);

  if (loading) return <div className="animate-fade-in space-y-5"><Skeleton className="h-8 w-64" /><Skeleton className="h-72 w-full rounded-card" /></div>;
  if (error) return <div role="alert" className="ui-card border-rose-200 bg-rose-50 p-4 text-sm text-rose-700">{error}</div>;
  if (!data) return null;

  const status = data.status || (data.successful ? "confirmed" : "pending");
  const verified = data.verification_status ? String(data.verification_status) : status;
  const panel = verificationPanel(status, verified);
  const style = PANEL_STYLE[panel.tone];
  const PanelIcon = panel.tone === "success" ? BadgeCheck : panel.tone === "danger" ? CircleAlert : Clock3;

  const rows: Array<[string, React.ReactNode]> = [
    ["Transaction hash", <span key="hash" className="break-all font-mono text-xs text-ink-900">{data.hash}</span>],
    ["Status", <StatusBadge key="status" status={status} />],
    ["Verification", <StatusBadge key="verification" status={verified} label={verified} />],
    ["Amount", data.amount ? `${formatMoney(data.amount, { decimals: 7 })} ${data.asset_code || "XLM"}` : "—"],
    ["Source", <span key="source" className="break-all font-mono text-xs text-ink-900">{data.source_account || "—"}</span>],
    ["Destination", <span key="destination" className="break-all font-mono text-xs text-ink-900">{data.destination_account || "—"}</span>],
    ["Memo", <span key="memo" className="font-mono text-xs text-ink-900">{data.memo || "(none)"}</span>],
    ["Ledger", data.ledger ? String(data.ledger) : "—"],
    ["Network fee", data.fee ? `${data.fee} stroops` : "—"],
    ["Created", formatDateTime(data.created_at)],
    ["Confirmed", formatDateTime(data.confirmed_at)],
  ];

  return (
    <div className="animate-fade-in space-y-5">
      <Link href="/transactions" className="inline-flex items-center gap-1.5 text-sm font-medium text-ink-400 transition-colors hover:text-ink-900">
        <ArrowLeft className="h-4 w-4" /> Back to transactions
      </Link>

      <PageHeader
        eyebrow="Blockchain transaction"
        title="Transaction detail"
        description="Live data from the database cross-checked against the Stellar Testnet ledger."
        actions={
          data.hash ? (
            <a href={explorerUrl(data.hash)} target="_blank" rel="noopener noreferrer" className="ui-btn-secondary">
              <ExternalLink className="h-4 w-4" /> View on explorer
            </a>
          ) : null
        }
      />

      <div className="grid gap-5 lg:grid-cols-[1.5fr_1fr]">
        <SectionCard title="Ledger record" description="Fields returned by the backend, never generated here">
          <dl className="divide-y divide-line">
            {rows.map(([label, value]) => (
              <div key={label} className="grid gap-1 py-3.5 sm:grid-cols-[170px_1fr] sm:items-center">
                <dt className="text-xs font-medium text-ink-400">{label}</dt>
                <dd className="text-sm text-ink-900">{value}</dd>
              </div>
            ))}
          </dl>
        </SectionCard>

        <div className="space-y-5">
          <SectionCard title="Verification" description="Status shown separately from settlement">
            <div className={`rounded-card border p-4 ${style.wrap}`}>
              <PanelIcon className={`h-5 w-5 ${style.icon}`} aria-hidden="true" />
              <p className={`mt-3 text-sm font-semibold ${style.title}`}>{panel.title}</p>
              <p className={`mt-1 text-xs leading-relaxed ${style.body}`}>{panel.body}</p>
            </div>
            <div className="mt-4 flex items-start gap-2.5 rounded-control border border-line bg-slate-50 px-3 py-2.5 text-xs leading-relaxed text-ink-500">
              <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-accent-600" aria-hidden="true" />
              <p>Submitted and pending are not displayed as successful. Only a verified ledger result settles a payment.</p>
            </div>
          </SectionCard>

          <SectionCard title="Timeline" description="Derived from recorded timestamps">
            <ol className="space-y-3 text-xs">
              {data.created_at ? (
                <li className="flex items-start gap-2.5">
                  <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-accent-500" aria-hidden="true" />
                  <span><strong className="font-semibold text-ink-900">Created</strong><span className="text-ink-400"> · {formatDateTime(data.created_at)}</span></span>
                </li>
              ) : null}
              {data.confirmed_at ? (
                <li className="flex items-start gap-2.5">
                  <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500" aria-hidden="true" />
                  <span><strong className="font-semibold text-ink-900">Confirmed on ledger</strong><span className="text-ink-400"> · {formatDateTime(data.confirmed_at)}</span></span>
                </li>
              ) : null}
              {data.ledger ? (
                <li className="flex items-start gap-2.5">
                  <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-slate-300" aria-hidden="true" />
                  <span><strong className="font-semibold text-ink-900">Ledger {String(data.ledger)}</strong><span className="text-ink-400"> · recorded by Horizon</span></span>
                </li>
              ) : null}
              {!data.created_at && !data.confirmed_at && !data.ledger ? <li className="text-ink-400">No timestamps recorded for this transaction.</li> : null}
            </ol>
          </SectionCard>

          <SectionCard title="Public receipt">
            <p className="text-xs leading-relaxed text-ink-500">
              Share a verification link with your supplier. The public receipt shows only non-sensitive settlement data.
            </p>
            <Link href={`/verify/${encodeURIComponent(data.hash)}`} className="ui-btn-secondary mt-4 text-accent-700">
              <ReceiptText className="h-4 w-4" /> Open public receipt
            </Link>
          </SectionCard>

          <div className="flex items-center gap-2 rounded-card bg-slate-100 px-4 py-3 text-xs text-ink-500">
            <Hash className="h-4 w-4" /> Hashes are never generated in the browser.
          </div>
        </div>
      </div>
    </div>
  );
}
