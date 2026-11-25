"use client";

import { AlertTriangle, ArrowRight, Loader2, LockKeyhole, ShieldCheck } from "lucide-react";
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
    <div className="rounded-control border border-line bg-slate-50/70 px-3.5 py-3">
      <dt className="ui-kicker">{label}</dt>
      <dd className={`mt-1.5 break-all text-sm font-medium text-ink-900 ${mono ? "font-mono text-xs" : ""}`}>{value || "—"}</dd>
    </div>
  );
}

/** Maps the live pipeline stage to an honest, non-success state label. */
function stageState(stage?: string): { label: string; tone: string } {
  if (!stage) return { label: "Awaiting your signature", tone: "border-line bg-slate-50 text-ink-500" };
  if (/submit/i.test(stage)) return { label: "Submitted · verification pending", tone: "border-accent-200 bg-accent-50 text-accent-700" };
  if (/sign|freighter/i.test(stage)) return { label: "Awaiting signature in Freighter", tone: "border-amber-200 bg-amber-50 text-amber-700" };
  if (/approv|review/i.test(stage)) return { label: "Awaiting your approval", tone: "border-amber-200 bg-amber-50 text-amber-700" };
  return { label: stage, tone: "border-accent-200 bg-accent-50 text-accent-700" };
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
  const state = stageState(stage);
  return (
    <Modal
      open={open}
      onClose={busy ? () => undefined : onCancel}
      title="Confirm & sign transaction"
      description="Review every field carefully before approving. BizFlow cannot reverse a submitted Stellar transaction."
      size="lg"
      footer={
        <div className="flex flex-col-reverse gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="flex items-start gap-1.5 text-xs leading-relaxed text-ink-400">
            <LockKeyhole className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600" aria-hidden="true" />
            Signing happens locally in Freighter. No private keys are shared.
          </p>
          <div className="flex flex-col-reverse gap-2 sm:flex-row">
            <button
              type="button"
              onClick={onCancel}
              disabled={busy}
              className="ui-btn-secondary"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={onApprove}
              disabled={busy || !details}
              className="ui-btn-accent"
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
          <div className={`flex items-center gap-2 rounded-control border px-3 py-2 text-xs font-semibold ${state.tone}`} role="status" aria-live="polite">
            <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden="true" />
            {state.label}
          </div>

          <div className="flex items-start gap-3 rounded-card border border-amber-200 bg-amber-50 p-4">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" aria-hidden="true" />
            <div className="text-sm text-amber-900">
              <p className="font-semibold">You are authorising a real payment</p>
              <p className="mt-0.5 text-xs leading-relaxed text-amber-800">
                This transaction was prepared on Stellar Testnet. Once signed and submitted it cannot be recalled.
              </p>
            </div>
          </div>

          <div>
            <p className="ui-kicker mb-2">Transaction to sign</p>
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
          </div>

          <div className="flex items-start gap-2.5 rounded-control border border-line bg-slate-50 px-3 py-2.5 text-xs leading-relaxed text-ink-500">
            <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-accent-600" aria-hidden="true" />
            <p>A signature is not a settlement. Confirmation is shown only after the backend verifies the transaction on the ledger.</p>
          </div>

          {error ? (
            <div role="alert" className="ui-card border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
              {error}
            </div>
          ) : null}
        </div>
      ) : (
        <p className="py-8 text-center text-sm text-ink-400">Preparing transaction details…</p>
      )}
    </Modal>
  );
}
