"use client";

import { AlertTriangle, ArrowRight, Loader2, ShieldCheck } from "lucide-react";
import { Modal } from "./Modal";
import { truncateAddress } from "@/lib/format";
import type { TransactionDetails } from "@/lib/types";

interface SignTransactionModalProps {
  open: boolean;
  details: TransactionDetails | null;
  busy?: boolean;
  stage?: string;
  error?: string | null;
  onApprove: () => void;
  onCancel: () => void;
}

function Detail({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="rounded-lg border border-slate-100 bg-slate-50/70 px-3.5 py-3">
      <dt className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">{label}</dt>
      <dd className={`mt-1 break-all text-sm font-medium text-navy-900 ${mono ? "font-mono text-xs" : ""}`}>{value || "—"}</dd>
    </div>
  );
}

export function SignTransactionModal({
  open,
  details,
  busy = false,
  stage,
  error,
  onApprove,
  onCancel,
}: SignTransactionModalProps) {
  return (
    <Modal
      open={open}
      onClose={busy ? () => undefined : onCancel}
      title="Confirm & sign transaction"
      description="Review every field carefully before approving. BizFlow cannot reverse a submitted Stellar transaction."
      size="lg"
      footer={
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-between">
          <p className="flex items-center gap-1.5 text-xs text-slate-500">
            <ShieldCheck className="h-3.5 w-3.5 text-emerald-600" />
            Signing happens locally in Freighter. No private keys are shared.
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onCancel}
              disabled={busy}
              className="rounded-lg border border-slate-200 bg-white px-4 py-2.5 text-sm font-medium text-slate-700 transition hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-600 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={onApprove}
              disabled={busy || !details}
              className="inline-flex items-center justify-center gap-2 rounded-lg bg-accent-600 px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-accent-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              {busy ? stage || "Working…" : "Approve & Sign"}
              {!busy ? <ArrowRight className="h-4 w-4" /> : null}
            </button>
          </div>
        </div>
      }
    >
      {details ? (
        <div className="space-y-5">
          <div className="flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" aria-hidden="true" />
            <div className="text-sm text-amber-900">
              <p className="font-semibold">You are authorising a real payment</p>
              <p className="mt-0.5 text-xs leading-relaxed text-amber-800">
                This transaction was prepared on Stellar Testnet. Once signed and submitted it cannot be recalled.
              </p>
            </div>
          </div>

          <dl className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
            <Detail label="Amount" value={`${details.amount} ${details.asset}`} />
            <Detail label="Network" value={details.network} />
            <Detail label="From" value={details.source} mono />
            <Detail label="Destination" value={details.destination} mono />
            <Detail label="Asset" value={details.assetIssuer ? `${details.asset} (${truncateAddress(details.assetIssuer, 6, 4)})` : `${details.asset} (native)`} />
            <Detail label="Network fee" value={`${details.fee} XLM`} />
            <Detail label="Memo" value={details.memo} />
            <Detail label="Operation" value={details.operationType} />
            <div className="sm:col-span-2">
              <Detail label="Transaction hash (precomputed)" value={details.hash || "Provided by Freighter before signing"} mono />
            </div>
          </dl>

          {error ? (
            <div role="alert" className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
              {error}
            </div>
          ) : null}
        </div>
      ) : (
        <p className="py-8 text-center text-sm text-slate-500">Preparing transaction details…</p>
      )}
    </Modal>
  );
}
