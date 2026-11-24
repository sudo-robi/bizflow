"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CheckCircle2, FileCheck2, Loader2, Wallet } from "lucide-react";
import { DataTable, type Column } from "@/components/DataTable";
import { EmptyState } from "@/components/EmptyState";
import { PageHeader, SectionCard } from "@/components/PageHeader";
import { SignTransactionModal } from "@/components/SignTransactionModal";
import { StatusBadge } from "@/components/StatusBadge";
import { useToast } from "@/components/ToastProvider";
import { api, getErrorMessage } from "@/lib/api";
import { formatDate, formatMoney, truncateAddress } from "@/lib/format";
import { connectWallet, getWalletAddress, parseTransactionDetails, signTransaction } from "@/lib/stellar";
import { useApiResource } from "@/lib/useApiResource";
import type { Payment, PreparedPayment, TransactionDetails } from "@/lib/types";

const STAGE_LABELS: Record<string, string> = {
  connecting: "Connecting wallet",
  preparing: "Preparing transaction",
  review: "Awaiting approval",
  signing: "Waiting for Freighter",
  submitting: "Submitting to network",
};

function unwrapPayments(value: unknown): Payment[] {
  if (Array.isArray(value)) return value as Payment[];
  if (value && typeof value === "object" && Array.isArray((value as { items?: unknown[] }).items)) return (value as { items: Payment[] }).items;
  return [];
}

export default function ApprovalsPage() {
  const router = useRouter();
  const toast = useToast();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [stage, setStage] = useState("");
  const [details, setDetails] = useState<TransactionDetails | null>(null);
  const [error, setError] = useState<string | null>(null);
  const decisionRef = useRef<{ resolve: (value: boolean) => void } | null>(null);

  const { data, loading, error: loadError, reload } = useApiResource<unknown>(() => api.get("/payments?status=prepared&per_page=100"));
  // The backend stores signed-ready payments as "prepared"; accept "verifying"
  // too so an in-flight verification result is not hidden from reviewers.
  const payments = unwrapPayments(data).filter((payment) => payment.status === "prepared" || payment.status === "verifying");

  const askApproval = (transaction: TransactionDetails): Promise<boolean> =>
    new Promise((resolve) => {
      setDetails(transaction);
      decisionRef.current = { resolve };
    });

  const decide = (approved: boolean) => {
    decisionRef.current?.resolve(approved);
    decisionRef.current = null;
    if (!approved) setDetails(null);
  };

  const beginApproval = async (payment: Payment) => {
    setError(null);
    setBusyId(payment.id);
    try {
      setStage(STAGE_LABELS.connecting);
      let source = await getWalletAddress();
      if (!source) {
        toast.info("Connect Freighter", "Connect the signing wallet to approve this payment.");
        source = await connectWallet();
      }

      setStage(STAGE_LABELS.preparing);
      // The XDR is produced and stored by the backend at prepare time. Never
      // re-POST /payments/prepare: that returns DUPLICATE_PAYMENT.
      const prepared = await api.get<PreparedPayment>(`/payments/${payment.id}/prepared-xdr`);
      if (!prepared?.xdr) throw new Error("The backend did not return a stored transaction for this payment.");
      const xdr = prepared.xdr;

      setStage(STAGE_LABELS.review);
      const approved = await askApproval(parseTransactionDetails(xdr, prepared.hash));
      if (!approved) {
        toast.info("Approval cancelled", "The payment remains in the approval queue.");
        return;
      }

      setStage(STAGE_LABELS.signing);
      const signedXdr = await signTransaction(xdr, source);

      setStage(STAGE_LABELS.submitting);
      await api.post(`/payments/${payment.id}/submit`, { signed_xdr: signedXdr });
      setDetails(null);
      toast.success("Payment approved", "The transaction was submitted and is being verified on-chain.");
      reload();
    } catch (reason) {
      setError(getErrorMessage(reason));
      toast.error("Could not approve payment", getErrorMessage(reason));
      setDetails(null);
    } finally {
      setBusyId(null);
      setStage("");
    }
  };

  const columns: Column<Payment>[] = [
    {
      key: "id",
      header: "Payment",
      render: (row) => <span className="font-mono text-xs font-medium text-navy-900">{truncateAddress(row.id, 8, 4)}</span>,
    },
    { key: "amount", header: "Amount", render: (row) => <span className="font-medium text-navy-900">{formatMoney(row.amount, { decimals: 4 })} <span className="text-xs text-slate-400">{row.asset_code || "XLM"}</span></span> },
    { key: "invoice", header: "Invoice", render: (row) => row.invoice_id ? <Link href={`/invoices/${row.invoice_id}`} className="text-accent-600 hover:underline">View invoice</Link> : <span className="text-slate-400">—</span> },
    { key: "status", header: "Status", render: (row) => <StatusBadge status={row.status} /> },
    { key: "created_at", header: "Created", render: (row) => <span className="text-slate-500">{formatDate(row.created_at)}</span> },
    {
      key: "action",
      header: "",
      headerClassName: "text-right",
      className: "text-right",
      render: (row) => (
        <button
          type="button"
          onClick={(event) => { event.stopPropagation(); void beginApproval(row); }}
          disabled={!!busyId}
          className="inline-flex items-center gap-1.5 rounded-lg bg-accent-600 px-3 py-2 text-xs font-semibold text-white transition hover:bg-accent-700 disabled:opacity-50"
        >
          {busyId === row.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
          {busyId === row.id ? stage || "Working…" : "Review & sign"}
        </button>
      ),
    },
  ];

  return (
    <div className="animate-fade-in">
      <PageHeader
        eyebrow="Operations"
        title="Payment approvals"
        description="Every outgoing payment requires a human review. Inspect the full transaction before signing in Freighter."
      />

      {loadError ? <div role="alert" className="mb-4 rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">{loadError}</div> : null}
      {error ? <div role="alert" className="mb-4 rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">{error}</div> : null}

      <DataTable
        columns={columns}
        rows={payments}
        rowKey={(row) => row.id}
        loading={loading}
        onRowClick={(row) => row.invoice_id && router.push(`/invoices/${row.invoice_id}`)}
        emptyTitle="Nothing to approve"
        emptyDescription="Prepared payments will appear here until a reviewer signs and submits them."
      />

      <div className="mt-5">
        <SectionCard title="How approval works">
          <div className="grid gap-4 sm:grid-cols-3">
            {[
              { icon: FileCheck2, title: "1. Review", body: "Check amount, asset, destination, memo, fee and network in the confirmation dialog." },
              { icon: Wallet, title: "2. Sign locally", body: "Freighter signs the real backend-prepared XDR. No private keys are sent anywhere." },
              { icon: CheckCircle2, title: "3. Verify", body: "The backend submits to Horizon and independently verifies the ledger result before settling the invoice." },
            ].map((step) => {
              const Icon = step.icon;
              return (
                <div key={step.title} className="rounded-lg border border-slate-100 bg-slate-50/60 p-4">
                  <Icon className="h-5 w-5 text-accent-600" />
                  <p className="mt-3 text-sm font-semibold text-navy-900">{step.title}</p>
                  <p className="mt-1 text-xs leading-relaxed text-slate-500">{step.body}</p>
                </div>
              );
            })}
          </div>
          {!loading && !payments.length ? <EmptyState compact title="Approval queue is clear" description="New prepared payments will show up in the table above." /> : null}
        </SectionCard>
      </div>

      <SignTransactionModal
        open={!!details}
        details={details}
        busy={!!busyId && !!stage && stage !== "Awaiting approval"}
        stage={stage}
        error={error}
        onApprove={() => decide(true)}
        onCancel={() => decide(false)}
      />
    </div>
  );
}
